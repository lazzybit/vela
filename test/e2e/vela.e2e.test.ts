import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEAM_DOMAIN = "https://vela-e2e.cloudflareaccess.com";
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

/** The panel is driven as a document with JavaScript disabled. */
async function openPanel(): Promise<void> {
  await panelPage.goto(`${developmentBase()}/`, { waitUntil: "load" });
}

async function panelText(): Promise<string> {
  await openPanel();
  return (await panelPage.textContent("main")) ?? "";
}

async function openSessionThroughPanel(name: string): Promise<string> {
  await openPanel();
  await panelPage.fill("#session-name", name);
  await panelPage.click("#open-session button[type=submit]");
  await panelPage.waitForURL(/notice=/);
  const text = (await panelPage.textContent(".notice")) ?? "";
  const match = /Opened session ([0-9a-f]{10})/.exec(text);
  if (!match) throw new Error(`no session id in notice: ${text}`);
  return match[1]!;
}

async function setDefaultThroughPanel(id: string): Promise<void> {
  await openPanel();
  await panelPage.click(`#default-${id} button[type=submit]`);
  await panelPage.waitForURL(/notice=/);
}

async function closeThroughPanel(id: string): Promise<string> {
  await openPanel();
  await panelPage.click(`#close-${id} button[type=submit]`);
  await panelPage.waitForURL(/notice=/);
  return (await panelPage.textContent(".notice")) ?? "";
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
    VELA_TEAM_DOMAIN: TEAM_DOMAIN,
    VELA_POLICY_AUD: POLICY_AUD,
  });
  await waitForServer(`${productionBase()}/`);

  panel = await chromium.launch({ headless: true, chromiumSandbox: false });
  panelPage = await panel.newPage({ javaScriptEnabled: false });
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

  it("opens a session from the panel document", async () => {
    sessionA = await openSessionThroughPanel("alpha");
    const text = await panelText();
    expect(text).toContain("Vela");
    expect(text).toContain(sessionA);
    expect(text).toContain(`/mcp/${sessionA}`);
  });

  it("sets the default from the panel document", async () => {
    await setDefaultThroughPanel(sessionA);
    expect(await panelText()).toContain("new connections to");
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
    sessionB = await openSessionThroughPanel("bravo");

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

  it("refuses browser_close because the context belongs to Vela", async () => {
    const { client } = await connectMcp(`/mcp/${sessionA}`);
    const result = await call(client, "browser_close");
    expect(result.isError).toBe(true);
    expect(result.content?.map(block => block.text).join("\n")).toMatch(/shared/);
    await client.close();
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

  it("reports a session closed from the panel and refuses it afterwards", async () => {
    const { client } = await connectMcp(`/mcp/${sessionA}`);
    await closeThroughPanel(sessionA);

    const afterClose = await call(client, "browser_snapshot");
    expect(afterClose.isError).toBe(true);
    await client.close();

    await expect(connectMcp(`/mcp/${sessionA}`)).rejects.toThrow(/Unknown session/);
  });

  it("clears the default when the default session is closed", async () => {
    const message = await closeThroughPanel(sessionB);
    expect(message).toMatch(/default is now clear/);
    expect(await panelText()).toContain("No default session is set");
    await expect(connectMcp("/mcp")).rejects.toThrow(/No default session/);
  });
});
