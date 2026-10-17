import { Title } from "@solidjs/meta";
import { action, createAsync, json, redirect, useParams, useSubmission } from "@solidjs/router";
import { For, Show, Suspense, createEffect, createSignal, onCleanup } from "solid-js";
import { panelState, sessionPanelState } from "../../panel-state";
import { liveView } from "../../server/panel";
import { closeSession, setDefaultSession } from "../../server/sessions/core";
import type { LiveMessage } from "../../server/sessions/live";

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

const LIVE_FPS_OPTIONS = [1, 2, 5, 10];

/**
 * The live view is on demand: nothing is captured until Start, and the stream
 * ends when it is stopped, the session closes, or the capture cannot start.
 */
function LiveView(props: { sessionId: string }) {
  const [fps, setFps] = createSignal(5);
  const [running, setRunning] = createSignal(false);
  const [frame, setFrame] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("");
  const [error, setError] = createSignal("");

  createEffect(() => {
    if (!running()) return;
    const rate = fps();
    const controller = new AbortController();
    let stopped = false;
    let reader: ReadableStreamDefaultReader<LiveMessage> | null = null;

    setError("");
    setStatus("Connecting…");

    const fail = (message: string) => {
      stopped = true;
      controller.abort();
      setError(message);
      setStatus("");
      setRunning(false);
    };

    // A server reference accepts request options; aborting the request removes
    // this viewer and, when it was the last one, stops the capture.
    const start = (
      liveView as typeof liveView & {
        withOptions(options: { signal: AbortSignal }): typeof liveView;
      }
    ).withOptions({ signal: controller.signal });

    void (async () => {
      try {
        const messages = await start(props.sessionId, rate);
        reader = messages.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done || stopped) break;
          switch (value.type) {
            case "frame":
              setFrame(`data:image/jpeg;base64,${value.data}`);
              setStatus("");
              break;
            case "clear":
              setFrame(null);
              break;
            case "status":
              setStatus(value.message);
              break;
            case "error":
              throw new Error(value.message);
          }
        }
        if (!stopped) fail("The live view stopped.");
      } catch (error) {
        if (!stopped) fail(error instanceof Error ? error.message : String(error));
      }
    })();

    onCleanup(() => {
      stopped = true;
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    });
  });

  const toggle = () => {
    if (running()) {
      setRunning(false);
      setFrame(null);
      setStatus("");
      setError("");
    } else {
      setRunning(true);
    }
  };

  return (
    <section>
      <h2>Live view</h2>
      <p>
        <label for="live-fps">Frame rate</label>{" "}
        <select id="live-fps" value={String(fps())} onChange={event => setFps(Number(event.currentTarget.value))}>
          <For each={LIVE_FPS_OPTIONS}>{option => <option value={String(option)}>{option} fps</option>}</For>
        </select>{" "}
        <button type="button" id="live-toggle" onClick={toggle}>
          {running() ? "Stop live view" : "Start live view"}
        </button>
      </p>

      <Show when={error()}>{message => <p class="error" role="alert">{message()}</p>}</Show>
      <Show when={status()}>{message => <p>{message()}</p>}</Show>
      <Show when={frame()}>
        {src => <img id="live-frame" class="live" src={src()} alt="Live view of the session's active page" />}
      </Show>
      <Show when={!running() && !frame() && !error()}>
        <p>The live view is stopped. It captures the session's active page while it is open.</p>
      </Show>
    </section>
  );
}

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
        <Show when={state()}>
          {session => (
            <>
              <Title>{session().name} — Vela</Title>
              <h1>{session().name}</h1>
              <p>
                <code>{session().id}</code>
                <Show when={session().default}>{" — default"}</Show>
              </p>

              <Show when={setDefault.result} keyed>
                {outcome => <p class="notice">{outcome.message}</p>}
              </Show>

              <section>
                <h2>Session</h2>
                <p>Opened {new Date(session().createdAt).toLocaleString()}</p>
                <p>
                  MCP endpoint: <code>/mcp/{session().id}</code>
                </p>
              </section>

              <LiveView sessionId={session().id} />

              <section>
                <h2>Pages</h2>
                <Show when={session().pages.length > 0} fallback={<p>No pages are open.</p>}>
                  <ul>
                    <For each={session().pages}>
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
                    <input type="hidden" name="id" value={session().id} />
                    <button type="submit" disabled={session().default || setDefault.pending}>
                      Set as default
                    </button>
                  </form>{" "}
                  <form id="close-session" action={closeSessionAction} method="post">
                    <input type="hidden" name="id" value={session().id} />
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
