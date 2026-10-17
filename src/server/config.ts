/**
 * Configuration for the single Access application in front of Vela.
 *
 * There is no fallback and no development mode: if either value is missing or
 * malformed, every request is refused. Vela has no second identity mechanism.
 */
export interface AccessConfig {
  /** Access team origin, derived from the team domain `team.cloudflareaccess.com`. */
  readonly teamDomain: string;
  /** Application Audience (AUD) tag of the Vela Access application. */
  readonly policyAud: string;
}

export type VelaEnvironment = "development" | "production";

/**
 * Development mode skips Access verification so the panel and MCP can be driven
 * locally without building assertions. Everything that is not exactly
 * "development" is production, so a missing or misspelled value fails closed.
 */
export function readEnvironment(env: NodeJS.ProcessEnv = process.env): VelaEnvironment {
  return env.ENVIRONMENT?.trim().toLowerCase() === "development" ? "development" : "production";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * The variable holds the bare team domain, `<team>.cloudflareaccess.com`, and
 * nothing else; the https origin used for the issuer is derived from it.
 */
function readTeamDomain(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    return null;
  }
  if (url.hostname !== value.toLowerCase()) return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.origin;
}

export function loadAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const problems: string[] = [];
  const teamDomain = readTeamDomain(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN);
  if (!teamDomain) {
    problems.push("CLOUDFLARE_ACCESS_TEAM_DOMAIN must be the team domain such as <team>.cloudflareaccess.com");
  }
  const policyAud = env.CLOUDFLARE_ACCESS_APPLICATION_AUD?.trim();
  if (!policyAud) {
    problems.push("CLOUDFLARE_ACCESS_APPLICATION_AUD must be the Access application's AUD tag");
  }
  if (!teamDomain || !policyAud) {
    throw new ConfigError(`Vela is not configured and will not serve requests: ${problems.join("; ")}.`);
  }
  return { teamDomain, policyAud };
}

/** Where Access publishes the public keys that sign application assertions. */
export function accessJwksUrl(config: AccessConfig): URL {
  return new URL(`${config.teamDomain}/cdn-cgi/access/certs`);
}
