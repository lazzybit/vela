import { Title } from "@solidjs/meta";
import { action, createAsync, redirect, useSearchParams, useSubmission } from "@solidjs/router";
import { For, Show, Suspense } from "solid-js";
import { panelState } from "../panel-state";
import { openSession } from "../server/sessions/core";

/** Opening lands on the new session's own page. */
const openSessionAction = action(async (form: FormData) => {
  "use server";
  const session = await openSession(form.get("name")?.toString());
  return redirect(`/sessions/${session.id}`, { revalidate: panelState.key });
}, "panel-open");

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function Panel() {
  const state = createAsync(() => panelState(), { deferStream: true });
  const [params] = useSearchParams();
  const open = useSubmission(openSessionAction);

  // An outcome from this page's own submission is newer than one a redirect
  // carried, so it wins while it exists.
  const error = () => (open.error ? errorMessage(open.error) : single(params.error));
  const notice = () => single(params.notice);

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
      <Show when={notice()} keyed>
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
                    <button type="submit" disabled={open.pending}>
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
                          <a href={`/sessions/${session.id}`}>{session.name}</a> <code>{session.id}</code>
                          <Show when={session.default}>{" — default"}</Show>
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
