import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createSessionRegistry } from "../src/server/sessions/registry";
import { FakeBrowser } from "./support/fake-browser";

interface Initial {
  webdriver: boolean;
  hardwareConcurrency: number;
  deviceMemory: number;
  effectiveType: string;
  rtt: number;
  downlink: number;
  outer: [number, number, number, number];
  hasFocus: boolean;
  gpu: string;
}

const MISMATCHED: Initial = {
  webdriver: true,
  hardwareConcurrency: 2,
  deviceMemory: 4,
  effectiveType: "slow-2g",
  rtt: 2000,
  downlink: 0.1,
  outer: [800, 600, 0, 0],
  hasFocus: false,
  gpu: "SwiftShader",
};

/**
 * The init script runs inside a page, so it is exercised in its own realm
 * against a small DOM-shaped surface. What the real browser does with it is the
 * end-to-end suite's job; this covers the script itself.
 */
function bootstrap(initial: Initial): string {
  const [width, height, x, y] = initial.outer;
  return `
class Plugin {}
class MimeType {}
class PluginArray {}
class MimeTypeArray {}

class NetworkInformation {}
Object.defineProperty(NetworkInformation.prototype, "effectiveType", { get: () => ${JSON.stringify(initial.effectiveType)}, enumerable: true, configurable: true });
Object.defineProperty(NetworkInformation.prototype, "rtt", { get: () => ${initial.rtt}, enumerable: true, configurable: true });
Object.defineProperty(NetworkInformation.prototype, "downlink", { get: () => ${initial.downlink}, enumerable: true, configurable: true });

class Navigator {}
Object.defineProperty(Navigator.prototype, "webdriver", { get: () => ${initial.webdriver}, enumerable: true, configurable: true });
Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => ${initial.hardwareConcurrency}, enumerable: true, configurable: true });
Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => ${initial.deviceMemory}, enumerable: true, configurable: true });
Object.defineProperty(Navigator.prototype, "plugins", { get: () => plugins, enumerable: true, configurable: true });
Object.defineProperty(Navigator.prototype, "mimeTypes", { get: () => mimeTypes, enumerable: true, configurable: true });
Object.defineProperty(Navigator.prototype, "connection", { get: () => connection, enumerable: true, configurable: true });

class Window {}
Object.defineProperty(Window.prototype, "outerWidth", { get: () => ${width}, enumerable: true, configurable: true });
Object.defineProperty(Window.prototype, "outerHeight", { get: () => ${height}, enumerable: true, configurable: true });
Object.defineProperty(Window.prototype, "screenX", { get: () => ${x}, enumerable: true, configurable: true });
Object.defineProperty(Window.prototype, "screenY", { get: () => ${y}, enumerable: true, configurable: true });

class Document {}
Document.prototype.hasFocus = function hasFocus() { return ${initial.hasFocus}; };

class WebGLRenderingContext {}
WebGLRenderingContext.prototype.getExtension = function getExtension() { return {}; };
WebGLRenderingContext.prototype.getParameter = function getParameter() { return ${JSON.stringify(initial.gpu)}; };

const plugins = Object.assign(new PluginArray(), { length: 0 });
const mimeTypes = Object.assign(new MimeTypeArray(), { length: 0 });
const connection = new NetworkInformation();
const navigator = new Navigator();
const document = new Document();
const window = new Window();
window.WebGLRenderingContext = WebGLRenderingContext;
window.WebGL2RenderingContext = undefined;
`;
}

async function recorded(): Promise<{ script: unknown; arg: unknown }> {
  const browser = new FakeBrowser();
  const registry = createSessionRegistry(async () => browser.asBrowser());
  await registry.open();
  const recorded = browser.contexts[0]?.initScripts[0];
  if (!recorded) throw new Error("no init script was recorded");
  return recorded;
}

async function page(initial: Initial): Promise<{ context: ReturnType<typeof createContext>; source: string }> {
  const { script, arg } = await recorded();
  const context = createContext({ PROFILE: arg });
  runInContext(bootstrap(initial), context);
  return { context, source: `(${String(script)})(PROFILE)` };
}

const REPORT = `({
  webdriver: navigator.webdriver,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory,
  effectiveType: navigator.connection.effectiveType,
  rtt: navigator.connection.rtt,
  downlink: navigator.connection.downlink,
  outer: [window.outerWidth, window.outerHeight, window.screenX, window.screenY],
  hasFocus: document.hasFocus(),
  plugins: navigator.plugins.length,
  mimeTypes: navigator.mimeTypes.length,
  webgl: [new window.WebGLRenderingContext().getParameter(0x9245), new window.WebGLRenderingContext().getParameter(0x9246)],
  descriptor: Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver"),
  native: Function.prototype.toString.call(Function.prototype.toString),
})`;

describe("page profile", () => {
  it("replaces every value the profile disagrees with", async () => {
    const { context, source } = await page(MISMATCHED);
    runInContext(source, context);

    const report = runInContext(REPORT, context) as Record<string, unknown>;
    expect(report).toMatchObject({
      webdriver: false,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      effectiveType: "4g",
      rtt: 50,
      downlink: 10,
      outer: [1808, 985, 60, 40],
      hasFocus: true,
      plugins: 1,
      mimeTypes: 2,
      webgl: [
        "Google Inc. (Intel)",
        "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1)",
      ],
      native: "function toString() { [native code] }",
    });

    const descriptor = report.descriptor as PropertyDescriptor;
    expect(descriptor.enumerable).toBe(true);
    expect(descriptor.configurable).toBe(true);
    expect(descriptor.get?.length).toBe(0);
    expect(descriptor.get?.name).toBe("get");
    expect(String(descriptor.get)).toBe("function get() { [native code] }");
  });
});
