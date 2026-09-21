/**
 * Native-Anthropic prompt-cache TTL resolution (Epic #696 / Issue #702).
 *
 * The direct Anthropic Messages API accepts an optional `ttl: "1h"` on a
 * `cache_control` breakpoint, extending the cache lifetime from the default
 * 5 minutes to 1 hour at 2× the one-time write cost (reads stay 0.1×). This is
 * a DIRECT-ANTHROPIC-ONLY capability: Bedrock does not support a 1h TTL for
 * Sonnet 4.6 / Opus 4.6 (5-min only), so this knob is never consulted on the
 * Bedrock / gateway path.
 *
 * This module is the single place the `ANTHROPIC_PROMPT_CACHE_TTL` config key is
 * read, so the provider (wire shape) and the token-tracker (cost multiplier)
 * stay in lock-step from one source of truth. It is intentionally tiny and
 * pure-ish (config is injectable) so both consumers can unit-test it without
 * touching the global singleton.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";

/** Registry key for the native-Anthropic prompt-cache TTL. */
export const ANTHROPIC_PROMPT_CACHE_TTL_KEY = "ANTHROPIC_PROMPT_CACHE_TTL";

/** Supported prompt-cache TTLs. `"5m"` is the default (bare breakpoint). */
export type PromptCacheTtl = "5m" | "1h";

/**
 * The `cache_control` breakpoint object emitted on a text block. The `ttl` field
 * is present ONLY for the 1-hour TTL — the 5-minute default emits a bare
 * `{ type: "ephemeral" }` so an un-flagged request is byte-for-byte unchanged.
 */
export type CacheControl = { type: "ephemeral"; ttl?: "1h" };

/**
 * Resolve the configured native-Anthropic prompt-cache TTL. Defaults to `"5m"`
 * when unset or set to anything other than the exact string `"1h"`.
 *
 * `config` is injectable for tests; production callers use the process-wide
 * singleton. Read per-request (not cached on the provider) so a runtime config
 * change to a tunable key takes effect without a restart.
 */
export function resolveAnthropicCacheTtl(
  config: ConfigService = getConfigService(),
): PromptCacheTtl {
  return config.get(ANTHROPIC_PROMPT_CACHE_TTL_KEY) === "1h" ? "1h" : "5m";
}

/**
 * Build the `cache_control` breakpoint for a given TTL. `"1h"` carries the
 * explicit `ttl`; `"5m"` returns a BARE `{ type: "ephemeral" }` (no `ttl` key at
 * all) — the byte-identical regression guard for the default path.
 */
export function cacheControlFor(ttl: PromptCacheTtl): CacheControl {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}
