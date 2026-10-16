import { createMiddleware } from "@solidjs/start/middleware";
import { AuthError, authenticateRequest } from "./server/access";
import { ConfigError, readEnvironment } from "./server/config";
import { isCrossSiteRequest } from "./server/origin";

let warnedAboutDev = false;

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Access is the only authentication, and every request is checked, every time —
 * except under ENVIRONMENT=development, where `authenticateRequest` returns a fixed
 * development identity on purpose. The panel, the panel's form posts and every
 * MCP method all pass through here.
 */
export default createMiddleware({
  onRequest: async event => {
    if (isCrossSiteRequest(event.request)) {
      return text(403, "Cross-origin request rejected.");
    }

    if (readEnvironment() === "development" && !warnedAboutDev) {
      warnedAboutDev = true;
      console.warn(
        "vela: ENVIRONMENT=development — Cloudflare Access verification is disabled. Never run this way in production.",
      );
    }

    try {
      event.locals.identity = await authenticateRequest(event.request);
    } catch (error) {
      if (error instanceof ConfigError) {
        return text(503, error.message);
      }
      if (error instanceof AuthError) {
        if (error.reason === "invalid") {
          console.warn(`vela: rejected an Access assertion (${error.message})`);
        }
        return text(403, error.message);
      }
      console.error("vela: unexpected authentication failure", error);
      return text(403, "Access assertion verification failed.");
    }
  },
});
