import { describe, expect, it } from "vitest";
import { isCrossSiteRequest } from "../src/server/origin";

function request(method: string, url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method, headers });
}

describe("isCrossSiteRequest", () => {
  it("allows safe methods", () => {
    expect(isCrossSiteRequest(request("GET", "https://vela.example/", { origin: "https://evil.example" }))).toBe(false);
  });

  it("allows a same-origin form post", () => {
    expect(
      isCrossSiteRequest(
        request("POST", "https://vela.example/panel/open", {
          origin: "https://vela.example",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBe(false);
  });

  it("allows a non-browser client that sends no browser headers", () => {
    expect(isCrossSiteRequest(request("POST", "https://vela.example/mcp"))).toBe(false);
  });

  it("rejects a cross-site post", () => {
    expect(
      isCrossSiteRequest(
        request("POST", "https://vela.example/panel/open", {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a same-site but different-origin post", () => {
    expect(
      isCrossSiteRequest(
        request("DELETE", "https://vela.example/mcp", {
          origin: "https://other.vela.example",
          "sec-fetch-site": "same-site",
        }),
      ),
    ).toBe(true);
  });

  it("rejects an unparsable origin", () => {
    expect(isCrossSiteRequest(request("POST", "https://vela.example/mcp", { origin: "not a url" }))).toBe(true);
  });
});
