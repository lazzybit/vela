import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium, type Browser, type Frame, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEAM_DOMAIN = "vela-e2e.cloudflareaccess.com";
const POLICY_AUD = "vela-e2e-aud";
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const fixtureHtml = `<!doctype html>
<html>
  <head><title>Vela fixture</title></head>
  <body>
    <h1 id="heading">Hello fixture</h1>
    <button id="counter" onclick="document.getElementById('heading').textContent = 'Clicked'">Click me</button>
    <input id="name" />
  </body>
</html>`;

const SESSION_MANAGEMENT_TOOLS = ["list_sessions", "open_session", "close_session", "set_default_session"];

let developmentServer: ChildProcess;
let productionServer: ChildProcess;
let developmentPort = 0;
let productionPort = 0;
let fixture: Server;
let fixturePort = 0;
let sessionA = "";
let sessionB = "";
let panel: Browser;
let panelPage: Page;

const developmentBase = () => `http://127.0.0.1:${developmentPort}`;
const productionBase = () => `http://127.0.0.1:${productionPort}`;
const fixtureUrl = (path = "/") => `http://127.0.0.1:${fixturePort}${path}`;

function listen(server: Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve, reject) => probe.close(error => (error ? reject(error) : resolve())));
  return port;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Vela did not become reachable at ${url}`);
}

function startVela(port: number, environment: string, extra: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, [join(PROJECT_ROOT, ".output/server/index.mjs")], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ENVIRONMENT: environment, PORT: String(port), HOST: "127.0.0.1", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", chunk => process.stderr.write(`[vela:${environment}] ${chunk}`));
  return child;
}

/** The panel updates its own document: nothing here reloads after a submission. */
async function openPanel(): Promise<void> {
  await panelPage.goto(`${developmentBase()}/`);
  await panelPage.waitForSelector("#open-session button[type=submit]");
}

async function mainText(): Promise<string> {
  return (await panelPage.textContent("main")) ?? "";
}

/** The one outcome line: the latest submission's notice or error. */
async function panelOutcome(page: Page = panelPage): Promise<string> {
  for (const selector of [".notice", ".error"]) {
    const locator = page.locator(selector);
    if (await locator.count()) return (await locator.first().textContent()) ?? "";
  }
  return "";
}

/**
 * Waits for the outcome line to change to a message matching `pattern`, so a
 * previous submission's message is never mistaken for this one's.
 */
async function waitForOutcome(page: Page, pattern: RegExp, previous: string): Promise<string> {
  let text = "";
  await expect
    .poll(
      async () => {
        text = await panelOutcome(page);
        return text === previous ? "" : text;
      },
      { timeout: 20_000 },
    )
    .toMatch(pattern);
  return text;
}

function sessionId(message: string): string {
  const match = /[0-9a-f]{10}/.exec(message);
  if (!match) throw new Error(`no session id in: ${message}`);
  return match[0];
}

async function openSessionThroughPanel(name: string, page: Page = panelPage): Promise<string> {
  const previous = await panelOutcome(page);
  await page.fill("#session-name", name);
  await page.click("#open-session button[type=submit]");
  const message = await waitForOutcome(page, /^Opened session [0-9a-f]{10}\.$/, previous);
  const id = sessionId(message);
  await page.locator(`#default-${id}`).waitFor();
  await expect
    .poll(() => page.locator("#open-session button[type=submit]").isEnabled().catch(() => false))
    .toBe(true);
  return id;
}

async function setDefaultThroughPanel(id: string): Promise<string> {
  const previous = await panelOutcome();
  await panelPage.click(`#default-${id} button[type=submit]`);
  return await waitForOutcome(panelPage, new RegExp(`^Session ${id} is now the default\\.`), previous);
}

async function closeThroughPanel(id: string): Promise<string> {
  const previous = await panelOutcome();
  await panelPage.click(`#close-${id} button[type=submit]`);
  const message = await waitForOutcome(panelPage, new RegExp(`^Closed session ${id}`), previous);
  await panelPage.locator(`#close-${id}`).waitFor({ state: "detached" });
  return message;
}

function section(heading: string): Locator {
  return panelPage
    .locator("section")
    .filter({ has: panelPage.getByRole("heading", { name: heading, exact: true }) });
}

function trackNavigations(): { urls: string[]; stop: () => void } {
  const urls: string[] = [];
  const listener = (frame: Frame) => {
    if (frame === panelPage.mainFrame()) urls.push(frame.url());
  };
  panelPage.on("framenavigated", listener);
  return { urls, stop: () => panelPage.off("framenavigated", listener) };
}

async function connectMcp(path: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${developmentBase()}${path}`));
  const client = new Client({ name: "e2e-agent", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

interface ToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function textOf(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await call(client, name, args);
  return (result.content ?? []).map(block => block.text ?? "").join("\n");
}

function refOf(snapshot: string, pattern: RegExp): string {
  const match = pattern.exec(snapshot);
  if (!match) throw new Error(`no ref matching ${pattern} in:\n${snapshot}`);
  return match[1]!;
}

/** The tabs list renders as `- 0: (current) [title](url)`. */
async function tabUrls(client: Client): Promise<string[]> {
  const text = await textOf(client, "browser_tabs", { action: "list" });
  return [...text.matchAll(/\]\(([^)]*)\)/g)].map(match => match[1]!);
}

beforeAll(async () => {
  fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  fixturePort = await listen(fixture);

  developmentPort = await freePort();
  developmentServer = startVela(developmentPort, "development", {});
  await waitForServer(`${developmentBase()}/`);

  // A second process in production mode, to prove the boundary still exists.
  productionPort = await freePort();
  productionServer = startVela(productionPort, "production", {
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    CLOUDFLARE_ACCESS_APPLICATION_AUD: POLICY_AUD,
  });
  await waitForServer(`${productionBase()}/`);

  panel = await chromium.launch({ headless: true, chromiumSandbox: false });
  panelPage = await panel.newPage();
});

afterAll(async () => {
  await panel?.close();
  developmentServer?.kill("SIGTERM");
  productionServer?.kill("SIGTERM");
  fixture?.close();
});

describe("Vela end to end", () => {
  it("verifies Access in production and skips it in development", async () => {
    const panel = await fetch(`${productionBase()}/`);
    expect(panel.status).toBe(403);
    expect(await panel.text()).toMatch(/Missing Cloudflare Access assertion/);

    const mcp = await fetch(`${productionBase()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(mcp.status).toBe(403);

    expect((await fetch(`${developmentBase()}/`)).status).toBe(200);
  });

  it("refuses a cross-origin form post", async () => {
    const response = await fetch(`${developmentBase()}/`, {
      method: "POST",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      body: "",
    });
    expect(response.status).toBe(403);
  });

  it("opens a session in the panel without navigating", async () => {
    await openPanel();
    const navigations = trackNavigations();
    try {
      sessionA = await openSessionThroughPanel("alpha");
    } finally {
      navigations.stop();
    }
    expect(navigations.urls).toEqual([]);
    expect(panelPage.url()).toBe(`${developmentBase()}/`);

    expect(await mainText()).toContain(`/mcp/${sessionA}`);
    expect(await panelPage.locator(".notice").count()).toBe(1);
    expect(await panelPage.locator(".error").count()).toBe(0);
  });

  it("sets the default in the panel without navigating", async () => {
    const navigations = trackNavigations();
    try {
      const message = await setDefaultThroughPanel(sessionA);
      expect(message).toContain("existing connections keep their browser");
    } finally {
      navigations.stop();
    }
    expect(navigations.urls).toEqual([]);
    expect(panelPage.url()).toBe(`${developmentBase()}/`);

    const text = (await section("Default session").textContent()) ?? "";
    expect(text).toContain(sessionA);
    expect(text).toContain("new connections to");
  });

  it("keeps the hydrated document working for later submissions", async () => {
    await panelPage.reload();
    await panelPage.locator(`#default-${sessionA}`).waitFor();
    expect((await section("Default session").textContent()) ?? "").toContain(sessionA);

    sessionB = await openSessionThroughPanel("bravo");
    expect(await panelPage.locator(".notice").count()).toBe(1);
    const notice = (await panelPage.locator(".notice").textContent()) ?? "";
    expect(notice).toContain(sessionB);
    expect(notice).not.toContain(sessionA);

    const sessions = (await section("Sessions").textContent()) ?? "";
    expect(sessions).toContain(sessionA);
    expect(sessions).toContain(sessionB);
  });

  it("exposes Playwright MCP tools and no session management", async () => {
    const { client } = await connectMcp(`/mcp/${sessionA}`);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).toEqual(
      expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_tabs"]),
    );
    for (const forbidden of SESSION_MANAGEMENT_TOOLS) {
      expect(tools).not.toContain(forbidden);
    }
    await client.close();
  });

  it("drives a real Chromium through Playwright MCP", async () => {
    const { client } = await connectMcp(`/mcp/${sessionA}`);

    const navigated = await textOf(client, "browser_navigate", { url: fixtureUrl("/") });
    expect(navigated).toContain(fixtureUrl("/"));

    const snapshot = await textOf(client, "browser_snapshot");
    expect(snapshot).toContain("Hello fixture");

    const buttonRef = refOf(snapshot, /button "Click me" \[ref=(e\d+)\]/);
    await call(client, "browser_click", { element: "the Click me button", target: buttonRef });
    const afterClick = await textOf(client, "browser_snapshot");
    expect(afterClick).toContain("Clicked");

    const inputRef = refOf(afterClick, /- textbox.*\[ref=(e\d+)\]/);
    await call(client, "browser_type", { element: "the name field", target: inputRef, text: "vela" });

    const screenshot = await call(client, "browser_take_screenshot", { scale: "css" });
    const image = screenshot.content?.find(block => block.type === "image");
    expect(image).toMatchObject({ mimeType: "image/png" });
    expect((image?.data ?? "").length).toBeGreaterThan(100);

    await client.close();
  });

  it("binds each MCP session to its own browser", async () => {
    const boundToB = await connectMcp(`/mcp/${sessionB}`);
    await textOf(boundToB.client, "browser_navigate", { url: fixtureUrl("/b") });
    expect(await tabUrls(boundToB.client)).toContain(fixtureUrl("/b"));
    await boundToB.client.close();

    const boundToA = await connectMcp(`/mcp/${sessionA}`);
    const aTabs = await tabUrls(boundToA.client);
    expect(aTabs).toContain(fixtureUrl("/"));
    expect(aTabs).not.toContain(fixtureUrl("/b"));
    await boundToA.client.close();
  });

  it("routes /mcp to the default without moving bound connections", async () => {
    await setDefaultThroughPanel(sessionB);

    const onDefault = await connectMcp("/mcp");
    expect(await tabUrls(onDefault.client)).toContain(fixtureUrl("/b"));
    await onDefault.client.close();

    const stillA = await connectMcp(`/mcp/${sessionA}`);
    expect(await tabUrls(stillA.client)).toContain(fixtureUrl("/"));
    await stillA.client.close();
  });

  it("rejects an MCP session used at the wrong path", async () => {
    const { client, transport } = await connectMcp(`/mcp/${sessionA}`);
    const mcpSessionId = transport.sessionId;
    expect(mcpSessionId).toBeTruthy();

    const mismatched = await fetch(`${developmentBase()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": mcpSessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mismatched.status).toBe(400);
    expect(await mismatched.text()).toContain("already bound");
    await client.close();
  });

  it("hides browser_close from discovery on both endpoints", async () => {
    for (const path of ["/mcp", `/mcp/${sessionA}`]) {
      const { client } = await connectMcp(path);
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      expect(tools).not.toContain("browser_close");
      expect(tools).toContain("browser_navigate");
      await client.close();
    }
  });

  it("keeps the browser state after the MCP connection drops", async () => {
    const first = await connectMcp(`/mcp/${sessionB}`);
    await textOf(first.client, "browser_navigate", { url: fixtureUrl("/kept") });
    await first.transport.terminateSession();
    await first.client.close();

    const second = await connectMcp(`/mcp/${sessionB}`);
    expect(await tabUrls(second.client)).toContain(fixtureUrl("/kept"));
    await second.client.close();
  });

  it("clears the default when the default session is closed", async () => {
    // A second tab keeps a form for a session this one is about to close.
    const stalePage = await panel.newPage();
    await stalePage.goto(`${developmentBase()}/`);
    await stalePage.locator(`#close-${sessionB}`).waitFor();

    const message = await closeThroughPanel(sessionB);
    expect(message).toMatch(/default is now clear/);

    expect((await section("Default session").textContent()) ?? "").toContain("No default session is set");
    await expect(connectMcp("/mcp")).rejects.toThrow(/No default session/);

    // The stale form fails, says why, and does not block the next submission.
    const previous = await panelOutcome(stalePage);
    await stalePage.click(`#close-${sessionB} button[type=submit]`);
    const error = await waitForOutcome(
      stalePage,
      new RegExp(`^Session "${sessionB}" is closed\\.$`),
      previous,
    );
    expect(error).toContain(sessionB);
    expect(await stalePage.locator(".notice").count()).toBe(0);
    expect(await stalePage.locator(`#close-${sessionB} button[type=submit]`).isEnabled()).toBe(true);

    const opened = await openSessionThroughPanel("charlie", stalePage);
    expect(await stalePage.locator(".error").count()).toBe(0);
    expect(await stalePage.locator(".notice").count()).toBe(1);
    expect(opened).not.toBe(sessionB);
    await stalePage.close();
  });

  it("reports a session closed from the panel and refuses it afterwards", async () => {
    const { client } = await connectMcp(`/mcp/${sessionA}`);
    const message = await closeThroughPanel(sessionA);
    expect(message).toMatch(new RegExp(`^Closed session ${sessionA}\\.$`));
    expect(await mainText()).not.toContain(`/mcp/${sessionA}`);

    const afterClose = await call(client, "browser_snapshot");
    expect(afterClose.isError).toBe(true);
    await client.close();

    await expect(connectMcp(`/mcp/${sessionA}`)).rejects.toThrow(/Unknown session/);
  });
});
