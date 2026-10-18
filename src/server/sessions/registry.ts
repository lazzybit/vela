import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
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
 * The page profile. Every session presents the same desktop, so what a page can
 * read does not vary between sessions or between restarts.
 */
const PROFILE = {
  viewport: { width: 1800, height: 900 },
  screen: { width: 1920, height: 1080 },
  // A window that fits the screen and carries browser chrome above the page.
  window: { width: 1808, height: 985, x: 60, y: 40 },
  hardwareConcurrency: 8,
  deviceMemory: 8,
  connection: { effectiveType: "4g", rtt: 50, downlink: 10 },
  webgl: {
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1)",
  },
};

const CONTEXT_OPTIONS: BrowserContextOptions = {
  viewport: PROFILE.viewport,
  screen: PROFILE.screen,
  deviceScaleFactor: 1,
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
  colorScheme: "light",
  reducedMotion: "no-preference",
};

type PageProfile = typeof PROFILE;

/**
 * Runs before any page script, in every frame. It changes only what a page can
 * observe; it changes nothing about what the browser can do.
 */
function applyProfile(profile: PageProfile): void {
  try {
    const patched = new WeakSet<Function>();

    const disguise = (replacement: Function, original: Function): Function => {
      patched.add(replacement);
      Object.defineProperty(replacement, "name", { value: original.name, configurable: true });
      Object.defineProperty(replacement, "length", { value: original.length, configurable: true });
      return replacement;
    };

    const nativeToString = Function.prototype.toString;
    const toStringProxy = new Proxy(nativeToString, {
      apply(target, thisArg, args) {
        if (typeof thisArg === "function" && patched.has(thisArg)) {
          return `function ${thisArg.name}() { [native code] }`;
        }
        // A proxy has an empty name, so answer for itself through its target.
        return Reflect.apply(target, thisArg === toStringProxy ? target : thisArg, args);
      },
    });
    Function.prototype.toString = toStringProxy;

    const owner = (object: object, property: string): [object, PropertyDescriptor] | null => {
      let current: object | null = object;
      while (current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, property);
        if (descriptor) return [current, descriptor];
        current = Object.getPrototypeOf(current);
      }
      return null;
    };

    /** Replaces a readable property, leaving the rest of its shape untouched. */
    const defineValue = (object: object, property: string, value: unknown): void => {
      if ((object as Record<string, unknown>)[property] === value) return;
      const found = owner(object, property);
      if (!found) return;
      const [holder, descriptor] = found;
      if (descriptor.get) {
        Object.defineProperty(holder, property, {
          get: disguise(function () {
            return value;
          }, descriptor.get) as () => unknown,
          set: descriptor.set,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
        });
        return;
      }
      Object.defineProperty(holder, property, { ...descriptor, value });
    };

    const defineFunction = (object: object, property: string, replace: (original: Function) => Function): void => {
      const found = owner(object, property);
      if (!found || typeof found[1].value !== "function") return;
      const [holder, descriptor] = found;
      const original = descriptor.value as Function;
      Object.defineProperty(holder, property, { ...descriptor, value: disguise(replace(original), original) });
    };

    defineValue(navigator, "webdriver", false);
    defineValue(navigator, "hardwareConcurrency", profile.hardwareConcurrency);
    defineValue(navigator, "deviceMemory", profile.deviceMemory);

    const connection = (navigator as unknown as { connection?: object }).connection;
    if (connection) {
      for (const property of ["effectiveType", "rtt", "downlink"] as const) {
        defineValue(connection, property, profile.connection[property]);
      }
    }

    defineValue(window, "outerWidth", profile.window.width);
    defineValue(window, "outerHeight", profile.window.height);
    defineValue(window, "screenX", profile.window.x);
    defineValue(window, "screenY", profile.window.y);

    defineFunction(document, "hasFocus", () => function () {
      return true;
    });

    for (const constructor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!constructor) continue;
      defineFunction(constructor.prototype, "getParameter", original =>
        function (this: WebGLRenderingContext, parameter: number) {
          if (parameter === 0x9245 || parameter === 0x9246) {
            if (this.getExtension("WEBGL_debug_renderer_info")) {
              return parameter === 0x9245 ? profile.webgl.vendor : profile.webgl.renderer;
            }
          }
          return original.call(this, parameter);
        },
      );
    }

    const navigatorWithPlugins = navigator as unknown as { plugins: { length: number }; mimeTypes: { length: number } };
    if (navigatorWithPlugins.plugins.length === 0) {
      const entry = (prototype: object, values: Record<string, unknown>): Record<string, unknown> => {
        const instance: Record<string, unknown> = Object.create(prototype);
        for (const [key, value] of Object.entries(values)) {
          Object.defineProperty(instance, key, { value, enumerable: true });
        }
        return instance;
      };
      const collection = (prototype: object, entries: Array<Record<string, unknown>>): Record<string, unknown> => {
        const instance = entry(prototype, { length: entries.length });
        entries.forEach((item, index) => Object.defineProperty(instance, index, { value: item, enumerable: true }));
        instance.item = disguise(function (index: number) {
          return entries[index] ?? null;
        }, function item(index: number) {});
        instance.namedItem = disguise(function (name: string) {
          return entries.find(candidate => candidate.name === name) ?? null;
        }, function namedItem(name: string) {});
        return instance;
      };

      const pdfMimeTypes = [
        entry(MimeType.prototype, {
          type: "application/pdf",
          suffixes: "pdf",
          description: "Portable Document Format",
        }),
        entry(MimeType.prototype, { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" }),
      ];
      const mimeTypes = collection(MimeTypeArray.prototype, pdfMimeTypes);
      const plugin = entry(Plugin.prototype, {
        name: "PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "Portable Document Format",
        length: pdfMimeTypes.length,
        mimeTypes,
      });
      for (const mimeType of pdfMimeTypes) mimeType.enabledPlugin = plugin;

      defineValue(navigator, "mimeTypes", mimeTypes);
      defineValue(navigator, "plugins", collection(PluginArray.prototype, [plugin]));
    }
  } catch {
    // A page Vela does not own must never fail to load because of this script.
  }
}

/**
 * Chromium applies `--user-agent` itself, so the client hints it sends stay its
 * own; Playwright's `userAgent` option would send metadata without any brands.
 * The string is the one this binary sends when it is not headless.
 */
function userAgentArgs(executablePath: string): string[] {
  const version = chromiumVersion(executablePath);
  if (!version) return [];
  return [
    `--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
  ];
}

const chromiumVersions = new Map<string, string | null>();

function chromiumVersion(executablePath: string): string | null {
  const known = chromiumVersions.get(executablePath);
  if (known !== undefined) return known;
  let version: string | null = null;
  try {
    const printed = execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 10_000 });
    version = /\b\d+\.\d+\.\d+\.\d+\b/.exec(printed)?.[0] ?? null;
  } catch {
    console.error(`vela: could not read the version of ${executablePath}; the browser keeps its own user agent.`);
  }
  chromiumVersions.set(executablePath, version);
  return version;
}

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
  const executablePath = findSystemChromium();
  return chromium.launch({
    headless: true,
    chromiumSandbox: !runningAsRoot,
    executablePath,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--enable-unsafe-swiftshader",
      ...userAgentArgs(executablePath),
    ],
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
    const context = await instance.newContext(CONTEXT_OPTIONS);
    await context.addInitScript(applyProfile, PROFILE);
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
