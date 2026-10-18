import type { Browser, BrowserContext, Page } from "playwright";

export interface FakeScreencastFrame {
  data: Buffer;
  timestamp: number;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * A browser-shaped stand-in for tests that need the session registry but must
 * not start Chromium. Only the Playwright surface Vela actually uses is
 * implemented.
 */
export class FakePage {
  readonly calls: string[] = [];
  visibilityState: "visible" | "hidden" = "visible";
  failScreencastStart = false;
  screencastStarts = 0;
  screencastStops = 0;
  private currentUrl = "about:blank";
  private currentTitle = "";
  private closed = false;
  private screencastRunning = false;
  private onScreencastFrame: ((frame: FakeScreencastFrame) => unknown) | undefined;
  private readonly listeners = new Map<string, Set<() => void>>();
  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      this.calls.push(`press:${key}`);
    },
  };

  readonly screencast = {
    start: async (options: { onFrame?: (frame: FakeScreencastFrame) => unknown } = {}) => {
      if (this.failScreencastStart || this.screencastRunning) {
        throw new Error("Screencast is already started");
      }
      this.screencastRunning = true;
      this.screencastStarts += 1;
      this.onScreencastFrame = options.onFrame;
      return { dispose: async () => this.screencast.stop() };
    },
    stop: async (): Promise<void> => {
      if (!this.screencastRunning) return;
      this.screencastRunning = false;
      this.screencastStops += 1;
      this.onScreencastFrame = undefined;
    },
  };

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async evaluate(): Promise<boolean> {
    return this.visibilityState === "visible" && !this.closed;
  }

  on(event: string, listener: () => void): this {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
    return this;
  }

  off(event: string, listener: () => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  get screencastIsRunning(): boolean {
    return this.screencastRunning;
  }

  emitFrame(text: string): void {
    void this.onScreencastFrame?.({
      data: Buffer.from(text),
      timestamp: Date.now(),
      viewportWidth: 8,
      viewportHeight: 6,
    });
  }

  async goto(url: string): Promise<null> {
    this.currentUrl = url;
    this.currentTitle = `Title of ${url}`;
    this.calls.push(`goto:${url}`);
    return null;
  }

  locator(selector: string) {
    return {
      click: async (): Promise<void> => {
        this.calls.push(`click:${selector}`);
      },
      fill: async (value: string): Promise<void> => {
        this.calls.push(`fill:${selector}:${value}`);
      },
      ariaSnapshot: async (): Promise<string> => {
        return `- document "${this.currentTitle}"\n- text: ${selector}`;
      },
    };
  }

  async screenshot(): Promise<Buffer> {
    this.calls.push("screenshot");
    return Buffer.from("fake-png");
  }

  closeSync(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...(this.listeners.get("close") ?? [])]) listener();
  }
}

export class FakeContext {
  readonly created: FakePage[] = [];
  readonly initScripts: Array<{ script: unknown; arg: unknown }> = [];
  closed = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(readonly options?: Record<string, unknown>) {}

  async addInitScript(script: unknown, arg?: unknown): Promise<unknown> {
    this.initScripts.push({ script, arg });
    return { dispose: async () => {} };
  }

  async newPage(): Promise<Page> {
    const page = new FakePage();
    this.created.push(page);
    return page as unknown as Page;
  }

  pages(): Page[] {
    return this.created.filter(page => !page.isClosed()) as unknown as Page[];
  }

  on(event: string, listener: () => void): this {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
    return this;
  }

  off(event: string, listener: () => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const page of this.created) page.closeSync();
    for (const listener of [...(this.listeners.get("close") ?? [])]) listener();
  }
}

export class FakeBrowser {
  readonly contexts: FakeContext[] = [];
  closed = false;

  isConnected(): boolean {
    return !this.closed;
  }

  on(): this {
    return this;
  }

  async newContext(options?: Record<string, unknown>): Promise<BrowserContext> {
    const context = new FakeContext(options);
    this.contexts.push(context);
    return context as unknown as BrowserContext;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const context of this.contexts) await context.close();
  }

  asBrowser(): Browser {
    return this as unknown as Browser;
  }

  get openContexts(): number {
    return this.contexts.filter(context => !context.closed).length;
  }
}
