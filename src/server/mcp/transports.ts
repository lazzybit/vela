import "server-only";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { onShutdown } from "../lifecycle";
import { defaultSessionId, sessionExists } from "../sessions/core";
import { createVelaMcpServer, type McpBinding } from "./server";

export const MCP_SESSION_HEADER = "mcp-session-id";

interface TransportRecord {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: Server;
  readonly binding: McpBinding;
}

/**
 * MCP transports, keyed by MCP session id. This map is connection state. It has
 * no relationship to the browser sessions in the registry: closing an MCP
 * session never closes a browser.
 */
const transports = new Map<string, TransportRecord>();

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bindingForPath(pathSessionId: string | null): McpBinding | Response {
  if (pathSessionId === null) {
    const id = defaultSessionId();
    if (!id) {
      return jsonRpcError(
        409,
        -32000,
        "No default session is set. Open a session and set it as default, or connect to /mcp/<session-id>.",
      );
    }
    return { kind: "default", sessionId: id, path: "/mcp" };
  }
  if (!sessionExists(pathSessionId)) {
    // Unknown or already closed: refuse explicitly, never reassign.
    return jsonRpcError(404, -32000, `Unknown session "${pathSessionId}".`);
  }
  return { kind: "specific", sessionId: pathSessionId, path: `/mcp/${pathSessionId}` };
}

function pathMatchesBinding(binding: McpBinding, pathSessionId: string | null): boolean {
  return binding.kind === "default" ? pathSessionId === null : pathSessionId === binding.sessionId;
}

function mismatchMessage(binding: McpBinding, pathSessionId: string | null): string {
  const target = pathSessionId === null ? "/mcp" : `/mcp/${pathSessionId}`;
  return `This MCP session is already bound to ${binding.path}. It cannot be used at ${target}.`;
}

function isInitializeBody(body: unknown): boolean {
  return isInitializeRequest(body);
}

/**
 * Serve one MCP HTTP request.
 *
 * `pathSessionId` is the id from `/mcp/{id}`, or `null` for `/mcp`. The path is
 * only an identifier: it selects a target, it never grants access. Access has
 * already authenticated the request before this runs.
 */
export async function handleMcpRequest(request: Request, pathSessionId: string | null): Promise<Response> {
  let body: unknown;
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(400, -32700, "Parse error: request body is not valid JSON.");
    }
  }

  const mcpSessionId = request.headers.get(MCP_SESSION_HEADER);
  if (mcpSessionId) {
    const record = transports.get(mcpSessionId);
    if (!record) {
      return jsonRpcError(404, -32001, `Unknown MCP session "${mcpSessionId}".`);
    }
    if (!pathMatchesBinding(record.binding, pathSessionId)) {
      return jsonRpcError(400, -32600, mismatchMessage(record.binding, pathSessionId));
    }
    return record.transport.handleRequest(request, body === undefined ? undefined : { parsedBody: body });
  }

  // No MCP session header: only `initialize` may start one.
  if (!isInitializeBody(body)) {
    return jsonRpcError(400, -32600, `Missing ${MCP_SESSION_HEADER} header. Only initialize may open a session.`);
  }

  const binding = bindingForPath(pathSessionId);
  if (binding instanceof Response) return binding;

  const server = await createVelaMcpServer(binding);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: mcpSessionId => {
      transports.set(mcpSessionId, { transport, server, binding });
    },
    onsessionclosed: mcpSessionId => {
      transports.delete(mcpSessionId);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
    void server.close().catch(() => undefined);
  };
  await server.connect(transport);

  const response = await transport.handleRequest(request, body === undefined ? undefined : { parsedBody: body });
  if (!transport.sessionId) {
    // Initialization failed; nothing is registered and the transport is done.
    transport.onclose = undefined;
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
  return response;
}

export async function closeMcpTransports(): Promise<void> {
  const records = [...transports.values()];
  transports.clear();
  await Promise.all(
    records.map(record =>
      record.transport.close().catch(error => {
        console.error("vela: failed to close an MCP transport", error);
      }),
    ),
  );
}

onShutdown(() => closeMcpTransports());
