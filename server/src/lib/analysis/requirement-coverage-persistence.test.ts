/**
 * Epic #726 (#736) — coverage persistence + API round-trip.
 *
 * Exercises the REAL `computeCoverageForRequirements` → `persistRequirements`
 * (writes the `coverage` column) → `getAnalysisSnapshot`/`toSnapshot` (returns
 * it) path against the repo's in-memory Prisma fake. Nothing under test is
 * stubbed — this proves the deterministic enum is persisted per requirement AND
 * surfaced on the GET snapshot, and that a re-run recomputes it (delete+recreate).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Citation, CodeCitation, DocumentCitation, SynthesisOutput } from "@metis/shared";

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
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const store = {
  requirements: [] as ReqRow[],
  seq: 0,
};

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
    crossDocFinding: {
      findMany: vi.fn(async () => []),
    },
  },
}));

const codeCitation: CodeCitation = { filePath: "src/api/auth.ts", startLine: 5, endLine: 40 };
const docCitation: DocumentCitation = { documentId: "doc_1", chunkIndex: 0 };

// Merged flat-finding list the synthesis model saw (index-aligned):
//   0 — code-cited, 1 — doc-only, 2 — placeholder (no citations).
const flatFindings = [
  { citations: [codeCitation] as Citation[] },
  { citations: [docCitation] as Citation[] },
  { citations: [] as Citation[] },
];
const findingIdsByIndex = ["f0", "f1", "f2"];

function synthesis(): SynthesisOutput {
  return {
    summary: "s",
    requirements: [
      {
        type: "feature",
        title: "Code-grounded",
        body: "b",
        priority: "high",
        labels: [],
        evidenceFindingIndexes: [0],
      },
      {
        type: "feature",
        title: "Docs-only",
        body: "b",
        priority: "medium",
        labels: [],
        evidenceFindingIndexes: [1],
      },
      {
        type: "feature",
        title: "Ungrounded",
        body: "b",
        priority: "low",
        labels: [],
        evidenceFindingIndexes: [2],
      },
    ],
  };
}

describe("coverage persistence + API round-trip (#736)", () => {
  beforeEach(() => {
    store.requirements = [];
    store.seq = 0;
  });

  it("persists the computed coverage per requirement and returns it on the snapshot", async () => {
    const { persistRequirements, getAnalysisSnapshot } = await import("./analysis-service.js");
    const { computeCoverageForRequirements } = await import("./requirement-coverage.js");

    const out = synthesis();
    const coverages = computeCoverageForRequirements(out.requirements, flatFindings);
    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: out,
      findingIdsByIndex,
      coverages,
    });

    // Persisted to the column.
    expect(store.requirements.map((r) => r.coverage)).toEqual([
      "grounded_in_code",
      "grounded_in_docs_only",
      "no_evidence",
    ]);

    // Returned on the GET snapshot (real toSnapshot mapping).
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    expect(snapshot?.requirements.map((r) => ({ title: r.title, coverage: r.coverage }))).toEqual([
      { title: "Code-grounded", coverage: "grounded_in_code" },
      { title: "Docs-only", coverage: "grounded_in_docs_only" },
      { title: "Ungrounded", coverage: "no_evidence" },
    ]);
  });

  it("recomputes coverage on a re-run (delete+recreate)", async () => {
    const { persistRequirements, getAnalysisSnapshot } = await import("./analysis-service.js");
    const { computeCoverageForRequirements } = await import("./requirement-coverage.js");

    const out = synthesis();
    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: out,
      findingIdsByIndex,
      coverages: computeCoverageForRequirements(out.requirements, flatFindings),
    });

    // Second run: the first requirement's evidence now resolves to doc-only
    // (e.g. the code citation was dropped as ungrounded on the rerun).
    const rerunFindings = [
      { citations: [docCitation] as Citation[] },
      { citations: [docCitation] as Citation[] },
      { citations: [] as Citation[] },
    ];
    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: out,
      findingIdsByIndex,
      coverages: computeCoverageForRequirements(out.requirements, rerunFindings),
    });

    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    expect(snapshot?.requirements).toHaveLength(3);
    expect(snapshot?.requirements[0].coverage).toBe("grounded_in_docs_only");
  });

  it("persists null coverage when the caller supplies none (legacy path)", async () => {
    const { persistRequirements, getAnalysisSnapshot } = await import("./analysis-service.js");
    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: synthesis(),
      findingIdsByIndex,
      // no coverages
    });
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    expect(snapshot?.requirements.every((r) => r.coverage === null)).toBe(true);
  });
});
