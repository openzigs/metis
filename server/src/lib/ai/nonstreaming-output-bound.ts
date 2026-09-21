/**
 * #1257 — the bound a NON-STREAMING request must respect, and the thinking
 * allowance every output cap is really sized against.
 *
 * ## Why a second bound exists at all
 *
 * `model-output-limits.ts` (#1221) holds what a MODEL can emit. This holds what
 * the `@anthropic-ai/sdk` CLIENT will agree to send without streaming. They are
 * different quantities and the second is far smaller, which is why #1221's
 * clamp reads as the guard against oversized output requests and is not one for
 * any non-streaming call: `claude-sonnet-5` is listed there at 128,000, so
 * `clampToModelOutputCeiling` is a literal no-op for it.
 *
 * ## The derivation, and how to re-check it
 *
 * `Messages.create` calls `Client#calculateNonstreamingTimeout` whenever the
 * client carries no explicit `timeout` — which `AnthropicProvider` does not set
 * — passing the request's `max_tokens` AND a per-model override looked up in the
 * SDK's own table (`@anthropic-ai/sdk` 0.104.2,
 * `resources/messages/messages.js`):
 *
 * ```js
 * const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? undefined;
 * timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
 * ```
 *
 * and that function is, verbatim (`client.js`):
 *
 * ```js
 * calculateNonstreamingTimeout(maxTokens, maxNonstreamingTokens) {
 *   const maxTime = 60 * 60 * 1000;      // 60 minutes
 *   const defaultTime = 60 * 10 * 1000;  // 10 minutes
 *   const expectedTime = (maxTime * maxTokens) / 128000;
 *   if (expectedTime > defaultTime ||
 *       (maxNonstreamingTokens != null && maxTokens > maxNonstreamingTokens)) {
 *     throw new Errors.AnthropicError('Streaming is required for operations …');
 *   }
 *   return defaultTime;
 * }
 * ```
 *
 * **There are therefore TWO throw conditions, not one**, and #1257 as filed named
 * only the first. The general bound is the largest integer satisfying
 * `60min × maxTokens / 128_000 ≤ 10min`, i.e. `⌊128_000 × 10 / 60⌋ = 21_333`. But
 * for the eight ids in {@link SDK_MODEL_NONSTREAMING_TOKENS} the SDK throws far
 * below that — at 8,192 — and clamping to 21,333 would not have saved a
 * deployment running one of them. `ANTHROPIC_MODEL` is an unconstrained string
 * (`ai/config.ts`), so those ids are reachable. The effective bound is the
 * MINIMUM of the two.
 *
 * **The test is the oracle, not this comment.** `nonstreaming-output-bound.test.ts`
 * asks the INSTALLED SDK directly — `n` accepted, `n + 1` throws, per model and in
 * general — and additionally reads the SDK's own table off disk and asserts our
 * mirror of it is identical, so an SDK bump that moves either the formula or the
 * table fails a 20 ms unit test rather than a live run. Do not "simplify" those
 * tests into a restatement of the arithmetic here: an expression derived on both
 * sides of an assertion proves nothing (#1222), and calling
 * `calculateNonstreamingTimeout` with ONE argument silently skips the second
 * throw condition entirely.
 *
 * ## Why clamp rather than switch to `stream()`
 *
 * Recorded in `docs/decisions/0008-clamp-non-streaming-output-caps.md`. Short
 * version: `chat()` is a one-shot `Promise<ChatResponse>` consumed by dozens of
 * call sites with their own parsing, retry and `responseFormat` handling;
 * converting them to `stream()` to buy headroom nobody currently uses would be a
 * large behavioural change to buy nothing. The constraint the SDK encodes is
 * also real — a >10-minute non-streaming HTTP response is what intermediaries
 * drop — so raising past it is not obviously safe merely because the client
 * stopped objecting. A caller that genuinely needs more than 21,333 output
 * tokens should stream, and the warning below says so.
 *
 * ## The other half: thinking spends the same budget
 *
 * `claude-sonnet-5` emits thinking BY DEFAULT — METIS sends no `thinking` field
 * and `output_tokens_details.thinking_tokens` comes back populated anyway — and
 * those tokens are drawn from the same `max_tokens` allowance as the answer. So
 * a cap sized against the expected payload is sized against roughly half of what
 * the request consumes, and the fraction moves run to run.
 * {@link OBSERVED_THINKING_TOKENS} carries the measured band so a cap can be
 * assessed against it instead of against a guess.
 */
import { createChildLogger } from "../logger.js";
import type { ProviderKey } from "./types.js";

const log = createChildLogger("nonstreaming-output-bound");

/** The SDK's non-streaming budget, in minutes (`defaultTime` in its source). */
export const SDK_NONSTREAMING_BUDGET_MINUTES = 10;
/** The SDK's reference wall-clock for a full-window response, in minutes (`maxTime`). */
export const SDK_FULL_WINDOW_MINUTES = 60;
/** The token count the SDK's rate assumption is expressed against. */
export const SDK_REFERENCE_MAX_TOKENS = 128_000;

/**
 * The largest `max_tokens` `@anthropic-ai/sdk` accepts on a non-streaming
 * request. Derived from the three constants above exactly as
 * `calculateNonstreamingTimeout` combines them; pinned against the installed
 * SDK in the sibling test.
 */
export const ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS = Math.floor(
  (SDK_REFERENCE_MAX_TOKENS * SDK_NONSTREAMING_BUDGET_MINUTES) / SDK_FULL_WINDOW_MINUTES,
);

/**
 * Provider keys whose `chat()` goes through `@anthropic-ai/sdk` and therefore
 * inherits its client-side non-streaming bound.
 *
 * Deliberately an ALLOWLIST of one rather than "any provider serving a Claude
 * model". `bedrock-gateway` reaches the same models through the AWS SDK, which
 * has no such heuristic, and clamping it would be an over-block on a cap that
 * was deliberately raised for it (#1226's 32,768 section cap). The bound is a
 * property of the CLIENT, not of the model.
 */
const ANTHROPIC_SDK_PROVIDERS: ReadonlySet<string> = new Set<ProviderKey>(["anthropic"]);

/**
 * A MIRROR of `MODEL_NONSTREAMING_TOKENS` in `@anthropic-ai/sdk` 0.104.2
 * (`internal/constants.js`) — the SDK's per-model non-streaming ceiling, which
 * is a SECOND throw condition below the general 21,333 bound.
 *
 * Mirrored rather than imported because `./internal/constants` is not in the
 * package's `exports` map, so a deep import fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. A mirror of a table is exactly the shape that
 * goes stale silently, so it is pinned twice in the sibling test: byte-for-byte
 * against the SDK's own file read off disk, and behaviourally against
 * `calculateNonstreamingTimeout(n, limit)` per id.
 *
 * Keys are the id **as sent on the wire**, matched EXACTLY, because that is how
 * the SDK matches them. `AnthropicProvider` normalises Bedrock-isms off the id
 * before sending, so the provider-boundary check sees the same string the SDK
 * will — which is why enforcement lives there and the resolution-layer check is
 * best-effort.
 */
export const SDK_MODEL_NONSTREAMING_TOKENS: Readonly<Record<string, number>> = {
  "claude-opus-4-20250514": 8192,
  "claude-opus-4-0": 8192,
  "claude-4-opus-20250514": 8192,
  "anthropic.claude-opus-4-20250514-v1:0": 8192,
  "claude-opus-4@20250514": 8192,
  "claude-opus-4-1-20250805": 8192,
  "anthropic.claude-opus-4-1-20250805-v1:0": 8192,
  "claude-opus-4-1@20250805": 8192,
};

/**
 * The bound in force for `model`: the general 21,333, lowered to the SDK's
 * per-model ceiling when it has one for that exact id.
 *
 * An id the table does not name gets the general bound — never a guessed
 * smaller one. That mirrors the SDK's `?? undefined`, which skips the per-model
 * condition entirely for an unlisted id.
 */
export function nonStreamingBoundForModel(model?: string | null): number {
  if (model == null) return ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS;
  const perModel = SDK_MODEL_NONSTREAMING_TOKENS[model.trim()];
  return perModel === undefined
    ? ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS
    : Math.min(ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS, perModel);
}

/** Outcome of a non-streaming bound check, including the numbers a warning names. */
export interface NonStreamingBoundClamp {
  /** The value to actually send as `maxTokens`. */
  value: number;
  /** The SDK bound, or `null` when this provider is not subject to one. */
  bound: number | null;
  /** `true` only when {@link value} is below what the caller asked for. */
  clamped: boolean;
}

/** The subset of a logger this module needs (mirrors `model-output-limits.ts`). */
export interface NonStreamingBoundLogger {
  warn: (msg: string, meta?: unknown) => void;
}

/**
 * Warn-once ledger, keyed by knob + the numbers involved, so a genuinely
 * different misconfiguration is still heard while a per-call repeat is not.
 */
const warned = new Set<string>();

/** @internal test-only — reset the warn-once ledger between cases. */
export function __resetNonStreamingBoundWarnings(): void {
  warned.clear();
}

/** Optional inputs to {@link boundNonStreamingOutputTokens}. */
export interface NonStreamingBoundOptions {
  /** Test seam — defaults to this module's child logger. */
  logger?: NonStreamingBoundLogger;
  /** The setting an operator would change, named in the warning. */
  knob?: string;
  /**
   * The model id **as it will be sent on the wire**. When it is one of the eight
   * the SDK caps at 8,192 the bound drops accordingly. Omitting it is safe but
   * weaker: the general 21,333 applies and a per-model throw is not prevented,
   * which is why `AnthropicProvider.chat()` — the one place holding the exact
   * outgoing id — always passes it.
   */
  model?: string | null;
}

/**
 * Hold `requested` at or below the SDK's non-streaming bound, when the request
 * will actually travel through the Anthropic SDK.
 *
 * Not subject to the bound (`bound: null`, value untouched): every other
 * provider, and an absent/unknown key — we will not bound a transport we cannot
 * name.
 *
 * @param requested the cap the call site resolved.
 * @param providerKey the provider the request will run on (`provider.key`).
 */
export function boundNonStreamingOutputTokens(
  requested: number,
  providerKey: string | null | undefined,
  options: NonStreamingBoundOptions = {},
): NonStreamingBoundClamp {
  if (providerKey == null || !ANTHROPIC_SDK_PROVIDERS.has(providerKey)) {
    return { value: requested, bound: null, clamped: false };
  }
  const logger = options.logger ?? log;
  const knob = options.knob ?? "the configured output cap";
  // #1257 (adversarial panel) — the SDK has TWO throw conditions, and the
  // per-model one is far lower. Taking only the general bound would have left
  // `claude-opus-4-0` and its seven aliases throwing at 8,193 with the clamp
  // reporting a clean 21,333.
  const bound = nonStreamingBoundForModel(options.model);
  // A non-finite request is a DEFECT upstream, not an over-large cap. Clamping
  // it would launder `NaN` into a legal-looking 21,333 and hide the bug — which
  // is exactly how a sweep test over a mis-resolved import passed while proving
  // nothing. Pass it through and let it fail where it was produced.
  if (!Number.isFinite(requested) || requested <= bound) {
    return { value: requested, bound, clamped: false };
  }

  const key = `${knob}:${requested}:${bound}`;
  if (!warned.has(key)) {
    warned.add(key);
    logger.warn(
      `${knob} exceeds what the Anthropic SDK accepts on a NON-STREAMING request and ` +
        "has been clamped. The SDK throws client-side — before any network call — for a " +
        "max_tokens implying more than its ten-minute non-streaming budget, so the " +
        "unclamped value would have failed the call outright rather than truncating it. " +
        "This bound is the CLIENT's, not the model's: the model's own ceiling is higher " +
        "and does not protect this path. A call that genuinely needs a larger output " +
        "budget must use the streaming path, which carries no such bound.",
      {
        knob,
        providerKey,
        model: options.model ?? "(unspecified)",
        configured: requested,
        sdkNonStreamingBound: bound,
        // Names WHICH of the two SDK throw conditions bound this request, so
        // an operator seeing 8,192 does not go hunting for a ten-minute budget.
        // NOTE: no apostrophes in a comment inside a log call — the #1263
        // enumeration scanner treats one as a string opener and then mis-slices
        // the call, which is how this line first failed that gate.
        boundSource:
          bound === ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS
            ? "SDK ten-minute non-streaming budget"
            : "SDK MODEL_NONSTREAMING_TOKENS entry for this model",
        effective: bound,
      },
    );
  }
  return { value: bound, bound, clamped: true };
}

/**
 * Thinking tokens observed on five identical synthesis calls at a 16,000 cap
 * (#1223's live reproduction; four of the five reported the field).
 *
 * These are MEASUREMENTS, not a budget: the point of keeping them is that a cap
 * can be assessed against the worst run actually seen rather than against a
 * plausible-sounding fraction. Re-measure from `thinking_tokens` in the provider
 * logs — {@link ../ai/providers/anthropic-provider} emits it per call — before
 * moving either number.
 */
export const OBSERVED_THINKING_TOKENS = {
  /** Smallest reported. */
  min: 5_088,
  /** Largest reported — the run that also hit `stop_reason: max_tokens`. */
  max: 9_763,
  /** Runs that reported the field, out of five identical calls. */
  sampleSize: 4,
} as const;

/**
 * Does `cap` leave room for `payloadTokens` of answer AFTER the worst thinking
 * run we have measured?
 *
 * The arithmetic is trivial; having it in one named place is what stops each
 * call site inventing its own fraction. Equality counts as surviving — a cap
 * exactly equal to payload + thinking emits the whole payload.
 */
export function survivesObservedThinkingRun(
  cap: number,
  payloadTokens: number,
  opts: { thinkingTokens?: number } = {},
): boolean {
  const thinking = opts.thinkingTokens ?? OBSERVED_THINKING_TOKENS.max;
  return cap >= payloadTokens + thinking;
}
