import { Title } from "@solidjs/meta";
import { action, createAsync, redirect, useSearchParams } from "@solidjs/router";
import { For, Show, Suspense } from "solid-js";
import { getPanelState } from "../server/panel";
import { closeSession, openSession, setDefaultSession, type SessionInfo } from "../server/sessions/core";

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function lastPageUrl(session: SessionInfo): string {
  return session.pages[session.pages.length - 1]?.url ?? "";
}

function panelFailure(error: unknown): ReturnType<typeof redirect> {
  const message = error instanceof Error ? error.message : String(error);
  return redirect(`/?error=${encodeURIComponent(message)}`);
}

const openSessionAction = action(async (form: FormData) => {
  "use server";
  try {
    const session = await openSession(form.get("name")?.toString());
    return redirect(`/?notice=${encodeURIComponent(`Opened session ${session.id}.`)}`);
  } catch (error) {
    return panelFailure(error);
  }
}, "panel-open");

const closeSessionAction = action(async (form: FormData) => {
  "use server";
  const id = form.get("id")?.toString() ?? "";
  if (!id) return panelFailure("Missing session id.");
  try {
    const { wasDefault } = await closeSession(id);
    const message = wasDefault
      ? `Closed session ${id}, which was the default. The default is now clear, so /mcp refuses new connections until one is set.`
      : `Closed session ${id}.`;
    return redirect(`/?notice=${encodeURIComponent(message)}`);
  } catch (error) {
    return panelFailure(error);
  }
}, "panel-close");

const setDefaultAction = action(async (form: FormData) => {
  "use server";
  const id = form.get("id")?.toString() ?? "";
  if (!id) return panelFailure("Missing session id.");
  try {
    await setDefaultSession(id);
    return redirect(
      `/?notice=${encodeURIComponent(`Session ${id} is now the default. New /mcp connections use it; existing connections keep their browser.`)}`,
    );
  } catch (error) {
    return panelFailure(error);
  }
}, "panel-default");

export default function Panel() {
  // The panel is a document: the server waits for the data before sending it, so
  // the page is complete without JavaScript and hydration has nothing to redo.
  const state = createAsync(() => getPanelState(), { deferStream: true });
  const [params] = useSearchParams();
  const error = () => single(params.error);
  const noticeMessage = () => single(params.notice);

  return (
    <main>
      <Title>Vela</Title>
      <h1>Vela</h1>
      <p>A remote browser for one person and their agents.</p>

      <Show when={error()} keyed>
        {message => (
          <p class="error" role="alert">
            {message}
          </p>
        )}
      </Show>
      <Show when={noticeMessage()} keyed>
        {message => <p class="notice">{message}</p>}
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
                <form id="open-session" action={openSessionAction} method="post">
                  <p>
                    <label for="session-name">Name</label>{" "}
                    <input id="session-name" name="name" type="text" autocomplete="off" />
                  </p>
                  <p>
                    <button type="submit">Open session</button>
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
                          <p>
                            <form id={`default-${session.id}`} action={setDefaultAction} method="post">
                              <input type="hidden" name="id" value={session.id} />
                              <button type="submit" disabled={session.default}>
                                Set as default
                              </button>
                            </form>{" "}
                            <form id={`close-${session.id}`} action={closeSessionAction} method="post">
                              <input type="hidden" name="id" value={session.id} />
                              <button type="submit">Close</button>
                            </form>
                          </p>
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
