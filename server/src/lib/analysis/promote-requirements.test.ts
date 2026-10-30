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
  analysis: { projectId: PROJECT_ID } as { projectId: string; metadata?: string } | null,
  synthesisOutput: JSON.stringify(SYNTHESIS_OUTPUT) as string | null,
  requirementCount: 0,
  /** #730 — the reviewed structured list and its per-requirement approvals. */
  structured: null as { requirements: Array<Record<string, unknown>>; runId?: string } | null,
  approvals: [] as Array<{
    itemId: string;
    status: string;
    createdAt?: Date;
    reviewedAt?: Date | null;
  }>,
  /** #909 — when the first requirement row was created (legacy append matching). */
  firstPromotedAt: new Date("2026-01-01T00:00:00Z"),
  /** #909 — make `persistRequirements` withhold the replacement (#769). */
  withhold: false,
  /** #1202 — the pairing columns of the requirement rows already promoted. */
  pairingRows: [] as Array<{
    promotedStructuredId: string | null;
    promotedStructuredRunId: string | null;
    promotedSynthesisKeys: string | null;
  }>,
};

/**
 * #723 — a small transactional model of the two tables the append writes. A
 * write made outside `$transaction` commits at once; one made through the tx
 * client is staged and lands only if the callback resolves. `$transaction`
 * runs one callback at a time — the analysis-row lock the append opens with.
 */
const committed = {
  /** Titles of the requirement rows that actually reached the database. */
  rows: [] as string[],
  /** Optional fault: the Nth requirement create (1-based) throws. */
  failCreateAt: 0,
  creates: 0,
  /** #1202 — the data of every requirement create, committed or not. */
  createdData: [] as Array<Record<string, unknown>>,
};
const createRow = async (args: { data: { title: string } }) => {
  committed.creates += 1;
  committed.createdData.push(args.data);
  if (committed.failCreateAt && committed.creates === committed.failCreateAt) {
    throw new Error("connection reset");
  }
  return { id: `rq_new_${committed.creates}` };
};
let txChain: Promise<unknown> = Promise.resolve();
/** The tx client handed to the most recent `$transaction` callback. */
let lastTx: {
  analysis: { update: ReturnType<typeof vi.fn> };
  requirement: { create: ReturnType<typeof vi.fn> };
} | null = null;

vi.mock("../prisma.js", () => {
  const requirementFindFirst = vi.fn(async () => ({ createdAt: db.firstPromotedAt }));
  const client = {
    analysis: { findFirst: vi.fn(async () => db.analysis) },
    agentResult: {
      findFirst: vi.fn(async () => (db.synthesisOutput ? { output: db.synthesisOutput } : null)),
    },
    requirement: {
      count: vi.fn(async () => db.requirementCount),
      findMany: vi.fn(async () => db.pairingRows),
      create: vi.fn(async (args: { data: { title: string } }) => {
        const row = await createRow(args);
        committed.rows.push(args.data.title);
        return row;
      }),
    },
    approvalRequest: {
      findMany: vi.fn(async ({ where }: { where: { type?: string } }) =>
        db.approvals.filter(() => where.type === "requirement"),
      ),
      findFirst: vi.fn(async ({ where }: { where: { type?: string } }) =>
        where.type === "requirement" ? (db.approvals[0] ?? null) : null,
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const run = txChain.then(async () => {
        const stagedRows: string[] = [];
        let stagedMetadata: string | undefined;
        const tx = {
          analysis: {
            update: vi.fn(async ({ data }: { data: { metadata?: string } }) => {
              if (data.metadata !== undefined) stagedMetadata = data.metadata;
              return { metadata: stagedMetadata ?? db.analysis?.metadata ?? null };
            }),
          },
          requirement: {
            findFirst: requirementFindFirst,
            create: vi.fn(async (args: { data: { title: string } }) => {
              const row = await createRow(args);
              stagedRows.push(args.data.title);
              return row;
            }),
          },
        };
        lastTx = tx;
        const result = await fn(tx);
        committed.rows.push(...stagedRows);
        if (stagedMetadata !== undefined && db.analysis) db.analysis.metadata = stagedMetadata;
        return result;
      });
      txChain = run.catch(() => undefined);
      return run;
    }),
  };
  return { prisma: client };
});

const persistRequirements = vi.fn(async (...args: unknown[]) => {
  if (db.withhold) {
    (args[0] as { onWithheld?: (w: unknown) => void }).onWithheld?.({ reason: "reviewed-work" });
    return [];
  }
  return ["rq_1", "rq_2"];
});
const persistAnalysisEnhancement = vi.fn(async () => undefined);
const lockRequirementSet = vi.fn(async (_tx: unknown, _analysisId: string) => undefined);
/** Persisted findings the promotion re-derives coverage + verdicts from. */
const findings: Array<Record<string, unknown>> = [];
vi.mock("./analysis-service.js", () => ({
  persistRequirements: (...a: unknown[]) => persistRequirements(...a),
  persistAnalysisEnhancement: (...a: unknown[]) => persistAnalysisEnhancement(...(a as [])),
  readFlattenedFindings: vi.fn(async () => findings),
  getStructuredRequirements: vi.fn(async () => db.structured),
  lockRequirementSet: (...a: unknown[]) => lockRequirementSet(...(a as [unknown, string])),
  CHECKPOINT_APPROVED_IDS_KEY: "checkpointApprovedRequirementIds",
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
const { synthesisItemKey } = await import("./promotion-pairing.js");

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
  db.firstPromotedAt = new Date("2026-01-01T00:00:00Z");
  db.withhold = false;
  findings.length = 0;
  committed.rows = [];
  committed.failCreateAt = 0;
  committed.creates = 0;
  committed.createdData = [];
  db.pairingRows = [];
  txChain = Promise.resolve();
  lastTx = null;
});

describe("#1104 B — promoting the requirements the approval gate withheld", () => {
  it("persists the withheld requirements once every approval is resolved", async () => {
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

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
    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(applyClarificationsToRequirements).toHaveBeenCalledWith(ANALYSIS_ID);
    // Order matters: enriching before the rows exist would be a silent no-op.
    expect(persistRequirements.mock.invocationCallOrder[0]).toBeLessThan(
      applyClarificationsToRequirements.mock.invocationCallOrder[0],
    );
  });

  it("#1116 — does not enrich anything while the gate is still closed", async () => {
    gate.allowed = false;
    gate.pendingCount = 1;

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(applyClarificationsToRequirements).not.toHaveBeenCalled();
  });

  it("clears the durable blocked marker so the UI stops warning", async () => {
    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(persistAnalysisEnhancement).toHaveBeenCalledWith(ANALYSIS_ID, {
      promotionBlocked: { blocked: false, pendingCount: 0, rejectedCount: 0 },
      promotionStatus: "allowed",
      // #1204 — written even when empty, so an earlier set's record is cleared.
      promotionMatching: {
        ambiguousCount: 0,
        ambiguous: [],
        shared: [],
        updatedAt: expect.any(String),
      },
    });
  });

  it("stays blocked — and persists nothing — while approvals are outstanding", async () => {
    gate.allowed = false;
    gate.pendingCount = 3;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome.status).toBe("blocked");
    expect(outcome).toMatchObject({ pendingCount: 3, awaitingRequirementCount: 2 });
    expect(persistRequirements).not.toHaveBeenCalled();
  });

  it("is idempotent — never re-persists an already-promoted analysis", async () => {
    db.requirementCount = 2;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "already-promoted", requirementCount: 2 });
    expect(persistRequirements).not.toHaveBeenCalled();
  });

  it("reports unavailable (never throws) when there is no synthesis output to promote", async () => {
    db.synthesisOutput = null;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome.status).toBe("unavailable");
    expect(persistRequirements).not.toHaveBeenCalled();
  });

  it("reports unavailable when the persisted synthesis output is unparseable", async () => {
    db.synthesisOutput = "{not json";

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

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

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

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

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "promoted", requirementCount: 2 });
    expect(persistAnalysisEnhancement).toHaveBeenCalled();
  });

  it("reports unavailable when the analysis does not exist", async () => {
    db.analysis = null;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

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
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

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
    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

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

  it("#909 — keeps the reviewed requirement type as a label instead of dropping it", async () => {
    (db.structured!.requirements[1] as { type: string }).type = "non-functional";

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    const reqs = persistedRequirements() as unknown as Array<{ labels: string[] }>;
    // Ahead of the matched synthesized requirement's own labels.
    expect(reqs[0]?.labels).toEqual(["functional", "database"]);
    expect(reqs[1]?.labels).toEqual(["non-functional"]);
  });

  it("leaves out a requirement the reviewer did not approve", async () => {
    db.approvals[1] = { itemId: "REQ-2", status: "rejected" };

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(persistedRequirements().map((r) => r.title)).toEqual([
      "Duplicate Feed URL Subscription Prevention",
      "OAuth2 User Creation Disabled by Default",
    ]);
  });

  it("counts the reviewed list, not the synthesis set, while the gate is closed", async () => {
    gate.allowed = false;
    gate.pendingCount = 3;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toMatchObject({ status: "blocked", awaitingRequirementCount: 3 });
    expect(persistRequirements).not.toHaveBeenCalled();
  });

  it("promotes the approved list even when there is no usable synthesis output", async () => {
    db.synthesisOutput = null;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome.status).toBe("promoted");
    expect(persistedRequirements()).toHaveLength(3);
  });

  it("#939 — promotes the reviewed requirements already approved: the checkpoint was the review", async () => {
    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(persistRequirements.mock.calls[0]?.[0]).toMatchObject({ reviewStatus: "approved" });
  });

  it("#939 — leaves synthesis-only rows as drafts: nobody has reviewed them", async () => {
    db.approvals = [];

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(persistRequirements.mock.calls[0]?.[0]).not.toHaveProperty("reviewStatus");
  });

  it("keeps promoting the synthesis output when no requirement went through the checkpoint", async () => {
    db.approvals = [];

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(persistedRequirements()).toHaveLength(3);
    expect(persistedRequirements()[0]?.title).toBe("Could not verify: PORT overrides LISTEN_ADDR");
  });
});

/**
 * Issue #1033 — through the persisted synthesis JSON: the ids synthesis wrote
 * survive `readSynthesisOutput`'s schema parse and decide which approved
 * requirement gets which criteria and evidence.
 */
describe("#1033 — criteria and evidence reach the requirements synthesis names", () => {
  const structuredReq = (id: string, title: string) => ({
    id,
    title,
    description: title,
    type: "functional",
    stakeholders: [],
    priority: "must-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  });
  const item = (title: string, extra: Record<string, unknown>) => ({
    type: "feature",
    title,
    body: title,
    priority: "medium",
    labels: [],
    acceptanceCriteria: [],
    evidenceFindingIndexes: [],
    ...extra,
  });

  beforeEach(() => {
    db.structured = {
      requirements: [
        structuredReq("REQ-1", "Require HTTP Basic Authentication for Metrics Endpoint"),
        structuredReq("REQ-2", "Restrict Debian package publishing to the sandbox repository"),
        structuredReq("REQ-3", "Reject Empty Username or Password for Metrics Endpoint"),
        structuredReq("REQ-4", "Constant-Time Credential Comparison for Metrics Endpoint"),
      ],
    };
    db.approvals = ["REQ-1", "REQ-2", "REQ-3", "REQ-4"].map((itemId) => ({
      itemId,
      status: "approved",
    }));
    db.synthesisOutput = JSON.stringify({
      summary: "s",
      requirements: [
        item("Require HTTP Basic auth on the metrics endpoint with constant-time checks", {
          evidenceFindingIndexes: [7, 8],
          acceptanceCriteria: ["Empty credentials are rejected.", "Comparison is constant-time."],
          structuredIds: ["REQ-3", "REQ-4"],
        }),
        item("Require HTTP Basic authentication for the metrics endpoint", {
          evidenceFindingIndexes: [6],
          acceptanceCriteria: ["No Authorization header gets 404."],
          structuredIds: ["REQ-1"],
        }),
      ],
    });
  });

  function persisted() {
    const input = persistRequirements.mock.calls[0]?.[0] as {
      synthesis: {
        requirements: Array<{
          title: string;
          labels: string[];
          acceptanceCriteria: string[];
          evidenceFindingIndexes: number[];
        }>;
      };
    };
    return input.synthesis.requirements;
  }

  it("gives the confirmed requirements after the first their criteria and evidence", async () => {
    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });
    const [basic, publishing, empty, constant] = persisted();
    expect(basic).toMatchObject({
      acceptanceCriteria: ["No Authorization header gets 404."],
      evidenceFindingIndexes: [6],
    });
    for (const r of [empty, constant]) {
      expect(r).toMatchObject({
        acceptanceCriteria: ["Empty credentials are rejected.", "Comparison is constant-time."],
        evidenceFindingIndexes: [7, 8],
      });
    }
    // Nothing in the code could confirm it: no evidence, so no code link.
    expect(publishing).toMatchObject({ acceptanceCriteria: [], evidenceFindingIndexes: [] });
  });
});

describe("#723 — a rejected requirement is dropped, and can be reopened after promotion", () => {
  /** Titles of the requirement rows that COMMITTED (see the transactional model). */
  const created = () => committed.rows;
  const recordedIds = () =>
    (JSON.parse(db.analysis?.metadata ?? "{}") as { promotedStructuredIds?: string[] })
      .promotedStructuredIds;

  const structuredReq = (id: string, title: string) => ({
    id,
    title,
    description: `${title}.`,
    type: "functional",
    stakeholders: [],
    priority: "should-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  });

  beforeEach(() => {
    db.structured = {
      requirements: [
        structuredReq("REQ-1", "Feed URL must be absolute"),
        structuredReq("REQ-2", "Reading speed validation"),
        structuredReq("REQ-3", "Per-host polling concurrency limit"),
      ],
    };
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "rejected" },
      { itemId: "REQ-3", status: "approved" },
    ];
    gate.rejectedCount = 1;
  });

  it("promotes the approved ones and records which structured ids it promoted", async () => {
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome.status).toBe("promoted");
    const input = persistRequirements.mock.calls[0]?.[0] as {
      synthesis: { requirements: Array<{ title: string }> };
    };
    expect(input.synthesis.requirements.map((r) => r.title)).toEqual([
      "Feed URL must be absolute",
      "Per-host polling concurrency limit",
    ]);
    expect(persistAnalysisEnhancement).toHaveBeenCalledWith(ANALYSIS_ID, {
      promotionBlocked: { blocked: false, pendingCount: 0, rejectedCount: 1 },
      promotionStatus: "allowed",
      promotedStructuredIds: ["REQ-1", "REQ-3"],
      promotedStructuredRunId: null,
      promotionMatching: {
        ambiguousCount: 0,
        ambiguous: [],
        shared: [],
        updatedAt: expect.any(String),
      },
    });
  });

  it("adds a reopened-then-approved requirement without replacing the promoted set", async () => {
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-3"] }),
    };
    db.approvals[1] = { itemId: "REQ-2", status: "approved" };
    gate.rejectedCount = 0;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "promoted", requirementCount: 1 });
    expect(persistRequirements).not.toHaveBeenCalled();
    expect(created()).toEqual(["Reading speed validation"]);
    expect(applyClarificationsToRequirements).toHaveBeenCalledWith(ANALYSIS_ID);
    expect(recordedIds()).toEqual(["REQ-1", "REQ-3", "REQ-2"]);
    // The record rides the rows' transaction, not a separate metadata write.
    expect(persistAnalysisEnhancement).not.toHaveBeenCalled();
  });

  it("#939 — creates an appended requirement approved and records it as the checkpoint's", async () => {
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({
        promotedStructuredIds: ["REQ-1", "REQ-3"],
        checkpointApprovedRequirementIds: ["rq_1", "rq_3"],
      }),
    };
    db.approvals[1] = { itemId: "REQ-2", status: "approved" };

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    const data = (
      lastTx!.requirement.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(data.reviewStatus).toBe("approved");
    const meta = JSON.parse(db.analysis.metadata ?? "{}") as Record<string, unknown>;
    expect(meta.checkpointApprovedRequirementIds).toEqual(["rq_1", "rq_3", "rq_new_1"]);
  });

  it("#1063 — an appended requirement keeps the imported item it came from", async () => {
    const sourceRequirements = [
      {
        candidateId: "NR-2",
        requirementId: "req-imported-2",
        title: "Validate reading speed",
        externalSource: "github",
        externalId: "4402",
        externalUrl: "https://github.com/miniflux/v2/issues/4402",
      },
    ];
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-3"], sourceRequirements }),
    };
    db.synthesisOutput = JSON.stringify({
      summary: "s",
      requirements: [
        {
          type: "feature",
          title: "Reading speed validation",
          body: "Reading speed validation.",
          priority: "medium",
          labels: [],
          evidenceFindingIndexes: [],
          acceptanceCriteria: [],
          // NR-9 is not one of this run's ids and must not be stored.
          sourceIds: ["NR-2", "NR-9"],
        },
      ],
    });
    db.approvals[1] = { itemId: "REQ-2", status: "approved" };

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    const data = (
      lastTx!.requirement.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(data.title).toBe("Reading speed validation");
    expect(data.sourceCandidateIds).toBe('["NR-2"]');
  });

  it("#1063 — an appended requirement of a run with no imported items records no source", async () => {
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-3"] }),
    };
    db.approvals[1] = { itemId: "REQ-2", status: "approved" };

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    const data = (
      lastTx!.requirement.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    ).data;
    expect(data.sourceCandidateIds).toBeNull();
  });

  it("takes #882's requirement-set lock on its own transaction before reading the record", async () => {
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-3"] }),
    };
    db.approvals[1] = { itemId: "REQ-2", status: "approved" };

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(lockRequirementSet).toHaveBeenCalledTimes(1);
    expect(lockRequirementSet).toHaveBeenCalledWith(lastTx, ANALYSIS_ID);
    const lockedAt = lockRequirementSet.mock.invocationCallOrder[0]!;
    const firstUpdateAt = lastTx!.analysis.update.mock.invocationCallOrder[0]!;
    expect(lockedAt).toBeLessThan(firstUpdateAt);
  });

  it("commits neither the rows nor the record when a create fails part-way", async () => {
    db.requirementCount = 1;
    const metadata = JSON.stringify({ promotedStructuredIds: ["REQ-1"] });
    db.analysis = { projectId: PROJECT_ID, metadata };
    db.approvals[1] = { itemId: "REQ-2", status: "approved" };
    committed.failCreateAt = 2; // REQ-2 lands, REQ-3 throws

    await expect(promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true })).rejects.toThrow(
      "connection reset",
    );

    expect(created()).toEqual([]);
    expect(db.analysis.metadata).toBe(metadata);

    // The retry then appends each requirement exactly once.
    committed.failCreateAt = 0;
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });
    expect(outcome).toEqual({ status: "promoted", requirementCount: 2 });
    expect(created()).toEqual(["Reading speed validation", "Per-host polling concurrency limit"]);
    expect(recordedIds()).toEqual(["REQ-1", "REQ-2", "REQ-3"]);
  });

  it("appends a requirement once when two approvals resolve concurrently", async () => {
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-3"] }),
    };
    db.approvals[1] = { itemId: "REQ-2", status: "approved" };

    const outcomes = await Promise.all([
      promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true }),
      promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true }),
    ]);

    expect(created()).toEqual(["Reading speed validation"]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["already-promoted", "promoted"]);
    expect(recordedIds()).toEqual(["REQ-1", "REQ-3", "REQ-2"]);
  });

  it("#909 — for a set promoted before the ids were recorded, appends only what was approved after it", async () => {
    // The promoted rows' titles were edited since; a title match would have
    // re-created both. Approval time vs. first promotion is edit-proof.
    db.requirementCount = 2;
    const before = new Date("2025-12-31T00:00:00Z");
    const after = new Date("2026-01-02T00:00:00Z");
    db.approvals = [
      { itemId: "REQ-1", status: "approved", reviewedAt: before },
      { itemId: "REQ-2", status: "approved", reviewedAt: after },
      { itemId: "REQ-3", status: "approved", reviewedAt: before },
    ];

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(created()).toEqual(["Reading speed validation"]);
    expect(recordedIds()).toEqual(["REQ-1", "REQ-2", "REQ-3"]);
  });

  it("is still a no-op when every approved requirement is already promoted", async () => {
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-3"] }),
    };

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "already-promoted", requirementCount: 2 });
    expect(created()).toEqual([]);
  });
});

describe("#909 — promoted ids are scoped to the extraction run", () => {
  const structuredReq = (id: string, title: string) => ({
    id,
    title,
    description: `${title}.`,
    type: "functional",
    stakeholders: [],
    priority: "should-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  });
  const recorded = () =>
    JSON.parse(db.analysis?.metadata ?? "{}") as {
      promotedStructuredIds?: string[];
      promotedStructuredRunId?: string | null;
    };

  beforeEach(() => {
    // Run 1 promoted REQ-1 and REQ-2; a re-run numbered its NEW list from REQ-1 again.
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({
        promotedStructuredIds: ["REQ-1", "REQ-2"],
        promotedStructuredRunId: "run-1",
      }),
    };
    db.structured = {
      runId: "run-2",
      requirements: [
        structuredReq("REQ-1", "Export subscriptions as OPML"),
        structuredReq("REQ-2", "Import subscriptions from OPML"),
        structuredReq("REQ-3", "Schedule feed refresh per category"),
      ],
    };
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "approved" },
      { itemId: "REQ-3", status: "approved" },
    ];
  });

  it("does not read a re-run's colliding ids as promoted, nor append its list beside the set", async () => {
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    // Nothing appended next to run 1's set ...
    expect(committed.rows).toEqual([]);
    // ... the re-run's whole list goes through the replacement path instead.
    expect(persistRequirements).toHaveBeenCalledTimes(1);
    const input = persistRequirements.mock.calls[0]?.[0] as {
      synthesis: { requirements: Array<{ title: string }> };
    };
    expect(input.synthesis.requirements.map((r) => r.title)).toEqual([
      "Export subscriptions as OPML",
      "Import subscriptions from OPML",
      "Schedule feed refresh per category",
    ]);
    expect(outcome).toEqual({ status: "promoted", requirementCount: 2 });
    expect(persistAnalysisEnhancement).toHaveBeenCalledWith(
      ANALYSIS_ID,
      expect.objectContaining({
        promotedStructuredIds: ["REQ-1", "REQ-2", "REQ-3"],
        promotedStructuredRunId: "run-2",
      }),
    );
  });

  it("records nothing when that replacement is withheld to protect review work (#769)", async () => {
    db.withhold = true;

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome.status).toBe("unavailable");
    expect(outcome).toMatchObject({ reason: expect.stringContaining("withheld") });
    expect(persistAnalysisEnhancement).not.toHaveBeenCalled();
    expect(recorded().promotedStructuredRunId).toBe("run-1");
  });

  it("still appends a reopened approval within the SAME run", async () => {
    db.structured!.runId = "run-1";

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "promoted", requirementCount: 1 });
    expect(persistRequirements).not.toHaveBeenCalled();
    expect(committed.rows).toEqual(["Schedule feed refresh per category"]);
    expect(recorded()).toEqual({
      promotedStructuredIds: ["REQ-1", "REQ-2", "REQ-3"],
      promotedStructuredRunId: "run-1",
      // #939 — the appended row is the checkpoint's approval, recorded with it.
      checkpointApprovedRequirementIds: ["rq_new_1"],
      // #1204 — the append records its rows' refusals (none here) in the same write.
      promotionMatching: {
        ambiguousCount: 0,
        ambiguous: [],
        shared: [],
        updatedAt: expect.any(String),
      },
    });
  });

  it("re-checks the run under the lock: a replacement that committed meanwhile wins", async () => {
    const { prisma } = await import("../prisma.js");
    db.structured!.runId = "run-1";
    // Routed on a stale read (run 1's record) ...
    vi.mocked(prisma.analysis.findFirst).mockResolvedValueOnce({
      projectId: PROJECT_ID,
      metadata: JSON.stringify({
        promotedStructuredIds: ["REQ-1", "REQ-2"],
        promotedStructuredRunId: "run-1",
      }),
    } as never);
    // ... while run 2's replacement had already committed its own record.
    const run2 = JSON.stringify({
      promotedStructuredIds: ["REQ-1"],
      promotedStructuredRunId: "run-2",
    });
    db.analysis = { projectId: PROJECT_ID, metadata: run2 };

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome.status).toBe("unavailable");
    expect(outcome).toMatchObject({ reason: expect.stringContaining("replaced by another run") });
    expect(committed.rows).toEqual([]);
    expect(db.analysis.metadata).toBe(run2);
  });

  it("lets the newest approval of an id decide, not an earlier run's", async () => {
    db.requirementCount = 0;
    db.analysis = { projectId: PROJECT_ID };
    db.approvals = [
      // Run 1's REQ-2 was approved; run 2's REQ-2 — a different requirement — was rejected.
      // Newest row FIRST for REQ-2: production's findMany has no orderBy.
      { itemId: "REQ-2", status: "rejected", createdAt: new Date("2026-02-01T00:00:00Z") },
      { itemId: "REQ-1", status: "approved", createdAt: new Date("2026-02-01T00:00:00Z") },
      { itemId: "REQ-2", status: "approved", createdAt: new Date("2026-01-01T00:00:00Z") },
      { itemId: "REQ-3", status: "approved", createdAt: new Date("2026-02-01T00:00:00Z") },
    ];

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    const input = persistRequirements.mock.calls[0]?.[0] as {
      synthesis: { requirements: Array<{ title: string }> };
    };
    expect(input.synthesis.requirements.map((r) => r.title)).toEqual([
      "Export subscriptions as OPML",
      "Schedule feed refresh per category",
    ]);
  });
});

describe("#1204 — promotion records each requirement the title join refused", () => {
  const structuredReq = (id: string, title: string) => ({
    id,
    title,
    description: `${title}.`,
    type: "functional",
    stakeholders: [],
    priority: "should-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  });
  const item = (title: string, criterion: string) => ({
    type: "feature",
    title,
    body: title,
    priority: "medium",
    labels: [],
    acceptanceCriteria: [criterion],
    evidenceFindingIndexes: [],
  });
  /** REQ-1 is level on both items; REQ-2 matches neither. */
  const LOGOUT = item("Flush sessions on logout", "Logging out ends every session.");
  const RESET = item("Flush sessions on password reset", "A password reset ends every session.");
  const BOTH = [
    { title: LOGOUT.title, acceptanceCriteria: LOGOUT.acceptanceCriteria },
    { title: RESET.title, acceptanceCriteria: RESET.acceptanceCriteria },
  ];
  const recordOf = () =>
    (JSON.parse(db.analysis?.metadata ?? "{}") as { promotionMatching?: unknown })
      .promotionMatching;

  beforeEach(() => {
    // REQ-0 is rejected and listed FIRST, so a requirement's position among
    // the approved (what the rows are aligned with) differs from its position
    // in the reviewed list: keying by the latter would name the wrong row.
    db.structured = {
      requirements: [
        structuredReq("REQ-0", "Rate limit the public API"),
        structuredReq("REQ-1", "Flush sessions"),
        structuredReq("REQ-2", "Export subscriptions as OPML"),
      ],
    };
    db.approvals = [
      { itemId: "REQ-0", status: "rejected" },
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "approved" },
    ];
    db.synthesisOutput = JSON.stringify({ summary: "s", requirements: [LOGOUT, RESET] });
  });

  it("keys the refusal by the row it became and names the items it was level on", async () => {
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "promoted", requirementCount: 2 });
    // The rule is unchanged: the refused requirement gets no item's criteria.
    const input = persistRequirements.mock.calls[0]?.[0] as {
      synthesis: { requirements: Array<{ acceptanceCriteria: string[] }> };
    };
    expect(input.synthesis.requirements[0]?.acceptanceCriteria).toEqual([]);
    expect(persistAnalysisEnhancement).toHaveBeenCalledWith(
      ANALYSIS_ID,
      expect.objectContaining({
        promotionMatching: {
          ambiguousCount: 1,
          ambiguous: [{ requirementId: "rq_1", structuredId: "REQ-1", candidates: BOTH }],
          shared: [],
          updatedAt: expect.any(String),
        },
      }),
    );
  });

  it("records nothing when the replacement is withheld (#769)", async () => {
    db.withhold = true;

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(persistAnalysisEnhancement).not.toHaveBeenCalled();
  });

  it("an append keeps the earlier entries and adds the appended row's refusal", async () => {
    const earlier = {
      requirementId: "rq_old",
      structuredId: "REQ-9",
      candidates: [{ title: "Earlier item", acceptanceCriteria: [] }],
    };
    db.requirementCount = 1;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({
        promotedStructuredIds: ["REQ-2"],
        promotionMatching: { ambiguousCount: 1, ambiguous: [earlier], updatedAt: "x" },
      }),
    };

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "promoted", requirementCount: 1 });
    expect(recordOf()).toEqual({
      ambiguousCount: 2,
      ambiguous: [earlier, { requirementId: "rq_new_1", structuredId: "REQ-1", candidates: BOTH }],
      shared: [],
      updatedAt: expect.any(String),
    });
  });

  // #1204 review — the append re-plans over the ENLARGED approved set. Alone,
  // REQ-1 reaches only X and the first promotion gave X to its row. With REQ-3
  // and REQ-4 approved later, the level reads REQ-1:{X}, REQ-3:{X,Y},
  // REQ-4:{Y}: three maximum matchings, nothing forced, all refused. X is on
  // REQ-1's row already, so listing it on REQ-3's card would invite copying
  // another requirement's criteria across.
  it("an append never lists an item the earlier set's rows already carry", async () => {
    const X = item("Flush sessions logout", "Logging out ends every session.");
    const Y = item("Flush tokens logout", "Logging out revokes every token.");
    db.structured = {
      requirements: [
        structuredReq("REQ-1", "Flush sessions"),
        structuredReq("REQ-3", "Flush logout"),
        structuredReq("REQ-4", "Flush tokens"),
      ],
    };
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-3", status: "approved" },
      { itemId: "REQ-4", status: "approved" },
    ];
    db.synthesisOutput = JSON.stringify({ summary: "s", requirements: [X, Y] });
    db.requirementCount = 1;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1"] }),
    };

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "promoted", requirementCount: 2 });
    const onlyY = [{ title: Y.title, acceptanceCriteria: Y.acceptanceCriteria }];
    expect(recordOf()).toEqual({
      ambiguousCount: 2,
      ambiguous: [
        { requirementId: "rq_new_1", structuredId: "REQ-3", candidates: onlyY },
        { requirementId: "rq_new_2", structuredId: "REQ-4", candidates: onlyY },
      ],
      shared: [],
      updatedAt: expect.any(String),
    });
  });

  it("an append records no notice for a row whose only option an earlier row carries", async () => {
    // Twins: alone, REQ-1 took X; together they tie on it and both are refused.
    const X = item("Flush sessions on logout", "Logging out ends every session.");
    db.structured = {
      requirements: [
        structuredReq("REQ-1", "Flush sessions"),
        structuredReq("REQ-3", "Flush sessions"),
      ],
    };
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-3", status: "approved" },
    ];
    db.synthesisOutput = JSON.stringify({ summary: "s", requirements: [X] });
    db.requirementCount = 1;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1"] }),
    };

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "promoted", requirementCount: 1 });
    expect(recordOf()).toEqual({
      ambiguousCount: 0,
      ambiguous: [],
      shared: [],
      updatedAt: expect.any(String),
    });
  });

  // #1253 — three requirements titled alike and one item, X, promoted in three
  // steps. Replaying the two earlier steps as ONE set ties all three on X, so
  // before the rows recorded their items REQ-3's notice listed X although X's
  // criteria are on REQ-1's row.
  describe("#1253 — two successive appends", () => {
    const X = item("Flush sessions", "Logging out ends every session.");
    const twins = () => {
      db.structured = {
        requirements: [
          structuredReq("REQ-1", "Flush sessions"),
          structuredReq("REQ-2", "Flush sessions"),
          structuredReq("REQ-3", "Flush sessions"),
        ],
      };
      db.synthesisOutput = JSON.stringify({ summary: "s", requirements: [X] });
    };
    const noNotice = {
      ambiguousCount: 0,
      ambiguous: [],
      shared: [],
      updatedAt: expect.any(String),
    };

    it("the third requirement's notice does not list X when the rows recorded their items (#1202)", async () => {
      twins();
      // Step 1 promoted REQ-1, and its row recorded taking X.
      db.requirementCount = 1;
      db.analysis = {
        projectId: PROJECT_ID,
        metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1"] }),
      };
      db.pairingRows = [
        {
          promotedStructuredId: "REQ-1",
          promotedStructuredRunId: null,
          promotedSynthesisKeys: JSON.stringify([synthesisItemKey(X)]),
        },
      ];
      // Step 2: append REQ-2.
      db.approvals = [
        { itemId: "REQ-1", status: "approved" },
        { itemId: "REQ-2", status: "approved" },
      ];
      expect(await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true })).toEqual({
        status: "promoted",
        requirementCount: 1,
      });
      expect(recordOf()).toEqual(noNotice);
      const second = committed.createdData.at(-1) as {
        promotedStructuredId: string;
        promotedStructuredRunId: string | null;
        promotedSynthesisKeys: string;
      };
      expect(second.promotedStructuredId).toBe("REQ-2");
      expect(JSON.parse(second.promotedSynthesisKeys)).toEqual([]);

      // Step 3: append REQ-3, with REQ-2's row now holding its recorded pairing.
      db.requirementCount = 2;
      db.pairingRows = [...db.pairingRows, second];
      db.approvals = [...db.approvals, { itemId: "REQ-3", status: "approved" }];
      expect(await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true })).toEqual({
        status: "promoted",
        requirementCount: 1,
      });
      expect(recordOf()).toEqual(noNotice);
    });

    it("the third requirement's notice does not list X when the earlier rows predate #1202", async () => {
      twins();
      // REQ-1 then REQ-2 were promoted in two steps before rows recorded items.
      db.requirementCount = 2;
      db.analysis = {
        projectId: PROJECT_ID,
        metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-2"] }),
      };
      db.pairingRows = [
        { promotedStructuredId: null, promotedStructuredRunId: null, promotedSynthesisKeys: null },
        { promotedStructuredId: null, promotedStructuredRunId: null, promotedSynthesisKeys: null },
      ];
      db.approvals = [
        { itemId: "REQ-1", status: "approved" },
        { itemId: "REQ-2", status: "approved" },
        { itemId: "REQ-3", status: "approved" },
      ];

      expect(await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true })).toEqual({
        status: "promoted",
        requirementCount: 1,
      });
      expect(recordOf()).toEqual(noNotice);
    });

    // #1253 review (F1/F6) — the reviewer's probe. All rows predate #1202.
    // REQ-1 is level on X1 and X2 on its own, so it took neither; REQ-2 took O.
    // Every one of REQ-3's options is an item REQ-1 alone is level on, and no
    // row holds either: the refusal must survive with both listed, or REQ-3 is
    // written with no criteria and no word of why.
    it("keeps the notice when the earlier tie was one requirement's own", async () => {
      const X1 = item("Flush sessions", "Logging out ends every session.");
      const X2 = { ...item("Flush sessions", "A reset ends every session."), body: "On reset." };
      const O = item("Export orders", "Orders export as CSV.");
      db.structured = {
        requirements: [
          structuredReq("REQ-1", "Flush sessions"),
          structuredReq("REQ-2", "Export orders"),
          structuredReq("REQ-3", "Flush sessions"),
        ],
      };
      db.synthesisOutput = JSON.stringify({ summary: "s", requirements: [X1, X2, O] });
      db.requirementCount = 2;
      db.analysis = {
        projectId: PROJECT_ID,
        metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-2"] }),
      };
      db.pairingRows = [
        { promotedStructuredId: null, promotedStructuredRunId: null, promotedSynthesisKeys: null },
        { promotedStructuredId: null, promotedStructuredRunId: null, promotedSynthesisKeys: null },
      ];
      db.approvals = [
        { itemId: "REQ-1", status: "approved" },
        { itemId: "REQ-2", status: "approved" },
        { itemId: "REQ-3", status: "approved" },
      ];

      expect(await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true })).toEqual({
        status: "promoted",
        requirementCount: 1,
      });
      expect(recordOf()).toEqual({
        ambiguousCount: 1,
        ambiguous: [
          {
            requirementId: "rq_new_1",
            structuredId: "REQ-3",
            candidates: [
              { title: X1.title, acceptanceCriteria: X1.acceptanceCriteria },
              { title: X2.title, acceptanceCriteria: X2.acceptanceCriteria },
            ],
          },
        ],
        shared: [],
        updatedAt: expect.any(String),
      });
    });
  });

  // #1253 — a set promoted before #723 recorded its ids: the earlier set is the
  // requirements approved before it was first promoted, never nobody.
  it("an append onto a set with no recorded ids drops the items its earlier rows carry", async () => {
    const X = item("Flush sessions", "Logging out ends every session.");
    db.structured = {
      requirements: [
        structuredReq("REQ-1", "Flush sessions"),
        structuredReq("REQ-3", "Flush sessions"),
      ],
    };
    db.synthesisOutput = JSON.stringify({ summary: "s", requirements: [X] });
    db.requirementCount = 1;
    db.analysis = { projectId: PROJECT_ID };
    db.approvals = [
      { itemId: "REQ-1", status: "approved", reviewedAt: new Date("2025-12-31T00:00:00Z") },
      { itemId: "REQ-3", status: "approved", reviewedAt: new Date("2026-01-02T00:00:00Z") },
    ];

    expect(await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true })).toEqual({
      status: "promoted",
      requirementCount: 1,
    });
    expect(committed.rows).toEqual(["Flush sessions"]);
    expect(recordOf()).toEqual({
      ambiguousCount: 0,
      ambiguous: [],
      shared: [],
      updatedAt: expect.any(String),
    });
  });
});
describe("#1203 — promotion records which requirements share criteria", () => {
  const structuredReq = (id: string, title: string) => ({
    id,
    title,
    description: `${title}.`,
    type: "functional",
    stakeholders: [],
    priority: "should-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  });
  const item = (title: string, structuredIds: string[], acceptanceCriteria: string[]) => ({
    type: "feature",
    title,
    body: title,
    priority: "medium",
    labels: [],
    acceptanceCriteria,
    evidenceFindingIndexes: [],
    structuredIds,
  });
  const GROUP = ["Logging out ends every session.", "A reset ends every session."];
  const ALONE = ["Subscriptions export as OPML."];
  const TITLES: Record<string, string> = {
    "REQ-0": "Rate limit the public API",
    "REQ-1": "Flush sessions on logout",
    "REQ-2": "Flush sessions on reset",
    "REQ-3": "Flush sessions on revoke",
    "REQ-4": "Export subscriptions as OPML",
  };
  const sib = (structuredId: string, requirementId: string | null, approved = true) => ({
    structuredId,
    title: TITLES[structuredId]!,
    requirementId,
    approved,
  });
  const shared = (
    requirementId: string,
    structuredId: string,
    sharedWith: ReturnType<typeof sib>[],
  ) => ({
    requirementId,
    structuredId,
    sharedWith,
    sharedCriteria: GROUP,
    promotedCriteria: GROUP,
  });
  const recordOf = () =>
    (
      JSON.parse(db.analysis?.metadata ?? "{}") as {
        promotionMatching?: { shared?: unknown };
      }
    ).promotionMatching;
  const writtenMatching = () =>
    (
      persistAnalysisEnhancement.mock.calls.at(-1) as unknown as
        [string, { promotionMatching?: { shared?: unknown } }] | undefined
    )?.[1].promotionMatching;

  beforeEach(() => {
    db.structured = {
      requirements: Object.entries(TITLES).map(([id, title]) => structuredReq(id, title)),
    };
    db.synthesisOutput = JSON.stringify({
      summary: "s",
      requirements: [
        item("Flush sessions", ["REQ-1", "REQ-2", "REQ-3"], GROUP),
        item("OPML export", ["REQ-4"], ALONE),
      ],
    });
  });

  it("a three-requirement item gives each row a note naming the other two; a single one none", async () => {
    // REQ-0 is rejected and listed FIRST: approved position ≠ reviewed position.
    db.approvals = [
      { itemId: "REQ-0", status: "rejected" },
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "approved" },
      { itemId: "REQ-3", status: "approved" },
      { itemId: "REQ-4", status: "approved" },
    ];
    persistRequirements.mockImplementationOnce(async () => ["rq_1", "rq_2", "rq_3", "rq_4"]);

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "promoted", requirementCount: 4 });
    expect(writtenMatching()?.shared).toEqual([
      shared("rq_1", "REQ-1", [sib("REQ-2", "rq_2"), sib("REQ-3", "rq_3")]),
      shared("rq_2", "REQ-2", [sib("REQ-1", "rq_1"), sib("REQ-3", "rq_3")]),
      shared("rq_3", "REQ-3", [sib("REQ-1", "rq_1"), sib("REQ-2", "rq_2")]),
    ]);
  });

  it("names a sibling that was not approved, with no row", async () => {
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "rejected" },
      { itemId: "REQ-3", status: "approved" },
    ];

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(writtenMatching()?.shared).toEqual([
      shared("rq_1", "REQ-1", [sib("REQ-2", null, false), sib("REQ-3", "rq_2")]),
      shared("rq_2", "REQ-3", [sib("REQ-1", "rq_1"), sib("REQ-2", null, false)]),
    ]);
  });

  it("two successive appends link every row's note to the siblings appended after it", async () => {
    // 1. Only REQ-1 approved: its note names REQ-2 and REQ-3, neither approved yet.
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "rejected" },
      { itemId: "REQ-3", status: "rejected" },
    ];
    persistRequirements.mockImplementationOnce(async () => ["rq_1"]);
    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });
    const first = writtenMatching();
    expect(first?.shared).toEqual([
      shared("rq_1", "REQ-1", [sib("REQ-2", null, false), sib("REQ-3", null, false)]),
    ]);
    // What promotion persisted (the enhancement writer is mocked here).
    db.requirementCount = 1;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({
        promotedStructuredIds: ["REQ-1"],
        promotionMatching: first,
      }),
    };

    // 2. REQ-2 reopened and approved: appended, and REQ-1's note links to it.
    db.approvals[1] = { itemId: "REQ-2", status: "approved" };
    expect(await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true })).toEqual({
      status: "promoted",
      requirementCount: 1,
    });
    expect(recordOf()?.shared).toEqual([
      shared("rq_1", "REQ-1", [sib("REQ-2", "rq_new_1"), sib("REQ-3", null, false)]),
      shared("rq_new_1", "REQ-2", [sib("REQ-1", "rq_1"), sib("REQ-3", null, false)]),
    ]);

    // 3. REQ-3 too: every note now links to both of its siblings.
    db.approvals[2] = { itemId: "REQ-3", status: "approved" };
    expect(await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true })).toEqual({
      status: "promoted",
      requirementCount: 1,
    });
    expect(recordOf()?.shared).toEqual([
      shared("rq_1", "REQ-1", [sib("REQ-2", "rq_new_1"), sib("REQ-3", "rq_new_2")]),
      shared("rq_new_1", "REQ-2", [sib("REQ-1", "rq_1"), sib("REQ-3", "rq_new_2")]),
      shared("rq_new_2", "REQ-3", [sib("REQ-1", "rq_1"), sib("REQ-2", "rq_new_1")]),
    ]);
  });

  it("an append onto a set promoted before #1203 names the earlier sibling without a link", async () => {
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "approved" },
    ];
    db.requirementCount = 1;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1"] }),
    };

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(recordOf()?.shared).toEqual([
      shared("rq_new_1", "REQ-2", [sib("REQ-1", null, true), sib("REQ-3", null, false)]),
    ]);
  });
});

describe("#1202 — promotion records the pairing, and an append joins on it", () => {
  const RUN = "run-1202";
  const structuredReq = (id: string, title: string) => ({
    id,
    title,
    description: `${title}.`,
    type: "functional",
    stakeholders: [],
    priority: "should-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  });
  const item = (title: string, body: string, criterion: string) => ({
    type: "feature",
    title,
    body,
    priority: "medium",
    labels: [],
    acceptanceCriteria: [criterion],
    evidenceFindingIndexes: [],
  });
  // Neighbours whose titles hold the same words. Alone, REQ-1 takes X (X's
  // title holds all of REQ-1's words, Y's body only). Together REQ-1 and REQ-2
  // are level on X, so the title join refuses both — and REQ-2 is never offered
  // Y, its own item, because a requirement refused at one level takes nothing
  // weaker (#1031).
  const X = item("Mark entries read", "Mark entries read from the list.", "X: the list is marked.");
  const Y = item(
    "Bulk actions",
    "Mark the selected entries as read.",
    "Y: the selection is marked.",
  );
  const createdFor = (structuredId: string) =>
    committed.createdData.find((d) => d.promotedStructuredId === structuredId) as
      | {
          acceptanceCriteria: string;
          promotedStructuredRunId: string;
          promotedSynthesisKeys: string;
        }
      | undefined;

  beforeEach(() => {
    db.structured = {
      requirements: [
        structuredReq("REQ-1", "Mark entries as read"),
        structuredReq("REQ-2", "Mark read entries"),
      ],
      runId: RUN,
    };
    db.synthesisOutput = JSON.stringify({ summary: "s", requirements: [X, Y] });
  });

  it("hands persistRequirements each row's structured id, run and synthesis items", async () => {
    db.approvals = [{ itemId: "REQ-1", status: "approved" }];

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    const input = persistRequirements.mock.calls[0]?.[0] as { promotedFrom?: unknown };
    expect(input.promotedFrom).toEqual({
      runId: RUN,
      pairings: [{ structuredId: "REQ-1", synthesisKeys: [synthesisItemKey(X)] }],
    });
  });

  it("records no pairing for a set that never went through the checkpoint", async () => {
    db.structured = null;

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    const input = persistRequirements.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).not.toHaveProperty("promotedFrom");
  });

  it("an append joins the earlier row on its pairing, so the new neighbour gets its own item", async () => {
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "approved" },
    ];
    db.requirementCount = 1;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1"], promotedStructuredRunId: RUN }),
    };
    db.pairingRows = [
      {
        promotedStructuredId: "REQ-1",
        promotedStructuredRunId: RUN,
        promotedSynthesisKeys: JSON.stringify([synthesisItemKey(X)]),
      },
    ];

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(outcome).toEqual({ status: "promoted", requirementCount: 1 });
    const row = createdFor("REQ-2");
    expect(JSON.parse(row!.acceptanceCriteria)).toEqual(["Y: the selection is marked."]);
    // The appended row records its own pairing in the same insert.
    expect(row!.promotedStructuredRunId).toBe(RUN);
    expect(JSON.parse(row!.promotedSynthesisKeys)).toEqual([synthesisItemKey(Y)]);
  });

  it("an append onto rows promoted before #1202 keeps the title join (REQ-2 refused)", async () => {
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "approved" },
    ];
    db.requirementCount = 1;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1"], promotedStructuredRunId: RUN }),
    };
    db.pairingRows = [
      { promotedStructuredId: null, promotedStructuredRunId: null, promotedSynthesisKeys: null },
    ];

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    const row = createdFor("REQ-2");
    expect(JSON.parse(row!.acceptanceCriteria)).toEqual([]);
    expect(JSON.parse(row!.promotedSynthesisKeys)).toEqual([]);
  });

  // #1202 review — the append's #1204 notice drops the items the EARLIER rows
  // hold. Those are the items the rows recorded, not the ones a title replay
  // would give them: REQ-1's row took Z, but by title alone REQ-1 is the exact
  // title of X. Replayed without the pairing, X would be counted as REQ-1's and
  // hidden from REQ-2's notice although no row holds it.
  it("an append's refusal notice lists every item no earlier row recorded taking", async () => {
    const Z = item("Session cleanup", "Remove stale entries.", "Z criterion");
    const P = item("Flush sessions", "Flush sessions.", "P criterion");
    const Q = item("Flush sessions reset", "Flush sessions reset.", "Q criterion");
    db.structured = {
      requirements: [
        structuredReq("REQ-1", "Flush sessions"),
        structuredReq("REQ-2", "Flush user sessions"),
      ],
      runId: RUN,
    };
    db.synthesisOutput = JSON.stringify({ summary: "s", requirements: [Z, P, Q] });
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "approved" },
    ];
    db.requirementCount = 1;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1"], promotedStructuredRunId: RUN }),
    };
    db.pairingRows = [
      {
        promotedStructuredId: "REQ-1",
        promotedStructuredRunId: RUN,
        promotedSynthesisKeys: JSON.stringify([synthesisItemKey(Z)]),
      },
    ];

    expect(await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true })).toEqual({
      status: "promoted",
      requirementCount: 1,
    });

    const record = (
      JSON.parse(db.analysis?.metadata ?? "{}") as {
        promotionMatching?: { ambiguous?: Array<{ structuredId: string; candidates: unknown }> };
      }
    ).promotionMatching;
    expect(record?.ambiguous).toEqual([
      {
        requirementId: "rq_new_1",
        structuredId: "REQ-2",
        candidates: [
          { title: P.title, acceptanceCriteria: P.acceptanceCriteria },
          { title: Q.title, acceptanceCriteria: Q.acceptanceCriteria },
        ],
      },
    ]);
  });

  it("ignores a pairing whose items are no longer in the synthesis output (synthesis re-ran)", async () => {
    db.approvals = [
      { itemId: "REQ-1", status: "approved" },
      { itemId: "REQ-2", status: "approved" },
    ];
    db.requirementCount = 1;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1"], promotedStructuredRunId: RUN }),
    };
    db.pairingRows = [
      {
        promotedStructuredId: "REQ-1",
        promotedStructuredRunId: RUN,
        promotedSynthesisKeys: JSON.stringify(["an-item-this-output-does-not-have"]),
      },
    ];

    await promoteApprovedRequirements(ANALYSIS_ID, { asApproved: true });

    expect(JSON.parse(createdFor("REQ-2")!.acceptanceCriteria)).toEqual([]);
  });
});
