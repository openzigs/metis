/**
 * #1226 / #1228 — docs-gen OUTPUT-token cap resolution.
 *
 * Every docs-gen call site that asks a model for long-form text has TWO cap
 * surfaces: the explicit `maxTokens` it passes, and — when it passes none — the
 * provider's own `defaultMaxTokens` (4096), applied silently inside the adapter
 * as `opts.maxTokens ?? this.defaultMaxTokens`. The second one is invisible at
 * the call site, which is how #1226, #1224 and #1228 each shipped a synthesizer
 * that quietly ran against a 4K ceiling.
 *
 * This module owns the model-ceiling table and the clamp so there is exactly ONE
 * of each. It deliberately lives apart from `holistic-synthesizer.ts`: the DB
 * schema synthesizer needs the same clamp, and importing the holistic module for
 * it would drag the entire Phase-1/Phase-2 pipeline (tree-sitter parsers, rule
 * miners, grounding retrieval) into a database-scope document generation that
 * uses none of it.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";

/**
 * #1226 — default OUTPUT cap for ONE Phase-2 section synthesis call. Was
 * hardcoded at 8192, which is roughly 6,000 words: long BRD sections (Business
 * Rules over a 200-module project) legitimately exceed it, and hitting the cap
 * is silent — the model simply stops, or the gateway substitutes a placeholder.
 */
export const DEFAULT_SECTION_MAX_OUTPUT_TOKENS = 32_768;

/**
 * #1226 — default OUTPUT cap for ONE Phase-1 fact-extraction call. Was
 * hardcoded at 4096; a truncated fact blob starves EVERY downstream section, so
 * this is the more damaging of the two caps despite being the quieter one.
 */
export const DEFAULT_FACTS_MAX_OUTPUT_TOKENS = 8_192;

/**
 * #1228 — default OUTPUT cap for ONE DB-schema prose batch.
 *
 * The batch asks for `DB_SCHEMA_SYNTH_BATCH_SIZE` (default 30) table
 * descriptions of 2-3 sentences each, returned as a SINGLE JSON object. That
 * object is the unit of parseability: a body cut anywhere inside it never closes
 * its brace, so the whole batch is lost rather than degrading to fewer
 * descriptions. Against the inherited 4096 default a wide Oracle schema
 * (long qualified table names, 30 verbose descriptions) exceeds the cap and
 * every batch returns unusable — the measured 0-of-641 in #1228.
 *
 * 16384 gives roughly 5x headroom over a well-behaved 30-table response while
 * staying inside the ceilings of every model in {@link MODEL_OUTPUT_CEILINGS};
 * an unknown model still falls back to {@link UNKNOWN_MODEL_SAFE_DEFAULT}.
 */
export const DEFAULT_DB_SCHEMA_PROSE_MAX_OUTPUT_TOKENS = 16_384;

/**
 * #152 — default OUTPUT cap for ONE claim-extraction call. Claim extraction
 * used to reuse the SECTION cap, so its budget moved whenever the section cap
 * was tuned for prose and was never sized for a claim list. With claim
 * extraction batched (`DEFAULT_CLAIM_BATCH_CHARS` characters of passage
 * per call) one reply is a few thousand tokens; 16384 leaves room for a dense,
 * formula-heavy passage. Like every default here it drops to 8192 for a model
 * with no known ceiling.
 */
export const DEFAULT_CLAIM_MAX_OUTPUT_TOKENS = 16_384;

/** Floor for any cap — below this no useful output could be written at all. */
const MIN_MAX_OUTPUT_TOKENS = 512;

/**
 * #1226 — the DEFAULT applied when the model's output ceiling is unknown. Every
 * provider docs-gen has ever run against accepted 8192 (it was the hardcoded
 * value), so an unknown model — Nova, Llama/Mistral on Bedrock, a local
 * OpenAI-compatible runtime — is never handed a raised default it would reject.
 * An explicit operator setting is still honoured unclamped for such models.
 */
const UNKNOWN_MODEL_SAFE_DEFAULT = 8_192;

/**
 * #1226 — conservative per-model OUTPUT ceilings, matched most-specific first.
 *
 * A local stand-in until the shared model-capability table (#1221) lands. An
 * UNKNOWN model is deliberately NOT clamped against an explicit operator
 * setting: a new model id must never be silently capped below what it supports,
 * and the provider rejects an over-ceiling request with a clear 400 rather than
 * corrupting the document. It does, however, fall back to
 * {@link UNKNOWN_MODEL_SAFE_DEFAULT} when no setting was supplied.
 */
const MODEL_OUTPUT_CEILINGS: ReadonlyArray<readonly [RegExp, number]> = [
  // Claude 3 / 3.5 generation — small output windows.
  [/claude-3[.-]5-haiku/i, 8_192],
  [/claude-3[.-]5-sonnet/i, 8_192],
  [/claude-3-haiku|claude-3-opus|claude-3-sonnet/i, 4_096],
  // Claude 3.7 and the 4.x/5.x families (`claude-sonnet-4-6`, `claude-opus-5`…).
  [/claude-3[.-]7-sonnet/i, 64_000],
  [/claude-(sonnet|opus|haiku)-\d/i, 64_000],
  // #25 — DeepSeek V4 (reached through ANTHROPIC_BASE_URL). `max_tokens` "must
  // be between 1 and 384K (393216)" — https://api-docs.deepseek.com/api/create-chat-completion
  // — and the Models & Pricing page lists MAX OUTPUT "MAXIMUM: 384K" for both
  // deepseek-flash and deepseek-v4-pro (read 2026-09-21). Without a row the
  // model fell to UNKNOWN_MODEL_SAFE_DEFAULT (8192), the cap #25 truncated at.
  [/deepseek-(v4-pro|flash)/i, 393_216],
];

/**
 * #25 — models that REASON BY DEFAULT and draw that reasoning from the same
 * `max_tokens` budget as the answer. DeepSeek documents "Thinking mode is
 * enabled by default, with the default effort being high" for both V4 models
 * (https://api-docs.deepseek.com/guides/thinking_mode), and its own default
 * `max_tokens` is 8K in non-thinking mode but 64K in thinking mode — the
 * reasoning is generated output. A cap sized for the ANSWER alone therefore
 * truncates the answer (#25: three section groups cut at 8,192).
 *
 * Deliberately a short allow-list: a model is only given the extra budget on
 * documented evidence that it thinks by default.
 */
const THINKING_BY_DEFAULT_MODELS: ReadonlyArray<RegExp> = [/deepseek-(v4-pro|flash)/i];

/**
 * PR #41 review — Anthropic-compatible endpoints that serve a `claude-*` model
 * NAME as one of their own thinking-by-default models. DeepSeek maps
 * `claude-opus-*` to `deepseek-v4-pro` and `claude-haiku-*` / `claude-sonnet-*`
 * to `deepseek-flash` (https://api-docs.deepseek.com/guides/anthropic_api), so
 * the model METIS requests is not the model that reasons. Keyed on the
 * documented host only: a proxy relaying to Anthropic serves real Claude.
 */
const THINKING_BY_DEFAULT_ENDPOINT_HOSTS: ReadonlyArray<RegExp> = [/(^|\.)deepseek\.com$/i];

/**
 * True when `model` is a bare `claude-*` name (the direct-Anthropic spelling;
 * Bedrock's is `us.anthropic.claude-…`) and `ANTHROPIC_BASE_URL` points at an
 * endpoint that serves such names as thinking-by-default models.
 */
function servedAsThinkingModel(
  model: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  if (!/^claude-/i.test(model)) return false;
  const raw = env.ANTHROPIC_BASE_URL?.trim();
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname;
    return THINKING_BY_DEFAULT_ENDPOINT_HOSTS.some((p) => p.test(host));
  } catch {
    return false;
  }
}

/** #25 — default reasoning allowance added on top of an answer budget. */
export const DEFAULT_REASONING_ALLOWANCE_TOKENS = 32_768;

/** True when `model` is documented to reason by default (see above). */
export function modelThinksByDefault(model: string | undefined): boolean {
  if (!model) return false;
  return THINKING_BY_DEFAULT_MODELS.some((p) => p.test(model));
}

/**
 * #25 — true when the model actually SERVED for `model` reasons by default:
 * a documented thinking-by-default model id, or a `claude-*` name sent to an
 * endpoint that serves it as one (DeepSeek's Anthropic API, via
 * `ANTHROPIC_BASE_URL`).
 */
export function servedModelThinksByDefault(
  model: string | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  if (!model) return false;
  return modelThinksByDefault(model) || servedAsThinkingModel(model, env);
}

/**
 * #25 — the extra OUTPUT tokens to grant a thinking-by-default model on top of
 * the answer budget: `DOCS_GEN_REASONING_ALLOWANCE_TOKENS` (db → env) or
 * {@link DEFAULT_REASONING_ALLOWANCE_TOKENS}; `0` for every other model. The
 * model is the one SERVED: a `claude-*` name on DeepSeek's endpoint counts
 * (PR #41 review). A
 * negative / non-numeric setting falls back to the default; `0` is honoured
 * (an operator who has disabled thinking upstream can opt out).
 */
export function reasoningAllowanceTokens(
  model: string | undefined,
  config: ConfigService = getConfigService(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  if (!servedModelThinksByDefault(model, env)) return 0;
  const raw = config.getNumber(
    "DOCS_GEN_REASONING_ALLOWANCE_TOKENS",
    DEFAULT_REASONING_ALLOWANCE_TOKENS,
  );
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_REASONING_ALLOWANCE_TOKENS;
}

/**
 * The known OUTPUT-token ceiling for `model`, or `null` when the model is not
 * in the table (→ no clamp). Matching is substring-based so fully-qualified
 * Bedrock ids (`us.anthropic.claude-sonnet-4-6-v1:0`) resolve the same as bare
 * Anthropic ones.
 */
export function modelOutputCeiling(model: string | undefined): number | null {
  if (!model) return null;
  for (const [pattern, ceiling] of MODEL_OUTPUT_CEILINGS) {
    if (pattern.test(model)) return ceiling;
  }
  return null;
}

/** The `ConfigService` keys that carry a docs-gen output cap. */
export type DocsGenMaxOutputTokensKey =
  | "DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS"
  | "DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS"
  | "DOCS_GEN_DB_SCHEMA_MAX_OUTPUT_TOKENS"
  | "DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS";

/**
 * #1226 — resolve a docs-gen OUTPUT cap: the registry value (db → env, so a
 * tunable change takes effect without a restart) or the default, floored so it
 * is always usable, then clamped DOWN to the model's known ceiling so an
 * over-ambitious setting can never turn a working call into a provider 400.
 * With no known ceiling the DEFAULT drops to {@link UNKNOWN_MODEL_SAFE_DEFAULT}
 * so the raised default is only ever applied to a model proven to accept it.
 */
export function resolveDocsGenMaxOutputTokens(
  key: DocsGenMaxOutputTokensKey,
  fallback: number,
  model?: string,
  config: ConfigService = getConfigService(),
): number {
  const ceiling = modelOutputCeiling(model);
  const safeFallback = ceiling === null ? Math.min(fallback, UNKNOWN_MODEL_SAFE_DEFAULT) : fallback;
  const raw = config.getNumber(key, safeFallback);
  const configured = Number.isFinite(raw) && raw >= MIN_MAX_OUTPUT_TOKENS ? raw : safeFallback;
  // #25 — the configured value is the ANSWER budget; a model that reasons by
  // default spends its reasoning from the same `max_tokens`, so add room for it
  // before clamping to the model's ceiling.
  const withReasoning = configured + reasoningAllowanceTokens(model, config);
  return ceiling === null ? withReasoning : Math.min(withReasoning, ceiling);
}

/** #1226 — OUTPUT cap for one Phase-2 section synthesis call. */
export function resolveSectionMaxOutputTokens(
  model?: string,
  config: ConfigService = getConfigService(),
): number {
  return resolveDocsGenMaxOutputTokens(
    "DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS",
    DEFAULT_SECTION_MAX_OUTPUT_TOKENS,
    model,
    config,
  );
}

/** #1226 — OUTPUT cap for one Phase-1 fact-extraction call. */
export function resolveFactsMaxOutputTokens(
  model?: string,
  config: ConfigService = getConfigService(),
): number {
  return resolveDocsGenMaxOutputTokens(
    "DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS",
    DEFAULT_FACTS_MAX_OUTPUT_TOKENS,
    model,
    config,
  );
}

/** #1228 — OUTPUT cap for one DB-schema table-prose batch. */
export function resolveDbSchemaProseMaxOutputTokens(
  model?: string,
  config: ConfigService = getConfigService(),
): number {
  return resolveDocsGenMaxOutputTokens(
    "DOCS_GEN_DB_SCHEMA_MAX_OUTPUT_TOKENS",
    DEFAULT_DB_SCHEMA_PROSE_MAX_OUTPUT_TOKENS,
    model,
    config,
  );
}

/** #152 — OUTPUT cap for one grounding claim-extraction call. */
export function resolveClaimMaxOutputTokens(
  model?: string,
  config: ConfigService = getConfigService(),
): number {
  return resolveDocsGenMaxOutputTokens(
    "DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS",
    DEFAULT_CLAIM_MAX_OUTPUT_TOKENS,
    model,
    config,
  );
}
