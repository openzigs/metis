/**
 * Issue #2341 — the change request's eight steps: every state of every step,
 * derived from data the product already has.
 */
import { describe, expect, it } from "vitest";
import {
  CHANGE_REQUEST_STEPS,
  STEP_STATE_LABELS,
  agentState,
  deriveChangeRequestSteps,
  proposedChangeRequestTitle,
  runOptionsFromMetadata,
  stepHref,
  type ChangeRequestFacts,
  type ChangeRequestStepKey,
  type ChangeRequestStepState,
} from "@/components/analysis/change-request-steps";

const NONE = { draft: 0, approved: 0, rejected: 0, deferred: 0 };

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
    policy: null,
    products: null,
    drafts: null,
    ...over,
  };
}

function stateOf(key: ChangeRequestStepKey, over: Partial<ChangeRequestFacts>) {
  const step = deriveChangeRequestSteps(facts(over)).find((s) => s.key === key)!;
  return step.state;
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
      "approvals pending",
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
    ["policy check off", { policy: null }, "not-applicable"],
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
  ],
  portfolio: [
    ["no products", { products: 0 }, "not-applicable"],
    ["nothing approved", { products: 3 }, "not-started"],
    ["approved, unknown products", { requirementCounts: { ...NONE, approved: 1 } }, "not-started"],
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
        expect(stateOf(key, over)).toBe(expected);
      });
    });
  }

  it("covers every state across the steps, each with a reason in words", () => {
    const seen = new Set<ChangeRequestStepState>();
    for (const [key, cases] of Object.entries(CASES) as Array<[ChangeRequestStepKey, Case[]]>) {
      for (const [, over] of cases) {
        const step = deriveChangeRequestSteps(facts(over)).find((s) => s.key === key)!;
        seen.add(step.state);
        expect(step.reason.length).toBeGreaterThan(0);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(STEP_STATE_LABELS).sort());
  });

  it("counts in the reasons", () => {
    const steps = deriveChangeRequestSteps(
      facts({
        openQuestions: 1,
        pendingApprovals: 1,
        policy: { findings: 2, needsInput: 2, checked: true },
        requirementCounts: { ...NONE, draft: 2, approved: 1 },
        drafts: { total: 2, published: 2 },
      }),
    );
    const reason = (k: ChangeRequestStepKey) => steps.find((s) => s.key === k)!.reason;
    expect(reason("questions")).toBe("1 open question.");
    expect(reason("requirements")).toBe("1 approval pending.");
    expect(reason("policy")).toBe("2 findings need your input.");
    expect(reason("review")).toBe("1 of 3 reviewed; 2 to go.");
    expect(reason("handoff")).toBe("2 issues published.");
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

  it("links each step to its existing screen", () => {
    const href = (k: ChangeRequestStepKey) => stepHref(k, "p 1", "an-1");
    expect(href("read")).toBe("/projects/p%201/analysis?analysisId=an-1&tab=agents");
    expect(href("questions")).toBe("/projects/p%201/analysis?analysisId=an-1&tab=questions");
    expect(href("requirements")).toBe("/projects/p%201/analysis?analysisId=an-1&tab=requirements");
    expect(href("policy")).toBe("/projects/p%201/analysis?analysisId=an-1&tab=findings");
    expect(href("impact")).toBe("/projects/p%201/impact");
    expect(href("portfolio")).toBe("/portfolio");
    expect(href("review")).toBe("/projects/p%201/requirements");
    expect(href("handoff")).toBe("/projects/p%201/publish?analysisId=an-1");
  });
});

describe("#2341 — proposedChangeRequestTitle", () => {
  const docs = [
    { id: "d1", filename: "brief.docx", title: null },
    { id: "d2", filename: "page-9.html", title: " Refund  policy " },
  ];
  it("is the first chosen document's name, with how many more", () => {
    expect(proposedChangeRequestTitle(["d2"], docs)).toBe("Refund policy");
    expect(proposedChangeRequestTitle(["d1", "d2"], docs)).toBe("brief.docx and 1 more");
  });
  it("is empty when no document is chosen or known", () => {
    expect(proposedChangeRequestTitle([], docs)).toBe("");
    expect(proposedChangeRequestTitle(["gone"], docs)).toBe("");
  });
  it("stays within the title limit", () => {
    const long = [{ id: "d", filename: "x".repeat(300), title: null }];
    expect(proposedChangeRequestTitle(["d", "e"], long).length).toBe(200);
    expect(proposedChangeRequestTitle(["d", "e"], long).endsWith(" and 1 more")).toBe(true);
  });
});
