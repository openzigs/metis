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
import { z } from "zod";

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

/**
 * Issue #2566 — `Project.codeExploration` legal values: `auto` (the column
 * default) defers to the platform key; `explore` / `fast` override it. Stored
 * as a `String` column, so ALWAYS validate a write against this whitelist
 * (OWASP A03), at the route and again in the service.
 */
export const CODE_EXPLORATION_SETTINGS = ["auto", "explore", "fast"] as const;
export type CodeExplorationSetting = (typeof CODE_EXPLORATION_SETTINGS)[number];

/** The `Project.codeExploration` column default (`@default("auto")`). */
export const DEFAULT_CODE_EXPLORATION_SETTING: CodeExplorationSetting = "auto";

/** Zod validator for a {@link CodeExplorationSetting}. */
export const codeExplorationSettingSchema = z.enum(CODE_EXPLORATION_SETTINGS);

/** `PATCH /api/projects/:id/code-exploration` request payload. */
export const updateCodeExplorationSchema = z
  .object({ codeExploration: codeExplorationSettingSchema })
  .strict();
export type UpdateCodeExplorationInput = z.infer<typeof updateCodeExplorationSchema>;

/**
 * Issue #2566 — the mode a project's code pass runs in, before the working
 * tree is checked: the project's own setting, or (`auto`, or an unknown
 * stored value) the platform default. Pure. The orchestrator then forces
 * `fast` with `no-working-tree` when the repository has no clone.
 */
export function resolveCodeExploration(
  projectSetting: string | null | undefined,
  platformDefault: CodePassMode,
): CodePassModeDecision {
  if (projectSetting === "explore") return { mode: "explore", reason: "project-explore" };
  if (projectSetting === "fast") return { mode: "fast", reason: "project-fast" };
  return { mode: platformDefault, reason: "platform-default" };
}

/** Issue #2566 — a project's raw setting and what it resolves to now (`GET /api/projects/:id`). */
export interface ProjectCodeExplorationState {
  setting: CodeExplorationSetting;
  resolved: CodePassModeDecision;
}

/** Why a code pass ended without a validated answer (the orchestrator's degradation reasons). */
export type CodePassDegradation =
  | "token-budget"
  | "turn-limit"
  | "schema-invalid"
  | "non-json-response"
  /** #2569 — the pass reached its dollar ceiling (`ANALYSIS_CODE_PASS_MAX_USD`). */
  | "cost-ceiling";

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

/**
 * #2569 — the code pass's dollar ceiling, on the capability record when it
 * stopped a pass or could not price one. `limitUsd` is the run's ceiling
 * (`ANALYSIS_CODE_PASS_MAX_USD` per requirement, shared by every repository's
 * pass); `spentUsd` is the priced spend it counted, a lower bound when
 * `pricing` is `cost-ceiling-unpriced`.
 */
export interface CodePassCostCeilingRecord {
  limitUsd: number;
  spentUsd: number;
  /** The ceiling refused a model call, so a pass stopped short. */
  reached: boolean;
  /**
   * `cost-ceiling-unpriced`: a call's model has no ledger rate, so its cost is
   * unknown (never $0) and the pass was bounded by its token budget.
   */
  pricing: "priced" | "cost-ceiling-unpriced";
}
