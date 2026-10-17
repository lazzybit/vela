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
    <div id="motion"></div>
    <style>
      #motion { width: 24px; height: 24px; margin-top: 1rem; background: #333; animation: motion 1s infinite alternate; }
      @keyframes motion { to { transform: translateX(80px); background: #e33; } }
    </style>
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

/** The panel's pages are documents: only opening and closing change the URL. */
async function openPanel(page: Page = panelPage): Promise<void> {
  await page.goto(`${developmentBase()}/`);
  await page.waitForSelector("#open-session button[type=submit]");
}

async function goToSession(id: string, page: Page = panelPage): Promise<void> {
  await page.goto(`${developmentBase()}/sessions/${id}`);
  await page.locator("#close-session button[type=submit]").waitFor();
}

async function mainText(page: Page = panelPage): Promise<string> {
  return (await page.textContent("main")) ?? "";
}

/** The one outcome line on the page: the latest submission's notice or error. */
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

function sessionIdFromUrl(url: string): string {
  const match = /\/sessions\/([0-9a-f]{10})$/.exec(new URL(url).pathname);
  if (!match) throw new Error(`no session id in: ${url}`);
  return match[1]!;
}

/** Opening from the home page lands on the new session's own page. */
async function openSessionThroughPanel(name: string, page: Page = panelPage): Promise<string> {
  await page.fill("#session-name", name);
  await page.click("#open-session button[type=submit]");
  await page.waitForURL(/\/sessions\/[0-9a-f]{10}$/);
  const id = sessionIdFromUrl(page.url());
  await page.locator("#close-session button[type=submit]").waitFor();
  return id;
}

/** The session page is the only place with these forms, so it supplies the id. */
async function setDefaultThroughPanel(page: Page = panelPage): Promise<string> {
  const id = sessionIdFromUrl(page.url());
  const previous = await panelOutcome(page);
  await page.click("#set-default button[type=submit]");
  const message = await waitForOutcome(page, new RegExp(`^Session ${id} is now the default\\.`), previous);
  await expect.poll(() => page.locator("#set-default button[type=submit]").isDisabled()).toBe(true);
  return message;
}

async function closeThroughPanel(page: Page = panelPage): Promise<string> {
  const previous = await panelOutcome(page);
  await page.click("#close-session button[type=submit]");
  await page.waitForURL(/\/\?(?:notice|error)=/);
  return await waitForOutcome(page, /./, previous);
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

  it("opens a session onto its own page", async () => {
    await openPanel();
    sessionA = await openSessionThroughPanel("alpha");

    expect(panelPage.url()).toBe(`${developmentBase()}/sessions/${sessionA}`);
    const text = await mainText();
    expect(text).toContain("alpha");
    expect(text).toContain(sessionA);
    expect(text).toContain(`/mcp/${sessionA}`);
    expect(text).toContain("Opened");
    expect(await panelPage.locator(".notice").count()).toBe(0);
    expect(await panelPage.locator(".error").count()).toBe(0);
  });

  it("sets the default on the session's page without navigating", async () => {
    const navigations = trackNavigations();
    try {
      const message = await setDefaultThroughPanel();
      expect(message).toContain("existing connections keep their browser");
    } finally {
      navigations.stop();
    }
    expect(navigations.urls).toEqual([]);
    expect(panelPage.url()).toBe(`${developmentBase()}/sessions/${sessionA}`);
    expect(await mainText()).toContain(`${sessionA} — default`);
  });

  it("keeps the hydrated document working for later submissions", async () => {
    await panelPage.getByRole("link", { name: "All sessions" }).click();
    await panelPage.waitForSelector("#open-session button[type=submit]");
    expect((await section("Default session").textContent()) ?? "").toContain(sessionA);

    await panelPage.reload();
    await panelPage.waitForSelector("#open-session button[type=submit]");
    expect((await section("Default session").textContent()) ?? "").toContain(sessionA);

    sessionB = await openSessionThroughPanel("bravo");
    expect(panelPage.url()).toBe(`${developmentBase()}/sessions/${sessionB}`);
    expect(await panelPage.locator(".error").count()).toBe(0);

    await panelPage.getByRole("link", { name: "All sessions" }).click();
    await panelPage.waitForSelector("#open-session button[type=submit]");
    const sessions = (await section("Sessions").textContent()) ?? "";
    expect(sessions).toContain(sessionA);
    expect(sessions).toContain(sessionB);
    expect(sessions).toContain("default");
    expect(await panelPage.locator("section li form").count()).toBe(0);
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

  it("lists a session's pages on its page", async () => {
    await goToSession(sessionA);
    const pages = (await section("Pages").textContent()) ?? "";
    expect(pages).toContain(fixtureUrl("/"));
  });

  it("streams a live view of the session's active page", async () => {
    await goToSession(sessionA);
    const frame = panelPage.locator("#live-frame");

    await panelPage.click("#live-toggle");
    await frame.waitFor();
    await expect
      .poll(async () => (await frame.getAttribute("src")) ?? "")
      .toMatch(/^data:image\/jpeg;base64,/);
    await expect
      .poll(() =>
        frame.evaluate(
          image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);

    // Changing the rate replaces the stream without stopping the view. The
    // fixture animates, so a later frame proves the new stream is delivering.
    await panelPage.selectOption("#live-fps", "1");
    await panelPage.waitForTimeout(2500);
    const settled = await frame.getAttribute("src");
    await expect
      .poll(async () => (await frame.getAttribute("src")) ?? "", { timeout: 10_000 })
      .not.toBe(settled);

    await panelPage.click("#live-toggle");
    await expect.poll(() => panelPage.locator("#live-frame").count()).toBe(0);
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
    await goToSession(sessionB);
    await setDefaultThroughPanel();

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
    // A second tab keeps a session page for a session this one is about to close.
    const stalePage = await panel.newPage();
    await goToSession(sessionB, stalePage);

    // The panel page is still on session B's page from the previous test.
    const message = await closeThroughPanel();
    expect(message).toMatch(/default is now clear/);

    await expect
      .poll(async () => (await section("Default session").textContent()) ?? "")
      .toContain("No default session is set");
    await expect(connectMcp("/mcp")).rejects.toThrow(/No default session/);

    // The stale page's action fails, says why, and sends the tab home.
    const previous = await panelOutcome(stalePage);
    await stalePage.click("#close-session button[type=submit]");
    await stalePage.waitForURL(/\/\?error=/);
    const error = await waitForOutcome(
      stalePage,
      new RegExp(`^Session "${sessionB}" is closed\\.$`),
      previous,
    );
    expect(error).toContain(sessionB);
    expect(await stalePage.locator(".notice").count()).toBe(0);

    const opened = await openSessionThroughPanel("charlie", stalePage);
    expect(opened).not.toBe(sessionB);
    expect(stalePage.url()).toBe(`${developmentBase()}/sessions/${opened}`);
    expect(await stalePage.locator(".error").count()).toBe(0);
    await stalePage.close();
  });

  it("reports a session closed from the panel and refuses it afterwards", async () => {
    const { client } = await connectMcp(`/mcp/${sessionA}`);
    await goToSession(sessionA);
    const message = await closeThroughPanel();
    expect(message).toMatch(new RegExp(`^Closed session ${sessionA}\\.$`));
    await expect
      .poll(async () => (await section("Sessions").textContent()) ?? "")
      .toContain("charlie");
    await expect.poll(() => panelPage.locator(`a[href="/sessions/${sessionA}"]`).count()).toBe(0);

    const afterClose = await call(client, "browser_snapshot");
    expect(afterClose.isError).toBe(true);
    await client.close();

    await expect(connectMcp(`/mcp/${sessionA}`)).rejects.toThrow(/Unknown session/);
  });

  it("sends an unknown session id home with an error", async () => {
    await panelPage.goto(`${developmentBase()}/sessions/0000000000`);
    await panelPage.waitForURL(/\/\?error=/);
    await expect.poll(() => panelOutcome()).toContain('Unknown session "0000000000"');
  });

  it("sends a closed session id home with an error", async () => {
    await panelPage.goto(`${developmentBase()}/sessions/${sessionA}`);
    await panelPage.waitForURL(/\/\?error=/);
    await expect.poll(() => panelOutcome()).toContain(`Session "${sessionA}" is closed.`);
  });
});
