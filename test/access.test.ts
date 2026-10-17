import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  ACCESS_ASSERTION_HEADER,
  AuthError,
  authenticateRequest,
  verifyAccessAssertion,
} from "../src/server/access";
import { accessJwksUrl, ConfigError, loadAccessConfig, readEnvironment, type AccessConfig } from "../src/server/config";

const config: AccessConfig = {
  teamDomain: "https://team.cloudflareaccess.com",
  policyAud: "vela-aud-tag",
};

const { privateKey, publicKey } = await generateKeyPair("RS256");
const { privateKey: otherKey } = await generateKeyPair("RS256");

const publicJwk = await exportJWK(publicKey);
const keySet = createLocalJWKSet({
  keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
});

interface SignOptions {
  issuer?: string;
  audience?: string;
  expiresAt?: number;
  key?: CryptoKey;
  subject?: string | null;
  includeEmail?: boolean;
}

async function sign(options: SignOptions = {}): Promise<string> {
  const payload: Record<string, unknown> = { type: "app" };
  if (options.includeEmail !== false) payload.email = "me@example.com";
  const token = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.issuer ?? config.teamDomain)
    .setAudience(options.audience ?? config.policyAud)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1000) + 300);
  if (options.subject !== null) token.setSubject(options.subject ?? "user-1");
  return token.sign(options.key ?? privateKey);
}

describe("verifyAccessAssertion", () => {
  it("accepts an assertion signed by the team key", async () => {
    await expect(verifyAccessAssertion(await sign(), config, keySet)).resolves.toEqual({
      subject: "user-1",
      email: "me@example.com",
    });
  });

  it("rejects a token for another audience", async () => {
    await expect(verifyAccessAssertion(await sign({ audience: "other-app" }), config, keySet)).rejects.toThrow();
  });

  it("rejects a token from another issuer", async () => {
    await expect(
      verifyAccessAssertion(await sign({ issuer: "https://evil.cloudflareaccess.com" }), config, keySet),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const expired = Math.floor(Date.now() / 1000) - 120;
    await expect(verifyAccessAssertion(await sign({ expiresAt: expired }), config, keySet)).rejects.toThrow();
  });

  it("rejects a token signed by another key", async () => {
    await expect(verifyAccessAssertion(await sign({ key: otherKey }), config, keySet)).rejects.toThrow();
  });

  it("rejects a symmetric-algorithm token even when the audience matches", async () => {
    const confused = await new SignJWT({ email: "me@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(config.teamDomain)
      .setAudience(config.policyAud)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(new TextEncoder().encode("secret"));
    await expect(verifyAccessAssertion(confused, config, keySet)).rejects.toThrow();
  });

  it("rejects a token without a subject", async () => {
    await expect(
      verifyAccessAssertion(await sign({ subject: null }), config, keySet),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("authenticateRequest", () => {
  const env = { CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", CLOUDFLARE_ACCESS_APPLICATION_AUD: config.policyAud };

  it("refuses a request without the Access header", async () => {
    await expect(authenticateRequest(new Request("https://vela.example/mcp"), env)).rejects.toMatchObject({
      reason: "missing",
    });
  });

  it("refuses a request with a bad assertion", async () => {
    const request = new Request("https://vela.example/mcp", {
      headers: { [ACCESS_ASSERTION_HEADER]: "not-a-jwt" },
    });
    await expect(authenticateRequest(request, env)).rejects.toMatchObject({ reason: "invalid" });
  });

  it("fails closed when Vela is not configured", async () => {
    const request = new Request("https://vela.example/mcp", {
      headers: { [ACCESS_ASSERTION_HEADER]: await sign() },
    });
    await expect(authenticateRequest(request, {})).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("development bypass", () => {
  it("treats anything but an explicit dev as production", () => {
    expect(readEnvironment({})).toBe("production");
    expect(readEnvironment({ ENVIRONMENT: "production" })).toBe("production");
    expect(readEnvironment({ ENVIRONMENT: "prod" })).toBe("production");
    expect(readEnvironment({ ENVIRONMENT: "dev" })).toBe("production");
    expect(readEnvironment({ ENVIRONMENT: "" })).toBe("production");
    expect(readEnvironment({ ENVIRONMENT: " DEVELOPMENT " })).toBe("development");
  });

  it("accepts a request with no assertion and no configuration", async () => {
    await expect(
      authenticateRequest(new Request("https://vela.example/mcp"), { ENVIRONMENT: "development" }),
    ).resolves.toEqual({ subject: "dev", email: "dev@localhost" });
  });
});

describe("loadAccessConfig", () => {
  it("reports exactly what is missing", () => {
    expect(() => loadAccessConfig({})).toThrow(/CLOUDFLARE_ACCESS_TEAM_DOMAIN.*CLOUDFLARE_ACCESS_APPLICATION_AUD/);
  });

  it("rejects a value that is not a bare team domain", () => {
    expect(() =>
      loadAccessConfig({
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        CLOUDFLARE_ACCESS_APPLICATION_AUD: "aud",
      }),
    ).toThrow(ConfigError);
  });

  it("derives the team origin from the bare team domain", () => {
    expect(
      loadAccessConfig({
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        CLOUDFLARE_ACCESS_APPLICATION_AUD: "aud",
      }),
    ).toEqual({ teamDomain: "https://team.cloudflareaccess.com", policyAud: "aud" });
  });

  it("derives the JWKS endpoint from the team domain", () => {
    expect(accessJwksUrl(config).href).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/certs");
  });
});
