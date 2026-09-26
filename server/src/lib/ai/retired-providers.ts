/**
 * #149 (epic #130, P4) — providers METIS no longer ships, and the one place
 * that says so.
 *
 * `copilot-native` (the GitHub Copilot SDK adapter and its `copilot-svc`
 * sidecar) was removed. A deployment, a runtime-config row, a project override
 * or a stored chat session can still NAME it. Every one of those must fail
 * loudly with the same message — never fall through to another provider,
 * which on most deployments would be a different, paid backend the operator
 * never chose.
 *
 * The same goes for the Copilot-era env names that the OpenAI / Azure
 * providers used to read as a fallback (`COPILOT_PROVIDER_*`, `COPILOT_MODEL`).
 * They are no longer read; when one is set and its replacement is not, the
 * config loader names the rename rather than silently running with a missing
 * base URL, key or model.
 */
import { AI_PROVIDER_KEYS } from "@metis/shared";

/** Provider keys that were supported once and are now refused by name. */
export const RETIRED_PROVIDER_KEYS = ["copilot-native"] as const;
export type RetiredProviderKey = (typeof RETIRED_PROVIDER_KEYS)[number];

/** Where the migration note lives (repo-relative, stable anchor for messages). */
export const COPILOT_MIGRATION_DOC = "docs/MIGRATING_FROM_COPILOT.md";

/** True when `value` names a retired provider (case/whitespace-insensitive). */
export function isRetiredProviderKey(value: unknown): value is RetiredProviderKey {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return (RETIRED_PROVIDER_KEYS as readonly string[]).includes(v);
}

/** Where a retired provider name was found — shapes the first sentence only. */
export type RetiredProviderSource = "AI_PROVIDER" | "runtime-config" | "project" | "session";

const SOURCE_PHRASE: Record<RetiredProviderSource, string> = {
  AI_PROVIDER: "AI_PROVIDER is set to",
  "runtime-config": "The runtime configuration (Admin → Settings) selects AI provider",
  project: "This project's AI provider override is",
  session: "This chat session was created with AI provider",
};

/**
 * The one message every refusal uses: what was found, that it is gone, the
 * supported providers, and where the migration note is.
 */
export function retiredProviderMessage(
  key: string,
  source: RetiredProviderSource = "AI_PROVIDER",
): string {
  const found = `${SOURCE_PHRASE[source]} "${key.trim()}"`;
  const tail =
    source === "session"
      ? " The session stays readable, but it can no longer send messages — start a new chat."
      : ` Choose one of the supported providers: ${AI_PROVIDER_KEYS.join(", ")}.`;
  return (
    `${found}, but GitHub Copilot support was removed from METIS.${tail}` +
    ` See ${COPILOT_MIGRATION_DOC} for the migration steps.`
  );
}

/**
 * Copilot-era env names the OpenAI / Azure providers used to read as a
 * fallback, mapped to what replaces each one. `COPILOT_PROVIDER_*` was read
 * only when the native name was unset, so the rename is exactly
 * "move the value to the new name".
 */
export const RETIRED_ENV_RENAMES: Readonly<
  Record<"openai" | "azure", ReadonlyArray<readonly [retired: string, replacement: string]>>
> = {
  openai: [
    ["COPILOT_PROVIDER_BASE_URL", "OPENAI_BASE_URL"],
    ["COPILOT_PROVIDER_API_KEY", "OPENAI_API_KEY"],
    ["COPILOT_MODEL", "AI_MODEL"],
  ],
  azure: [
    ["COPILOT_PROVIDER_BASE_URL", "AZURE_OPENAI_ENDPOINT"],
    ["COPILOT_PROVIDER_API_KEY", "AZURE_OPENAI_API_KEY"],
    ["COPILOT_MODEL", "AI_MODEL"],
  ],
};

const isSet = (raw: unknown): boolean => typeof raw === "string" && raw.trim().length > 0;

/**
 * For the `openai` / `azure` providers: every retired env name that is set
 * while its replacement is NOT. Such a deployment used to work through the
 * fallback; it must now be told which variable to rename. A retired name
 * whose replacement is also set is ignored (the replacement always won).
 * Other providers never read these names, so a leftover is harmless there.
 */
export function findRetiredEnvRenames(
  provider: string,
  env: NodeJS.ProcessEnv,
): Array<{ retired: string; replacement: string }> {
  if (provider !== "openai" && provider !== "azure") return [];
  return RETIRED_ENV_RENAMES[provider]
    .filter(([retired, replacement]) => isSet(env[retired]) && !isSet(env[replacement]))
    .map(([retired, replacement]) => ({ retired, replacement }));
}
