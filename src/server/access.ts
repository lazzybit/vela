import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { accessJwksUrl, loadAccessConfig, readEnvironment, type AccessConfig } from "./config";

/**
 * The header Cloudflare Access adds to every request it forwards. The
 * `CF_Authorization` cookie is deliberately ignored: the docs recommend the
 * header, and the cookie is not guaranteed to be present.
 */
export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

export type AuthFailureReason = "missing" | "invalid";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly reason: AuthFailureReason,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}

export interface Identity {
  readonly subject: string;
  readonly email?: string;
}

/** The identity every request carries while Vela runs with ENVIRONMENT=development. */
export const DEV_IDENTITY: Identity = { subject: "dev", email: "dev@localhost" };

/**
 * JWKS are cached per team domain for the process lifetime. jose's remote key
 * set keeps the fetched keys, refreshes them when an unknown `kid` appears, and
 * rate limits that refresh. Caching keys saves work; it never skips a check.
 */
const keySets = new Map<string, JWTVerifyGetKey>();

export function jwksFor(config: AccessConfig): JWTVerifyGetKey {
  const url = accessJwksUrl(config).href;
  let keySet = keySets.get(url);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(url));
    keySets.set(url, keySet);
  }
  return keySet;
}

/**
 * Verify one Access assertion. Signature, issuer, audience, expiry and signing
 * algorithm are all checked on every call.
 */
export async function verifyAccessAssertion(
  token: string,
  config: AccessConfig,
  keySet: JWTVerifyGetKey = jwksFor(config),
): Promise<Identity> {
  const { payload } = await jwtVerify(token, keySet, {
    issuer: config.teamDomain,
    audience: config.policyAud,
    algorithms: ["RS256"],
    clockTolerance: 5,
  });
  const subject = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  if (!subject) {
    throw new AuthError("Access assertion has no subject.", "invalid");
  }
  const email = typeof payload.email === "string" && payload.email.length > 0 ? payload.email : undefined;
  return { subject, ...(email ? { email } : {}) };
}

/**
 * Authenticate an incoming request from scratch. In production configuration is
 * read per request so that a misconfigured process fails closed instead of
 * failing open; in development the check is skipped by design.
 */
export async function authenticateRequest(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Identity> {
  if (readEnvironment(env) === "development") {
    return DEV_IDENTITY;
  }
  const config = loadAccessConfig(env);
  const token = request.headers.get(ACCESS_ASSERTION_HEADER);
  if (!token) {
    throw new AuthError("Missing Cloudflare Access assertion.", "missing");
  }
  try {
    return await verifyAccessAssertion(token, config);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("Invalid Cloudflare Access assertion.", "invalid", { cause: error });
  }
}
