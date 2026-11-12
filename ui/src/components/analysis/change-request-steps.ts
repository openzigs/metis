/**
 * Issue #2341 (epic #2328) — where a change request stands, as eight steps:
 * Read → Questions → Requirements → Policy check → Impact → Portfolio → Review
 * → Hand-off.
 *
 * Every state is derived from data the product already has (the run, its
 * agents, its requirements, its open questions, its governing findings, the
 * portfolio, the publish drafts); nothing new is stored. A step whose feature is
 * off, or that does not apply to this run, reads "not applicable", never as a
 * failure. Pure, so every state of every step is unit-tested.
 */
import { CHANGE_REQUEST_TITLE_MAX, openQuestionCount } from "@metis/shared";
import type { AnalysisStatus, RequirementReviewStatus } from "@/lib/analysis-api";

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
  "not-started" | "in-progress" | "needs-you" | "done" | "not-applicable";

/** Each state in words: the header shows this text, never colour alone. */
export const STEP_STATE_LABELS: Record<ChangeRequestStepState, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  "needs-you": "Needs you",
  done: "Done",
  "not-applicable": "Not applicable",
};

/** An agent's result on the run, or `absent` when it has none (yet). */
export type AgentState = "absent" | "running" | "completed" | "failed";

/** The facts the steps are derived from; `null` means "not known (yet)". */
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
  /**
   * Governing findings: `null` when the policy check is off (the feature flag)
   * or could not be read; otherwise how many findings and how many need the
   * analyst's input.
   */
  policy: { findings: number; needsInput: number; checked: boolean } | null;
  /** How many products the portfolio has; `null` when not known. */
  products: number | null;
  /** This run's issue drafts: how many, and how many are published; `null` when not known. */
  drafts: { total: number; published: number } | null;
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
      reason: `${f.pendingApprovals} approval${f.pendingApprovals === 1 ? "" : "s"} pending.`,
    };
  if (n > 0) return { state: "done", reason: `${n} requirement${n === 1 ? "" : "s"}.` };
  if (f.status === "pending") return { state: "not-started", reason: "The run has not started." };
  if (f.status === "running") return { state: "in-progress", reason: "Writing the requirements." };
  if (stopped(f.status)) return { state: "needs-you", reason: `The run ${f.status}.` };
  return { state: "needs-you", reason: "The run produced no requirements." };
}

function policyStep(f: ChangeRequestFacts): Derived {
  if (f.policy === null) return { state: "not-applicable", reason: "The policy check is off." };
  if (f.policy.needsInput > 0)
    return {
      state: "needs-you",
      reason: `${f.policy.needsInput} finding${f.policy.needsInput === 1 ? "" : "s"} need your input.`,
    };
  if (f.policy.findings > 0) return { state: "done", reason: "Checked against policy." };
  if (f.status === "pending") return { state: "not-started", reason: "The run has not started." };
  if (f.status === "running") return { state: "in-progress", reason: "Checking against policy." };
  // #2113 — checked with nothing found is a result; not checked means no rules.
  if (f.policy.checked) return { state: "done", reason: "No policy rule applies." };
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
  if (f.requirementCounts.approved === 0)
    return {
      state: "not-started",
      reason: "Approve a requirement to check it across the portfolio.",
    };
  // No record of a portfolio check per run exists to say it is done.
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
  if (f.drafts && f.drafts.published > 0)
    return {
      state: "done",
      reason: `${f.drafts.published} issue${f.drafts.published === 1 ? "" : "s"} published.`,
    };
  if (f.drafts && f.drafts.total > 0)
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

/** Where each step's existing screen is. */
export function stepHref(key: ChangeRequestStepKey, projectId: string, analysisId: string): string {
  const p = encodeURIComponent(projectId);
  const run = (tab: string) =>
    `/projects/${p}/analysis?${new URLSearchParams({ analysisId, tab }).toString()}`;
  switch (key) {
    case "read":
      return run("agents");
    case "questions":
      return run("questions");
    case "requirements":
      return run("requirements");
    case "policy":
      return run("findings");
    case "impact":
      return `/projects/${p}/impact`;
    case "portfolio":
      return "/portfolio";
    case "review":
      return `/projects/${p}/requirements`;
    case "handoff":
      return `/projects/${p}/publish?${new URLSearchParams({ analysisId }).toString()}`;
  }
}

/**
 * #2341 — the title the form proposes: the first chosen document's name (its
 * source title, else the filename), with how many more were chosen. Empty when
 * none is chosen: the server then names it after the first imported item.
 */
export function proposedChangeRequestTitle(
  selected: readonly string[],
  docs: ReadonlyArray<{ id: string; filename: string; title?: string | null }>,
): string {
  const first = docs.find((d) => d.id === selected[0]);
  if (!first) return "";
  // One line, within the limit the server checks (a filename is not).
  const name = (first.title?.trim() || first.filename).replace(/\s+/g, " ").trim();
  const more = selected.length - 1;
  const suffix = more > 0 ? ` and ${more} more` : "";
  return `${name.slice(0, CHANGE_REQUEST_TITLE_MAX - suffix.length)}${suffix}`;
}
