/**
 * #1224 — how "reasoning off" (`ChatOptions.disableThinking`) is spelled for
 * each model behind the Anthropic Messages API.
 *
 * `thinking: {type: "disabled"}` is not accepted everywhere. Anthropic's
 * per-model thinking table ("Troubleshooting thinking",
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting,
 * read 2026-10-19) says:
 *
 *   • Claude Sonnet 5.5 rejects `disabled` at every effort and takes
 *     `{type: "between_tools"}` in its place (no other field, effort ≤ high).
 *     Only Sonnet 5.5 accepts `between_tools`.
 *   • Claude Opus 5.5, Fable 5 / 5.1 and Mythos 5 / 5.1 are "always on": they
 *     reject `disabled` and cannot turn thinking off at all. The parameter is
 *     omitted and the effort set to its lowest level, `low`.
 *   • Every other model in the registry (`model-catalog.ts` BUILTIN_MODELS:
 *     Haiku 5.5, Sonnet 5, Opus 4.8, Sonnet 4.6, Haiku 4.5) accepts `disabled`
 *     — Haiku 5.5 at effort ≤ high, and "off" sends no effort — and so does
 *     DeepSeek's Anthropic-compatible endpoint, which documents only
 *     `enabled`/`disabled` (https://api-docs.deepseek.com/guides/thinking_mode).
 *     An id this module does not recognise keeps `disabled`, the pre-#1224
 *     behaviour, rather than guessing.
 */

/** The `thinking` / effort an "off" request sends. */
export type ThinkingOff =
  { kind: "disabled" } | { kind: "between-tools" } | { kind: "always-on"; effort: "low" };

/**
 * Strip the spellings that do not change which model it is: a regional or
 * `global.` inference prefix, the `anthropic.` vendor segment, a `[1m]`
 * context tag. A dated suffix and Bedrock's `-v1:0` suffix are left in place
 * and matched as a continuation by {@link isModel} (PR #1275 review: a
 * separate `-v1:0` strip was unreachable, so it was removed rather than
 * kept as untestable code).
 */
function bareClaudeId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^(?:us|eu|apac|global)\./, "")
    .replace(/^anthropic\./, "")
    .replace(/\[[^\]]*\]$/, "");
}

/**
 * `id`, `id-<date>`, `id-v1:0` (Bedrock) or `id@<version>` (Vertex) — never a
 * longer version (`5-5` ≠ `5`, `5-5` ≠ `5-50`).
 */
function isModel(bare: string, id: string): boolean {
  return bare === id || bare.startsWith(`${id}-`) || bare.startsWith(`${id}@`);
}

const ALWAYS_ON_FAMILIES = /^claude-(?:fable|mythos)-/;

export function anthropicThinkingOff(model: string, deepSeekEndpoint: boolean): ThinkingOff {
  if (deepSeekEndpoint) return { kind: "disabled" };
  const bare = bareClaudeId(model);
  if (isModel(bare, "claude-sonnet-5-5")) return { kind: "between-tools" };
  if (isModel(bare, "claude-opus-5-5") || ALWAYS_ON_FAMILIES.test(bare)) {
    return { kind: "always-on", effort: "low" };
  }
  return { kind: "disabled" };
}
