import { registry, type SessionInfo } from "./registry";

export type { SessionInfo } from "./registry";

/**
 * The management core. Opening, listing, closing and setting the default
 * session live here and nowhere else. The MCP face and the panel face are both
 * thin adapters over these functions.
 */

export async function openSession(name?: string): Promise<SessionInfo> {
  return registry().open(name);
}

export async function listSessions(): Promise<{ defaultId: string | null; sessions: SessionInfo[] }> {
  const sessions = registry();
  return { defaultId: sessions.defaultId(), sessions: await sessions.list() };
}

export async function getSession(id: string): Promise<SessionInfo> {
  return registry().info(id);
}

export async function closeSession(id: string): Promise<{ id: string; wasDefault: boolean }> {
  return registry().close(id);
}

export async function setDefaultSession(id: string): Promise<SessionInfo> {
  return registry().setDefault(id);
}

export function defaultSessionId(): string | null {
  return registry().defaultId();
}

export function sessionExists(id: string): boolean {
  return registry().has(id);
}
