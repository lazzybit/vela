import "server-only";
import { createConnection } from "@playwright/mcp";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { registry } from "../sessions/registry";

/**
 * What an MCP transport is bound to. Binding happens once, at `initialize`, and
 * is never resolved again. Changing the default session affects new connections
 * only; an agent mid-flight is never moved to another browser.
 */
export interface McpBinding {
  readonly kind: "default" | "specific";
  readonly sessionId: string;
  readonly path: string;
}

/**
 * The MCP face is Playwright MCP: its tools, its schemas, its snapshots. Vela
 * only decides which `BrowserContext` those tools may use, and it always comes
 * from the session captured at `initialize` — never from the current default,
 * and never from a browser Vela launches here.
 *
 * `sharedBrowserContext` tells Playwright MCP the context belongs to someone
 * else: `browser_close` refuses to close it, and transport cleanup leaves it
 * alone.
 */
export async function createVelaMcpServer(binding: McpBinding): Promise<Server> {
  return createConnection({ sharedBrowserContext: true }, async () => registry().get(binding.sessionId).context);
}
