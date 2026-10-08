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
};
const createRow = async (_args: { data: { title: string } }) => {
  committed.creates += 1;
  if (committed.failCreateAt && committed.creates === committed.failCreateAt) {
    throw new Error("connection reset");
  }
  return { id: `rq_new_${committed.creates}` };
};
let txChain: Promise<unknown> = Promise.resolve();
/** The tx client handed to the most recent `$transaction` callback. */
let lastTx: { analysis: { update: ReturnType<typeof vi.fn> } } | null = null;

vi.mock("../prisma.js", () => {
  const requirementFindFirst = vi.fn(async () => ({ createdAt: db.firstPromotedAt }));
  const client = {
    analysis: { findFirst: vi.fn(async () => db.analysis) },
    agentResult: {
      findFirst: vi.fn(async () => (db.synthesisOutput ? { output: db.synthesisOutput } : null)),
    },
    requirement: {
      count: vi.fn(async () => db.requirementCount),
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
  db.firstPromotedAt = new Date("2026-01-01T00:00:00Z");
  db.withhold = false;
  findings.length = 0;
  committed.rows = [];
  committed.failCreateAt = 0;
  committed.creates = 0;
  txChain = Promise.resolve();
  lastTx = null;
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

  it("#909 — keeps the reviewed requirement type as a label instead of dropping it", async () => {
    (db.structured!.requirements[1] as { type: string }).type = "non-functional";

    await promoteApprovedRequirements(ANALYSIS_ID);

    const reqs = persistedRequirements() as unknown as Array<{ labels: string[] }>;
    // Ahead of the matched synthesized requirement's own labels.
    expect(reqs[0]?.labels).toEqual(["functional", "database"]);
    expect(reqs[1]?.labels).toEqual(["non-functional"]);
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
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

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

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome).toEqual({ status: "promoted", requirementCount: 1 });
    expect(persistRequirements).not.toHaveBeenCalled();
    expect(created()).toEqual(["Reading speed validation"]);
    expect(applyClarificationsToRequirements).toHaveBeenCalledWith(ANALYSIS_ID);
    expect(recordedIds()).toEqual(["REQ-1", "REQ-3", "REQ-2"]);
    // The record rides the rows' transaction, not a separate metadata write.
    expect(persistAnalysisEnhancement).not.toHaveBeenCalled();
  });

  it("takes #882's requirement-set lock on its own transaction before reading the record", async () => {
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-3"] }),
    };
    db.approvals[1] = { itemId: "REQ-2", status: "approved" };

    await promoteApprovedRequirements(ANALYSIS_ID);

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

    await expect(promoteApprovedRequirements(ANALYSIS_ID)).rejects.toThrow("connection reset");

    expect(created()).toEqual([]);
    expect(db.analysis.metadata).toBe(metadata);

    // The retry then appends each requirement exactly once.
    committed.failCreateAt = 0;
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);
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
      promoteApprovedRequirements(ANALYSIS_ID),
      promoteApprovedRequirements(ANALYSIS_ID),
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

    await promoteApprovedRequirements(ANALYSIS_ID);

    expect(created()).toEqual(["Reading speed validation"]);
    expect(recordedIds()).toEqual(["REQ-1", "REQ-2", "REQ-3"]);
  });

  it("is still a no-op when every approved requirement is already promoted", async () => {
    db.requirementCount = 2;
    db.analysis = {
      projectId: PROJECT_ID,
      metadata: JSON.stringify({ promotedStructuredIds: ["REQ-1", "REQ-3"] }),
    };

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

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
    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

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

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome.status).toBe("unavailable");
    expect(outcome).toMatchObject({ reason: expect.stringContaining("withheld") });
    expect(persistAnalysisEnhancement).not.toHaveBeenCalled();
    expect(recorded().promotedStructuredRunId).toBe("run-1");
  });

  it("still appends a reopened approval within the SAME run", async () => {
    db.structured!.runId = "run-1";

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

    expect(outcome).toEqual({ status: "promoted", requirementCount: 1 });
    expect(persistRequirements).not.toHaveBeenCalled();
    expect(committed.rows).toEqual(["Schedule feed refresh per category"]);
    expect(recorded()).toEqual({
      promotedStructuredIds: ["REQ-1", "REQ-2", "REQ-3"],
      promotedStructuredRunId: "run-1",
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

    const outcome = await promoteApprovedRequirements(ANALYSIS_ID);

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

    await promoteApprovedRequirements(ANALYSIS_ID);

    const input = persistRequirements.mock.calls[0]?.[0] as {
      synthesis: { requirements: Array<{ title: string }> };
    };
    expect(input.synthesis.requirements.map((r) => r.title)).toEqual([
      "Export subscriptions as OPML",
      "Schedule feed refresh per category",
    ]);
  });
});
