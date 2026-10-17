import { Title } from "@solidjs/meta";
import { action, createAsync, json, query, useSubmission } from "@solidjs/router";
import { For, Show, Suspense, createSignal } from "solid-js";
import { getPanelState } from "../server/panel";
import { closeSession, openSession, setDefaultSession, type SessionInfo } from "../server/sessions/core";

/**
 * Panel data is a router query, so a submission revalidates it by key and the
 * list refreshes in place instead of the browser going back through the URL.
 */
const panelState = query(getPanelState, "panel-state");

interface PanelOutcome {
  message: string;
}

interface PanelSubmission {
  readonly result?: PanelOutcome;
  readonly error: any;
  readonly pending: boolean | undefined;
}

type PanelCommand = "open" | "default" | "close";

function lastPageUrl(session: SessionInfo): string {
  return session.pages[session.pages.length - 1]?.url ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const openSessionAction = action(async (form: FormData) => {
  "use server";
  const session = await openSession(form.get("name")?.toString());
  return json({ message: `Opened session ${session.id}.` }, { revalidate: panelState.key });
}, "panel-open");

const closeSessionAction = action(async (form: FormData) => {
  "use server";
  const id = form.get("id")?.toString() ?? "";
  if (!id) throw new Error("Missing session id.");
  const { wasDefault } = await closeSession(id);
  const message = wasDefault
    ? `Closed session ${id}, which was the default. The default is now clear, so /mcp refuses new connections until one is set.`
    : `Closed session ${id}.`;
  return json({ message }, { revalidate: panelState.key });
}, "panel-close");

const setDefaultAction = action(async (form: FormData) => {
  "use server";
  const id = form.get("id")?.toString() ?? "";
  if (!id) throw new Error("Missing session id.");
  await setDefaultSession(id);
  return json(
    { message: `Session ${id} is now the default. New /mcp connections use it; existing connections keep their browser.` },
    { revalidate: panelState.key },
  );
}, "panel-default");

export default function Panel() {
  const state = createAsync(() => panelState(), { deferStream: true });

  // The three forms report through one line, so that an older action's outcome
  // is not left on screen as if it described the submission just made.
  const submissions: Record<PanelCommand, PanelSubmission> = {
    open: useSubmission(openSessionAction),
    default: useSubmission(setDefaultAction),
    close: useSubmission(closeSessionAction),
  };
  const [command, setCommand] = createSignal<PanelCommand | null>(null);
  const submission = () => {
    const submitted = command();
    return submitted ? submissions[submitted] : undefined;
  };

  return (
    <main>
      <Title>Vela</Title>
      <h1>Vela</h1>
      <p>A remote browser for one person and their agents.</p>

      <Show when={submission()?.error} keyed>
        {error => (
          <p class="error" role="alert">
            {errorMessage(error)}
          </p>
        )}
      </Show>
      <Show when={submission()?.result} keyed>
        {outcome => <p class="notice">{outcome.message}</p>}
      </Show>

      <Suspense fallback={<p>Loading sessions…</p>}>
        <Show when={state()} keyed>
          {data => (
            <>
              <section>
                <h2>Identity</h2>
                <p>{data.identity ? (data.identity.email ?? data.identity.subject) : "unknown"}</p>
              </section>

              <section>
                <h2>Default session</h2>
                <Show
                  when={data.defaultId}
                  fallback={
                    <p>
                      No default session is set. <code>/mcp</code> refuses new connections until one is set.
                    </p>
                  }
                  keyed
                >
                  {id => (
                    <p>
                      <code>{id}</code> — new connections to <code>/mcp</code> use this browser.
                    </p>
                  )}
                </Show>
              </section>

              <section>
                <h2>Open a session</h2>
                <form id="open-session" action={openSessionAction} method="post" onSubmit={() => setCommand("open")}>
                  <p>
                    <label for="session-name">Name</label>{" "}
                    <input id="session-name" name="name" type="text" autocomplete="off" />
                  </p>
                  <p>
                    <button type="submit" disabled={submissions.open.pending}>
                      Open session
                    </button>
                  </p>
                </form>
              </section>

              <section>
                <h2>Sessions</h2>
                <Show when={data.sessions.length > 0} fallback={<p>No browser sessions are open.</p>}>
                  <ul>
                    <For each={data.sessions}>
                      {session => (
                        <li>
                          <h3>
                            {session.name} <code>{session.id}</code>
                            <Show when={session.default}> — default</Show>
                          </h3>
                          <p>
                            {session.title ?? "(no title)"} — <code>{lastPageUrl(session) || "(blank)"}</code>
                          </p>
                          <p>
                            {session.pages.length} page{session.pages.length === 1 ? "" : "s"}, opened{" "}
                            {new Date(session.createdAt).toLocaleString()}
                          </p>
                          <p>
                            MCP endpoint: <code>/mcp/{session.id}</code>
                          </p>
                          <div>
                            <form
                              id={`default-${session.id}`}
                              action={setDefaultAction}
                              method="post"
                              onSubmit={() => setCommand("default")}
                            >
                              <input type="hidden" name="id" value={session.id} />
                              <button type="submit" disabled={session.default || submissions.default.pending}>
                                Set as default
                              </button>
                            </form>{" "}
                            <form
                              id={`close-${session.id}`}
                              action={closeSessionAction}
                              method="post"
                              onSubmit={() => setCommand("close")}
                            >
                              <input type="hidden" name="id" value={session.id} />
                              <button type="submit" disabled={submissions.close.pending}>
                                Close
                              </button>
                            </form>
                          </div>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            </>
          )}
        </Show>
      </Suspense>
    </main>
  );
}
