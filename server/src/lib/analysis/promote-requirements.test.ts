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
  /** #730 — the reviewed structured list and its per-requirement approvals. */
  structured: null as { requirements: Array<Record<string, unknown>> } | null,
  approvals: [] as Array<{ itemId: string; status: string }>,
};

vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: { findFirst: vi.fn(async () => db.analysis) },
    agentResult: {
      findFirst: vi.fn(async () => (db.synthesisOutput ? { output: db.synthesisOutput } : null)),
    },
    requirement: { count: vi.fn(async () => db.requirementCount) },
    approvalRequest: {
      findMany: vi.fn(async ({ where }: { where: { type?: string } }) =>
        db.approvals.filter(() => where.type === "requirement"),
      ),
    },
  },
}));

const persistRequirements = vi.fn(async (..._args: unknown[]) => ["rq_1", "rq_2"]);
const persistAnalysisEnhancement = vi.fn(async () => undefined);
/** Persisted findings the promotion re-derives coverage + verdicts from. */
const findings: Array<Record<string, unknown>> = [];
vi.mock("./analysis-service.js", () => ({
  persistRequirements: (...a: unknown[]) => persistRequirements(...a),
  persistAnalysisEnhancement: (...a: unknown[]) => persistAnalysisEnhancement(...(a as [])),
  readFlattenedFindings: vi.fn(async () => findings),
  getStructuredRequirements: vi.fn(async () => db.structured),
}));

/**
 * Issue #1116 — promotion is the moment the withheld rows first exist, so it is
 * the moment the clarification answers submitted against the closed gate can be
 * written into them.
 */
const applyClarificationsToRequirements = vi.fn(async () => null);
vi.mock("./clarification-enrichment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clarification-enrichment.js")>()),
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
  db.structured = null;
  db.approvals = [];
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

describe("#730 — promote the requirements the user approved, not a different set", () => {
  const structuredReq = (id: string, title: string, description: string) => ({
    id,
    title,
    description,
    type: "functional",
    stakeholders: [],
    priority: "must-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  });

  beforeEach(() => {
    // The degraded-synthesis shape from the walkthrough: finding-titled
    // fallback rows, one of them an open question, none with criteria.
    db.synthesisOutput = JSON.stringify({
      summary: "Auto-synthesized 3 requirement(s) from 3 finding(s).",
      requirements: [
        {
          type: "feature",
          title: "Could not verify: PORT overrides LISTEN_ADDR",
          body: "(config) PORT may override LISTEN_ADDR.",
          priority: "medium",
          labels: [],
          acceptanceCriteria: [],
          evidenceFindingIndexes: [0],
        },
        {
          type: "bug",
          title: "Duplicate feed subscriptions are rejected by a unique index",
          body: "(database) unique (user_id, feed_url) prevents duplicate feed url subscription.",
          priority: "high",
          labels: ["database"],
          acceptanceCriteria: ["Subscribing to the same feed URL twice returns a conflict"],
          evidenceFindingIndexes: [1],
        },
        {
          type: "feature",
          title: "Observability is metrics plus a health endpoint",
          body: "(code) metrics and /healthcheck.",
          priority: "low",
          labels: [],
          acceptanceCriteria: [],
          evidenceFindingIndexes: [2],
        },
      ],
    });
    db.structured = {
      requirements: [
        structuredReq(
          "REQ-1",
          "Duplicate Feed URL Subscription Prevention",
          "A user cannot subscribe to the same feed URL twice.",
        ),
        structuredReq(
          "REQ-2",
          "Duplicate Category Title Prevention",
          "Category titles are unique per user.",
        ),
        structuredReq("REQ-3", "OAuth2 User Creation Disabled by Default", "Off unless enabled."),
      ],
    };
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "approved" },
      { itemId: "REQ-3", status: "approved" },
    ];
  });

  function persistedRequirements() {
    const input = persistRequirements.mock.calls[0]?.[0] as {
      synthesis: {
        requirements: Array<{
          title: string;
          body: string;
          type: string;
          priority: string;
          acceptanceCriteria: string[];
          evidenceFindingIndexes: number[];
        }>;
      };
    };
    return input.synthesis.requirements;
  }

  it("persists exactly the approved structured requirements, with the reviewed titles and descriptions", async () => {
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome).toEqual({ status: "promoted", requirementCount: 2 });
    const reqs = persistedRequirements();
    expect(reqs.map((r) => r.title)).toEqual([
      "Duplicate Feed URL Subscription Prevention",
      "Duplicate Category Title Prevention",
      "OAuth2 User Creation Disabled by Default",
    ]);
    expect(reqs[0]?.body).toBe("A user cannot subscribe to the same feed URL twice.");
    expect(reqs.some((r) => r.title.startsWith("Could not verify"))).toBe(false);
  });

  it("carries a matching synthesized requirement's criteria and evidence onto the approved one", async () => {
    await promoteApprovedRequirements(ANALYSIS_ID);

    const [feed, category, oauth] = persistedRequirements();
    expect(feed).toMatchObject({
      type: "bug",
      priority: "high",
      acceptanceCriteria: ["Subscribing to the same feed URL twice returns a conflict"],
      evidenceFindingIndexes: [1],
    });
    // No synthesized counterpart: an honest empty set, never another row's evidence.
    expect(category).toMatchObject({ acceptanceCriteria: [], evidenceFindingIndexes: [] });
    expect(oauth).toMatchObject({ acceptanceCriteria: [], evidenceFindingIndexes: [] });
  });

  it("leaves out a requirement the reviewer did not approve", async () => {
    db.approvals[1] = { itemId: "REQ-2", status: "rejected" };

    await promoteApprovedRequirements(ANALYSIS_ID);

    expect(persistedRequirements().map((r) => r.title)).toEqual([
      "Duplicate Feed URL Subscription Prevention",
      "OAuth2 User Creation Disabled by Default",
    ]);
  });

  it("counts the reviewed list, not the synthesis set, while the gate is closed", async () => {
    gate.allowed = false;
    gate.pendingCount = 3;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome).toMatchObject({ status: "blocked", awaitingRequirementCount: 3 });
    expect(persistRequirements).not.toHaveBeenCalled();
  });

  it("promotes the approved list even when there is no usable synthesis output", async () => {
    db.synthesisOutput = null;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome.status).toBe("promoted");
    expect(persistedRequirements()).toHaveLength(3);
  });

  it("keeps promoting the synthesis output when no requirement went through the checkpoint", async () => {
    db.approvals = [];

    await promoteApprovedRequirements(ANALYSIS_ID);

    expect(persistedRequirements()).toHaveLength(3);
    expect(persistedRequirements()[0]?.title).toBe("Could not verify: PORT overrides LISTEN_ADDR");
  });
});
