import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionRegistry,
  type SessionRegistry,
  type VelaSession,
} from "../src/server/sessions/registry";
import {
  normalizeLiveFps,
  watchSession,
  type LiveMessage,
} from "../src/server/sessions/live";
import { FakeBrowser, FakePage } from "./support/fake-browser";

interface Collected {
  messages: LiveMessage[];
  done: Promise<void>;
  cancel: () => Promise<void>;
}

function collect(stream: ReadableStream<LiveMessage>): Collected {
  const messages: LiveMessage[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) return;
        if (value) messages.push(value);
      }
    } catch {
      // The consumer canceled the stream.
    }
  })();
  return { messages, done, cancel: () => reader.cancel() };
}

describe("live view", () => {
  let fake: FakeBrowser;
  let sessions: SessionRegistry;

  beforeEach(() => {
    fake = new FakeBrowser();
    sessions = createSessionRegistry(async () => fake.asBrowser());
  });

  afterEach(async () => {
    await sessions.closeAll();
  });

  async function setup(): Promise<{ session: VelaSession; page: FakePage }> {
    const info = await sessions.open("live");
    const session = sessions.get(info.id);
    const page = session.context.pages()[0] as unknown as FakePage;
    return { session, page };
  }

  it("starts a capture on the visible page and delivers frames", async () => {
    const { session, page } = await setup();
    const live = collect(await watchSession(session, 5));

    await expect.poll(() => page.screencastIsRunning).toBe(true);
    page.emitFrame("first");

    await expect.poll(() => live.messages.length).toBe(1);
    expect(live.messages[0]).toEqual({ type: "frame", data: Buffer.from("first").toString("base64") });

    await live.cancel();
    await expect.poll(() => page.screencastIsRunning).toBe(false);
  });

  it("shares one capture and stops it when the last viewer leaves", async () => {
    const { session, page } = await setup();
    const first = collect(await watchSession(session, 5));
    const second = collect(await watchSession(session, 5));

    await expect.poll(() => page.screencastIsRunning).toBe(true);
    expect(page.screencastStarts).toBe(1);

    await first.cancel();
    expect(page.screencastIsRunning).toBe(true);

    await second.cancel();
    await expect.poll(() => page.screencastIsRunning).toBe(false);
    expect(page.screencastStops).toBe(1);
  });

  it("limits delivery to each viewer's frame rate", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      const { session, page } = await setup();
      const live = collect(await watchSession(session, 2));
      await expect.poll(() => page.screencastIsRunning).toBe(true);

      page.emitFrame("first");
      await expect.poll(() => live.messages.length).toBe(1);

      vi.setSystemTime(1_000_100);
      page.emitFrame("too soon");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(live.messages).toHaveLength(1);

      vi.setSystemTime(1_000_600);
      page.emitFrame("due");
      await expect.poll(() => live.messages.length).toBe(2);

      expect(live.messages[1]).toEqual({ type: "frame", data: Buffer.from("due").toString("base64") });
      await live.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows the page Chromium reports as visible", async () => {
    const { session, page } = await setup();
    const second = (await session.context.newPage()) as unknown as FakePage;
    second.visibilityState = "hidden";

    const live = collect(await watchSession(session, 5));
    await expect.poll(() => page.screencastIsRunning).toBe(true);

    page.visibilityState = "hidden";
    second.visibilityState = "visible";

    await expect.poll(() => second.screencastIsRunning, { timeout: 5_000 }).toBe(true);
    expect(page.screencastIsRunning).toBe(false);

    second.emitFrame("second");
    await expect.poll(() => live.messages.some(message => message.type === "frame")).toBe(true);

    await live.cancel();
  });

  it("falls back to the most recent page when none reports visible", async () => {
    const { session, page } = await setup();
    page.visibilityState = "hidden";
    const second = (await session.context.newPage()) as unknown as FakePage;
    second.visibilityState = "hidden";

    const live = collect(await watchSession(session, 5));
    await expect.poll(() => second.screencastIsRunning).toBe(true);
    expect(page.screencastIsRunning).toBe(false);

    await live.cancel();
  });

  it("announces an empty session and clears the view", async () => {
    const { session, page } = await setup();
    const first = collect(await watchSession(session, 5));
    await expect.poll(() => page.screencastIsRunning).toBe(true);

    page.closeSync();
    await expect
      .poll(() => first.messages.some(message => message.type === "status" && message.message === "No pages are open."))
      .toBe(true);
    await expect.poll(() => first.messages.some(message => message.type === "clear")).toBe(true);
    await expect.poll(() => page.screencastIsRunning).toBe(false);

    // A viewer that joins later hears the same state.
    const second = collect(await watchSession(session, 5));
    await expect.poll(() => second.messages.some(message => message.type === "status")).toBe(true);
    expect(second.messages.some(message => message.type === "clear")).toBe(true);

    await first.cancel();
    await second.cancel();
  });

  it("reports a capture that cannot start and stops", async () => {
    const { session, page } = await setup();
    page.failScreencastStart = true;

    const live = collect(await watchSession(session, 5));
    await expect.poll(() => live.messages.find(message => message.type === "error")).toBeTruthy();
    await live.done;

    const error = live.messages.find(message => message.type === "error");
    expect(error).toMatchObject({ type: "error" });
    expect(error && "message" in error ? error.message : "").toContain("Screencast is already started");
    expect(page.screencastIsRunning).toBe(false);
  });

  it("ends the view when the session's context closes", async () => {
    const { session } = await setup();
    const live = collect(await watchSession(session, 5));
    const page = session.context.pages()[0] as unknown as FakePage;
    await expect.poll(() => page.screencastIsRunning).toBe(true);

    await sessions.close(session.id);
    await live.done;

    expect(live.messages.some(message => message.type === "error")).toBe(true);
    expect(page.screencastIsRunning).toBe(false);
  });

  it("resubscribes immediately after the last viewer leaves", async () => {
    const { session, page } = await setup();
    const first = collect(await watchSession(session, 5));
    await expect.poll(() => page.screencastIsRunning).toBe(true);

    await first.cancel();
    const second = collect(await watchSession(session, 5));
    await expect.poll(() => page.screencastIsRunning).toBe(true);
    expect(page.screencastStarts).toBe(2);
    expect(page.screencastStops).toBe(1);

    page.emitFrame("second");
    await expect.poll(() => second.messages.length).toBe(1);
    await second.cancel();
  });

  it("does not start a capture for an already-aborted viewer", async () => {
    const { session, page } = await setup();
    const controller = new AbortController();
    controller.abort();

    const live = collect(await watchSession(session, 5, controller.signal));
    await live.done;
    expect(page.screencastStarts).toBe(0);
  });

  it("removes an aborted viewer and keeps the other", async () => {
    const { session, page } = await setup();
    const controller = new AbortController();
    const first = collect(await watchSession(session, 5, controller.signal));
    const second = collect(await watchSession(session, 5));
    await expect.poll(() => page.screencastIsRunning).toBe(true);

    controller.abort();
    await first.done;
    expect(page.screencastIsRunning).toBe(true);

    await second.cancel();
    await expect.poll(() => page.screencastIsRunning).toBe(false);
  });

  it("normalizes the requested frame rate", () => {
    expect(normalizeLiveFps(Number.NaN)).toBe(5);
    expect(normalizeLiveFps(0)).toBe(1);
    expect(normalizeLiveFps(7.4)).toBe(7);
    expect(normalizeLiveFps(90)).toBe(30);
  });
});
