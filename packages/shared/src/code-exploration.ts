/**
 * #2565 — how the analysis code pass investigates the code, and why a run used
 * the mode it did. One vocabulary for the platform key
 * (`ANALYSIS_CODE_EXPLORATION`), the per-project setting (#2566) and the run's
 * capability record.
 *
 * - `explore`: the code pass explores the working tree first (`grep_files`,
 *   `list_files`, whole-file reads), then answers (A20 of #2560, measured on
 *   Miniflux: Recall@5 +0.19 at about +46% cost and +7 s per item).
 * - `fast`: the code pass as it was before #2565 (graph and symbol search,
 *   200-line reads). The kill switch.
 */

export const CODE_PASS_MODES = ["explore", "fast"] as const;
export type CodePassMode = (typeof CODE_PASS_MODES)[number];

/**
 * Why a run's code pass ran in its mode:
 * - `platform-default`: the platform key decided (the project has no setting,
 *   or its setting is `auto`);
 * - `project-explore` / `project-fast`: the project's own setting (#2566);
 * - `no-working-tree`: the repository has no clone on this machine, so the pass
 *   runs `fast` whatever was asked (explore needs the file tools).
 */
export const CODE_PASS_MODE_REASONS = [
  "platform-default",
  "project-explore",
  "project-fast",
  "no-working-tree",
] as const;
export type CodePassModeReason = (typeof CODE_PASS_MODE_REASONS)[number];

/** The mode a code pass ran in, and why. */
export interface CodePassModeDecision {
  mode: CodePassMode;
  reason: CodePassModeReason;
}

/** Why a code pass ended without a validated answer (the orchestrator's degradation reasons). */
export type CodePassDegradation =
  "token-budget" | "turn-limit" | "schema-invalid" | "non-json-response";

/**
 * #2565 — what one code pass spent and how it ended, so #2568 can count how often
 * production's token budget cuts an explore pass short. `tokensUsed` is the
 * loop's cumulative `totalTokens` over every turn (a large read is counted again
 * on every turn until compaction elides it).
 */
export interface CodePassOutcome {
  mode: CodePassMode;
  tokensUsed: number;
  /** The pass's effective token budget (after the seeded blocks are carved out). */
  tokenBudget: number;
  turnsUsed: number;
  maxTurns: number;
  /** Absent when the pass produced a validated answer. */
  degradation?: CodePassDegradation;
  /** Tool calls whose (tool, arguments) the pass had already made. */
  repeatedToolCalls: number;
}
