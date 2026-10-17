import type { Page } from "playwright";
import { onShutdown } from "../lifecycle";
import { registry, type VelaSession } from "./registry";

/**
 * A live view is demand-driven: it starts when the first viewer subscribes,
 * follows the page Chromium reports as visible, and stops when the last viewer
 * leaves. One screencast per session is shared by every viewer.
 */
export type LiveMessage =
  | { type: "frame"; data: string }
  | { type: "clear" }
  | { type: "status"; message: string }
  | { type: "error"; message: string };

export const DEFAULT_LIVE_FPS = 5;
export const MAX_LIVE_FPS = 30;

// The source runs as fast as Chromium delivers frames; each viewer is throttled
// on delivery, so viewers with different frame rates can share one screencast.
const CAPTURE_FPS = 30;
const CAPTURE_QUALITY = 60;

// Tab selection has no event in the Playwright API, but a background tab is
// hidden to the page itself. Polling is only active while someone is watching.
const VISIBILITY_POLL_MS = 1000;
const VISIBILITY_TIMEOUT_MS = 1000;

interface Viewer {
  readonly fps: number;
  lastFrameAt: number;
  readonly controller: ReadableStreamDefaultController<LiveMessage>;
}

export function normalizeLiveFps(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LIVE_FPS;
  return Math.min(MAX_LIVE_FPS, Math.max(1, Math.round(value)));
}

class SessionLive {
  private readonly session: VelaSession;
  private readonly viewers = new Set<Viewer>();
  private page: Page | null = null;
  private capturing = false;
  private lastStatus = "";
  private monitor: NodeJS.Timeout | null = null;
  private polling = false;
  private released = false;
  private transition: Promise<void> = Promise.resolve();
  private disposal: Promise<void> | null = null;
  private detachPage: (() => void) | null = null;

  get disposed(): boolean {
    return this.released;
  }

  get disposalDone(): Promise<void> {
    return this.disposal ?? Promise.resolve();
  }

  private readonly onContextClose = () => {
    this.fail(`Session "${this.session.id}" is closed.`);
  };

  constructor(session: VelaSession) {
    this.session = session;
    session.context.on("close", this.onContextClose);
  }

  add(viewer: Viewer): void {
    this.viewers.add(viewer);
    if (this.lastStatus) {
      this.send(viewer, { type: "status", message: this.lastStatus });
      this.send(viewer, { type: "clear" });
    }
    if (this.monitor) return;
    this.monitor = setInterval(() => void this.poll(), VISIBILITY_POLL_MS);
    void this.poll();
  }

  remove(viewer: Viewer): void {
    this.viewers.delete(viewer);
    if (this.viewers.size === 0) this.release();
  }

  async shutdown(): Promise<void> {
    this.release();
    await this.disposalDone;
  }

  /** Release a broker that never gained a viewer. */
  discard(): void {
    if (this.viewers.size === 0) this.release();
  }

  private async poll(): Promise<void> {
    if (this.released || this.polling) return;
    this.polling = true;
    try {
      const page = await this.choosePage();
      if (this.released) return;
      await this.show(page);
    } catch (error) {
      this.fail(`Live view failed: ${message(error)}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Exactly one page is visible in Chromium. Where that signal is unavailable
   * (several pages report visible, or none does) keep the page already shown,
   * then fall back to the most recently created page.
   */
  private async choosePage(): Promise<Page | null> {
    const pages = this.session.context.pages().filter(page => !page.isClosed());
    if (pages.length === 0) return null;
    // A context with one page has nothing to choose between.
    if (pages.length === 1) return pages[0] ?? null;

    const visibility = await Promise.all(
      pages.map(async page => ({ page, visible: await pageVisible(page) })),
    );
    if (this.released) return null;

    const visible = visibility.filter(entry => entry.visible).map(entry => entry.page);
    const lastVisible = visible[visible.length - 1];
    if (lastVisible) return lastVisible;
    if (this.page && pages.includes(this.page)) return this.page;
    return pages[pages.length - 1] ?? null;
  }

  private show(page: Page | null): Promise<void> {
    return this.schedule(async () => {
      if (this.released || page === this.page) return;
      await this.stopCapture();
      if (this.released) return;
      if (!page || page.isClosed()) {
        this.status("No pages are open.");
        this.clear();
        return;
      }

      this.lastStatus = "";
      this.page = page;
      const onClose = () => void this.poll();
      page.on("close", onClose);
      this.detachPage = () => page.off("close", onClose);

      try {
        await page.screencast.start({
          fps: CAPTURE_FPS,
          quality: CAPTURE_QUALITY,
          onFrame: frame => this.onFrame(page, frame),
        });
        this.capturing = true;
      } catch (error) {
        this.fail(`Live view is unavailable: ${message(error)}`);
      }
    });
  }

  private onFrame(page: Page, frame: { data: Buffer }): void {
    if (this.released || page !== this.page || !this.capturing || page.isClosed()) return;

    const now = Date.now();
    let encoded: string | null = null;
    for (const viewer of [...this.viewers]) {
      // Drop frames a viewer is not due for, or is too far behind to accept,
      // instead of queueing them.
      if (now - viewer.lastFrameAt < 1000 / viewer.fps) continue;
      if ((viewer.controller.desiredSize ?? 0) <= 0) continue;
      viewer.lastFrameAt = now;
      encoded ??= frame.data.toString("base64");
      this.send(viewer, { type: "frame", data: encoded });
    }
    if (this.viewers.size === 0) this.release();
  }

  private send(viewer: Viewer, message: LiveMessage): void {
    try {
      viewer.controller.enqueue(message);
    } catch {
      this.viewers.delete(viewer);
    }
  }

  private status(message: string): void {
    if (this.lastStatus === message) return;
    this.lastStatus = message;
    for (const viewer of [...this.viewers]) this.send(viewer, { type: "status", message });
  }

  private clear(): void {
    for (const viewer of [...this.viewers]) this.send(viewer, { type: "clear" });
  }

  private fail(message: string): void {
    if (this.released) return;
    for (const viewer of [...this.viewers]) this.send(viewer, { type: "error", message });
    this.release();
  }

  /** Give up the session quietly: no more viewers, no more capture. */
  private release(): void {
    if (this.released) return;
    this.released = true;
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = null;
    }
    this.session.context.off("close", this.onContextClose);
    for (const viewer of [...this.viewers]) {
      try {
        viewer.controller.close();
      } catch {
        // The viewer is already gone.
      }
    }
    this.viewers.clear();
    this.disposal = this.schedule(() => this.stopCapture()).then(() => {
      if (brokers.get(this.session.id) === this) brokers.delete(this.session.id);
    });
  }

  private async stopCapture(): Promise<void> {
    const page = this.page;
    const capturing = this.capturing;
    this.page = null;
    this.capturing = false;
    if (this.detachPage) {
      this.detachPage();
      this.detachPage = null;
    }
    if (!capturing || !page) return;
    try {
      // Only stop a screencast Vela started. A start that failed (for example
      // because an MCP client is recording video) leaves the capture alone.
      await page.screencast.stop();
    } catch (error) {
      console.error("vela: failed to stop the live screencast", error);
    }
  }

  private schedule(task: () => Promise<void>): Promise<void> {
    this.transition = this.transition.then(task, task).catch(error => {
      console.error("vela: live view transition failed", error);
    });
    return this.transition;
  }
}

async function pageVisible(page: Page): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      page.evaluate(() => document.visibilityState === "visible"),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), VISIBILITY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const brokers = new Map<string, SessionLive>();

async function brokerFor(session: VelaSession): Promise<SessionLive> {
  for (;;) {
    const broker = brokers.get(session.id);
    if (!broker) {
      const created = new SessionLive(session);
      brokers.set(session.id, created);
      return created;
    }
    if (!broker.disposed) return broker;
    // Wait for the old capture to finish stopping before starting another one.
    await broker.disposalDone;
  }
}

function closedStream(): ReadableStream<LiveMessage> {
  return new ReadableStream<LiveMessage>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Subscribe to one session's live view. The stream carries JPEG frames and
 * short status or error messages; frame delivery is limited to `fps` per
 * viewer while the capture itself is shared.
 */
export async function watchSession(
  session: VelaSession,
  fps: number,
  signal?: AbortSignal,
): Promise<ReadableStream<LiveMessage>> {
  if (signal?.aborted) return closedStream();

  const rate = normalizeLiveFps(fps);
  const broker = await brokerFor(session);
  let viewer: Viewer | null = null;
  let controllerRef: ReadableStreamDefaultController<LiveMessage> | null = null;
  let abortListener: (() => void) | null = null;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    if (abortListener && signal) signal.removeEventListener("abort", abortListener);
    if (viewer) broker.remove(viewer);
    if (controllerRef) {
      try {
        controllerRef.close();
      } catch {
        // The consumer is already gone.
      }
    }
  };

  return new ReadableStream<LiveMessage>({
    start(controller) {
      if (signal?.aborted) {
        broker.discard();
        controller.close();
        return;
      }
      controllerRef = controller;
      viewer = { fps: rate, lastFrameAt: 0, controller };
      broker.add(viewer);
      if (signal) {
        abortListener = () => release();
        signal.addEventListener("abort", abortListener, { once: true });
      }
    },
    cancel() {
      release();
    },
  });
}

let shutdownHooked = false;
let shuttingDown = false;

/** Subscribe by session id. Throws for unknown or closed ids. */
export async function liveSession(
  sessionId: string,
  fps: number,
  signal?: AbortSignal,
): Promise<ReadableStream<LiveMessage>> {
  if (shuttingDown) return closedStream();
  if (!shutdownHooked) {
    shutdownHooked = true;
    onShutdown(() => closeLiveViews());
  }
  return watchSession(registry().get(sessionId), fps, signal);
}

export async function closeLiveViews(): Promise<void> {
  shuttingDown = true;
  const all = [...brokers.values()];
  brokers.clear();
  await Promise.all(all.map(broker => broker.shutdown()));
}
