/**
 * #718 — OUTPUT cap for one scanner LLM call.
 *
 * The per-symbol scan asks for a 2,048-token answer and each FP-filter vote for
 * 512. A model that REASONS BY DEFAULT (DeepSeek `deepseek-flash` /
 * `deepseek-v4-pro`, or a `claude-*` name served by DeepSeek's Anthropic
 * endpoint) draws its reasoning from the same `max_tokens`, so a cap sized for
 * the answer alone can be spent entirely on thinking and return empty content —
 * the "no JSON object/array found in model output" that failed whole scans.
 *
 * Reuses docs-gen's reasoning allowance (`DOCS_GEN_REASONING_ALLOWANCE_TOKENS`,
 * #25) and model-ceiling table rather than growing a second copy of either.
 * The allowance is a CAP, not a spend: a model that does not reason uses none
 * of it, and every other model gets exactly the answer budget.
 */
import type { ConfigService } from "../config/config-service.js";
import { getConfigService } from "../config/config-service.js";
import { modelOutputCeiling, reasoningAllowanceTokens } from "../docs-gen/output-caps.js";

export function scannerMaxOutputTokens(
  answerTokens: number,
  model: string | undefined,
  config: ConfigService = getConfigService(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const withReasoning = answerTokens + reasoningAllowanceTokens(model, config, env);
  const ceiling = modelOutputCeiling(model);
  return ceiling === null ? withReasoning : Math.min(withReasoning, ceiling);
}
