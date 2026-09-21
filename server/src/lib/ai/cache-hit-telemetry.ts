/**
 * Issue #390 — Bedrock prompt-cache hit-ratio telemetry (in-process emission).
 *
 * Prompt caching only pays off if it actually HITS. Bedrock fails *silently*
 * when the cacheable prefix is unstable or under the model's min-token floor:
 * no error, just `cached_tokens = 0`. Before this module there was no
 * visibility into the cache-hit ratio, so we could not confirm the caching
 * work (cacheable prefix, region pinning, model-min reconciliation) was paying
 * off.
 *
 * Scope (deliberately small): per-call metric/log EMISSION plus a tiny
 * in-process aggregator. The underlying `usage.cacheReadTokens` value is
 * ALREADY parsed by the provider from the gateway response — this module only
 * derives the hit ratio, logs it tagged by call type + model, and accumulates
 * per-(callType, model) totals. It is dependency-free and in-process: NO
 * external metrics backend, NO dashboard, NO alert wiring (those are ops infra,
 * out of scope here and flagged as follow-ups on the PR).
 *
 * READS vs WRITES (important): the OpenAI-compatible gateway path
 * (`bedrock-direct-provider.ts`) reports cache **reads** only — the
 * OpenAI-compatible `usage` shape surfaces `prompt_tokens_details.cached_tokens`
 * but has no field for cache CREATION. So the hit ratio computed here is a
 * READ ratio (`cacheReadTokens / promptTokens`). If write-cost visibility is
 * ever needed, the native Anthropic path (`anthropic-provider.ts`) reports BOTH
 * `cache_creation_input_tokens` and `cache_read_input_tokens`.
 *
 * OWASP (A09 — logging failures): emissions carry ONLY the model ID, the call
 * type, and the integer token counts/ratio. The API key, the `Authorization`
 * header, and full inference-profile ARNs are NEVER logged. As defence in
 * depth, {@link redactModelForLog} strips an ARN passed (by a bug or hostile
 * caller) in the `model` position so the account id / resource path can never
 * leak through this code path.
 */
import { createChildLogger } from "../logger.js";
import type { CacheTelemetryCallType } from "./types.js";

const log = createChildLogger("ai-cache-hit-telemetry");

/**
 * Compute a prompt-cache hit ratio: `cacheReadTokens / promptTokens`, clamped
 * to `[0, 1]`.
 *
 * Hardened for telemetry use: a zero/negative/NaN `promptTokens` (the
 * silent-cache-miss case, where Bedrock returns `cached_tokens = 0` and a
 * caller could even see 0 prompt tokens) yields `0` rather than `Infinity` or
 * `NaN` — so the value is always a safe, plottable number. A read larger than
 * the prompt (should not happen, but defends against a malformed gateway
 * response) is clamped to `1`.
 *
 * Exported for direct unit testing of the math.
 */
export function computeCacheHitRatio(cacheReadTokens: number, promptTokens: number): number {
  if (!Number.isFinite(cacheReadTokens) || !Number.isFinite(promptTokens)) return 0;
  if (cacheReadTokens <= 0 || promptTokens <= 0) return 0;
  const ratio = cacheReadTokens / promptTokens;
  if (!Number.isFinite(ratio) || ratio < 0) return 0;
  return ratio > 1 ? 1 : ratio;
}

/**
 * Redact a value that lands in the `model` position before it is logged. A
 * model ID (e.g. `claude-sonnet-4-6`, `us.anthropic.claude-...`) is a safe,
 * non-secret identifier and passes through unchanged. An inference-profile ARN
 * (which embeds the AWS account id and resource path) must NOT be logged, so it
 * is collapsed to the constant `"<redacted-arn>"`. This is defence in depth:
 * the provider already resolves to a model ID for the tag, but a future caller
 * passing an ARN must never leak it through this telemetry path (OWASP A09).
 *
 * Exported for direct unit testing of the redaction rule.
 */
export function redactModelForLog(model: string): string {
  return /^arn:aws:/i.test(model.trim()) ? "<redacted-arn>" : model;
}

/**
 * Reads-per-write ratio: `cacheReadTokens / cacheWriteTokens`, the cross-region
 * cache-fragmentation signal (epic #696). A HIGH ratio means the cache is being
 * amortised — many cheap reads (0.1× input) per one-time write (1.25× input). A
 * ratio trending toward the write cost signals fragmentation: `us.anthropic.*`
 * cross-region inference profiles have region-local caches, so AWS warns of
 * "increased cache writes" under high demand and hit rates are structurally
 * lower (do NOT propose region pinning — cross-region routing is intentional).
 *
 * Returns `null` when there are no cache writes (`cacheWriteTokens <= 0`), which
 * is the normal case on the OpenAI-compatible gateway path — that shape reports
 * cache READS only and never surfaces creation, so the ratio is undefined
 * rather than a misleading `Infinity`/`0`. A negative/NaN input also yields
 * `null`.
 *
 * Exported for direct unit testing of the math.
 */
export function computeReadWriteRatio(
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number | null {
  if (!Number.isFinite(cacheReadTokens) || !Number.isFinite(cacheWriteTokens)) return null;
  if (cacheWriteTokens <= 0) return null;
  const reads = Math.max(0, cacheReadTokens);
  return reads / cacheWriteTokens;
}

/** A single per-call cache-hit sample. */
export interface CacheHitSample {
  /** Workload tag. Defaults to `"unknown"` when omitted. */
  callType?: CacheTelemetryCallType;
  /** Model ID (NOT an ARN — see {@link redactModelForLog}). */
  model: string;
  /** Cache READ tokens reported by the gateway for this call. */
  cacheReadTokens: number;
  /** Total prompt tokens for this call (the hit-ratio denominator). */
  promptTokens: number;
  /**
   * Cache CREATION (write) tokens for this call, where the provider path
   * surfaces them. Only the native Anthropic path reports
   * `cache_creation_input_tokens`; the OpenAI-compatible gateway path has no
   * creation field, so this is absent (treated as `0`) there. See the
   * READS-vs-WRITES note in this file's header.
   */
  cacheWriteTokens?: number;
}

/** Rolling per-(callType, model) accumulation. */
export interface CacheHitStats {
  callType: CacheTelemetryCallType;
  model: string;
  /** Number of calls accumulated into this bucket. */
  calls: number;
  /** Running sum of cache READ tokens across the bucket's calls. */
  sumCacheReadTokens: number;
  /**
   * Running sum of cache CREATION (write) tokens across the bucket's calls.
   * Populated only where the provider path reports creation (native Anthropic);
   * stays `0` on the gateway path, which surfaces reads only.
   */
  sumCacheWriteTokens: number;
  /** Running sum of prompt tokens across the bucket's calls. */
  sumPromptTokens: number;
  /**
   * Rolling hit ratio = `sumCacheReadTokens / sumPromptTokens`, with the same
   * divide-by-zero guard as {@link computeCacheHitRatio}.
   */
  hitRatio: number;
}

const DEFAULT_CALL_TYPE: CacheTelemetryCallType = "unknown";

/** Composite key for the per-(callType, model) bucket map. `\u0000` can never appear in either part. */
function bucketKey(callType: CacheTelemetryCallType, model: string): string {
  return `${callType}\u0000${model}`;
}

/**
 * In-process, dependency-free aggregator of prompt-cache hit telemetry. It
 * accumulates per-(callType, model) totals so a future readout (or a flush to
 * an external backend, intentionally NOT implemented here) can report the
 * rolling hit ratio per workload. There is no timer, no I/O, and no external
 * dependency — it is a plain in-memory map, safe to keep for the process
 * lifetime.
 */
export class CacheHitAggregator {
  private readonly buckets = new Map<
    string,
    {
      callType: CacheTelemetryCallType;
      model: string;
      calls: number;
      read: number;
      write: number;
      prompt: number;
    }
  >();

  /** Accumulate one call's tokens into its (callType, model) bucket. */
  record(sample: CacheHitSample): void {
    const callType = sample.callType ?? DEFAULT_CALL_TYPE;
    const model = sample.model;
    const key = bucketKey(callType, model);
    const read = Number.isFinite(sample.cacheReadTokens) ? Math.max(0, sample.cacheReadTokens) : 0;
    const write = Number.isFinite(sample.cacheWriteTokens)
      ? Math.max(0, sample.cacheWriteTokens as number)
      : 0;
    const prompt = Number.isFinite(sample.promptTokens) ? Math.max(0, sample.promptTokens) : 0;
    const existing = this.buckets.get(key);
    if (existing) {
      existing.calls += 1;
      existing.read += read;
      existing.write += write;
      existing.prompt += prompt;
    } else {
      this.buckets.set(key, { callType, model, calls: 1, read, write, prompt });
    }
  }

  /** Snapshot the rolling stats for one (callType, model) bucket, or `undefined` if unseen. */
  snapshot(callType: CacheTelemetryCallType, model: string): CacheHitStats | undefined {
    const b = this.buckets.get(bucketKey(callType, model));
    if (!b) return undefined;
    return {
      callType: b.callType,
      model: b.model,
      calls: b.calls,
      sumCacheReadTokens: b.read,
      sumCacheWriteTokens: b.write,
      sumPromptTokens: b.prompt,
      hitRatio: computeCacheHitRatio(b.read, b.prompt),
    };
  }

  /** Snapshot every bucket — for a future periodic readout / flush. */
  allSnapshots(): CacheHitStats[] {
    return [...this.buckets.values()].map((b) => ({
      callType: b.callType,
      model: b.model,
      calls: b.calls,
      sumCacheReadTokens: b.read,
      sumCacheWriteTokens: b.write,
      sumPromptTokens: b.prompt,
      hitRatio: computeCacheHitRatio(b.read, b.prompt),
    }));
  }

  /** Clear all buckets (used by the test reset helper). */
  reset(): void {
    this.buckets.clear();
  }
}

let singleton: CacheHitAggregator | null = null;

/** Shared process-wide aggregator. Lazily constructed; in-memory only. */
export function getCacheHitAggregator(): CacheHitAggregator {
  if (!singleton) singleton = new CacheHitAggregator();
  return singleton;
}

/** Test helper — drop the singleton so each test starts from a clean aggregator. */
export function __resetCacheHitAggregatorSingleton(): void {
  if (singleton) singleton.reset();
  singleton = null;
}

/**
 * Record ONE call's prompt-cache result: derive the per-call hit ratio, emit a
 * structured `info` log line tagged by call type and (redacted) model, and
 * accumulate into the shared in-process aggregator.
 *
 * This is the single entry point the provider calls after each `chat()` /
 * `stream()` completes. It never throws on bad input (a 0/NaN denominator
 * yields ratio 0) so telemetry can never break a request. It logs ONLY the
 * model ID, the call type, and the integer token counts/ratio — never a secret
 * (OWASP A09).
 */
export function recordCacheHit(sample: CacheHitSample): void {
  const callType = sample.callType ?? DEFAULT_CALL_TYPE;
  const safeModel = redactModelForLog(sample.model);
  const cacheReadTokens = Number.isFinite(sample.cacheReadTokens)
    ? Math.max(0, sample.cacheReadTokens)
    : 0;
  const cacheWriteTokens = Number.isFinite(sample.cacheWriteTokens)
    ? Math.max(0, sample.cacheWriteTokens as number)
    : 0;
  const promptTokens = Number.isFinite(sample.promptTokens) ? Math.max(0, sample.promptTokens) : 0;
  const hitRatio = computeCacheHitRatio(cacheReadTokens, promptTokens);

  getCacheHitAggregator().record({
    callType,
    model: safeModel,
    cacheReadTokens,
    cacheWriteTokens,
    promptTokens,
  });

  // NOTE: only identifiers + token counts — never the API key, Authorization
  // header, or a full ARN (the model is already ARN-redacted above).
  log.info("prompt cache hit", {
    callType,
    model: safeModel,
    cacheReadTokens,
    cacheWriteTokens,
    promptTokens,
    hitRatio,
  });
}
