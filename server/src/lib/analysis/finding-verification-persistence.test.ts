/**
 * Epic #727 (#740) — verification persistence + read-back round-trip.
 *
 * Exercises the REAL `persistAgentResult` (writes the `verificationStatus`
 * column) → `readFlattenedFindings` (the shape synthesis consumes) AND
 * `getAnalysisSnapshot`/`toSnapshot` (the shape the GET API + UI consume) path
 * against the repo's in-memory Prisma fake. Nothing under test is stubbed — this
 * proves the verifier verdict is persisted per finding, survives the DB
 * round-trip into synthesis, and is surfaced on the analysis GET snapshot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutput, CodeCitation } from "@metis/shared";

interface AgentResultRow {
  id: string;
  analysisId: string;
  agentKey: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  output: string | null;
  errorMessage: string | null;
}
interface FindingRow {
  id: string;
  agentResultId: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  evidence: string | null;
  derivation: string;
  confidence: number;
  symbolId: string | null;
  scanFindingId: string | null;
  verificationStatus: string | null;
  createdAt: Date;
  agentResultId_rel?: AgentResultRow;
}

const store = {
  agentResults: [] as AgentResultRow[],
  findings: [] as FindingRow[],
  seq: 0,
};

const ANALYSIS_ID = "an_1";
const PROJECT_ID = "pr_1";

function findingsFor(agentResultId: string): FindingRow[] {
  return store.findings.filter((f) => f.agentResultId === agentResultId);
}

vi.mock("../prisma.js", () => ({
  prisma: {
    agentResult: {
      findFirst: vi.fn(async ({ where }: { where: { analysisId: string; agentKey: string } }) => {
        return (
          store.agentResults.find(
            (a) => a.analysisId === where.analysisId && a.agentKey === where.agentKey,
          ) ?? null
        );
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        store.agentResults = store.agentResults.filter((a) => a.id !== where.id);
        store.findings = store.findings.filter((f) => f.agentResultId !== where.id);
        return { id: where.id };
      }),
      create: vi.fn(async ({ data }: { data: Partial<AgentResultRow> }) => {
        const row: AgentResultRow = {
          id: `ar_${++store.seq}`,
          analysisId: data.analysisId!,
          agentKey: data.agentKey!,
          status: data.status ?? "completed",
          startedAt: data.startedAt ?? new Date(),
          completedAt: data.completedAt ?? null,
          output: data.output ?? null,
          errorMessage: data.errorMessage ?? null,
        };
        store.agentResults.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({ where }: { where: { analysisId: string; agentKey?: { in: string[] } } }) => {
          return store.agentResults
            .filter(
              (a) =>
                a.analysisId === where.analysisId &&
                (!where.agentKey || where.agentKey.in.includes(a.agentKey)),
            )
            .map((a) => ({ ...a, findings: findingsFor(a.id) }));
        },
      ),
    },
    finding: {
      create: vi.fn(async ({ data }: { data: Partial<FindingRow> }) => {
        const row: FindingRow = {
          id: `f_${++store.seq}`,
          agentResultId: data.agentResultId!,
          category: data.category ?? "other",
          severity: data.severity ?? "info",
          title: data.title ?? "",
          body: data.body ?? "",
          evidence: data.evidence ?? null,
          derivation: data.derivation ?? "inferred",
          confidence: data.confidence ?? 0.7,
          symbolId: data.symbolId ?? null,
          scanFindingId: data.scanFindingId ?? null,
          verificationStatus: data.verificationStatus ?? null,
          createdAt: new Date(),
        };
        store.findings.push(row);
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
          agentResults: store.agentResults
            .filter((a) => a.analysisId === ANALYSIS_ID)
            .map((a) => ({ ...a, findings: findingsFor(a.id) })),
          requirements: [],
        };
      }),
    },
    crossDocFinding: {
      findMany: vi.fn(async () => []),
    },
  },
}));

const codeCitation: CodeCitation = { filePath: "src/api/auth.ts", startLine: 5, endLine: 40 };

function codeAgentOutput(): AgentOutput {
  return {
    agentKey: "code",
    summary: "code agent output",
    notes: [],
    findings: [
      {
        category: "security",
        severity: "high",
        title: "Confirmed gap",
        body: "grounded against real code",
        citations: [codeCitation],
        tags: [],
        verificationStatus: "confirmed",
      },
      {
        category: "security",
        severity: "high",
        title: "Unverified gap",
        body: "claimed a file that was never retrieved",
        citations: [],
        tags: [],
        verificationStatus: "unverified",
      },
      {
        category: "other",
        severity: "info",
        title: "Neutral observation",
        body: "no code claim",
        citations: [],
        tags: [],
        // no verificationStatus → persists as null
      },
    ],
  };
}

describe("verification persistence round-trip (#740)", () => {
  beforeEach(() => {
    store.agentResults = [];
    store.findings = [];
    store.seq = 0;
  });

  it("persists verificationStatus per finding and returns it via readFlattenedFindings", async () => {
    const { persistAgentResult, readFlattenedFindings } = await import("./analysis-service.js");
    await persistAgentResult({
      analysisId: ANALYSIS_ID,
      agentKey: "code",
      status: "completed",
      output: codeAgentOutput(),
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    // Persisted to the column.
    expect(store.findings.map((f) => f.verificationStatus)).toEqual([
      "confirmed",
      "unverified",
      null,
    ]);

    // Flattened for synthesis carries the verdict.
    const flat = await readFlattenedFindings(ANALYSIS_ID);
    expect(flat.map((f) => ({ title: f.title, status: f.verificationStatus }))).toEqual([
      { title: "Confirmed gap", status: "confirmed" },
      { title: "Unverified gap", status: "unverified" },
      { title: "Neutral observation", status: null },
    ]);
  });

  it("surfaces verificationStatus on the analysis GET snapshot", async () => {
    const { persistAgentResult, getAnalysisSnapshot } = await import("./analysis-service.js");
    await persistAgentResult({
      analysisId: ANALYSIS_ID,
      agentKey: "code",
      status: "completed",
      output: codeAgentOutput(),
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    const findings = snapshot?.agents.find((a) => a.agentKey === "code")?.findings ?? [];
    expect(findings.map((f) => ({ title: f.title, status: f.verificationStatus }))).toEqual([
      { title: "Confirmed gap", status: "confirmed" },
      { title: "Unverified gap", status: "unverified" },
      { title: "Neutral observation", status: null },
    ]);
  });

  it("coerces an unknown legacy column value to null (graceful)", async () => {
    const { readFlattenedFindings } = await import("./analysis-service.js");
    store.agentResults.push({
      id: "ar_legacy",
      analysisId: ANALYSIS_ID,
      agentKey: "code",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      output: null,
      errorMessage: null,
    });
    store.findings.push({
      id: "f_legacy",
      agentResultId: "ar_legacy",
      category: "other",
      severity: "info",
      title: "Legacy",
      body: "b",
      evidence: JSON.stringify({ citations: [], tags: [] }),
      derivation: "inferred",
      confidence: 0.7,
      symbolId: null,
      scanFindingId: null,
      verificationStatus: "bogus-legacy-value",
      createdAt: new Date(),
    });
    const flat = await readFlattenedFindings(ANALYSIS_ID);
    expect(flat[0]?.verificationStatus).toBeNull();
  });
});
