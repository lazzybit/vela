# Playwright fingerprints

Strategies Vela adopts, and where each one lives.

## Launch

### Disable the automation-controlled feature

`args: ["--disable-blink-features=AutomationControlled"]` in `launchChromium`. The same switch Playwright MCP passes for its own Chromium.

### Allow software WebGL

`args: ["--enable-unsafe-swiftshader"]` in `launchChromium`. The `chromium` browser type adds it on darwin only, so on Linux it is otherwise absent.

### Set the user agent as a browser switch

`args: ["--user-agent=<desktop Chromium>"]`, carrying the version the binary reports for `--version` and the `Linux x86_64` token the published `linux/amd64` image needs. Chromium applies the switch itself, so client hints stay the browser's own; Playwright's `userAgent` context option would send metadata with no brands.

## Context

Applied as one `newContext()` options object in `registry.open()`.

### Pin the viewport and the screen

`viewport: { width: 1800, height: 900 }`, `screen: { width: 1920, height: 1080 }`. A headless window equals the viewport, and an unset `screen` falls back to the viewport, so both are set.

### Pin the device scale factor

`deviceScaleFactor: 1`.

### Use a US locale

`locale: "en-US"`, which also sets `Accept-Language: en-US`. The deployment's egress stays in the United States.

### Use a US timezone

`timezoneId: "America/Los_Angeles"`, so the clock agrees with the locale and the egress.

### Fix the remaining media preferences

`colorScheme: "light"`, `reducedMotion: "no-preference"`, so they do not vary between sessions.

## Init script

One `context.addInitScript` in `registry.open()`, receiving the profile as its argument. It runs before any page script, in every frame.

### Clear the automation marker

`navigator.webdriver` reports `false`.

### Fill the desktop object surface

`navigator.hardwareConcurrency`, `navigator.deviceMemory` and `navigator.connection` report the profile's values. `navigator.plugins` and `navigator.mimeTypes` are replaced with a PDF viewer only when the browser reports none.

### Agree the window geometry with the screen

`window.outerWidth`, `outerHeight`, `screenX`, `screenY` and `document.hasFocus()` report a focused window on the pinned screen, not a window the size of the viewport.

### Match WebGL to the profile

`getParameter` returns one fixed vendor and renderer pair for `UNMASKED_VENDOR_WEBGL` and `UNMASKED_RENDERER_WEBGL`, and only when the page has asked for `WEBGL_debug_renderer_info`, as the browser does.

### Make the patch itself unremarkable

An override stays where the browser defines it: the same holder in the prototype chain, the same `enumerable`/`configurable`/`writable` flags, the original function's `name` and `length`, and a `Function.prototype.toString` that still reports `[native code]`, including for itself.

## Verification

### Assert the profile with a contract test

A `browser_evaluate` probe in `test/e2e` reads a session's page and asserts: user agent without a headless token, `navigator.webdriver`, client-hint brands, language and languages, timezone, viewport, window and screen geometry, window position, plugin count, `document.hasFocus()`, WebGL vendor and renderer, and that the `navigator.webdriver` accessor still looks native to `Object.getOwnPropertyDescriptor` and `Function.prototype.toString`. `test/profile.test.ts` runs the same init script in its own realm against a DOM-shaped surface.
