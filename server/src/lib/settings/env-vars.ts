/**
 * Phase 12 — env-var inspector.
 *
 * Returns a curated, allow-listed view of runtime env vars with secret
 * values redacted. Used by the Settings page (admin.read).
 *
 * Two classifications:
 *   - PUBLIC_ENV_VARS: shown verbatim (hostnames, modes, sizes — no secrets)
 *   - SECRET_ENV_VARS: shown as "[REDACTED]" if present, "[unset]" otherwise
 *
 * Anything not on either list is omitted entirely so a future leaky env
 * never accidentally lands in the response.
 */

const PUBLIC_ENV_VARS: readonly string[] = [
  "NODE_ENV",
  "PORT",
  "LOG_LEVEL",
  "AI_MODE",
  "AI_PROVIDER",
  "AI_DEFAULT_MODEL",
  "ANALYSIS_MONTHLY_TOKEN_CAP",
  "ANALYSIS_AGENT_TOKEN_CAP",
  "ONLINE_EVAL_ENABLED",
  "ONLINE_EVAL_SAMPLE_RATE",
  "ONLINE_EVAL_MONTHLY_TOKEN_BUDGET",
  "ONLINE_EVAL_DRIFT_ALERTS_ENABLED",
  "DB_ALLOWED_HOSTS",
  "REPO_ALLOWED_HOSTS",
  "PUBLISH_GITHUB_ALLOWED_HOSTS",
  "GITHUB_DEFAULT_BASE_URL",
  "PUBLISH_RATE_LIMIT_DELAY_MS",
  "PUBLISH_MAX_RETRIES",
  "MCP_HEALTH_ALLOW_PARTIAL",
  "SCHEDULER_ENABLED",
  "SCHEDULER_TICK_INTERVAL_MS",
];

const SECRET_ENV_VARS: readonly string[] = [
  "VAULT_MASTER_KEY",
  "DATABASE_URL",
  "JWT_SECRET",
  "SESSION_SECRET",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "BEDROCK_GATEWAY_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
];

export interface EnvVarRow {
  key: string;
  value: string;
  classification: "public" | "secret";
  set: boolean;
}

export function listRedactedEnv(env: NodeJS.ProcessEnv = process.env): EnvVarRow[] {
  const rows: EnvVarRow[] = [];
  for (const key of PUBLIC_ENV_VARS) {
    const raw = env[key];
    rows.push({
      key,
      value: raw === undefined || raw === "" ? "[unset]" : raw,
      classification: "public",
      set: raw !== undefined && raw !== "",
    });
  }
  for (const key of SECRET_ENV_VARS) {
    const raw = env[key];
    rows.push({
      key,
      value: raw === undefined || raw === "" ? "[unset]" : "[REDACTED]",
      classification: "secret",
      set: raw !== undefined && raw !== "",
    });
  }
  return rows;
}

export const _publicVarsForTests: readonly string[] = PUBLIC_ENV_VARS;
export const _secretVarsForTests: readonly string[] = SECRET_ENV_VARS;
