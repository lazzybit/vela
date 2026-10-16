import type { Browser, BrowserContext, Page } from "playwright";

/**
 * A browser-shaped stand-in for tests that need the session registry but must
 * not start Chromium. Only the Playwright surface Vela actually uses is
 * implemented.
 */
export class FakePage {
  readonly calls: string[] = [];
  private currentUrl = "about:blank";
  private currentTitle = "";
  private closed = false;
  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      this.calls.push(`press:${key}`);
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
    this.closed = true;
  }
}

export class FakeContext {
  readonly created: FakePage[] = [];
  closed = false;

  async newPage(): Promise<Page> {
    const page = new FakePage();
    this.created.push(page);
    return page as unknown as Page;
  }

  pages(): Page[] {
    return this.created.filter(page => !page.isClosed()) as unknown as Page[];
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const page of this.created) page.closeSync();
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

  async newContext(): Promise<BrowserContext> {
    const context = new FakeContext();
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
