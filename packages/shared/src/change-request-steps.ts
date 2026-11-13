/**
 * Issue #2341 (epic #2328) — where a change request stands, as eight steps:
 * Read → Questions → Requirements → Policy check → Impact → Portfolio → Review
 * → Hand-off.
 *
 * Shared so the UI's step header and the server (Home grouped by state, #2348;
 * "questions waiting" on the list and the Overview, #2343) derive the same
 * states from the same rules: one source of truth, not one per reader.
 *
 * Every state is derived from data the product already has (the run, its
 * agents, its requirements, its open questions, its governing findings, the
 * portfolio, the publish drafts); nothing new is stored. A step whose feature is
 * off, or that does not apply to this run, reads "not applicable", never as a
 * failure. A fact that could not be read reads "unknown", never as a state it
 * might not be in. Pure, so every state of every step is unit-tested.
 */
import { openQuestionCount } from "./analysis-open-questions.js";
import type { AnalysisStatus, RequirementReviewStatus } from "./constants.js";

export const CHANGE_REQUEST_STEPS = [
  { key: "read", label: "Read" },
  { key: "questions", label: "Questions" },
  { key: "requirements", label: "Requirements" },
  { key: "policy", label: "Policy check" },
  { key: "impact", label: "Impact" },
  { key: "portfolio", label: "Portfolio" },
  { key: "review", label: "Review" },
  { key: "handoff", label: "Hand-off" },
] as const;

export type ChangeRequestStepKey = (typeof CHANGE_REQUEST_STEPS)[number]["key"];

export type ChangeRequestStepState =
  "not-started" | "in-progress" | "needs-you" | "done" | "not-applicable" | "unknown";

/** Each state in words: a reader shows this text, never colour alone. */
export const STEP_STATE_LABELS: Record<ChangeRequestStepState, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  "needs-you": "Needs you",
  done: "Done",
  "not-applicable": "Not applicable",
  unknown: "Unknown",
};

/** An agent's result on the run, or `absent` when it has none (yet). */
export type AgentState = "absent" | "running" | "completed" | "failed";

/**
 * A fact read from somewhere else that is not known: still being read
 * (`loading`), or the read failed or was refused (`failed`, e.g. a 403 for a
 * user without the permission). Either way the step reads "unknown".
 */
export type UnknownFact = "loading" | "failed";

/** The run's governing findings, once read. */
export interface PolicyFacts {
  findings: number;
  needsInput: number;
  /** False when the run had no governing documents to check against (#2113). */
  checked: boolean;
}

/** This run's issue drafts, once read. */
export interface DraftFacts {
  total: number;
  published: number;
}

/** This run's portfolio checks, once read, by status. */
export interface PortfolioCheckFacts {
  completed: number;
  /** Pending or running. */
  inFlight: number;
  failed: number;
}

/** A run's portfolio checks tallied by status (an unknown status counts as none). */
export function portfolioCheckTally(
  checks: ReadonlyArray<{ status: string }>,
): PortfolioCheckFacts {
  const tally = { completed: 0, inFlight: 0, failed: 0 };
  for (const c of checks) {
    if (c.status === "completed") tally.completed += 1;
    else if (c.status === "pending" || c.status === "running") tally.inFlight += 1;
    else if (c.status === "failed") tally.failed += 1;
  }
  return tally;
}

/** The facts the steps are derived from. */
export interface ChangeRequestFacts {
  status: AnalysisStatus;
  /** The specialist agents the run was started with (`metadata.agentKeys`). */
  agentKeys: readonly string[];
  documentAgent: AgentState;
  codeAgent: AgentState;
  /** `metadata.enhancement.enableClarification`. */
  clarificationEnabled: boolean;
  /** Open clarifying questions; `null` when extraction failed (none can be counted). */
  openQuestions: number | null;
  requirementCounts: Record<RequirementReviewStatus, number>;
  /** Approval checkpoints still pending; `null` when not loaded. */
  pendingApprovals: number | null;
  /** Governing findings; `"off"` only when the policy check is switched off. */
  policy: PolicyFacts | "off" | UnknownFact;
  /** How many products the portfolio has; `null` when not known. */
  products: number | null;
  /**
   * The portfolio checks started from this run's requirements (a check's
   * `sourceRequirementId` names a requirement, whose `analysisId` is the run),
   * as far as the reader may read them.
   */
  portfolioChecks: PortfolioCheckFacts | UnknownFact;
  /** This run's issue drafts. */
  drafts: DraftFacts | UnknownFact;
}

export interface ChangeRequestStep {
  key: ChangeRequestStepKey;
  label: string;
  state: ChangeRequestStepState;
  /** One line saying why the step is in this state. */
  reason: string;
}

const stopped = (s: AnalysisStatus) => s === "failed" || s === "cancelled";

function total(counts: Record<RequirementReviewStatus, number>): number {
  return counts.draft + counts.approved + counts.rejected + counts.deferred;
}

type Derived = Pick<ChangeRequestStep, "state" | "reason">;

function unknownStep(fact: UnknownFact, what: string): Derived {
  return fact === "loading"
    ? { state: "unknown", reason: `Checking ${what}…` }
    : { state: "unknown", reason: `Couldn't check ${what}.` };
}

function readStep(f: ChangeRequestFacts): Derived {
  if (!f.agentKeys.includes("document"))
    return { state: "not-applicable", reason: "This run did not read documents." };
  if (f.status === "pending") return { state: "not-started", reason: "The run has not started." };
  if (f.documentAgent === "failed")
    return { state: "needs-you", reason: "Reading the documents failed." };
  if (f.documentAgent === "completed") return { state: "done", reason: "The documents were read." };
  if (stopped(f.status)) return { state: "needs-you", reason: `The run ${f.status}.` };
  if (f.status === "running") return { state: "in-progress", reason: "Reading the documents." };
  return { state: "done", reason: "The documents were read." };
}

function questionsStep(f: ChangeRequestFacts): Derived {
  if (!f.clarificationEnabled)
    return { state: "not-applicable", reason: "This run did not ask clarifying questions." };
  if (f.openQuestions === null)
    return { state: "needs-you", reason: "The questions could not be worked out." };
  // #2330 — a run with questions on COMPLETES with its questions open: they are
  // waiting on the analyst whatever the run's status.
  if (f.openQuestions > 0)
    return {
      state: "needs-you",
      reason: `${f.openQuestions} open question${f.openQuestions === 1 ? "" : "s"}.`,
    };
  if (f.status === "pending") return { state: "not-started", reason: "The run has not started." };
  if (f.status === "running") return { state: "in-progress", reason: "Looking for questions." };
  if (stopped(f.status)) return { state: "needs-you", reason: `The run ${f.status}.` };
  return { state: "done", reason: "No open questions." };
}

function requirementsStep(f: ChangeRequestFacts): Derived {
  const n = total(f.requirementCounts);
  if (f.pendingApprovals !== null && f.pendingApprovals > 0)
    return {
      state: "needs-you",
      reason: `${f.pendingApprovals} checkpoint${f.pendingApprovals === 1 ? "" : "s"} pending.`,
    };
  if (n > 0) return { state: "done", reason: `${n} requirement${n === 1 ? "" : "s"}.` };
  if (f.status === "pending") return { state: "not-started", reason: "The run has not started." };
  if (f.status === "running") return { state: "in-progress", reason: "Writing the requirements." };
  if (stopped(f.status)) return { state: "needs-you", reason: `The run ${f.status}.` };
  return { state: "needs-you", reason: "The run produced no requirements." };
}

function policyStep(f: ChangeRequestFacts): Derived {
  const p = f.policy;
  if (p === "off") return { state: "not-applicable", reason: "The policy check is off." };
  if (p === "loading" || p === "failed") return unknownStep(p, "the policy findings");
  if (p.needsInput > 0)
    return {
      state: "needs-you",
      reason: `${p.needsInput} finding${p.needsInput === 1 ? "" : "s"} need your input.`,
    };
  if (p.findings > 0) return { state: "done", reason: "Checked against policy." };
  if (f.status === "pending") return { state: "not-started", reason: "The run has not started." };
  if (f.status === "running") return { state: "in-progress", reason: "Checking against policy." };
  // #2113 — checked with nothing found is a result; not checked means no rules.
  if (p.checked) return { state: "done", reason: "No policy rule applies." };
  return { state: "not-applicable", reason: "No governing documents to check against." };
}

function impactStep(f: ChangeRequestFacts): Derived {
  if (!f.agentKeys.includes("code"))
    return { state: "not-applicable", reason: "This run did not look at code." };
  if (f.status === "pending") return { state: "not-started", reason: "The run has not started." };
  if (f.codeAgent === "failed") return { state: "needs-you", reason: "The code analysis failed." };
  if (f.codeAgent === "completed")
    return { state: "done", reason: "The affected code was mapped." };
  if (stopped(f.status)) return { state: "needs-you", reason: `The run ${f.status}.` };
  if (f.status === "running") return { state: "in-progress", reason: "Looking at the code." };
  return { state: "not-applicable", reason: "No code was analysed." };
}

function portfolioStep(f: ChangeRequestFacts): Derived {
  if (f.products === 0)
    return { state: "not-applicable", reason: "There is no portfolio of products." };
  const c = f.portfolioChecks;
  if (c === "loading" || c === "failed") return unknownStep(c, "the portfolio");
  if (c.completed > 0)
    return {
      state: "done",
      reason: `${c.completed} portfolio check${c.completed === 1 ? "" : "s"} completed.`,
    };
  if (c.inFlight > 0) return { state: "in-progress", reason: "Checking across the portfolio." };
  if (c.failed > 0) return { state: "needs-you", reason: "The portfolio check failed." };
  if (f.requirementCounts.approved === 0)
    return {
      state: "not-started",
      reason: "Approve a requirement to check it across the portfolio.",
    };
  return {
    state: "not-started",
    reason: "Approved requirements can be checked across the portfolio.",
  };
}

function reviewStep(f: ChangeRequestFacts): Derived {
  const n = total(f.requirementCounts);
  if (n === 0) return { state: "not-started", reason: "No requirements to review yet." };
  const drafts = f.requirementCounts.draft;
  if (drafts === 0) return { state: "done", reason: "Every requirement has a decision." };
  if (drafts === n)
    return {
      state: "needs-you",
      reason: `${drafts} requirement${drafts === 1 ? "" : "s"} to review.`,
    };
  return {
    state: "in-progress",
    reason: `${n - drafts} of ${n} reviewed; ${drafts} to go.`,
  };
}

function handoffStep(f: ChangeRequestFacts): Derived {
  const d = f.drafts;
  // Not read (or refused, as for a user without `issue.draft`): the run's issues
  // may well be published, so no state is claimed.
  if (d === "loading" || d === "failed") return unknownStep(d, "the issue drafts");
  if (d.published > 0)
    return {
      state: "done",
      reason: `${d.published} issue${d.published === 1 ? "" : "s"} published.`,
    };
  if (d.total > 0)
    return { state: "in-progress", reason: "Issue drafts are waiting to be published." };
  if (f.requirementCounts.approved === 0)
    return { state: "not-started", reason: "Approve requirements to hand them off." };
  return { state: "not-started", reason: "Approved requirements are ready to hand off." };
}

const DERIVE: Record<ChangeRequestStepKey, (f: ChangeRequestFacts) => Derived> = {
  read: readStep,
  questions: questionsStep,
  requirements: requirementsStep,
  policy: policyStep,
  impact: impactStep,
  portfolio: portfolioStep,
  review: reviewStep,
  handoff: handoffStep,
};

/** The eight steps, in order, each with its state and why. */
export function deriveChangeRequestSteps(facts: ChangeRequestFacts): ChangeRequestStep[] {
  return CHANGE_REQUEST_STEPS.map(({ key, label }) => ({ key, label, ...DERIVE[key](facts) }));
}

/** An agent's state from the run's agent results. */
export function agentState(
  results: ReadonlyArray<{ agentKey: string; status: string }>,
  agentKey: string,
): AgentState {
  const r = results.find((a) => a.agentKey === agentKey);
  if (!r) return "absent";
  if (r.status === "completed") return "completed";
  if (r.status === "failed") return "failed";
  return "running";
}

/** The run's requirements tallied by review status. */
export function requirementTally(
  requirements: ReadonlyArray<{ reviewStatus: RequirementReviewStatus }>,
): Record<RequirementReviewStatus, number> {
  const tally = { draft: 0, approved: 0, rejected: 0, deferred: 0 };
  for (const r of requirements) tally[r.reviewStatus] += 1;
  return tally;
}

/** The run's agents and whether it asked clarifying questions, from its metadata. */
export function runOptionsFromMetadata(metadata: Record<string, unknown> | null | undefined): {
  agentKeys: string[];
  clarificationEnabled: boolean;
  openQuestions: number | null;
} {
  const keys = Array.isArray(metadata?.agentKeys)
    ? (metadata.agentKeys as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
  const enhancement = metadata?.enhancement as { enableClarification?: unknown } | undefined;
  const clarificationEnabled = enhancement?.enableClarification === true;
  return {
    agentKeys: keys,
    clarificationEnabled,
    openQuestions: clarificationEnabled ? (openQuestionCount(metadata) ?? null) : 0,
  };
}
