/**
 * #25 (follow-up to #41) — how much a docs-gen call may REASON.
 *
 * #41 gave thinking-by-default models a large output budget so reasoning no
 * longer truncates the answer. The measured cost was the opposite problem:
 * `deepseek-v4-pro` (whose documented default is thinking ON at `high` effort,
 * https://api-docs.deepseek.com/guides/thinking_mode) spent ~19,800 output
 * tokens and ~88 s per Phase-1 module instead of ~7,700 / ~23 s. Phase 1 is
 * mechanical per-module fact extraction, so the headroom is kept as a safety
 * margin and the reasoning itself is bounded here instead.
 *
 * Only Phase 1 is bounded for now; Phase-2 synthesis, claim extraction and the
 * faithfulness judge keep the provider default until a complete run is
 * re-measured.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";
import type { ChatOptions } from "../ai/types.js";
import { servedModelThinksByDefault } from "./output-caps.js";

/** Values accepted by `DOCS_GEN_PHASE1_REASONING`. */
export const DOCS_GEN_REASONING_MODES = [
  "auto",
  "provider-default",
  "off",
  "low",
  "medium",
  "high",
] as const;
export type DocsGenReasoningMode = (typeof DOCS_GEN_REASONING_MODES)[number];

/**
 * The Phase-1 effort `auto` picks for a thinking-by-default model. DeepSeek's
 * lowest documented effort; it maps `medium` up to `high`, so `low` is the only
 * value that actually reduces its reasoning without switching it off.
 */
export const DEFAULT_THINKING_MODEL_PHASE1_EFFORT = "low" as const;

/** The per-request options a resolved mode contributes to a chat call. */
export type DocsGenReasoningOptions = Pick<ChatOptions, "reasoningEffort" | "disableThinking">;

function readMode(config: ConfigService, key: string): DocsGenReasoningMode {
  const raw = config.get(key)?.trim().toLowerCase();
  return (DOCS_GEN_REASONING_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as DocsGenReasoningMode)
    : "auto";
}

/**
 * Resolve the reasoning options for ONE Phase-1 fact-extraction call on
 * `model` (the id the provider will send).
 *
 *   • `auto` (default, also any unrecognised value) — `low` effort for a model
 *     that reasons by default ({@link servedModelThinksByDefault}); NOTHING for
 *     any other model, so Claude on api.anthropic.com is sent the same request
 *     as before.
 *   • `provider-default` — send nothing; the model's own default applies.
 *   • `off` — thinking disabled (the `anthropic` provider spells it per model,
 *     #1224: `between_tools` on Sonnet 5.5, lowest effort on an always-on model).
 *   • `low` / `medium` / `high` — that effort, for any model. On Claude this
 *     turns adaptive thinking ON, so it is an explicit operator choice only.
 *
 * Honoured by the native `anthropic` provider (including an
 * Anthropic-compatible `ANTHROPIC_BASE_URL`) and by `local-gemma` (as
 * `reasoning_effort`; `off` → `think: false` + `reasoning_effort: "none"`);
 * other providers ignore it.
 */
export function resolvePhase1Reasoning(
  model: string | undefined,
  config: ConfigService = getConfigService(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DocsGenReasoningOptions {
  return resolveReasoningSetting("DOCS_GEN_PHASE1_REASONING", model, config, env);
}

/**
 * Provider keys that put `ChatOptions.reasoningEffort` / `disableThinking` on
 * the wire: the native `anthropic` provider (`thinking` + `output_config.effort`,
 * `anthropic-provider.ts`) and `local-gemma` (`reasoning_effort` / `think`,
 * `thinkingFields` in `bedrock-direct-provider.ts`). Every other key (`openai`,
 * `azure`, `bedrock-gateway`) drops both, so a model that reasons by default
 * behind an OpenAI-format endpoint is NOT bounded by any reasoning setting here.
 * Keep in step with those two call sites.
 */
const REASONING_OPTION_PROVIDER_KEYS: ReadonlySet<string> = new Set(["anthropic", "local-gemma"]);

/**
 * PR #1095 review — whether a `*_REASONING` setting can reach the model through
 * `providerKey`. Used so a note never advises a setting that does nothing.
 */
export function providerHonoursReasoningOptions(providerKey: string | undefined): boolean {
  return providerKey !== undefined && REASONING_OPTION_PROVIDER_KEYS.has(providerKey);
}

/**
 * #1057 — the same resolution for any config key that takes the
 * {@link DOCS_GEN_REASONING_MODES} values (`SPEC_KIT_REASONING` uses it too).
 */
export function resolveReasoningSetting(
  key: string,
  model: string | undefined,
  config: ConfigService = getConfigService(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DocsGenReasoningOptions {
  const mode = readMode(config, key);
  switch (mode) {
    case "provider-default":
      return {};
    case "off":
      return { disableThinking: true };
    case "low":
    case "medium":
    case "high":
      return { reasoningEffort: mode };
    case "auto":
      return servedModelThinksByDefault(model, env)
        ? { reasoningEffort: DEFAULT_THINKING_MODEL_PHASE1_EFFORT }
        : {};
  }
}
