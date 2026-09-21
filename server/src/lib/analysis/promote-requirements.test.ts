/**
 * Issue #1104 finding B — clearing the approval gate must actually release the
 * withheld requirements.
 *
 * Before this, `runSynthesisAndPersist` returned early on a blocked gate and
 * NOTHING ever re-ran promotion: approving every request left the analysis
 * showing "No requirements yet" forever, even though the synthesis output was
 * sitting in the AgentResult row. These tests drive the retry path directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ANALYSIS_ID = "an_1104";
const PROJECT_ID = "pr_1104";

const SYNTHESIS_OUTPUT = {
  summary: "Two requirements were synthesized.",
  requirements: [
    {
      type: "feature",
      title: "Idempotent order placement",
      body: "Placing the same order twice must not double-charge.",
      priority: "high",
      labels: [],
      acceptanceCriteria: [],
      evidenceFindingIndexes: [],
    },
    {
      type: "feature",
      title: "Inventory decrement",
      body: "Inventory must decrement atomically.",
      priority: "medium",
      labels: [],
      acceptanceCriteria: [],
      evidenceFindingIndexes: [],
    },
  ],
};

const gate = { allowed: true, pendingCount: 0, rejectedCount: 0 };
const db = {
  analysis: { projectId: PROJECT_ID } as { projectId: string } | null,
  synthesisOutput: JSON.stringify(SYNTHESIS_OUTPUT) as string | null,
  requirementCount: 0,
};

vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: { findFirst: vi.fn(async () => db.analysis) },
    agentResult: {
      findFirst: vi.fn(async () => (db.synthesisOutput ? { output: db.synthesisOutput } : null)),
    },
    requirement: { count: vi.fn(async () => db.requirementCount) },
  },
}));

const persistRequirements = vi.fn(async () => ["rq_1", "rq_2"]);
const persistAnalysisEnhancement = vi.fn(async () => undefined);
/** Persisted findings the promotion re-derives coverage + verdicts from. */
const findings: Array<Record<string, unknown>> = [];
vi.mock("./analysis-service.js", () => ({
  persistRequirements: (...a: unknown[]) => persistRequirements(...(a as [])),
  persistAnalysisEnhancement: (...a: unknown[]) => persistAnalysisEnhancement(...(a as [])),
  readFlattenedFindings: vi.fn(async () => findings),
}));

/**
 * Issue #1116 — promotion is the moment the withheld rows first exist, so it is
 * the moment the clarification answers submitted against the closed gate can be
 * written into them.
 */
const applyClarificationsToRequirements = vi.fn(async () => null);
vi.mock("./clarification-enrichment.js", () => ({
  applyClarificationsToRequirements: (...a: unknown[]) =>
    applyClarificationsToRequirements(...(a as [])),
}));

const seedRequirementCodeLinksFromFindings = vi.fn(async () => undefined);
vi.mock("../traceability/seed-code-links-from-findings.js", () => ({
  seedRequirementCodeLinksFromFindings: (...a: unknown[]) =>
    seedRequirementCodeLinksFromFindings(...(a as [])),
}));

vi.mock("./approval-checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./approval-checkpoint.js")>();
  return { ...actual, canCreateTickets: vi.fn(async () => ({ ...gate })) };
});

const { promoteApprovedRequirements } = await import("./promote-requirements.js");

beforeEach(() => {
  vi.clearAllMocks();
  gate.allowed = true;
  gate.pendingCount = 0;
  gate.rejectedCount = 0;
  db.analysis = { projectId: PROJECT_ID };
  db.synthesisOutput = JSON.stringify(SYNTHESIS_OUTPUT);
  db.requirementCount = 0;
  findings.length = 0;
});

describe("#1104 B — promoting the requirements the approval gate withheld", () => {
  it("persists the withheld requirements once every approval is resolved", async () => {
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome).toEqual({ status: "promoted", requirementCount: 2 });
    expect(persistRequirements).toHaveBeenCalledTimes(1);
    const input = persistRequirements.mock.calls[0]?.[0] as {
      analysisId: string;
      projectId: string;
      synthesis: { requirements: unknown[] };
    };
    expect(input.analysisId).toBe(ANALYSIS_ID);
    expect(input.projectId).toBe(PROJECT_ID);
    expect(input.synthesis.requirements).toHaveLength(2);
  });

  it("#1116 — writes the clarification answers into the rows it just created", async () => {
    await promoteApprovedRequirements(ANALYSIS_ID);

    expect(applyClarificationsToRequirements).toHaveBeenCalledWith(ANALYSIS_ID);
    // Order matters: enriching before the rows exist would be a silent no-op.
    expect(persistRequirements.mock.invocationCallOrder[0]).toBeLessThan(
      applyClarificationsToRequirements.mock.invocationCallOrder[0],
    );
  });

  it("#1116 — does not enrich anything while the gate is still closed", async () => {
    gate.allowed = false;
    gate.pendingCount = 1;

    await promoteApprovedRequirements(ANALYSIS_ID);

    expect(applyClarificationsToRequirements).not.toHaveBeenCalled();
  });

  it("clears the durable blocked marker so the UI stops warning", async () => {
    await promoteApprovedRequirements(ANALYSIS_ID);

    expect(persistAnalysisEnhancement).toHaveBeenCalledWith(ANALYSIS_ID, {
      promotionBlocked: { blocked: false, pendingCount: 0, rejectedCount: 0 },
      promotionStatus: "allowed",
    });
  });

  it("stays blocked — and persists nothing — while approvals are outstanding", async () => {
    gate.allowed = false;
    gate.pendingCount = 3;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome.status).toBe("blocked");
    expect(outcome).toMatchObject({ pendingCount: 3, awaitingRequirementCount: 2 });
    expect(persistRequirements).not.toHaveBeenCalled();
  });

  it("is idempotent — never re-persists an already-promoted analysis", async () => {
    db.requirementCount = 2;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome).toEqual({ status: "already-promoted", requirementCount: 2 });
    expect(persistRequirements).not.toHaveBeenCalled();
  });

  it("reports unavailable (never throws) when there is no synthesis output to promote", async () => {
    db.synthesisOutput = null;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome.status).toBe("unavailable");
    expect(persistRequirements).not.toHaveBeenCalled();
  });

  it("reports unavailable when the persisted synthesis output is unparseable", async () => {
    db.synthesisOutput = "{not json";

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome.status).toBe("unavailable");
  });

  it("re-derives coverage + verdicts from the persisted findings", async () => {
    // A code finding grounding the FIRST requirement (index 0) — the same
    // deterministic inputs the orchestrator's happy path computes.
    findings.push({
      findingId: "f_1",
      agentKey: "code",
      citations: [{ type: "code", filePath: "server/src/orders.ts", startLine: 1, endLine: 2 }],
      verdict: "gap-confirmed",
    });
    const grounded = { ...SYNTHESIS_OUTPUT.requirements[0], evidenceFindingIndexes: [0] };
    db.synthesisOutput = JSON.stringify({
      ...SYNTHESIS_OUTPUT,
      requirements: [grounded, SYNTHESIS_OUTPUT.requirements[1]],
    });

    await promoteApprovedRequirements(ANALYSIS_ID);

    const input = persistRequirements.mock.calls[0]?.[0] as {
      findingIdsByIndex: string[];
      coverages: unknown[];
      verdicts: unknown[];
    };
    expect(input.findingIdsByIndex).toEqual(["f_1"]);
    expect(input.coverages).toHaveLength(2);
    expect(input.verdicts).toHaveLength(2);
  });

  it("still promotes when the best-effort code-link seeding fails", async () => {
    seedRequirementCodeLinksFromFindings.mockRejectedValueOnce(new Error("graph offline"));

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome).toEqual({ status: "promoted", requirementCount: 2 });
    expect(persistAnalysisEnhancement).toHaveBeenCalled();
  });

  it("reports unavailable when the analysis does not exist", async () => {
    db.analysis = null;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome.status).toBe("unavailable");
  });
});
