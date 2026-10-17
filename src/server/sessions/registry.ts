import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { onShutdown } from "../lifecycle";

/**
 * A session owns a Playwright `BrowserContext`: its pages, its cookies, its
 * logins. It is process state. It outlives the MCP transport that created it,
 * and closing a connection never closes it.
 *
 * Pages are read back from the context itself, so tabs opened by Playwright MCP
 * or by the site (popups) are visible without Vela tracking them separately.
 */
export interface VelaSession {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly context: BrowserContext;
}

export interface SessionPageInfo {
  index: number;
  url: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  createdAt: string;
  default: boolean;
  title: string | null;
  pages: SessionPageInfo[];
}

export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session "${sessionId}".`);
    this.name = "UnknownSessionError";
  }
}

export class SessionClosedError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session "${sessionId}" is closed.`);
    this.name = "SessionClosedError";
  }
}

export type BrowserFactory = () => Promise<Browser>;

/**
 * Locate the Chromium installed by the operating system. Its package can ship
 * the setuid sandbox helper that Playwright's downloaded browser lacks, so the
 * browser keeps its sandbox where user namespaces are unavailable.
 */
function findSystemChromium(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "chromium");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; try the next directory.
    }
  }
  throw new Error("vela: chromium was not found on PATH.");
}

/**
 * Chromium runs as a child process that Playwright drives over pipes. It never
 * opens a debugging port, and Vela never exposes one.
 *
 * The sandbox is disabled only where it cannot work at all (uid 0, e.g. a
 * container that runs the service as root).
 */
async function launchChromium(): Promise<Browser> {
  // Imported lazily so that a process which never drives a browser (for
  // example a unit test with an injected factory) never loads Playwright.
  const { chromium } = await import("playwright");
  const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return chromium.launch({
    headless: true,
    chromiumSandbox: !runningAsRoot,
    executablePath: findSystemChromium(),
  });
}

export interface SessionRegistry {
  open(name?: string): Promise<SessionInfo>;
  list(): Promise<SessionInfo[]>;
  info(id: string): Promise<SessionInfo>;
  has(id: string): boolean;
  get(id: string): VelaSession;
  defaultId(): string | null;
  setDefault(id: string): Promise<SessionInfo>;
  close(id: string): Promise<{ id: string; wasDefault: boolean }>;
  closeAll(): Promise<void>;
}

const SAFE_TITLE_TIMEOUT_MS = 1000;

export function createSessionRegistry(launch: BrowserFactory = launchChromium): SessionRegistry {
  let browser: Browser | null = null;
  const sessions = new Map<string, VelaSession>();
  // Closed ids are remembered only so that a stale MCP binding can say
  // "closed" instead of "unknown". They are never reused.
  const closedIds = new Set<string>();
  let defaultSessionId: string | null = null;

  async function browserInstance(): Promise<Browser> {
    if (browser && browser.isConnected()) return browser;
    const started = await launch();
    started.on("disconnected", () => {
      if (browser === started) browser = null;
    });
    browser = started;
    return started;
  }

  function newId(): string {
    let id: string;
    do {
      id = randomUUID().replaceAll("-", "").slice(0, 10);
    } while (sessions.has(id) || closedIds.has(id));
    return id;
  }

  function get(id: string): VelaSession {
    const session = sessions.get(id);
    if (session) return session;
    if (closedIds.has(id)) throw new SessionClosedError(id);
    throw new UnknownSessionError(id);
  }

  function livePages(session: VelaSession): Page[] {
    try {
      return session.context.pages().filter(page => !page.isClosed());
    } catch {
      return [];
    }
  }

  async function describe(session: VelaSession): Promise<SessionInfo> {
    const pages = livePages(session);
    const last = pages[pages.length - 1];
    return {
      id: session.id,
      name: session.name,
      createdAt: new Date(session.createdAt).toISOString(),
      default: defaultSessionId === session.id,
      title: last ? await safeTitle(last) : null,
      pages: pages.map((page, index) => ({ index, url: safeUrl(page) })),
    };
  }

  async function open(name?: string): Promise<SessionInfo> {
    const instance = await browserInstance();
    const context = await instance.newContext();
    await context.newPage();
    const id = newId();
    const session: VelaSession = {
      id,
      name: name?.trim() || `session ${sessions.size + 1}`,
      createdAt: Date.now(),
      context,
    };
    sessions.set(id, session);
    return describe(session);
  }

  async function close(id: string): Promise<{ id: string; wasDefault: boolean }> {
    const session = get(id);
    sessions.delete(id);
    closedIds.add(id);
    const wasDefault = defaultSessionId === id;
    // Closing the default clears it. Nobody is quietly reassigned to another
    // browser, and /mcp refuses new connections until a default is set again.
    if (wasDefault) defaultSessionId = null;
    await session.context.close().catch(error => {
      console.error(`vela: failed to close browser context for session ${id}`, error);
    });
    return { id, wasDefault };
  }

  async function closeAll(): Promise<void> {
    sessions.clear();
    defaultSessionId = null;
    // Closing the browser closes every context it owns, so there is no need to
    // race individual context closures against process shutdown.
    const instance = browser;
    browser = null;
    if (instance) {
      await instance.close().catch(error => console.error("vela: failed to close the browser", error));
    }
  }

  return {
    open,
    async list() {
      return Promise.all([...sessions.values()].map(describe));
    },
    async info(id) {
      return describe(get(id));
    },
    has: id => sessions.has(id),
    get,
    defaultId: () => defaultSessionId,
    async setDefault(id) {
      const session = get(id);
      defaultSessionId = id;
      return describe(session);
    },
    close,
    closeAll,
  };
}

async function safeTitle(page: Page): Promise<string | null> {
  if (page.isClosed()) return null;
  try {
    return await Promise.race([
      page.title(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), SAFE_TITLE_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

type RegistryHolder = { [key: symbol]: SessionRegistry | undefined };

const REGISTRY_KEY = Symbol.for("vela.session-registry");

export function registry(): SessionRegistry {
  const holder = globalThis as unknown as RegistryHolder;
  let instance = holder[REGISTRY_KEY];
  if (!instance) {
    instance = createSessionRegistry();
    holder[REGISTRY_KEY] = instance;
    onShutdown(() => closeSessions());
  }
  return instance;
}

async function closeSessions(): Promise<void> {
  const holder = globalThis as unknown as RegistryHolder;
  await holder[REGISTRY_KEY]?.closeAll();
}
