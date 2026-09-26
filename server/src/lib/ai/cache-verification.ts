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
 * Minimum cacheable prefix (tokens) below which the backend silently skips
 * caching (`cached_tokens = 0`, no error). Platform-split per the #696 research:
 *   • Sonnet 4.6 — 1,024 on Bedrock, 2,048 on the direct Anthropic API.
 *   • Haiku 4.5  — 4,096 on both platforms.
 * Sources: AWS Bedrock prompt-caching doc; Anthropic prompt-caching doc.
 */
export function cacheFloorTokens(model: string, platform: CachePlatform): number {
  const id = model.toLowerCase();
  if (id.includes("haiku")) return 4096;
  // Legacy Sonnet 4.5 / Opus 4.5 carry the 4,096 floor on both platforms.
  if (id.includes("sonnet-4-5") || id.includes("sonnet-4.5") || id.includes("opus")) return 4096;
  // Sonnet 4.6 (and unknown Sonnet ids) — platform-split floor.
  return platform === "bedrock" ? 1024 : 2048;
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
