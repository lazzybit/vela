"use server";
import { getRequestEvent } from "solid-js/web";
import type { Identity } from "./access";
import { listSessions, type SessionInfo } from "./sessions/core";

export interface PanelState {
  defaultId: string | null;
  sessions: SessionInfo[];
  identity: Identity | null;
}

/**
 * The panel face. It reads the management core directly; it does not go through
 * the MCP face, and it does not reimplement anything the core already does.
 */
export async function getPanelState(): Promise<PanelState> {
  const event = getRequestEvent();
  const identity = event?.locals.identity ?? null;
  const { defaultId, sessions } = await listSessions();
  return { defaultId, sessions, identity };
}
