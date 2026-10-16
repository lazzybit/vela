/**
 * Configuration for the single Access application in front of Vela.
 *
 * There is no fallback and no development mode: if either value is missing or
 * malformed, every request is refused. Vela has no second identity mechanism.
 */
export interface AccessConfig {
  /** Access team origin, for example `https://team.cloudflareaccess.com`. */
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

function readTeamDomain(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.origin;
}

export function loadAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const problems: string[] = [];
  const teamDomain = readTeamDomain(env.VELA_TEAM_DOMAIN);
  if (!teamDomain) {
    problems.push("VELA_TEAM_DOMAIN must be an https origin such as https://<team>.cloudflareaccess.com");
  }
  const policyAud = env.VELA_POLICY_AUD?.trim();
  if (!policyAud) {
    problems.push("VELA_POLICY_AUD must be the Access application's AUD tag");
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
