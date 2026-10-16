/**
 * CI shims for the issue-analysis workflow, auto-loaded from the project
 * extension directory `.pi/extensions/ci`.
 *
 * The plugin only takes effect in CI (GitHub Actions sets `CI=true`); outside
 * CI it registers nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOpenaiProvider } from "./openai.ts";
import { registerSandbox } from "./sandbox.ts";

export default function (pi: ExtensionAPI) {
  // GitHub Actions sets CI=true.
  if (process.env.CI !== "true") return;

  registerOpenaiProvider(pi);
  registerSandbox(pi);
}
