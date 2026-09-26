/**
 * Model → max-output-tokens ceilings, and the clamp that keeps a configured
 * OUTPUT cap inside them (#1221).
 *
 * ## Why this exists
 *
 * `ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS` (#1218, default 16384) was a knob
 * with no guard: set it above what the active model supports and the provider
 * rejects the request outright. The call that eats that rejection is the
 * *degraded* pass — the one that exists to salvage an investigation the normal
 * path could not serialize — so the operator sees a salvage failure at the
 * worst possible moment and diagnoses everything except their own config.
 *
 * ## The inherited default is NOT the model ceiling
 *
 * #1224 measured the adapters' `defaultMaxTokens`: 4096 on Bedrock and the
 * OpenAI-compatible provider, 16000 on `AnthropicProvider`. Those are what a
 * request inherits when `maxTokens` is unset. They are unrelated to how many
 * tokens the model can actually emit, which is what this table holds.
 * Conflating the two is how this class of bug keeps recurring, so they are kept
 * in different files with different names.
 *
 * ## Provenance, and how to re-verify a row
 *
 * Every row carries a `source`. For the Anthropic models the number is the
 * `max_tokens` field the Models API reports for that id — machine-checkable at
 * any time without reading a doc page:
 *
 * ```
 * curl -s https://api.anthropic.com/v1/models/claude-opus-4-8 \
 *   -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | jq .max_tokens
 * # or: ant models retrieve --model-id claude-opus-4-8 --transform max_tokens -r
 * ```
 *
 * A table of ceilings goes stale silently, which is exactly why the ROW is
 * cheap to re-check and why an id that is not in it is never guessed at.
 *
 * ## An unknown model is never given a permissive default
 *
 * {@link lookupModelMaxOutputTokens} returns `null` for an id it does not know,
 * and {@link clampToModelOutputCeiling} then leaves the value alone **but says
 * so, once, at WARN**. Silently substituting a large ceiling for an unknown
 * model would be a fail-open — the shape this repo shipped fifteen times in
 * twelve days (#1215 found eight in one audit) — and inventing a small one
 * would break every local/self-hosted deployment. Naming the gap is the only
 * honest option: the operator can add a row or lower the knob.
 */
import { createChildLogger } from "../logger.js";
import { boundNonStreamingOutputTokens } from "./nonstreaming-output-bound.js";

const log = createChildLogger("model-output-limits");

/** One row of the ceiling table. */
export interface ModelOutputLimit {
  /** Maximum tokens the model will emit in one response. */
  readonly maxOutputTokens: number;
  /** Where the number came from, and how to re-verify it. */
  readonly source: string;
}

/**
 * Verified as of 2026-08-06. Keyed by {@link normalizeModelId} output — a key
 * that is not already normalised can never be hit (asserted in the tests).
 *
 * Deliberately SMALL: it holds the models this repo can actually select
 * (`server/src/lib/ai/model-router.ts`, `server/src/lib/ai/config.ts`) and
 * nothing speculative. A model absent here is reported, not guessed.
 */
export const MODEL_MAX_OUTPUT_TOKENS: ReadonlyMap<string, ModelOutputLimit> = new Map([
  // ── Anthropic ────────────────────────────────────────────────────────────
  // Re-verify with `GET /v1/models/{id}` → `.max_tokens` (see the header).
  // The Bedrock `us.anthropic.*` ids in model-router.ts normalise onto these.
  ["claude-fable-5", { maxOutputTokens: 128000, source: "Anthropic Models API max_tokens (128K)" }],
  [
    "claude-mythos-5",
    { maxOutputTokens: 128000, source: "Anthropic Models API max_tokens (128K)" },
  ],
  ["claude-opus-5", { maxOutputTokens: 128000, source: "Anthropic Models API max_tokens (128K)" }],
  [
    "claude-opus-4-8",
    { maxOutputTokens: 128000, source: "Anthropic Models API max_tokens (128K)" },
  ],
  [
    "claude-opus-4-7",
    { maxOutputTokens: 128000, source: "Anthropic Models API max_tokens (128K)" },
  ],
  [
    "claude-opus-4-6",
    { maxOutputTokens: 128000, source: "Anthropic Models API max_tokens (128K)" },
  ],
  [
    "claude-sonnet-5",
    { maxOutputTokens: 128000, source: "Anthropic Models API max_tokens (128K)" },
  ],
  [
    "claude-sonnet-4-6",
    { maxOutputTokens: 128000, source: "Anthropic Models API max_tokens (128K)" },
  ],
  [
    // The one Anthropic model here that is NOT 128K. Its presence is the reason
    // a single hardcoded ceiling would have been wrong.
    "claude-haiku-4-5",
    { maxOutputTokens: 64000, source: "Anthropic Models API max_tokens (64K)" },
  ],
  // ── OpenAI (the openai/azure default, see ai/config.ts) ────────────────────
  [
    "gpt-4.1",
    {
      maxOutputTokens: 32768,
      source: "OpenAI model reference — 32,768 max output tokens (1,047,576 input)",
    },
  ],
]);

/** Bedrock cross-region routing prefix (`us.` / `eu.` / `apac.` / `global.`). */
const CROSS_REGION_PREFIX = /^(?:us|eu|apac|global)\./;
/** Bedrock vendor namespace. */
const VENDOR_PREFIX = /^anthropic\./;
/** Bedrock dated snapshot + model version, e.g. `-20251001-v1:0`. */
const SNAPSHOT_AND_VERSION_SUFFIX = /-\d{8}-v\d+:\d+$/;
/** Native Anthropic dated snapshot, e.g. `-20251001`. */
const SNAPSHOT_SUFFIX = /-\d{8}$/;

/**
 * Reduce a provider-specific model id to the key this table uses.
 *
 * Only spellings we can name are stripped — a cross-region prefix, the
 * `anthropic.` vendor namespace, and a dated snapshot suffix. Anything else is
 * returned as-is (lower-cased and trimmed) so an id we do not recognise MISSES
 * the table rather than being mangled into a neighbouring hit. `gemma4:12b`
 * must stay `gemma4:12b`.
 */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(CROSS_REGION_PREFIX, "")
    .replace(VENDOR_PREFIX, "")
    .replace(SNAPSHOT_AND_VERSION_SUFFIX, "")
    .replace(SNAPSHOT_SUFFIX, "");
}

/**
 * The model's output ceiling, or `null` when we have no verified number for it.
 *
 * `null` means "unknown", never "unlimited" — callers must not substitute a
 * default. It is also `null` for an absent/blank id, because a request with no
 * explicit model resolves to whatever the adapter's own default is, which this
 * module cannot see.
 *
 * @param limits test seam — defaults to the shipped {@link MODEL_MAX_OUTPUT_TOKENS}.
 */
export function lookupModelMaxOutputTokens(
  model: string | null | undefined,
  limits: ReadonlyMap<string, number | ModelOutputLimit> = MODEL_MAX_OUTPUT_TOKENS,
): number | null {
  if (model == null || model.trim().length === 0) return null;
  const entry = limits.get(normalizeModelId(model));
  if (entry === undefined) return null;
  return typeof entry === "number" ? entry : entry.maxOutputTokens;
}

/** Outcome of a clamp, including the two numbers a warning has to name. */
export interface OutputCeilingClamp {
  /** The value to actually send as `maxTokens`. */
  value: number;
  /** The model's ceiling, or `null` when the model is unknown. */
  ceiling: number | null;
  /** `true` only when {@link value} is below what the caller asked for. */
  clamped: boolean;
  /**
   * #1257 — the SDK's non-streaming bound when one applied, else `null`. A
   * SEPARATE field from {@link ceiling} because they are separate quantities:
   * `claude-sonnet-5`'s ceiling is 128,000 and the SDK's bound is 21,333, and
   * collapsing them into one number is how the clamp came to read as a guard on
   * a path it did not cover.
   */
  sdkNonStreamingBound: number | null;
}

/** The subset of a logger this module needs (mirrors `ai/capabilities.ts`). */
export interface OutputCeilingLogger {
  warn: (msg: string, meta?: unknown) => void;
}

/** Optional inputs to {@link clampToModelOutputCeiling}. */
export interface OutputCeilingOptions {
  /** Test seam — defaults to this module's child logger. */
  logger?: OutputCeilingLogger;
  /**
   * #1257 — the setting an operator would actually change, named in the
   * warning. Was hardcoded to `ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS`, which
   * made the warning actively misleading for any other caller: #1223 declined
   * to wire synthesis in for exactly that reason.
   */
  knob?: string;
  /**
   * #1257 — the provider the request will run on. Supplied only by NON-streaming
   * call sites: the SDK's client-side bound applies to `chat()`, and `stream()`
   * has no such limit, so passing a key for a streaming call would over-block.
   */
  nonStreamingProviderKey?: string | null;
}

/**
 * #1218 — a repair echoes its input back verbatim, so its cap is scaled up.
 * Mirrored from `analysis/agent-runner.ts`; kept here only so the *warning* can
 * quote the number a provider can actually be asked for. `agent-runner.ts`
 * remains the one place that applies it.
 */
const REPAIR_HEADROOM = 1.25;

/**
 * Warn-once ledger. Keyed by model + the numbers involved, so a genuinely
 * different misconfiguration is still heard while a per-run repeat is not: an
 * analysis run resolves this cap on every pass, and a per-call warn would bury
 * the signal it exists to raise.
 */
const warned = new Set<string>();

/** @internal test-only — reset the warn-once ledger between cases. */
export function __resetOutputCeilingWarnings(): void {
  warned.clear();
}

function warnOnce(key: string, emit: () => void): void {
  if (warned.has(key)) return;
  warned.add(key);
  emit();
}

/** The knob this warning names when a caller supplies none. */
const DEFAULT_KNOB = "ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS";

/**
 * Hold `requested` at or below the active model's output ceiling — and, for a
 * non-streaming call, at or below what the SDK will send (#1257).
 *
 * Known model, value over the ceiling → clamped down, warned once naming BOTH
 * numbers. Known model, value within → returned untouched, silent. Unknown
 * model → returned untouched and warned once, because we will not guess a
 * ceiling and will not pretend the value was checked.
 *
 * The transport bound is applied INDEPENDENTLY of the model ceiling and after
 * it, because the two are unrelated: every Anthropic row in the table above is
 * ≥ 64,000 while the SDK stops at 21,333, so a model-only clamp passes a value
 * that then throws client-side. An unknown model is unclamped by the ceiling but
 * is still bounded by the transport, since the transport limit is a fact about
 * the client rather than a guess about the model.
 *
 * @param limits test seam — defaults to the shipped table.
 */
export function clampToModelOutputCeiling(
  requested: number,
  model: string | null | undefined,
  limits: ReadonlyMap<string, number | ModelOutputLimit> = MODEL_MAX_OUTPUT_TOKENS,
  options: OutputCeilingOptions = {},
): OutputCeilingClamp {
  const logger = options.logger ?? log;
  const knob = options.knob ?? DEFAULT_KNOB;
  const ceiling = lookupModelMaxOutputTokens(model, limits);
  const label = model == null || model.trim().length === 0 ? "(unspecified)" : model;

  // #1257 — the transport bound. `bound === null` when the call is streaming or
  // runs on a provider that does not go through the Anthropic SDK.
  const transport = boundNonStreamingOutputTokens(requested, options.nonStreamingProviderKey, {
    logger,
    knob,
    // Best-effort: this layer may hold a Bedrock-style spelling the SDK's
    // per-model table does not match. `AnthropicProvider.chat()` re-checks with
    // the exact outgoing id and is the enforcement point.
    model,
  });

  if (ceiling === null) {
    warnOnce(`unknown:${label}:${requested}`, () =>
      logger.warn(
        `${knob} could not be checked against a model ` +
          "output ceiling — no verified ceiling is known for this model, so the value is " +
          "being sent unclamped. If the model rejects the request, lower the knob to the " +
          "model's real ceiling, or add a row to MODEL_MAX_OUTPUT_TOKENS " +
          "(server/src/lib/ai/model-output-limits.ts).",
        {
          model: label,
          configured: requested,
          // The number the provider can actually be asked for on the salvage
          // path — the base value is not the largest request this produces.
          effectiveWithRepairHeadroom: Math.ceil(requested * REPAIR_HEADROOM),
        },
      ),
    );
    return {
      value: transport.value,
      ceiling: null,
      clamped: transport.clamped,
      sdkNonStreamingBound: transport.bound,
    };
  }

  if (requested <= ceiling) {
    return {
      value: transport.value,
      ceiling,
      clamped: transport.clamped,
      sdkNonStreamingBound: transport.bound,
    };
  }

  warnOnce(`clamped:${label}:${requested}:${ceiling}`, () =>
    logger.warn(
      `${knob} exceeds the active model's output ` +
        "ceiling and has been clamped. The configured value would have been rejected by " +
        "the provider outright — on the degraded salvage pass, which is the worst place " +
        "to discover a config error. Lower the knob to stop seeing this.",
      {
        model: label,
        configured: requested,
        modelCeiling: ceiling,
        effective: ceiling,
      },
    ),
  );
  return {
    value: Math.min(ceiling, transport.value),
    ceiling,
    clamped: true,
    sdkNonStreamingBound: transport.bound,
  };
}
