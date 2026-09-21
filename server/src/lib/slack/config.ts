/**
 * Issue #579 (epic #63) — Slack app environment configuration.
 *
 * Loads the platform-level Slack app credentials from the environment. These are
 * the APP's credentials (one Slack app serving many METIS workspaces), distinct
 * from the per-workspace bot TOKEN (which is granted by OAuth and stored
 * encrypted in the vault by `installation-store.ts`):
 *
 *   - SLACK_SIGNING_SECRET — verifies every inbound request signature (REQUIRED
 *     for the Slack surface to be enabled; without it we refuse to mount the
 *     receiver, failing CLOSED rather than serving unverified requests).
 *   - SLACK_CLIENT_ID / SLACK_CLIENT_SECRET — OAuth app credentials for the
 *     install flow (`oauth.v2.access`).
 *   - SLACK_STATE_SECRET — signs the OAuth `state` param (CSRF protection on the
 *     install round-trip).
 *
 * `isSlackEnabled` is the single switch the wiring consults: the Slack receiver is
 * mounted ONLY when at minimum the signing secret is present, so a deployment
 * that hasn't configured Slack never exposes an unverified endpoint.
 */

export interface SlackAppConfig {
  signingSecret: string | null;
  clientId: string | null;
  clientSecret: string | null;
  stateSecret: string | null;
  /** OAuth scopes requested at install. */
  scopes: string[];
}

const DEFAULT_SCOPES = ["commands", "chat:write", "users:read", "users:read.email"];

function clean(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v.length > 0 ? v : null;
}

/** Parse the Slack app config from the environment. Pure + injectable for tests. */
export function loadSlackConfig(env: NodeJS.ProcessEnv = process.env): SlackAppConfig {
  const scopesRaw = clean(env.SLACK_SCOPES);
  return {
    signingSecret: clean(env.SLACK_SIGNING_SECRET),
    clientId: clean(env.SLACK_CLIENT_ID),
    clientSecret: clean(env.SLACK_CLIENT_SECRET),
    stateSecret: clean(env.SLACK_STATE_SECRET),
    scopes: scopesRaw
      ? scopesRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_SCOPES,
  };
}

/**
 * The Slack surface is enabled only when the signing secret is configured. Without
 * it we cannot verify request authenticity, so we fail CLOSED (never mount an
 * unverified receiver).
 */
export function isSlackEnabled(config: SlackAppConfig): boolean {
  return config.signingSecret !== null;
}

/**
 * The OAuth install flow additionally requires the client id/secret + a state
 * secret. `isSlackEnabled` can be true (signature verification works) while OAuth
 * is not configured — in that case installs are done via the admin API directly.
 */
export function isSlackOAuthConfigured(config: SlackAppConfig): boolean {
  return config.clientId !== null && config.clientSecret !== null && config.stateSecret !== null;
}
