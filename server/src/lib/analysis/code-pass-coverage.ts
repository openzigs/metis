/**
 * #1388 — keep the agentic code pass investigating while it can, and never let a
 * shallow pass read as a clean one.
 *
 * The measured run (`cmvivqzri008jj39km1bzzjk8`, DeepSeek, 32 requirements): the
 * loop's third reply (116 output tokens) was neither a parseable tool call nor
 * the findings JSON, so the loop treated it as the final answer and stopped at
 * 6k of a ~100k budget after 7 tool calls. The final-answer retry then told the
 * model it had no tools left (its note: "no tool access remained"), and it wrote
 * up 22 of 32 requirements as could-not-verify. That retry SUCCEEDED, so nothing
 * marked the code agent degraded: the card read a green `completed`.
 *
 * Two halves, both pure:
 *   - {@link buildCodePassContinuation} — the loop's continuation policy: a
 *     tool-less reply that is not a usable answer, or an answer that leaves most
 *     requirements unverified with most of the budget unspent, is sent back with
 *     an instruction to keep investigating (bounded, see `MAX_CONTINUATION_NUDGES`).
 *   - {@link assessShallowCodePass} — after the pass, whether it ended shallow
 *     (most requirements unverified, or starved retrieval far under budget), and
 *     the analyst-facing note that puts the `degraded` badge on the agent card.
 */
import { AGENT_DEGRADED_NOTE_PREFIX, type AnalysisRetrievalHealth } from "@metis/shared";
import type { AgentLoopContinuationState, AgentLoopOptions } from "./agent-loop.js";
import { extractJsonObject } from "./agent-runner.js";
import {
  MAX_UNVERIFIED_REQUIREMENT_SHARE,
  unverifiedRequirementIds,
  type VerdictBearingFinding,
} from "./retrieval-health.js";

/** Extra exchanges one pass may spend being asked to continue. */
export const MAX_CONTINUATION_NUDGES = 2;

/**
 * An answer leaving most requirements unverified is sent back only while the
 * pass has spent less than this share of its token budget: past it, finishing
 * the answer is worth more than another round of searching.
 */
export const COVERAGE_NUDGE_MAX_BUDGET_SHARE = 0.5;

/**
 * A pass whose retrieval was starved is reported degraded when it also spent
 * less than this share of its budget: it stopped by choice, not for lack of room.
 */
export const SHALLOW_PASS_MAX_BUDGET_SHARE = 0.5;

/**
 * An answer is sent back for coverage only with at least this many turns left:
 * a search, a read and the answer again. With fewer, the loop could end on a
 * tool call and leave the run to the final-answer retry.
 */
export const COVERAGE_NUDGE_MIN_TURNS_LEFT = 3;

/** How many unverified ids a coverage nudge names. */
const NUDGE_ID_LIMIT = 15;

const budgetShare = (used: number | undefined, total: number | undefined): number | null =>
  used !== undefined && total !== undefined && total > 0 ? used / total : null;

const percent = (share: number): number => Math.max(1, Math.round(share * 100));

function turnsLeftText(turnsLeft: number): string {
  return `${turnsLeft} turn${turnsLeft === 1 ? "" : "s"}`;
}

/** The instruction for a tool-less reply that is not a usable answer. */
export function unusableReplyInstruction(state: AgentLoopContinuationState): string {
  return [
    "Your last reply was neither a tool call nor the final JSON answer, so it could not be used.",
    `Your tools are still available, and you have ${turnsLeftText(state.turnsLeft)} and token budget left.`,
    "If any requirement is not yet backed by code you have read, call a tool now to investigate it.",
    "Otherwise emit your final answer as EXACTLY ONE JSON object matching the response schema from your",
    "role description (agentKey, summary, findings[], notes[]), with nothing before or after it.",
  ].join("\n");
}

/** The instruction for an answer that leaves most requirements unverified. */
export function coverageInstruction(
  unverified: readonly string[],
  requirementCount: number,
  state: AgentLoopContinuationState,
): string {
  const named = unverified.slice(0, NUDGE_ID_LIMIT).join(", ");
  const more =
    unverified.length > NUDGE_ID_LIMIT ? `, and ${unverified.length - NUDGE_ID_LIMIT} more` : "";
  const share = budgetShare(state.budgetUsed, state.budgetTotal);
  const spent =
    share === null ? "" : ` You have used only about ${percent(share)}% of your token budget.`;
  return [
    `Do not answer yet. Your answer leaves ${unverified.length} of ${requirementCount} requirements without`,
    `code evidence (${named}${more}).${spent} You have ${turnsLeftText(state.turnsLeft)} left and your tools are still available.`,
    "Investigate those requirements now: search for each one, then read the code that matches.",
    "When they are investigated, or you have run out of leads, emit the full findings JSON again.",
    "A requirement you genuinely cannot find in the code stays could-not-verify.",
  ].join("\n");
}

function answerFindings(text: string): VerdictBearingFinding[] | null {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return null;
  return findings.filter(
    (f): f is VerdictBearingFinding => f !== null && typeof f === "object",
  ) as VerdictBearingFinding[];
}

/**
 * The agentic code pass's continuation policy for {@link AgentLoopOptions.continuation}.
 * `isValidFinalAnswer` is the same predicate the final-answer retry uses, so a
 * reply this policy accepts is one the orchestrator can persist.
 */
export function buildCodePassContinuation(input: {
  requirementIds: readonly string[];
  isValidFinalAnswer: (text: string) => boolean;
}): NonNullable<AgentLoopOptions["continuation"]> {
  let coverageNudged = false;
  return {
    maxNudges: MAX_CONTINUATION_NUDGES,
    nudge: (reply, state) => {
      if (!input.isValidFinalAnswer(reply)) return unusableReplyInstruction(state);
      // A usable answer: send it back once, and only when it leaves most
      // requirements unverified with most of the budget still unspent.
      if (coverageNudged || input.requirementIds.length === 0) return null;
      const share = budgetShare(state.budgetUsed, state.budgetTotal);
      if (share === null || share >= COVERAGE_NUDGE_MAX_BUDGET_SHARE) return null;
      // #1388 review — room to search, read and answer again; otherwise keep it.
      if (state.turnsLeft < COVERAGE_NUDGE_MIN_TURNS_LEFT) return null;
      const findings = answerFindings(reply);
      if (!findings) return null;
      const unverified = unverifiedRequirementIds(findings, input.requirementIds);
      if (unverified.length <= input.requirementIds.length * MAX_UNVERIFIED_REQUIREMENT_SHARE) {
        return null;
      }
      coverageNudged = true;
      return coverageInstruction(unverified, input.requirementIds.length, state);
    },
  };
}

export interface ShallowCodePassInput {
  /** The pass's REPORTED health (after `assessInvestigationCoverage`). */
  health: AnalysisRetrievalHealth;
  turnsUsed: number;
  toolCalls: number;
  /** Tokens the loop's turns were charged; `undefined` when not reported. */
  loopTokens?: number;
  /** The pass's token budget. */
  budget: number;
}

export interface ShallowCodePassVerdict {
  shallow: boolean;
  /** The agent-card note (carries {@link AGENT_DEGRADED_NOTE_PREFIX}) when `shallow`. */
  note?: string;
}

/**
 * Did this code pass end shallow? Yes when it stopped on its own (not cut off by
 * its turn or token budget) and MORE than half of its requirements came back
 * unverified, or its retrieval was starved and it had spent under
 * {@link SHALLOW_PASS_MAX_BUDGET_SHARE} of its budget. A pass that covered its
 * requirements is never flagged, however little it spent.
 *
 * A pass its budget cut off is left to `code-investigation-cut-short` (#1001),
 * which already reports how many requirements it did not reach and offers to
 * continue it; flagging it here too would report one cause twice.
 */
export function assessShallowCodePass(input: ShallowCodePassInput): ShallowCodePassVerdict {
  const { health } = input;
  const total = health.requirementCount;
  if (total === 0 || health.exhausted === true) return { shallow: false };
  const unverified = Math.min(total, Math.max(0, health.unverifiedRequirements ?? 0));
  const mostlyUnverified = unverified > total * MAX_UNVERIFIED_REQUIREMENT_SHARE;
  const share = budgetShare(input.loopTokens, input.budget);
  const starvedEarly = health.starved && share !== null && share < SHALLOW_PASS_MAX_BUDGET_SHARE;
  if (!mostlyUnverified && !starvedEarly) return { shallow: false };

  const turns = `${input.turnsUsed} turn${input.turnsUsed === 1 ? "" : "s"}`;
  const calls = `${input.toolCalls} look-up${input.toolCalls === 1 ? "" : "s"} in the code`;
  const stop =
    share !== null
      ? `the code agent stopped after ${turns} and ${calls}, using about ${percent(share)}% of its token budget`
      : `the code agent stopped after ${turns} and ${calls}`;
  const outcome = mostlyUnverified
    ? `, and ${unverified} of ${total} requirements were not checked against the code. They are marked “Could not verify”`
    : `, which is too few to check ${total} requirements against the code`;
  const note = `${AGENT_DEGRADED_NOTE_PREFIX} ${stop}${outcome}. Re-run the code investigation before relying on its results.`;
  return { shallow: true, note: note.slice(0, 512) };
}
