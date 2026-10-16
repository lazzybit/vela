import type { APIEvent } from "@solidjs/start/server";
import { handleMcpRequest } from "../../server/mcp/transports";

/** `/mcp/{id}` is one specific session. The id identifies a target, never a grant. */
function handle(event: APIEvent): Promise<Response> {
  return handleMcpRequest(event.request, event.params.id ?? null);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
