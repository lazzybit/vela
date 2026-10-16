/**
 * Points the built-in `openai` provider at OPENAI_BASE_URL, so an
 * OpenAI-compatible gateway can be used instead of api.openai.com. Pi does not
 * read a base-url environment variable for this provider itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerOpenaiProvider(pi: ExtensionAPI): void {
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!baseUrl) return;

  // Supplying only `baseUrl` preserves the built-in OpenAI models.
  pi.registerProvider("openai", { baseUrl });
}
