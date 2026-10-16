import type { APIEvent } from "@solidjs/start/server";
import { handleMcpRequest } from "../server/mcp/transports";

/** `/mcp` is the default session, resolved once at initialize. */
function handle(event: APIEvent): Promise<Response> {
  return handleMcpRequest(event.request, null);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
