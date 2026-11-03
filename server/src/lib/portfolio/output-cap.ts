/**
 * #1726 — the OUTPUT cap of a portfolio model call (the criteria split, each
 * repo verdict, the BA report), and one retry of a reply the cap cut off.
 *
 * A reasoning model spends its reasoning from the same `max_tokens` as its
 * answer. At the old 2,000 (repo verdict) and 3,000 (report) a model such as
 * DeepSeek `deepseek-flash` spent the whole cap reasoning and returned nothing
 * (`finishReason=max_tokens, 0 chars`), which read as "the evidence could not
 * be verified". So the cap mirrors the synthesis call's (#1223, #751): a
 * default of 21,000, an operator override (`PORTFOLIO_MAX_OUTPUT_TOKENS`), the
 * docs-gen reasoning allowance added to the DEFAULT for a model that reasons by
 * default, and the model's known ceiling and the Anthropic SDK's non-streaming
 * bound (#1257) applied last. A cap is a ceiling, not a spend: a model that
 * answers in 800 tokens is billed for 800.
 */
import type { AIProvider } from "../ai/types.js";
import {
  JsonLlmParseError,
  callJsonLlm,
  type JsonLlmCallInput,
  type JsonLlmCallResult,
} from "../ai/json-llm-client.js";
import { clampToModelOutputCeiling } from "../ai/model-output-limits.js";
import { boundNonStreamingOutputTokens } from "../ai/nonstreaming-output-bound.js";
import { getConfigService, type ConfigService } from "../config/config-service.js";
import { reasoningAllowanceTokens } from "../docs-gen/output-caps.js";
import { isTruncationFinishReason } from "../docs-gen/truncation.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("portfolio-output-cap");

/** The default cap, the synthesis call's (#1223): measured to hold a reasoning model's reply. */
export const DEFAULT_PORTFOLIO_MAX_OUTPUT_TOKENS = 21_000;
/** The knob that overrides it (db → env). */
export const PORTFOLIO_MAX_OUTPUT_TOKENS_KEY = "PORTFOLIO_MAX_OUTPUT_TOKENS";
/** How much a retry of a cut-off reply raises the cap, before the clamps. */
export const PORTFOLIO_RETRY_CAP_FACTOR = 2;

/** The operator's value, or undefined when unset or not a positive integer (logged). */
function configured(config: ConfigService): number | undefined {
  const raw = config.get(PORTFOLIO_MAX_OUTPUT_TOKENS_KEY);
  if (raw === undefined) return undefined;
  const parsed = config.getKeyDef(PORTFOLIO_MAX_OUTPUT_TOKENS_KEY)?.schema.safeParse(raw);
  const value: unknown = parsed?.success ? parsed.data : undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  log.warn("Portfolio output cap setting is not a positive integer; using the default", {
    knob: PORTFOLIO_MAX_OUTPUT_TOKENS_KEY,
    configured: String(raw).slice(0, 40),
  });
  return undefined;
}

/** Clamp `requested` to what `provider`'s model and transport accept. */
function clamp(requested: number, provider: Pick<AIProvider, "model" | "key">): number {
  return clampToModelOutputCeiling(requested, provider.model, undefined, {
    knob: PORTFOLIO_MAX_OUTPUT_TOKENS_KEY,
    nonStreamingProviderKey: provider.key,
  }).value;
}

/**
 * The cap for one portfolio model call on `provider`: the operator's value as
 * given, or the default plus the reasoning allowance of a model that reasons
 * by default (held at the non-streaming bound), then clamped to the model's
 * ceiling and the transport's bound.
 */
export function resolvePortfolioMaxOutputTokens(
  provider: Pick<AIProvider, "model" | "key">,
  config: ConfigService = getConfigService(),
): number {
  const explicit = configured(config);
  let requested = explicit ?? DEFAULT_PORTFOLIO_MAX_OUTPUT_TOKENS;
  if (explicit === undefined) {
    const allowance = reasoningAllowanceTokens(provider.model, config);
    if (allowance > 0) {
      const silent = { warn: (): void => undefined };
      requested = Math.max(
        requested,
        boundNonStreamingOutputTokens(requested + allowance, provider.key, {
          logger: silent,
          model: provider.model,
        }).value,
      );
    }
  }
  return clamp(requested, provider);
}

/** The cap a retry of a cut-off reply asks for: larger when the clamps allow, never smaller. */
export function retryMaxOutputTokens(
  cap: number,
  provider: Pick<AIProvider, "model" | "key">,
): number {
  return Math.max(cap, clamp(cap * PORTFOLIO_RETRY_CAP_FACTOR, provider));
}

/** Whether `err` is a reply the output cap cut off before any usable JSON. */
export function isCutOffReply(err: unknown): err is JsonLlmParseError {
  return err instanceof JsonLlmParseError && isTruncationFinishReason(err.response.finishReason);
}

/**
 * `callJsonLlm` at `maxTokens`; a reply the cap cut off before any usable JSON
 * (an empty `max_tokens` reply is the usual one: the model reasoned until the
 * cap) is retried once at {@link retryMaxOutputTokens} before the failure is
 * returned. A retry is only worth a call when its cap is LARGER: where the
 * clamps leave the cap unchanged (an Anthropic-transport provider already sits
 * at the SDK's 21,333 non-streaming bound, so DeepSeek through the Anthropic-
 * compatible endpoint does), the same call would be charged for nothing, so the
 * failure is returned instead. Streaming past the bound is a decision recorded
 * in docs/decisions/0008-clamp-non-streaming-output-caps.md, not taken here.
 * `mayRetry` is asked next, and may refuse (a spent budget); it counts the
 * retry when it allows it. Any other failure is thrown as it was.
 */
export async function callJsonLlmRetryingCutOff<T>(
  provider: AIProvider,
  input: JsonLlmCallInput & { maxTokens: number },
  mayRetry: () => boolean = () => true,
): Promise<JsonLlmCallResult<T>> {
  try {
    return await callJsonLlm<T>(provider, input);
  } catch (err) {
    if (!isCutOffReply(err) || input.signal?.aborted) throw err;
    const maxTokens = retryMaxOutputTokens(input.maxTokens, provider);
    if (maxTokens <= input.maxTokens || !mayRetry()) throw err;
    log.warn("Portfolio model reply cut off by its output cap; retrying once", {
      model: provider.model,
      finishReason: err.response.finishReason,
      chars: err.raw.length,
      maxTokens: input.maxTokens,
      retryCap: maxTokens,
    });
    return callJsonLlm<T>(provider, { ...input, maxTokens });
  }
}
