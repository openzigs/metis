/**
 * Static rate map for `lib/finops/token-tracker.ts` (Epic #164).
 *
 * Rates are cents per 1k tokens. Values reflect published list prices as of
 * 2026-04 and intentionally err on the side of "slightly high" so projected
 * costs are conservative. The map is keyed by `provider:model` (case
 * sensitive). Unknown keys fall through to `DEFAULT_RATE` (zero cost) — the
 * caller still records the row for token accounting.
 *
 * Cost is computed as integer cents. We round half-up at the cent boundary
 * to avoid systematic under-billing.
 */
export interface TokenRate {
  /** Cents per 1,000 input tokens. */
  inputPer1k: number;
  /** Cents per 1,000 output tokens. */
  outputPer1k: number;
  /** Cents per 1,000 cache-read tokens (Bedrock prompt cache). */
  cacheReadPer1k?: number;
  /** Cents per 1,000 cache-write tokens (Bedrock prompt cache). */
  cacheWritePer1k?: number;
}

export const DEFAULT_RATE: TokenRate = {
  inputPer1k: 0,
  outputPer1k: 0,
};

// Published Anthropic API pricing (USD per 1M tokens) → cents per 1k tokens
// via `$X / MTok === (X / 10) cents-per-1k`. Source:
// https://platform.claude.com/docs/en/docs/about-claude/pricing (read 2026-06-25).
//   Sonnet 4.x : $3 in / $15 out / $0.30 cacheRead / $3.75 cacheWrite(5m)
//   Opus 4.5+  : $5 in / $25 out / $0.50 cacheRead / $6.25 cacheWrite(5m)
//   Haiku 4.5  : $1 in / $5 out / $0.10 cacheRead / $1.25 cacheWrite(5m)
const ANTHROPIC_SONNET_4: TokenRate = {
  inputPer1k: 0.3,
  outputPer1k: 1.5,
  cacheReadPer1k: 0.03,
  cacheWritePer1k: 0.375,
};
const ANTHROPIC_OPUS_4: TokenRate = {
  inputPer1k: 0.5,
  outputPer1k: 2.5,
  cacheReadPer1k: 0.05,
  cacheWritePer1k: 0.625,
};
const ANTHROPIC_HAIKU_4: TokenRate = {
  inputPer1k: 0.1,
  outputPer1k: 0.5,
  cacheReadPer1k: 0.01,
  cacheWritePer1k: 0.125,
};

const RATES: ReadonlyMap<string, TokenRate> = new Map([
  // ── Anthropic direct API — BARE 4.x model ids (Issue #428) ──────────────
  // AnthropicProvider emits bare ids (claude-sonnet-4-6, claude-opus-4-8,
  // claude-haiku-4-5) after normalizeAnthropicModelId(); these are what land
  // in TokenUsage.model. They were previously absent from the table so the
  // "By provider" anthropic row billed at $0.00 despite non-zero tokens.
  ["anthropic:claude-sonnet-4-6", ANTHROPIC_SONNET_4],
  ["anthropic:claude-sonnet-4-5", ANTHROPIC_SONNET_4],
  ["anthropic:claude-sonnet-4", ANTHROPIC_SONNET_4],
  ["anthropic:claude-opus-4-8", ANTHROPIC_OPUS_4],
  ["anthropic:claude-opus-4-6", ANTHROPIC_OPUS_4],
  ["anthropic:claude-opus-4-5", ANTHROPIC_OPUS_4],
  ["anthropic:claude-haiku-4-5", ANTHROPIC_HAIKU_4],
  // Bare 4.x default fallbacks keyed by family (handles dated/suffixed ids).
  ["anthropic:default", ANTHROPIC_SONNET_4],
  // Anthropic Claude 3.5 Sonnet (direct API)
  [
    "anthropic:claude-3-5-sonnet-20241022",
    { inputPer1k: 0.3, outputPer1k: 1.5, cacheReadPer1k: 0.03, cacheWritePer1k: 0.375 },
  ],
  ["anthropic:claude-3-5-sonnet", { inputPer1k: 0.3, outputPer1k: 1.5 }],
  ["anthropic:claude-3-5-haiku", { inputPer1k: 0.1, outputPer1k: 0.5 }],
  ["anthropic:claude-3-opus", { inputPer1k: 1.5, outputPer1k: 7.5 }],
  // Bedrock-hosted Claude Sonnet 4.6 (legacy id, kept for historical usage rows)
  [
    "bedrock-gateway:us.anthropic.claude-sonnet-4-6",
    { inputPer1k: 0.3, outputPer1k: 1.5, cacheReadPer1k: 0.03, cacheWritePer1k: 0.375 },
  ],
  [
    "bedrock-gateway:anthropic.claude-sonnet-4-6",
    { inputPer1k: 0.3, outputPer1k: 1.5, cacheReadPer1k: 0.03, cacheWritePer1k: 0.375 },
  ],
  // Bedrock-hosted Claude Sonnet 5 (current default; see model-router.ts)
  [
    "bedrock-gateway:us.anthropic.claude-sonnet-5",
    { inputPer1k: 0.3, outputPer1k: 1.5, cacheReadPer1k: 0.03, cacheWritePer1k: 0.375 },
  ],
  // Bedrock-hosted Claude Opus 4.8 — no published Bedrock rate yet; using the
  // nearest published Opus 4.x tier as an approximation.
  ["bedrock-gateway:us.anthropic.claude-opus-4-8", ANTHROPIC_OPUS_4],
  // Bedrock-hosted Claude Fable 5 — no published rate; approximated from the
  // Haiku tier pending real pricing data.
  ["bedrock-gateway:us.anthropic.claude-fable-5", ANTHROPIC_HAIKU_4],
  // Bedrock-hosted Claude 3.5 Sonnet (legacy)
  [
    "bedrock-gateway:anthropic.claude-3-5-sonnet-20241022-v2:0",
    { inputPer1k: 0.3, outputPer1k: 1.5, cacheReadPer1k: 0.03, cacheWritePer1k: 0.375 },
  ],
  [
    "bedrock-gateway:anthropic.claude-3-5-sonnet-20240620-v1:0",
    { inputPer1k: 0.3, outputPer1k: 1.5 },
  ],
  [
    "bedrock-gateway:anthropic.claude-3-5-haiku-20241022-v1:0",
    { inputPer1k: 0.1, outputPer1k: 0.5 },
  ],
  ["bedrock-gateway:anthropic.claude-3-opus-20240229-v1:0", { inputPer1k: 1.5, outputPer1k: 7.5 }],
  // OpenAI
  ["openai:gpt-4o", { inputPer1k: 0.25, outputPer1k: 1.0 }],
  ["openai:gpt-4o-2024-08-06", { inputPer1k: 0.25, outputPer1k: 1.0 }],
  ["openai:gpt-4o-mini", { inputPer1k: 0.015, outputPer1k: 0.06 }],
  ["openai:gpt-4-turbo", { inputPer1k: 1.0, outputPer1k: 3.0 }],
  // Azure OpenAI — same effective rates as OpenAI direct
  ["azure:gpt-4o", { inputPer1k: 0.25, outputPer1k: 1.0 }],
  ["azure:gpt-4o-mini", { inputPer1k: 0.015, outputPer1k: 0.06 }],
  // METIS-internal stubs — no rate.
  ["copilot-native:default", DEFAULT_RATE],
  ["copilot-native:gpt-4o", DEFAULT_RATE],
  ["offline-stub:offline-stub", DEFAULT_RATE],
  ["offline-stub:default", DEFAULT_RATE],
]);

export function getRate(provider: string, model: string): TokenRate {
  const exact = RATES.get(`${provider}:${model}`);
  if (exact) return exact;
  // Issue #428 — bare anthropic ids may carry a date/version suffix
  // (e.g. "claude-sonnet-4-5-20250929"). Match the model FAMILY so dated
  // variants still attract a non-zero, correctly-tiered rate instead of
  // silently falling through to DEFAULT_RATE (the original $0.00 bug).
  if (provider === "anthropic") {
    const family = anthropicFamilyRate(model);
    if (family) return family;
  }
  // Allow callers to query the provider with no model (rare).
  const fallback = RATES.get(`${provider}:default`);
  return fallback ?? DEFAULT_RATE;
}

/**
 * Map a bare anthropic model id to its 4.x family rate by prefix. Returns
 * `undefined` for ids we don't recognise (e.g. legacy 3.x) so the caller can
 * continue its normal exact/default lookup.
 */
function anthropicFamilyRate(model: string): TokenRate | undefined {
  if (/^claude-opus-4/.test(model)) return ANTHROPIC_OPUS_4;
  if (/^claude-sonnet-4/.test(model)) return ANTHROPIC_SONNET_4;
  if (/^claude-haiku-4/.test(model)) return ANTHROPIC_HAIKU_4;
  return undefined;
}

/**
 * Compute the integer-cent cost for a usage row.
 *
 * Standard input/output tokens use the headline rate. Cache-read is usually
 * the cheapest tier (Bedrock advertises ~10% of input). Cache-write is more
 * expensive than vanilla input (Anthropic charges 1.25× input). Both
 * default to the input rate when the provider doesn't publish a separate
 * cache rate so we don't silently under-bill.
 */
export function computeCostCents(
  rate: TokenRate,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): number {
  const cacheRead = rate.cacheReadPer1k ?? rate.inputPer1k;
  const cacheWrite = rate.cacheWritePer1k ?? rate.inputPer1k;
  const cents =
    (usage.inputTokens * rate.inputPer1k) / 1000 +
    (usage.outputTokens * rate.outputPer1k) / 1000 +
    ((usage.cacheReadTokens ?? 0) * cacheRead) / 1000 +
    ((usage.cacheWriteTokens ?? 0) * cacheWrite) / 1000;
  // Round half-up to the integer cent.
  return Math.round(cents);
}

/** Test-only helper. */
export function __testRateKeys(): string[] {
  return Array.from(RATES.keys()).sort();
}
