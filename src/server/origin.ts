const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Vela authenticates with an assertion that Cloudflare Access attaches on the
 * way in, so the browser's own cookies cannot be used to prove intent. A
 * cross-site form can still carry them, so state-changing requests must prove
 * they are same-origin when the client identifies itself as a browser.
 *
 * Non-browser MCP clients send neither `Origin` nor `Sec-Fetch-Site` on POST and
 * are unaffected.
 */
export function isCrossSiteRequest(request: Request): boolean {
  if (SAFE_METHODS.has(request.method)) return false;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return true;

  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}
