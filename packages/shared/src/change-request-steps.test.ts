/**
 * Issue #2341 — the change request's eight steps: every state of every step,
 * derived from data the product already has. Shared, so the UI header and the
 * server (#2343, #2348) read one set of rules.
 */
import { describe, expect, it } from "vitest";
import {
  CHANGE_REQUEST_STEPS,
  NO_CODE_IMPACT_REASON,
  STEP_STATE_LABELS,
  agentState,
  deriveChangeRequestSteps,
  latestResult,
  portfolioCheckTally,
  requirementTally,
  runOptionsFromMetadata,
  type ChangeRequestFacts,
  type ChangeRequestStepKey,
  type ChangeRequestStepState,
} from "./change-request-steps.js";
import * as barrel from "./index.js";

const NONE = { draft: 0, approved: 0, rejected: 0, deferred: 0 };
const NO_CHECKS = { completed: 0, inFlight: 0, failed: 0 };

/** A completed run that used every agent and asked questions, with nothing else known. */
function facts(over: Partial<ChangeRequestFacts> = {}): ChangeRequestFacts {
  return {
    status: "completed",
    agentKeys: ["document", "code", "database", "web"],
    documentAgent: "completed",
    codeAgent: "completed",
    clarificationEnabled: true,
    openQuestions: 0,
    requirementCounts: { ...NONE },
    pendingApprovals: 0,
    policy: "off",
    products: null,
    portfolioChecks: { ...NO_CHECKS },
    drafts: { total: 0, published: 0 },
    ...over,
  };
}

function stepOf(key: ChangeRequestStepKey, over: Partial<ChangeRequestFacts>) {
  return deriveChangeRequestSteps(facts(over)).find((s) => s.key === key)!;
}

type Case = [string, Partial<ChangeRequestFacts>, ChangeRequestStepState];

const CASES: Record<ChangeRequestStepKey, Case[]> = {
  read: [
    ["no document agent", { agentKeys: ["code"] }, "not-applicable"],
    ["run pending", { status: "pending", documentAgent: "absent" }, "not-started"],
    ["reading failed", { documentAgent: "failed" }, "needs-you"],
    ["read", { documentAgent: "completed", status: "running" }, "done"],
    ["run failed before reading", { status: "failed", documentAgent: "absent" }, "needs-you"],
    ["reading", { status: "running", documentAgent: "running" }, "in-progress"],
    ["completed with no agent row", { documentAgent: "absent" }, "done"],
  ],
  questions: [
    ["clarification off", { clarificationEnabled: false }, "not-applicable"],
    ["extraction failed", { openQuestions: null }, "needs-you"],
    ["open questions on a COMPLETED run (#2330)", { openQuestions: 12 }, "needs-you"],
    ["run pending", { status: "pending" }, "not-started"],
    ["run going", { status: "running" }, "in-progress"],
    ["run cancelled", { status: "cancelled" }, "needs-you"],
    ["no open questions", {}, "done"],
  ],
  requirements: [
    [
      "checkpoints pending",
      { pendingApprovals: 2, requirementCounts: { ...NONE, draft: 3 } },
      "needs-you",
    ],
    ["requirements written", { requirementCounts: { ...NONE, draft: 3 } }, "done"],
    ["run pending", { status: "pending" }, "not-started"],
    ["run going", { status: "running" }, "in-progress"],
    ["run failed", { status: "failed" }, "needs-you"],
    ["completed with none", {}, "needs-you"],
  ],
  policy: [
    ["policy check off", { policy: "off" }, "not-applicable"],
    ["findings still loading", { policy: "loading" }, "unknown"],
    ["findings read failed", { policy: "failed" }, "unknown"],
    ["findings need input", { policy: { findings: 3, needsInput: 1, checked: true } }, "needs-you"],
    ["findings settled", { policy: { findings: 3, needsInput: 0, checked: true } }, "done"],
    [
      "run pending",
      { status: "pending", policy: { findings: 0, needsInput: 0, checked: false } },
      "not-started",
    ],
    [
      "run going",
      { status: "running", policy: { findings: 0, needsInput: 0, checked: false } },
      "in-progress",
    ],
    ["checked, nothing applies", { policy: { findings: 0, needsInput: 0, checked: true } }, "done"],
    [
      "no governing documents",
      { policy: { findings: 0, needsInput: 0, checked: false } },
      "not-applicable",
    ],
  ],
  impact: [
    ["no code agent", { agentKeys: ["document"] }, "not-applicable"],
    ["run pending", { status: "pending", codeAgent: "absent" }, "not-started"],
    ["code analysis failed", { codeAgent: "failed" }, "needs-you"],
    ["code mapped", { codeAgent: "completed" }, "done"],
    ["run cancelled first", { status: "cancelled", codeAgent: "absent" }, "needs-you"],
    ["looking at code", { status: "running", codeAgent: "running" }, "in-progress"],
    ["completed with no code row", { codeAgent: "absent" }, "not-applicable"],
    // #2454 — a Documents-only project had no code to map, whatever the code agent
    // did; an impact analysis over other projects is still on offer (Options).
    ["no code connected", { codeAgent: "completed", codeConnected: false }, "not-started"],
    [
      "no code connected, none started",
      { latestImpact: null, codeConnected: false },
      "not-started",
    ],
    [
      "no code connected, the run still looking",
      { status: "running", codeAgent: "running", codeConnected: false },
      "not-started",
    ],
    [
      "no code connected, an impact analysis ran over other projects",
      { codeConnected: false, latestImpact: { id: "ia-9", status: "completed" } },
      "done",
    ],
    // #2345 — the newest impact analysis started from the change request decides.
    ["latest impact completed", { latestImpact: { id: "ia-1", status: "completed" } }, "done"],
    [
      "latest impact running, code agent failed",
      { codeAgent: "failed", latestImpact: { id: "ia-2", status: "running" } },
      "in-progress",
    ],
    ["latest impact pending", { latestImpact: { id: "ia-2", status: "pending" } }, "in-progress"],
    ["latest impact failed", { latestImpact: { id: "ia-3", status: "failed" } }, "needs-you"],
    ["latest impact of an unknown status", { latestImpact: { id: "x", status: "?" } }, "unknown"],
    ["impact analyses loading", { latestImpact: "loading" }, "unknown"],
    ["impact analyses refused", { latestImpact: "failed" }, "unknown"],
    ["none started, no code agent", { agentKeys: ["document"], latestImpact: null }, "not-started"],
    ["none started, code mapped", { codeAgent: "completed", latestImpact: null }, "done"],
  ],
  portfolio: [
    ["no products", { products: 0 }, "not-applicable"],
    ["nothing approved", { products: 3 }, "not-started"],
    ["approved, unknown products", { requirementCounts: { ...NONE, approved: 1 } }, "not-started"],
    [
      "a check of this run's requirement completed",
      { products: 3, portfolioChecks: { ...NO_CHECKS, completed: 1, failed: 1 } },
      "done",
    ],
    [
      "a check of this run's requirement running",
      { products: 3, portfolioChecks: { ...NO_CHECKS, inFlight: 1, failed: 1 } },
      "in-progress",
    ],
    [
      "the only check failed",
      { products: 3, portfolioChecks: { ...NO_CHECKS, failed: 1 } },
      "needs-you",
    ],
    ["checks still loading", { products: 3, portfolioChecks: "loading" }, "unknown"],
    ["checks read failed", { products: 3, portfolioChecks: "failed" }, "unknown"],
    [
      "no products, whatever the checks say",
      { products: 0, portfolioChecks: { ...NO_CHECKS, completed: 1 } },
      "not-applicable",
    ],
    // #2345 — the newest check decides, even when an older one completed.
    [
      "latest check running, an older one completed",
      {
        products: 3,
        portfolioChecks: {
          ...NO_CHECKS,
          completed: 1,
          inFlight: 1,
          latest: { id: "b", status: "running" },
        },
      },
      "in-progress",
    ],
    [
      "latest check failed, an older one completed",
      {
        products: 3,
        portfolioChecks: {
          ...NO_CHECKS,
          completed: 1,
          failed: 1,
          latest: { id: "b", status: "failed" },
        },
      },
      "needs-you",
    ],
    [
      "latest check completed before approval",
      {
        products: 3,
        portfolioChecks: {
          ...NO_CHECKS,
          completed: 1,
          latest: { id: "a", status: "completed", preApproval: true },
        },
      },
      "done",
    ],
  ],
  review: [
    ["no requirements", {}, "not-started"],
    ["all decided", { requirementCounts: { ...NONE, approved: 2, rejected: 1 } }, "done"],
    ["none decided", { requirementCounts: { ...NONE, draft: 2 } }, "needs-you"],
    ["some decided", { requirementCounts: { ...NONE, draft: 1, approved: 1 } }, "in-progress"],
  ],
  handoff: [
    ["published", { drafts: { total: 3, published: 1 } }, "done"],
    ["drafted", { drafts: { total: 3, published: 0 } }, "in-progress"],
    ["nothing approved", { drafts: { total: 0, published: 0 } }, "not-started"],
    ["approved, not drafted", { requirementCounts: { ...NONE, approved: 2 } }, "not-started"],
    ["drafts still loading", { drafts: "loading" }, "unknown"],
    [
      "drafts refused (403, no issue.draft) on a run with approvals",
      { drafts: "failed", requirementCounts: { ...NONE, approved: 2 } },
      "unknown",
    ],
    ["drafts refused with nothing approved", { drafts: "failed" }, "unknown"],
  ],
};

describe("#2341 — deriveChangeRequestSteps", () => {
  it("has the eight steps in order", () => {
    expect(deriveChangeRequestSteps(facts()).map((s) => s.label)).toEqual([
      "Read",
      "Questions",
      "Requirements",
      "Policy check",
      "Impact",
      "Portfolio",
      "Review",
      "Hand-off",
    ]);
    expect(CHANGE_REQUEST_STEPS).toHaveLength(8);
  });

  for (const [key, cases] of Object.entries(CASES) as Array<[ChangeRequestStepKey, Case[]]>) {
    describe(key, () => {
      it.each(cases)("%s", (_name, over, expected) => {
        expect(stepOf(key, over).state).toBe(expected);
      });
    });
  }

  it("covers every state across the steps, each with a reason in words", () => {
    const seen = new Set<ChangeRequestStepState>();
    for (const [key, cases] of Object.entries(CASES) as Array<[ChangeRequestStepKey, Case[]]>) {
      for (const [, over] of cases) {
        const step = stepOf(key, over);
        seen.add(step.state);
        expect(step.reason.length).toBeGreaterThan(0);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(STEP_STATE_LABELS).sort());
  });

  it("says a failed read could not be checked, and never that the feature is off", () => {
    expect(stepOf("policy", { policy: "failed" }).reason).toBe(
      "Couldn't check the policy findings.",
    );
    expect(stepOf("policy", { policy: "loading" }).reason).toBe("Checking the policy findings…");
    expect(stepOf("policy", { policy: "off" }).reason).toBe("The policy check is off.");
    expect(stepOf("handoff", { drafts: "failed" }).reason).toBe("Couldn't check the issue drafts.");
    expect(STEP_STATE_LABELS.unknown).toBe("Unknown");
  });

  it("counts in the reasons", () => {
    const steps = deriveChangeRequestSteps(
      facts({
        openQuestions: 1,
        pendingApprovals: 1,
        policy: { findings: 2, needsInput: 2, checked: true },
        requirementCounts: { ...NONE, draft: 2, approved: 1 },
        drafts: { total: 2, published: 2 },
        products: 4,
        portfolioChecks: { ...NO_CHECKS, completed: 2 },
      }),
    );
    const reason = (k: ChangeRequestStepKey) => steps.find((s) => s.key === k)!.reason;
    expect(reason("questions")).toBe("1 open question.");
    expect(reason("requirements")).toBe("1 checkpoint pending.");
    expect(reason("policy")).toBe("2 findings need your input.");
    expect(reason("review")).toBe("1 of 3 reviewed; 2 to go.");
    expect(reason("handoff")).toBe("2 issues published.");
    expect(reason("portfolio")).toBe("2 portfolio checks completed.");
  });

  it("tallies a run's portfolio checks by status", () => {
    expect(
      portfolioCheckTally([
        { status: "completed" },
        { status: "completed" },
        { status: "pending" },
        { status: "running" },
        { status: "failed" },
        { status: "something-new" },
      ]),
    ).toEqual({ completed: 2, inFlight: 2, failed: 1 });
    expect(portfolioCheckTally([])).toEqual(NO_CHECKS);
    // #2345 — the first check (newest first) is the latest, with its pre-approval label.
    expect(
      portfolioCheckTally([
        { id: "new", status: "running", preApproval: true },
        { id: "old", status: "completed", preApproval: false },
      ]).latest,
    ).toEqual({ id: "new", status: "running", preApproval: true });
    expect(
      portfolioCheckTally([{ id: "new", status: "completed", preApproval: false }]).latest,
    ).toEqual({ id: "new", status: "completed" });
    expect(stepOf("portfolio", { products: 2, portfolioChecks: "failed" }).reason).toBe(
      "Couldn't check the portfolio.",
    );
  });

  it("#2345 — says in words which result the Impact and Portfolio steps read", () => {
    expect(stepOf("impact", { latestImpact: { id: "ia", status: "completed" } }).reason).toBe(
      "The latest impact analysis is complete.",
    );
    expect(stepOf("impact", { latestImpact: { id: "ia", status: "failed" } }).reason).toBe(
      "The latest impact analysis failed.",
    );
    expect(stepOf("impact", { latestImpact: "failed" }).reason).toBe(
      "Couldn't check the impact analyses.",
    );
    expect(stepOf("impact", { agentKeys: ["document"], latestImpact: null }).reason).toBe(
      "Run an impact analysis from this change request.",
    );
    // #2454 — not "The affected code was mapped." on a project with no code.
    expect(stepOf("impact", { codeAgent: "completed", codeConnected: false }).reason).toBe(
      NO_CODE_IMPACT_REASON,
    );
    expect(NO_CODE_IMPACT_REASON).toBe(
      "This project has no code connected. Run an impact analysis over projects with code from Options.",
    );
    const preApproval = {
      products: 3,
      portfolioChecks: {
        ...NO_CHECKS,
        completed: 1,
        latest: { id: "a", status: "completed", preApproval: true },
      },
    };
    expect(stepOf("portfolio", preApproval).reason).toBe(
      "The latest portfolio check is complete (run on unapproved requirements).",
    );
    // Before approval the step offers the check rather than asking for approval first.
    expect(stepOf("portfolio", { products: 3 }).reason).toBe(
      "Run a portfolio check; before approval it is labelled as on unapproved requirements.",
    );
    expect(latestResult([])).toBeNull();
    expect(
      latestResult([
        { id: "b", status: "running" },
        { id: "a", status: "completed" },
      ]),
    ).toEqual({ id: "b", status: "running" });
  });

  it("is exported from the package barrel, for the server and the UI alike", () => {
    expect(barrel.deriveChangeRequestSteps).toBe(deriveChangeRequestSteps);
    expect(barrel.STEP_STATE_LABELS).toBe(STEP_STATE_LABELS);
  });
});

describe("#2341 — the facts", () => {
  it("agentState reads the run's agent results", () => {
    const results = [
      { agentKey: "document", status: "completed" },
      { agentKey: "code", status: "failed" },
      { agentKey: "web", status: "running" },
    ];
    expect(agentState(results, "document")).toBe("completed");
    expect(agentState(results, "code")).toBe("failed");
    expect(agentState(results, "web")).toBe("running");
    expect(agentState(results, "database")).toBe("absent");
  });

  it("requirementTally counts the requirements by review status", () => {
    expect(
      requirementTally([
        { reviewStatus: "draft" },
        { reviewStatus: "approved" },
        { reviewStatus: "approved" },
        { reviewStatus: "deferred" },
      ]),
    ).toEqual({ draft: 1, approved: 2, rejected: 0, deferred: 1 });
  });

  it("runOptionsFromMetadata reads the agents and the open questions", () => {
    expect(
      runOptionsFromMetadata({
        agentKeys: ["document", 3],
        enhancement: { enableClarification: true },
        structuredRequirements: { totalAmbiguities: 4 },
      }),
    ).toEqual({ agentKeys: ["document"], clarificationEnabled: true, openQuestions: 4 });
    expect(
      runOptionsFromMetadata({
        enhancement: { enableClarification: true },
        structuredExtractionFailure: { reason: "x" },
      }).openQuestions,
    ).toBeNull();
    expect(runOptionsFromMetadata(null)).toEqual({
      agentKeys: [],
      clarificationEnabled: false,
      openQuestions: 0,
    });
  });
});
