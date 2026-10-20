/**
 * Issue #697 (Epic #696) — prompt-cache end-to-end verification logic.
 *
 * A spike found that nonzero prompt-cache hits have NEVER been confirmed live
 * through the Bedrock gateway (`docs/OPERATIONS.md` §7.5). This module holds the
 * pure, provider-agnostic logic the verification harness
 * (`server/scripts/verify-prompt-cache.ts`) uses to turn a pair of provider
 * `usage` payloads (a cache-WRITE warm-up call followed by a cache-READ measured
 * call over an identical repeated prefix) into a verdict — WITHOUT any live
 * gateway or network dependency, so it is fully unit-testable.
 *
 * The subtle correctness risk this module exists to pin down: the two provider
 * shapes disagree on what "prompt tokens" means.
 *
 *   • OpenAI-compatible gateway (`bedrock-direct-provider.ts`,
 *     `openai-compatible-provider.ts`): `usage.prompt_tokens` INCLUDES the
 *     cached tokens; the read portion rides in
 *     `usage.prompt_tokens_details.cached_tokens`. There is NO field for cache
 *     creation, so a write is never reported on this path.
 *   • Native Anthropic SDK (`anthropic-provider.ts`): `usage.input_tokens`
 *     EXCLUDES the cache fields; `cache_read_input_tokens` and
 *     `cache_creation_input_tokens` are reported separately.
 *
 * If a caller naively used `prompt_tokens`/`input_tokens` as the hit-ratio
 * denominator across both paths it would be right on one and wrong on the other.
 * {@link normalizeOpenAICompatibleUsage} / {@link normalizeAnthropicNativeUsage}
 * / {@link normalizeTokenUsage} collapse both conventions to a single canonical
 * {@link NormalizedCacheUsage} whose `totalPromptTokens` is always the true full
 * prompt size (fresh + read + write).
 *
 * OWASP (A09): this module handles only integer token counts + model ids; it
 * never touches secrets, headers, or ARNs.
 */
import { computeCacheHitRatio } from "./cache-hit-telemetry.js";
import type { TokenUsage, UsageProvider } from "./types.js";

/**
 * How a provider's `usage` payload accounts for cached tokens.
 *   • `openai-compatible` — `prompt_tokens` INCLUDES cached; no write field.
 *   • `anthropic-native`  — `input_tokens` EXCLUDES cache; read + write reported.
 */
export type CacheUsageConvention = "openai-compatible" | "anthropic-native";

/** Raw OpenAI-compatible `usage` shape (Bedrock gateway / OpenAI / vLLM). */
export interface OpenAICompatibleUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** `null` is tolerated (some runtimes omit the object entirely). */
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** Raw native-Anthropic `usage` shape (official SDK Messages API). */
export interface AnthropicNativeUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Canonical, convention-independent cache accounting for one call. */
export interface NormalizedCacheUsage {
  /**
   * TRUE total prompt size = fresh input + cache reads + cache writes,
   * regardless of the source provider's convention. This is the correct
   * hit-ratio denominator.
   */
  totalPromptTokens: number;
  /** Fresh (uncached) input tokens billed at full input rate. */
  freshInputTokens: number;
  /** Cache READ tokens (billed at ~0.1× input). */
  cacheReadTokens: number;
  /**
   * Cache CREATION tokens (billed at 1.25×/2× input). 0 when the source shape
   * has no field for it — see {@link cacheWriteReported}.
   */
  cacheWriteTokens: number;
  /**
   * True when the source shape actually surfaces cache creation. On the
   * OpenAI-compatible gateway path this is `false`, so a `cacheWriteTokens` of 0
   * means "not reported" — NOT "confirmed zero writes".
   */
  cacheWriteReported: boolean;
}

/** Coerce any input to a finite, non-negative integer count (default 0). */
function safeCount(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Normalize an OpenAI-compatible `usage` payload. `prompt_tokens` INCLUDES the
 * cached tokens, so `totalPromptTokens = prompt_tokens` and the fresh portion is
 * `prompt_tokens - cached_tokens`. Cache creation is never reported on this
 * path, so `cacheWriteReported` is `false`.
 */
export function normalizeOpenAICompatibleUsage(
  raw: OpenAICompatibleUsageShape | null | undefined,
): NormalizedCacheUsage {
  const totalPromptTokens = safeCount(raw?.prompt_tokens);
  // Clamp reads to the reported prompt total — a gateway that reports more
  // cached than prompt tokens is malformed; never let fresh go negative.
  const cacheReadTokens = Math.min(
    safeCount(raw?.prompt_tokens_details?.cached_tokens),
    totalPromptTokens,
  );
  return {
    totalPromptTokens,
    freshInputTokens: totalPromptTokens - cacheReadTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    cacheWriteReported: false,
  };
}

/**
 * Normalize a native-Anthropic `usage` payload. `input_tokens` EXCLUDES the
 * cache fields, so the true total is `input_tokens + cache_read + cache_write`.
 * Both cache halves are reported, so `cacheWriteReported` is `true`.
 */
export function normalizeAnthropicNativeUsage(
  raw: AnthropicNativeUsageShape | null | undefined,
): NormalizedCacheUsage {
  const freshInputTokens = safeCount(raw?.input_tokens);
  const cacheReadTokens = safeCount(raw?.cache_read_input_tokens);
  const cacheWriteTokens = safeCount(raw?.cache_creation_input_tokens);
  return {
    totalPromptTokens: freshInputTokens + cacheReadTokens + cacheWriteTokens,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWriteReported: true,
  };
}

/**
 * Normalize METIS's already-mapped {@link TokenUsage}. The gotcha the harness
 * relies on: `usage.promptTokens` follows the SAME convention as the raw shape
 * the provider mapped it from, so the caller MUST pass the provider's
 * convention. On `openai-compatible`, `promptTokens` includes the cache reads;
 * on `anthropic-native` it excludes them.
 */
export function normalizeTokenUsage(
  usage: TokenUsage,
  convention: CacheUsageConvention,
): NormalizedCacheUsage {
  const cacheReadTokens = safeCount(usage.cacheReadTokens);
  const cacheWriteTokens = safeCount(usage.cacheWriteTokens);
  const promptTokens = safeCount(usage.promptTokens);
  if (convention === "anthropic-native") {
    return {
      totalPromptTokens: promptTokens + cacheReadTokens + cacheWriteTokens,
      freshInputTokens: promptTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWriteReported: true,
    };
  }
  // openai-compatible: promptTokens already includes the reads.
  const clampedRead = Math.min(cacheReadTokens, promptTokens);
  return {
    totalPromptTokens: promptTokens,
    freshInputTokens: promptTokens - clampedRead,
    cacheReadTokens: clampedRead,
    cacheWriteTokens: 0,
    cacheWriteReported: false,
  };
}

/**
 * Map a METIS {@link UsageProvider} to its cache-usage convention. Only the native
 * `anthropic` provider excludes cache tokens from the prompt count; every other
 * key (bedrock gateway, openai, azure, local) is OpenAI-compatible.
 */
export function conventionForProvider(provider: UsageProvider): CacheUsageConvention {
  return provider === "anthropic" ? "anthropic-native" : "openai-compatible";
}

/** Verdict for one verification run over a repeated prefix. */
export type CacheVerdict = "cache-confirmed" | "write-only" | "no-cache-observed";

/** Outcome of a two-call (warm-up write → measured read) verification run. */
export interface CacheVerificationResult {
  /** Normalized usage from the first (cold) call — expected to CREATE the cache. */
  warmup: NormalizedCacheUsage;
  /** Normalized usage from the second (warm) call — expected to READ the cache. */
  measured: NormalizedCacheUsage;
  /** Read-based hit ratio on the measured call = cacheRead / totalPrompt, clamped [0,1]. */
  hitRatio: number;
  /** True when the measured call reported any cache read — the load-bearing signal. */
  cacheReadObserved: boolean;
  /** True when EITHER call reported cache creation (only possible on the native path). */
  cacheWriteObserved: boolean;
  verdict: CacheVerdict;
}

/**
 * Turn a warm-up + measured pair of normalized usages into a verdict.
 *
 *   • `cache-confirmed`   — the measured (warm) call reported cache reads. The
 *     only outcome that proves caching works end-to-end.
 *   • `write-only`        — no reads, but a write was reported. The cache was
 *     created but never read back (unstable prefix, region-local cache miss, or
 *     TTL expiry) — caching is NOT paying off.
 *   • `no-cache-observed` — neither reads nor a reported write. On the
 *     OpenAI-compatible path (no write field) this is the default even when a
 *     write silently happened, so treat it as "reads never confirmed", which is
 *     exactly the #697 silent-failure risk.
 */
export function summarizeCacheVerification(input: {
  warmup: NormalizedCacheUsage;
  measured: NormalizedCacheUsage;
}): CacheVerificationResult {
  const { warmup, measured } = input;
  const cacheReadObserved = measured.cacheReadTokens > 0;
  const cacheWriteObserved = warmup.cacheWriteTokens > 0 || measured.cacheWriteTokens > 0;
  const verdict: CacheVerdict = cacheReadObserved
    ? "cache-confirmed"
    : cacheWriteObserved
      ? "write-only"
      : "no-cache-observed";
  return {
    warmup,
    measured,
    hitRatio: computeCacheHitRatio(measured.cacheReadTokens, measured.totalPromptTokens),
    cacheReadObserved,
    cacheWriteObserved,
    verdict,
  };
}

/** Which platform's cache floors apply. */
export type CachePlatform = "bedrock" | "anthropic";

/**
 * Minimum cacheable prefix per Claude `family-version`, in tokens. Below it
 * the backend silently skips caching (`cached_tokens = 0`, no error, no write
 * charge).
 *
 * #1277 review — every row re-read 2026-10-19 from the two official tables:
 *   - Anthropic: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *     ("These minimums apply on every platform where each model is available";
 *     for Bedrock it defers to AWS's page).
 *   - Bedrock: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 * The two agree except Opus 4.7: 2,048 on Anthropic's page, 4,096 on Bedrock's.
 * The #696-era rules this replaced (Sonnet 4.6 at 2,048 direct; Sonnet 4.5 and
 * every Opus at 4,096) no longer match either page.
 */
const CACHE_FLOORS: Readonly<Record<string, number>> = {
  "fable-5": 512,
  "fable-5.1": 512,
  "mythos-5": 512,
  "mythos-5.1": 512,
  "mythos-preview": 2048,
  "opus-5.5": 512,
  "opus-5": 512,
  "opus-4.8": 1024,
  "opus-4.7": 2048,
  "opus-4.6": 4096,
  "opus-4.5": 4096,
  "opus-4.1": 1024,
  "opus-4": 1024,
  "sonnet-5.5": 512,
  "sonnet-5": 1024,
  "sonnet-4.6": 1024,
  "sonnet-4.5": 1024,
  "sonnet-4": 1024,
  "sonnet-3.7": 1024,
  "sonnet-3.5": 1024,
  "haiku-5.5": 512,
  "haiku-4.5": 4096,
  "haiku-3.5": 2048,
};
/** Where Bedrock's table differs from Anthropic's. */
const BEDROCK_CACHE_FLOORS: Readonly<Record<string, number>> = { "opus-4.7": 4096 };
/**
 * #1284 — an id no row names gets its family's LOWEST listed floor (and an id
 * with no family, the lowest of any row). The floor gates the docs-gen
 * warm-up (`prompt-cache-warmup.ts`), so the two ways to guess wrong cost
 * different things:
 *   - too LOW: a prefix under the real minimum is not cached, and the fan-out
 *     waits for the first reply to begin for nothing. That costs latency.
 *   - too HIGH: the warm-up is skipped, every parallel batch writes the shared
 *     prefix itself, and each write is billed at the cache-write premium. That
 *     costs money, and it is the #1277 race back again.
 * The likeliest unknown id is a newer model, and every family's newest
 * generation sits at its lowest floor, so the lowest is also the likeliest right.
 */
function lowestFloor(family: string | null): number {
  const floors = Object.entries(CACHE_FLOORS)
    .filter(([key]) => family === null || key.startsWith(`${family}-`))
    .map(([, floor]) => floor);
  return Math.min(...floors);
}

/** `family-major[.minor]` of a Claude id, in any spelling; `null` for none. */
function claudeFloorKey(model: string): { key: string | null; family: string | null } {
  const id = model.toLowerCase();
  if (/mythos-preview/.test(id)) return { key: "mythos-preview", family: "mythos" };
  // Legacy spelling: claude-3-5-sonnet, claude-3-7-sonnet, claude-3-5-haiku.
  const legacy = /claude-(\d)-(\d)-(sonnet|haiku|opus)/.exec(id);
  if (legacy) return { key: `${legacy[3]}-${legacy[1]}.${legacy[2]}`, family: legacy[3]! };
  // Current spelling: family-major, then an optional ONE-or-two-digit minor —
  // a dated snapshot suffix (`-20260301`) is not a minor version.
  const current = /(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(id);
  if (!current) {
    const family = /(opus|sonnet|haiku|fable|mythos)/.exec(id)?.[1] ?? null;
    return { key: null, family };
  }
  const [, family, major, minor] = current;
  return { key: minor ? `${family}-${major}.${minor}` : `${family}-${major}`, family: family! };
}

export function cacheFloorTokens(model: string, platform: CachePlatform): number {
  const { key, family } = claudeFloorKey(model);
  if (key !== null) {
    const bedrock = platform === "bedrock" ? BEDROCK_CACHE_FLOORS[key] : undefined;
    const floor = bedrock ?? CACHE_FLOORS[key];
    if (floor !== undefined) return floor;
  }
  return lowestFloor(family);
}

/** Whether a prefix clears its model+platform floor. */
export type CacheFloorOutcome = "expected-hit" | "below-floor-expected-zero";

/**
 * Predict whether a cacheable prefix of `prefixTokens` should register hits for
 * `model` on `platform`. Drives the "expected?" column of the verification
 * matrix — e.g. the ~2,225-token analysis prefix on the Haiku route
 * (floor 4,096) predicts `below-floor-expected-zero`.
 */
export function expectedCacheOutcome(
  prefixTokens: number,
  model: string,
  platform: CachePlatform,
): CacheFloorOutcome {
  const floor = cacheFloorTokens(model, platform);
  return safeCount(prefixTokens) >= floor ? "expected-hit" : "below-floor-expected-zero";
}
