"use server";
import { getRequestEvent } from "solid-js/web";
import type { Identity } from "./access";
import { getSession, listSessions, type SessionInfo } from "./sessions/core";
import { SessionClosedError, UnknownSessionError } from "./sessions/registry";

export interface PanelState {
  defaultId: string | null;
  sessions: SessionInfo[];
  identity: Identity | null;
}

/** A session page either has its session or the registry's reason it cannot. */
export type SessionPanelState = { session: SessionInfo } | { error: string };

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

/**
 * One session, or the reason the registry cannot describe it. Only the two
 * session lookup failures become an error result; anything else is a real
 * failure and is left to surface as one.
 */
export async function getSessionPanelState(id: string): Promise<SessionPanelState> {
  try {
    return { session: await getSession(id) };
  } catch (error) {
    if (error instanceof UnknownSessionError || error instanceof SessionClosedError) {
      return { error: error.message };
    }
    throw error;
  }
}
