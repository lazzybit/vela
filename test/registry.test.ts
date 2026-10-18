import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionRegistry,
  SessionClosedError,
  UnknownSessionError,
  type SessionRegistry,
} from "../src/server/sessions/registry";
import { FakeBrowser } from "./support/fake-browser";

describe("session registry", () => {
  let fake: FakeBrowser;
  let registry: SessionRegistry;
  let launches: number;

  beforeEach(() => {
    fake = new FakeBrowser();
    launches = 0;
    registry = createSessionRegistry(async () => {
      launches += 1;
      return fake.asBrowser();
    });
  });

  it("opens a session with one page and no default", async () => {
    const session = await registry.open("first");
    expect(session.name).toBe("first");
    expect(session.pages).toHaveLength(1);
    expect(session.default).toBe(false);
    expect(registry.defaultId()).toBeNull();
  });

  it("launches the browser once for many sessions", async () => {
    await registry.open();
    await registry.open();
    await registry.open();
    expect(launches).toBe(1);
    expect(await registry.list()).toHaveLength(3);
  });

  it("sets and reports the default session", async () => {
    const first = await registry.open();
    const second = await registry.open();
    await registry.setDefault(second.id);
    expect(registry.defaultId()).toBe(second.id);
    const listed = await registry.list();
    expect(listed.find(session => session.id === first.id)?.default).toBe(false);
    expect(listed.find(session => session.id === second.id)?.default).toBe(true);
  });

  it("clears the default when the default session is closed", async () => {
    const session = await registry.open();
    await registry.setDefault(session.id);
    await expect(registry.close(session.id)).resolves.toEqual({ id: session.id, wasDefault: true });
    expect(registry.defaultId()).toBeNull();
    expect(registry.has(session.id)).toBe(false);
  });

  it("does not reassign the default to a surviving session", async () => {
    const first = await registry.open();
    const second = await registry.open();
    await registry.setDefault(second.id);
    await registry.close(second.id);
    expect(registry.defaultId()).toBeNull();
    expect(registry.has(first.id)).toBe(true);
  });

  it("reports closed and unknown sessions differently", async () => {
    const session = await registry.open();
    await registry.close(session.id);
    expect(() => registry.get(session.id)).toThrow(SessionClosedError);
    expect(() => registry.get("nope")).toThrow(UnknownSessionError);
  });

  it("closes the browser context but not other sessions", async () => {
    const first = await registry.open();
    const second = await registry.open();
    await registry.close(first.id);
    expect(fake.contexts[0]?.closed).toBe(true);
    expect(fake.contexts[1]?.closed).toBe(false);
    expect(registry.has(second.id)).toBe(true);
  });

  it("reports the pages that exist on the context", async () => {
    const session = await registry.open();
    const context = registry.get(session.id).context;
    await context.newPage();
    const info = await registry.info(session.id);
    expect(info.pages).toHaveLength(2);
  });

  it("reports the current url and title of the last page", async () => {
    const session = await registry.open();
    const context = registry.get(session.id).context;
    await context.pages()[0]?.goto("https://example.com/one");
    const info = await registry.info(session.id);
    expect(info.pages[0]?.url).toBe("https://example.com/one");
    expect(info.title).toBe("Title of https://example.com/one");
  });

  it("closes every context and the browser on shutdown", async () => {
    await registry.open();
    await registry.open();
    await registry.closeAll();
    expect(fake.openContexts).toBe(0);
    expect(fake.closed).toBe(true);
    expect(registry.defaultId()).toBeNull();
    expect(await registry.list()).toEqual([]);
  });

  it("uses a fresh unique id per session", async () => {
    const ids = new Set<string>();
    for (let index = 0; index < 25; index += 1) {
      ids.add((await registry.open()).id);
    }
    expect(ids.size).toBe(25);
  });

  it("opens every session with the same page profile", async () => {
    await registry.open();
    await registry.open();
    const [first, second] = fake.contexts;
    expect(first?.options).toMatchObject({
      viewport: { width: 1800, height: 900 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      colorScheme: "light",
      reducedMotion: "no-preference",
    });
    expect(second?.options).toEqual(first?.options);
    expect(first?.initScripts).toHaveLength(1);
    expect(first?.initScripts[0]?.arg).toMatchObject({ hardwareConcurrency: 8, deviceMemory: 8 });
  });

  it("survives a browser disconnect by launching again", async () => {
    await registry.open();
    fake.closed = true;
    const factory = vi.fn(async () => new FakeBrowser().asBrowser());
    const second = createSessionRegistry(factory);
    await second.open();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
