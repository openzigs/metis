/**
 * Epic #880 — Issue #886 — provider-backed {@link JudgeModelCaller}.
 *
 * The test-coverage judge + suggestion phases depend on a pluggable
 * {@link JudgeModelCaller} so tests can run without a live model. In
 * production the runner must be wired with a real bridge, otherwise the
 * judge/suggest phases are silently skipped (the original #886 bug). This
 * adapter wraps any {@link AIProvider} into that contract using a
 * tool-free text completion.
 */
import type { AIProvider } from "../ai/types.js";
import type { JudgeModelCaller } from "./judge.js";

/**
 * Build a {@link JudgeModelCaller} backed by a concrete {@link AIProvider}.
 * Tools are disabled for these calls — the judge expects a pure JSON text
 * response and must not be tempted into tool use.
 */
export function createProviderJudgeCaller(provider: AIProvider): JudgeModelCaller {
  return {
    async call({ modelId, systemPrompt, userPrompt }) {
      const res = await provider.chat([{ role: "user", content: userPrompt }], {
        model: modelId,
        systemMessage: systemPrompt,
        disableTools: true,
      });
      return {
        raw: res.content,
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
      };
    },
  };
}
