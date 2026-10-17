import { Title } from "@solidjs/meta";
import { action, createAsync, json, redirect, useParams, useSubmission } from "@solidjs/router";
import { For, Show, Suspense } from "solid-js";
import { panelState, sessionPanelState } from "../../panel-state";
import { closeSession, setDefaultSession } from "../../server/sessions/core";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed session action means this page's session is gone, so go home. */
function panelFailure(error: unknown): ReturnType<typeof redirect> {
  return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`, {
    revalidate: [panelState.key, sessionPanelState.key],
  });
}

/** Closing returns to the list, which is where a closed session no longer is. */
const closeSessionAction = action(async (form: FormData) => {
  "use server";
  const id = form.get("id")?.toString() ?? "";
  if (!id) return panelFailure("Missing session id.");
  try {
    const { wasDefault } = await closeSession(id);
    const message = wasDefault
      ? `Closed session ${id}, which was the default. The default is now clear, so /mcp refuses new connections until one is set.`
      : `Closed session ${id}.`;
    return redirect(`/?notice=${encodeURIComponent(message)}`, {
      revalidate: [panelState.key, sessionPanelState.key],
    });
  } catch (error) {
    return panelFailure(error);
  }
}, "panel-close");

/** Setting the default stays here, so the page and the list refresh in place. */
const setDefaultAction = action(async (form: FormData) => {
  "use server";
  const id = form.get("id")?.toString() ?? "";
  if (!id) return panelFailure("Missing session id.");
  try {
    await setDefaultSession(id);
  } catch (error) {
    return panelFailure(error);
  }
  return json(
    { message: `Session ${id} is now the default. New /mcp connections use it; existing connections keep their browser.` },
    { revalidate: [panelState.key, sessionPanelState.key] },
  );
}, "panel-default");

export default function SessionPanel() {
  const params = useParams();
  const state = createAsync(() => sessionPanelState(params.id ?? ""), { deferStream: true });
  const setDefault = useSubmission(setDefaultAction);
  const close = useSubmission(closeSessionAction);

  return (
    <main>
      <p>
        <a href="/">All sessions</a>
      </p>

      <Suspense fallback={<p>Loading session…</p>}>
        <Show when={state()} keyed>
          {session => (
            <>
              <Title>{session.name} — Vela</Title>
              <h1>{session.name}</h1>
              <p>
                <code>{session.id}</code>
                <Show when={session.default}>{" — default"}</Show>
              </p>

              <Show when={setDefault.result} keyed>
                {outcome => <p class="notice">{outcome.message}</p>}
              </Show>

              <section>
                <h2>Session</h2>
                <p>Opened {new Date(session.createdAt).toLocaleString()}</p>
                <p>
                  MCP endpoint: <code>/mcp/{session.id}</code>
                </p>
              </section>

              <section>
                <h2>Pages</h2>
                <Show when={session.pages.length > 0} fallback={<p>No pages are open.</p>}>
                  <ul>
                    <For each={session.pages}>
                      {page => (
                        <li>
                          <code>{page.url || "(blank)"}</code>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>

              <section>
                <h2>Actions</h2>
                <div>
                  <form id="set-default" action={setDefaultAction} method="post">
                    <input type="hidden" name="id" value={session.id} />
                    <button type="submit" disabled={session.default || setDefault.pending}>
                      Set as default
                    </button>
                  </form>{" "}
                  <form id="close-session" action={closeSessionAction} method="post">
                    <input type="hidden" name="id" value={session.id} />
                    <button type="submit" disabled={close.pending}>
                      Close
                    </button>
                  </form>
                </div>
              </section>
            </>
          )}
        </Show>
      </Suspense>
    </main>
  );
}
