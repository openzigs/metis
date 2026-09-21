/**
 * Issue #1096 — acceptance-criteria persistence + API round-trip.
 *
 * Stage 1 of the reported data loss was that the synthesis output's per-criterion
 * structure never reached the database: `requirements.body` held prose only. This
 * exercises the REAL `persistRequirements` → `getAnalysisSnapshot` path against an
 * in-memory Prisma fake and asserts the criteria survive INTACT and PER
 * REQUIREMENT.
 *
 * The assertions are differential — two requirements with different criteria must
 * round-trip differently — so a regression that drops the column (returning `[]`
 * for everything) or that shares one list across rows fails here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SynthesisOutput } from "@metis/shared";

interface ReqRow {
  id: string;
  analysisId: string;
  projectId: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  labels: string;
  storyPoints: number | null;
  reviewStatus: string | null;
  coverage: string | null;
  verdict: string | null;
  acceptanceCriteria: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const store = { requirements: [] as ReqRow[], seq: 0 };

const ANALYSIS_ID = "an_1";
const PROJECT_ID = "pr_1";

vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: {
      deleteMany: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        const before = store.requirements.length;
        store.requirements = store.requirements.filter((r) => r.analysisId !== where.analysisId);
        return { count: before - store.requirements.length };
      }),
      create: vi.fn(async ({ data }: { data: Partial<ReqRow> }) => {
        const now = new Date();
        const row: ReqRow = {
          id: `req-${++store.seq}`,
          analysisId: data.analysisId!,
          projectId: data.projectId!,
          type: data.type ?? "feature",
          title: data.title ?? "",
          body: data.body ?? "",
          priority: data.priority ?? "medium",
          labels: data.labels ?? "[]",
          storyPoints: data.storyPoints ?? null,
          reviewStatus: data.reviewStatus ?? null,
          coverage: data.coverage ?? null,
          verdict: data.verdict ?? null,
          // The DB default — a regression that stops writing the column lands here.
          acceptanceCriteria: data.acceptanceCriteria ?? "[]",
          version: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        store.requirements.push(row);
        return row;
      }),
    },
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== ANALYSIS_ID) return null;
        return {
          id: ANALYSIS_ID,
          projectId: PROJECT_ID,
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          errorMessage: null,
          metadata: null,
          agentResults: [],
          requirements: store.requirements.filter((r) => r.analysisId === ANALYSIS_ID),
        };
      }),
    },
    crossDocFinding: { findMany: vi.fn(async () => []) },
  },
}));

const INVENTORY = [
  "Checkout validates available quantity for every line item inside the order-writing transaction.",
  "INVENTORY.QTY can never go below zero, enforced by a database CHECK constraint.",
];
const PCI = ["The ORDERS table retains only CARDTYPE and CARD_LAST_FOUR (CHAR(4))."];

function synthesis(): SynthesisOutput {
  return {
    summary: "s",
    requirements: [
      {
        type: "bug",
        title: "Enforce inventory availability at checkout",
        body: "Stock is decremented after the order is written.",
        priority: "critical",
        labels: [],
        evidenceFindingIndexes: [0],
        acceptanceCriteria: INVENTORY,
      },
      {
        type: "bug",
        title: "Eliminate cleartext payment card storage",
        body: "The ORDERS table persists full card numbers.",
        priority: "critical",
        labels: [],
        evidenceFindingIndexes: [1],
        acceptanceCriteria: PCI,
      },
      {
        type: "chore",
        title: "Requirement with no derivable criteria",
        body: "Vague ask with no evidence.",
        priority: "low",
        labels: [],
        evidenceFindingIndexes: [],
        acceptanceCriteria: [],
      },
    ],
  };
}

describe("acceptance-criteria persistence + round-trip (#1096)", () => {
  beforeEach(() => {
    store.requirements = [];
    store.seq = 0;
  });

  it("persists each requirement's own criteria and returns them on the snapshot", async () => {
    const { persistRequirements, getAnalysisSnapshot } = await import("./analysis-service.js");

    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: synthesis(),
      findingIdsByIndex: ["f0", "f1", "f2"],
    });

    // Written to the column, per requirement — not merged, not dropped.
    expect(JSON.parse(store.requirements[0].acceptanceCriteria)).toEqual(INVENTORY);
    expect(JSON.parse(store.requirements[1].acceptanceCriteria)).toEqual(PCI);
    expect(JSON.parse(store.requirements[2].acceptanceCriteria)).toEqual([]);

    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    const reqs = snapshot!.requirements;

    expect(reqs[0].acceptanceCriteria).toEqual(INVENTORY);
    expect(reqs[1].acceptanceCriteria).toEqual(PCI);
    expect(reqs[2].acceptanceCriteria).toEqual([]);

    // Substance: the criteria are not the same list for every requirement, and
    // they carry terms from their own requirement.
    expect(reqs[0].acceptanceCriteria).not.toEqual(reqs[1].acceptanceCriteria);
    expect(reqs[0].acceptanceCriteria.join(" ")).toContain("INVENTORY.QTY");
    expect(reqs[1].acceptanceCriteria.join(" ")).toContain("CARD_LAST_FOUR");
  });

  it("recomputes on a re-run (delete + recreate) rather than accumulating", async () => {
    const { persistRequirements } = await import("./analysis-service.js");

    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: synthesis(),
      findingIdsByIndex: ["f0", "f1", "f2"],
    });

    const rerun = synthesis();
    rerun.requirements = [
      { ...rerun.requirements[0], acceptanceCriteria: ["A single revised criterion."] },
    ];
    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: rerun,
      findingIdsByIndex: ["f0"],
    });

    expect(store.requirements).toHaveLength(1);
    expect(JSON.parse(store.requirements[0].acceptanceCriteria)).toEqual([
      "A single revised criterion.",
    ]);
  });
});
