/**
 * THE model-pricing source (Epic #164, #22).
 *
 * Both usage tables are priced from here: `token_usages` (finops
 * `recordUsage`, integer cents) and `ai_token_usages` (`TokenTracker`, USD via
 * `estimateCostUsd` in `lib/ai/token-tracker.ts`). Before #22 each had its own
 * table and they disagreed in opposite directions for a model neither knew:
 * `token_usages` billed it at Claude Sonnet 4.6 rates through an
 * `anthropic:default` fallback, `ai_token_usages` recorded `0`.
 *
 * Rates are cents per 1k tokens. Resolution order ({@link resolveRate}):
 *   1. an administrator's per-model price (`MODEL_PRICES` tunable, USD/MTok);
 *   2. the built-in list prices below — SKIPPED for the `anthropic` provider
 *      when `ANTHROPIC_BASE_URL` points somewhere other than Anthropic, because
 *      an Anthropic-compatible endpoint (DeepSeek, …) bills its own prices even
 *      for a `claude-*` model name it maps onto one of its own models. A proxy
 *      or gateway that relays to Anthropic opts back in with
 *      `ANTHROPIC_BASE_URL_BILLS_AS=anthropic`;
 *   3. a Claude-family match on the model id, then a `provider:default` row —
 *      which exists only for providers that genuinely cost nothing per token
 *      (offline-stub, copilot-native, self-hosted local-gemma);
 *   4. otherwise `null` — UNPRICED. Never `0`, and never another model's price.
 *
 * Cost is computed as integer cents. We round half-up at the cent boundary
 * to avoid systematic under-billing.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";
import { MODEL_PRICES_KEY, modelPricesSchema, type ModelPrice } from "./model-prices-schema.js";

export { MODEL_PRICES_KEY, modelPricesSchema, type ModelPrice };

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

/**
 * A genuinely zero rate — for METIS-internal stubs whose calls cost nothing.
 * It is NOT a fallback: an unknown model resolves to `null` (unpriced).
 */
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
// Re-read 2026-09-21 for #22, adding:
//   Sonnet 5   : $2 in / $10 out / $0.20 cacheRead / $2.50 cacheWrite(5m)
//   Opus 4/4.1 : $15 in / $75 out / $1.50 cacheRead / $18.75 cacheWrite(5m)
//   Fable 5    : $10 in / $50 out / $1 cacheRead / $12.50 cacheWrite(5m)
//   Fable 5.1  : as Fable 5 but $0.25 cacheRead (0.025x input)
// Re-read 2026-09-22 for #42, adding:
//   Haiku 3.5  : $0.80 in / $4 out / $0.08 cacheRead / $1 cacheWrite(5m)
// Every Claude row and family price is pinned to its published price by
// `published-claude-prices.test.ts`.
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
const ANTHROPIC_SONNET_5: TokenRate = {
  inputPer1k: 0.2,
  outputPer1k: 1.0,
  cacheReadPer1k: 0.02,
  cacheWritePer1k: 0.25,
};
const ANTHROPIC_OPUS_LEGACY: TokenRate = {
  inputPer1k: 1.5,
  outputPer1k: 7.5,
  cacheReadPer1k: 0.15,
  cacheWritePer1k: 1.875,
};

const ANTHROPIC_FABLE_5: TokenRate = {
  inputPer1k: 1,
  outputPer1k: 5,
  cacheReadPer1k: 0.1,
  cacheWritePer1k: 1.25,
};
const ANTHROPIC_FABLE_5_1: TokenRate = { ...ANTHROPIC_FABLE_5, cacheReadPer1k: 0.025 };
const ANTHROPIC_HAIKU_3_5: TokenRate = {
  inputPer1k: 0.08,
  outputPer1k: 0.4,
  cacheReadPer1k: 0.008,
  cacheWritePer1k: 0.1,
};
// Claude 3 Haiku is no longer on Anthropic's page; $0.25 / $1.25 is the
// Bedrock list price (AWS Price List, see below).
const CLAUDE_3_HAIKU: TokenRate = { inputPer1k: 0.025, outputPer1k: 0.125 };

// Amazon Bedrock prices (#42). Source: the AWS Price List API, offer
// `AmazonBedrockFoundationModels`, us-east-1, publication 2026-09-11 — the
// machine-readable form of https://aws.amazon.com/bedrock/pricing/ — read
// 2026-09-22. Bedrock bills a geo inference profile (`us.`, `eu.`, …) or an
// in-region call at its "Regional" SKU, which for Claude 4.5 and later is 1.1x
// the "Global" SKU (Anthropic's pricing page: "Regional and multi-region
// endpoints include a 10% premium over global endpoints"). The Global SKU
// equals Anthropic's own price. Models before 4.5 have one Bedrock price.
const BEDROCK_REGIONAL_PREMIUM = 1.1;

/** A rate × `factor`, rounded clear of float noise (0.1 × 1.1 must be 0.11). */
function scaleRate(rate: TokenRate, factor: number): TokenRate {
  const s = (v: number) => Math.round(v * factor * 1e9) / 1e9;
  return {
    inputPer1k: s(rate.inputPer1k),
    outputPer1k: s(rate.outputPer1k),
    ...(rate.cacheReadPer1k !== undefined ? { cacheReadPer1k: s(rate.cacheReadPer1k) } : {}),
    ...(rate.cacheWritePer1k !== undefined ? { cacheWritePer1k: s(rate.cacheWritePer1k) } : {}),
  };
}

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
  // #22 — there is deliberately NO `anthropic:default` row. It billed every
  // unrecognised model on the anthropic provider (e.g. `deepseek-v4-pro` via
  // ANTHROPIC_BASE_URL) at Sonnet 4.6 rates. Dated/suffixed Claude ids are
  // handled by `claudeFamilyRate`; anything else is unpriced.
  // Anthropic Claude 3.5 Sonnet (direct API)
  [
    "anthropic:claude-3-5-sonnet-20241022",
    { inputPer1k: 0.3, outputPer1k: 1.5, cacheReadPer1k: 0.03, cacheWritePer1k: 0.375 },
  ],
  ["anthropic:claude-3-5-sonnet", { inputPer1k: 0.3, outputPer1k: 1.5 }],
  // Haiku 3.5 is $0.80 / $4 (pricing page); it was billed at Haiku 4.5's $1 / $5.
  ["anthropic:claude-3-5-haiku", ANTHROPIC_HAIKU_3_5],
  ["anthropic:claude-3-opus", { inputPer1k: 1.5, outputPer1k: 7.5 }],
  // Bedrock-hosted Claude 4.5+ at the Regional SKU (see BEDROCK_REGIONAL_PREMIUM).
  // Sonnet 4.6: $3.30 / $16.50 / $0.33 / $4.125 (legacy id, kept for historical
  // usage rows).
  [
    "bedrock-gateway:us.anthropic.claude-sonnet-4-6",
    scaleRate(ANTHROPIC_SONNET_4, BEDROCK_REGIONAL_PREMIUM),
  ],
  [
    "bedrock-gateway:anthropic.claude-sonnet-4-6",
    scaleRate(ANTHROPIC_SONNET_4, BEDROCK_REGIONAL_PREMIUM),
  ],
  // Sonnet 5 (current default; see model-router.ts): $2.20 / $11 / $0.22 / $2.75.
  // It was billed at Sonnet 4.x's Global $3 / $15.
  [
    "bedrock-gateway:us.anthropic.claude-sonnet-5",
    scaleRate(ANTHROPIC_SONNET_5, BEDROCK_REGIONAL_PREMIUM),
  ],
  // Opus 4.8: $5.50 / $27.50 / $0.55 / $6.875.
  [
    "bedrock-gateway:us.anthropic.claude-opus-4-8",
    scaleRate(ANTHROPIC_OPUS_4, BEDROCK_REGIONAL_PREMIUM),
  ],
  // Fable 5: $11 / $55 / $1.10 / $13.75. #42 — it was billed at Haiku 4.5's
  // $1 / $5, about a tenth of its price.
  [
    "bedrock-gateway:us.anthropic.claude-fable-5",
    scaleRate(ANTHROPIC_FABLE_5, BEDROCK_REGIONAL_PREMIUM),
  ],
  // Bedrock-hosted Claude 3.5 Sonnet (legacy)
  [
    "bedrock-gateway:anthropic.claude-3-5-sonnet-20241022-v2:0",
    { inputPer1k: 0.3, outputPer1k: 1.5, cacheReadPer1k: 0.03, cacheWritePer1k: 0.375 },
  ],
  [
    "bedrock-gateway:anthropic.claude-3-5-sonnet-20240620-v1:0",
    { inputPer1k: 0.3, outputPer1k: 1.5 },
  ],
  // Haiku 3.5 standard (not latency-optimized) SKU: $0.80 / $4 / $0.08 / $1.
  ["bedrock-gateway:anthropic.claude-3-5-haiku-20241022-v1:0", ANTHROPIC_HAIKU_3_5],
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
  // Self-hosted Ollama / vLLM (PR #41 review): no per-token charge exists, so
  // this is a genuine zero, not an unpriced model.
  ["local-gemma:default", DEFAULT_RATE],
  ["copilot-native:gpt-4o", DEFAULT_RATE],
  ["offline-stub:offline-stub", DEFAULT_RATE],
  ["offline-stub:default", DEFAULT_RATE],
]);

/** USD per MTok → cents per 1k tokens (`$X / MTok === X / 10 cents / 1k`). */
function toRate(p: ModelPrice): TokenRate {
  return {
    inputPer1k: p.inputPerMTok / 10,
    outputPer1k: p.outputPerMTok / 10,
    ...(p.cacheReadPerMTok !== undefined ? { cacheReadPer1k: p.cacheReadPerMTok / 10 } : {}),
    ...(p.cacheWritePerMTok !== undefined ? { cacheWritePer1k: p.cacheWritePerMTok / 10 } : {}),
  };
}

/**
 * Last `MODEL_PRICES` value seen and its parse — usage is recorded per model
 * call, and the setting almost never changes, so re-validating it each time is
 * wasted work (PR #41 nit). Keyed on the raw string, so an edit is picked up
 * on the next lookup.
 */
let parsedPrices: { raw: string; prices: Record<string, ModelPrice> | null } | null = null;

function parsePrices(raw: string): Record<string, ModelPrice> | null {
  if (parsedPrices?.raw !== raw) {
    const parsed = modelPricesSchema.safeParse(raw);
    parsedPrices = { raw, prices: parsed.success ? parsed.data : null };
  }
  return parsedPrices.prices;
}

/**
 * The administrator's override for `provider:model` or bare `model`, or
 * `undefined`. A stored value that no longer validates is ignored (the write
 * path validates, so this only guards a hand-edited env var) — it must never
 * throw inside usage accounting.
 */
function overrideRate(
  provider: string | undefined,
  model: string,
  config: ConfigService,
): TokenRate | undefined {
  let raw: string | undefined;
  try {
    raw = config.get(MODEL_PRICES_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  const prices = parsePrices(raw);
  if (!prices) return undefined;
  // Own keys only: a model id such as "constructor" or "toString" must not
  // resolve to an Object.prototype member.
  const own = (key: string) => (Object.hasOwn(prices, key) ? prices[key] : undefined);
  const price = (provider ? own(`${provider}:${model}`) : undefined) ?? own(model);
  return price ? toRate(price) : undefined;
}

/**
 * True when the `anthropic` provider is pointed at a non-Anthropic endpoint
 * (`ANTHROPIC_BASE_URL`). Such an endpoint serves and bills its OWN models —
 * DeepSeek maps `claude-haiku-*` to `deepseek-flash`, for example
 * (https://api-docs.deepseek.com/guides/anthropic_api) — so Anthropic's list
 * prices must not be applied to it.
 */
export function isThirdPartyAnthropicEndpoint(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.ANTHROPIC_BASE_URL?.trim();
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host !== "api.anthropic.com";
  } catch {
    // Unparseable → we cannot tell whose prices apply; say so by not pricing.
    return true;
  }
}

/**
 * PR #41 review — an operator's statement that `ANTHROPIC_BASE_URL` is a proxy
 * or gateway relaying to Anthropic (`ANTHROPIC_BASE_URL_BILLS_AS=anthropic`),
 * so Anthropic's list prices DO apply behind it. Anything else keeps the host
 * check. Never throws inside usage accounting.
 */
function baseUrlBillsAsAnthropic(config: ConfigService): boolean {
  try {
    return config.get("ANTHROPIC_BASE_URL_BILLS_AS")?.trim().toLowerCase() === "anthropic";
  } catch {
    return false;
  }
}

export interface ResolveRateOptions {
  config?: ConfigService;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

/**
 * Resolve the price for a model call, or `null` when METIS has no price for
 * it (UNPRICED — recorded as a null cost, never as 0). See the module header
 * for the resolution order. `provider` may be omitted by a caller that only
 * knows the model id; it then skips provider-keyed rows.
 */
export function resolveRate(
  provider: string | undefined,
  model: string,
  opts: ResolveRateOptions = {},
): TokenRate | null {
  const config = opts.config ?? getConfigService();
  const override = overrideRate(provider, model, config);
  if (override) return override;

  if (
    provider === "anthropic" &&
    isThirdPartyAnthropicEndpoint(opts.env) &&
    !baseUrlBillsAsAnthropic(config)
  ) {
    return null;
  }

  if (provider) {
    const exact = RATES.get(`${provider}:${model}`);
    if (exact) return exact;
  }
  const family = claudeFamilyRate(model);
  if (family) return family;
  // A provider-wide row exists only for METIS-internal providers whose calls
  // genuinely cost nothing per token (offline-stub, copilot-native). There is
  // deliberately no such row for a paid provider (#22).
  return (provider && RATES.get(`${provider}:default`)) || null;
}

/**
 * Back-compat name for {@link resolveRate}. Returns `null` for an unpriced
 * model (#22) — before, it returned a Sonnet-tier default for any anthropic id
 * and a zero rate for everything else.
 */
export function getRate(provider: string, model: string): TokenRate | null {
  return resolveRate(provider, model);
}

/**
 * Map a Claude model id — bare, dated, or a Bedrock `us.anthropic.…-v1:0`
 * spelling, on any provider — to its family's published rate. Returns
 * `undefined` for an id that names no Claude family, so it stays unpriced.
 *
 * Fable 5 / 5.1 are $10/$50. Opus 4.5 and later are $5/$25; Opus 4 / 4.1
 * (and Claude 3 Opus) are $15/$75. Sonnet 5 is $2/$10; every earlier Sonnet
 * is $3/$15. Haiku 4.5 is $1/$5, Haiku 3.5 $0.80/$4, Claude 3 Haiku $0.25/$1.25.
 *
 * A Bedrock geo inference profile (`us.anthropic.…`, `eu.anthropic.…`, …) or
 * in-region id (`anthropic.…`) of a Claude 4.5+ model bills at Bedrock's
 * Regional SKU, 1.1x the price above; a `global.anthropic.…` profile bills at
 * the price above (#42).
 */
export function claudeFamilyRate(model: string): TokenRate | undefined {
  const m = model.toLowerCase();
  const base = claudeBaseFamilyRate(m);
  if (!base) return undefined;
  return isBedrockRegionalId(m) && isRegionallyPricedGeneration(m)
    ? scaleRate(base, BEDROCK_REGIONAL_PREMIUM)
    : base;
}

function claudeBaseFamilyRate(m: string): TokenRate | undefined {
  if (/fable-5[.-]1/.test(m)) return ANTHROPIC_FABLE_5_1;
  if (/fable/.test(m)) return ANTHROPIC_FABLE_5;
  if (/opus-(4-[5-9]|[5-9])/.test(m)) return ANTHROPIC_OPUS_4;
  if (/opus/.test(m)) return ANTHROPIC_OPUS_LEGACY;
  if (/sonnet-[5-9]/.test(m)) return ANTHROPIC_SONNET_5;
  if (/sonnet/.test(m)) return ANTHROPIC_SONNET_4;
  if (/3-5-haiku/.test(m)) return ANTHROPIC_HAIKU_3_5;
  if (/3-haiku/.test(m)) return CLAUDE_3_HAIKU;
  if (/haiku/.test(m)) return ANTHROPIC_HAIKU_4;
  return undefined;
}

/**
 * A Bedrock model id — bare, or the tail of an inference-profile ARN — that is
 * not a `global.` profile: a geo profile (`us.anthropic.…`) or in-region id.
 */
function isBedrockRegionalId(m: string): boolean {
  const id = /(?:^|\/)((?:[a-z-]+\.)?anthropic\.claude[^/]*)$/.exec(m)?.[1];
  return id !== undefined && !id.startsWith("global.");
}

/** Claude 4.5 and later — the generations Bedrock prices per endpoint type. */
function isRegionallyPricedGeneration(m: string): boolean {
  return /fable|(opus|sonnet|haiku)-(4-[5-9]|[5-9])/.test(m);
}

/**
 * The published per-family prices in USD per MTok, derived from the rates
 * above (never restated). `cache-crossover.ts` reasons in these units.
 */
export function familyPricePerMTok(family: "haiku" | "sonnet" | "opus"): {
  input: number;
  output: number;
} {
  const rate =
    family === "haiku"
      ? ANTHROPIC_HAIKU_4
      : family === "sonnet"
        ? ANTHROPIC_SONNET_4
        : ANTHROPIC_OPUS_LEGACY;
  // Round away float noise from the ×10 (0.3 × 10 must be exactly 3).
  const usd = (per1k: number) => Math.round(per1k * 10 * 1e6) / 1e6;
  return { input: usd(rate.inputPer1k), output: usd(rate.outputPer1k) };
}

export interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Unrounded cost in cents. `cacheWritePer1k` overrides the rate's own
 * cache-write price (the 1-hour prompt-cache TTL bills 2× input, #702).
 */
export function computeCostCentsExact(
  rate: TokenRate,
  usage: CostUsage,
  opts: { cacheWritePer1k?: number } = {},
): number {
  const cacheRead = rate.cacheReadPer1k ?? rate.inputPer1k;
  const cacheWrite = opts.cacheWritePer1k ?? rate.cacheWritePer1k ?? rate.inputPer1k;
  return (
    (usage.inputTokens * rate.inputPer1k) / 1000 +
    (usage.outputTokens * rate.outputPer1k) / 1000 +
    ((usage.cacheReadTokens ?? 0) * cacheRead) / 1000 +
    ((usage.cacheWriteTokens ?? 0) * cacheWrite) / 1000
  );
}

/**
 * Compute the integer-cent cost for a usage row, or `null` when the rate is
 * `null` (unpriced model, #22).
 *
 * Standard input/output tokens use the headline rate. Cache-read is usually
 * the cheapest tier (Bedrock advertises ~10% of input). Cache-write is more
 * expensive than vanilla input (Anthropic charges 1.25× input). Both
 * default to the input rate when the provider doesn't publish a separate
 * cache rate so we don't silently under-bill.
 */
export function computeCostCents(rate: TokenRate, usage: CostUsage): number;
export function computeCostCents(rate: TokenRate | null, usage: CostUsage): number | null;
export function computeCostCents(rate: TokenRate | null, usage: CostUsage): number | null {
  if (rate === null) return null;
  // Round half-up to the integer cent.
  return Math.round(computeCostCentsExact(rate, usage));
}

/** Test-only helper. */
export function __testRateKeys(): string[] {
  return Array.from(RATES.keys()).sort();
}
