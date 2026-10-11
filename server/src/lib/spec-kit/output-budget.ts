/**
 * #1057 — the output budget every Spec Kit model call sends.
 *
 * Spec Kit used to pass no `maxTokens` and no reasoning option, so the native
 * Anthropic path fell back to its 16,000-token non-streaming default and a
 * thinking-by-default model (DeepSeek `deepseek-flash`, or a `claude-*` name on
 * DeepSeek's Anthropic endpoint) spent that budget reasoning at its default
 * HIGH effort. In #706 run 7 `/speckit.plan` came back three times with
 * nothing but reasoning and was saved as a stub.
 *
 * Both values are config-driven (db → env, read per call):
 *
 *   • `SPEC_KIT_MAX_OUTPUT_TOKENS` — the call's `max_tokens`. Default 21,333,
 *     the Anthropic SDK's non-streaming bound (ADR 0008): the `anthropic`
 *     provider clamps to it anyway, so asking for more buys nothing. Clamped to
 *     the model's known output ceiling; a model with no known ceiling gets the
 *     same 8,192 safe default docs-gen uses unless the operator set a value.
 *   • `SPEC_KIT_REASONING` — the docs-gen reasoning modes. `auto` (default)
 *     asks a thinking-by-default model for LOW effort and sends nothing to any
 *     other model, so Claude on api.anthropic.com keeps its request shape.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";
import type { ChatOptions } from "../ai/types.js";
import { modelOutputCeiling } from "../docs-gen/output-caps.js";
import { resolveReasoningSetting } from "../docs-gen/docs-gen-reasoning.js";

/** Default `max_tokens` for one Spec Kit call — the SDK non-streaming bound. */
export const DEFAULT_SPEC_KIT_MAX_OUTPUT_TOKENS = 21_333;

/** Default for a model with no known ceiling (matches docs-gen's safe default). */
const UNKNOWN_MODEL_SAFE_DEFAULT = 8_192;

/** Below this no Spec Kit artifact could be written at all. */
const MIN_SPEC_KIT_MAX_OUTPUT_TOKENS = 512;

export type SpecKitOutputOptions = Pick<
  ChatOptions,
  "maxTokens" | "reasoningEffort" | "disableThinking"
>;

/** The `max_tokens` one Spec Kit call on `model` sends. */
export function resolveSpecKitMaxOutputTokens(
  model: string | undefined,
  config: ConfigService = getConfigService(),
): number {
  const ceiling = modelOutputCeiling(model);
  const fallback =
    ceiling === null
      ? Math.min(DEFAULT_SPEC_KIT_MAX_OUTPUT_TOKENS, UNKNOWN_MODEL_SAFE_DEFAULT)
      : DEFAULT_SPEC_KIT_MAX_OUTPUT_TOKENS;
  const raw = config.getNumber("SPEC_KIT_MAX_OUTPUT_TOKENS", fallback);
  const configured =
    Number.isFinite(raw) && raw >= MIN_SPEC_KIT_MAX_OUTPUT_TOKENS ? Math.floor(raw) : fallback;
  return ceiling === null ? configured : Math.min(configured, ceiling);
}

/** The output cap plus reasoning options one Spec Kit call on `model` sends. */
export function resolveSpecKitOutputOptions(
  model: string | undefined,
  config: ConfigService = getConfigService(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): SpecKitOutputOptions {
  return {
    maxTokens: resolveSpecKitMaxOutputTokens(model, config),
    ...resolveReasoningSetting("SPEC_KIT_REASONING", model, config, env),
  };
}
