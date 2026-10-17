import { query, redirect } from "@solidjs/router";
import { getPanelState, getSessionPanelState } from "./server/panel";

/**
 * Panel data is a router query, so a submission revalidates it by key and the
 * page refreshes in place instead of the browser going back through the URL.
 */
export const panelState = query(getPanelState, "panel-state");

/**
 * One session's panel data. A session the registry does not know, or knows as
 * closed, sends the visitor home carrying the registry's own explanation.
 */
export const sessionPanelState = query(async (id: string) => {
  const state = await getSessionPanelState(id);
  if ("error" in state) throw redirect(`/?error=${encodeURIComponent(state.error)}`);
  return state.session;
}, "session-panel-state");
