/**
 * Issue #741 (Epic #727) — persistence seams the multi-repo resume relies on.
 *
 * Exercises the REAL analysis-service functions against an in-memory Prisma fake
 * (nothing under test is stubbed):
 *   - `persistAgentResult` in `mode: "append"` MERGES a resumed connector's
 *     `code` findings alongside the original run's, so `readFlattenedFindings`
 *     (what synthesis re-reads) returns BOTH — proving the resume never clobbers
 *     the original findings the way the default `"replace"` mode would.
 *   - `getAnalysisCapability` round-trips the persisted `skippedRepos` +
 *     `repos-skipped-budget` reason, and clearing them (post-resume) removes the
 *     reason — the observable state the banner reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOutput } from "@metis/shared";
import { deriveCapabilityReasons, type AnalysisCapability } from "@metis/shared";

interface AgentResultRow {
  id: string;
  analysisId: string;
  agentKey: string;
  // Issue #763 — the RepoConnection a multi-repo `code` result was produced for.
  connectorId: string | null;
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
}

const store = {
  agentResults: [] as AgentResultRow[],
  findings: [] as FindingRow[],
  metadata: null as string | null,
  seq: 0,
};

const ANALYSIS_ID = "an_1";

function findingsFor(agentResultId: string): FindingRow[] {
  return store.findings.filter((f) => f.agentResultId === agentResultId);
}

vi.mock("../prisma.js", () => ({
  prisma: {
    agentResult: {
      findFirst: vi.fn(
        // Issue #763 — connector-scoped when the caller passes `connectorId`
        // (multi-repo replace), else whole-agentKey (legacy / append callers).
        async ({
          where,
        }: {
          where: { analysisId: string; agentKey: string; connectorId?: string };
        }) => {
          return (
            store.agentResults.find(
              (a) =>
                a.analysisId === where.analysisId &&
                a.agentKey === where.agentKey &&
                (where.connectorId === undefined || a.connectorId === where.connectorId),
            ) ?? null
          );
        },
      ),
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
          connectorId: data.connectorId ?? null,
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
        return { id: ANALYSIS_ID, metadata: store.metadata };
      }),
      update: vi.fn(async ({ data }: { data: { metadata?: string } }) => {
        if (data.metadata !== undefined) store.metadata = data.metadata;
        return { id: ANALYSIS_ID };
      }),
    },
  },
}));

const {
  persistAgentResult,
  readFlattenedFindings,
  getAnalysisCapability,
  persistAnalysisCapability,
} = await import("./analysis-service.js");

function codeOutput(title: string): AgentOutput {
  return {
    agentKey: "code",
    summary: `code output for ${title}`,
    notes: [],
    findings: [
      {
        category: "security",
        severity: "high",
        title,
        body: `finding from ${title}`,
        citations: [],
        tags: [],
      },
    ],
  };
}

function capability(skipped: AnalysisCapability["skippedRepos"]): AnalysisCapability {
  const base = {
    codeAnalysisRequested: true,
    databaseAnalysisRequested: false,
    codeGraphPresent: true,
    agentMode: "agentic" as const,
    repoSourceIngested: true,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
    quarantineFallbackUsed: false,
    skippedRepos: skipped,
  };
  return { ...base, reasons: deriveCapabilityReasons(base) };
}

describe("resume persistence seams (#741)", () => {
  beforeEach(() => {
    store.agentResults = [];
    store.findings = [];
    store.metadata = null;
    store.seq = 0;
  });

  it("append mode MERGES resumed code findings instead of clobbering the original run", async () => {
    // Original multi-repo run persisted repo A's code findings (default replace).
    await persistAgentResult({
      analysisId: ANALYSIS_ID,
      agentKey: "code",
      status: "completed",
      output: codeOutput("repo-A gap"),
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    // Resume analyzes the previously-skipped repo B in APPEND mode.
    await persistAgentResult({
      analysisId: ANALYSIS_ID,
      agentKey: "code",
      status: "completed",
      output: codeOutput("repo-B gap"),
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      mode: "append",
    });

    // Both repos' findings survive for synthesis to re-read.
    const flat = await readFlattenedFindings(ANALYSIS_ID);
    const titles = flat.map((f) => f.title).sort();
    expect(titles).toEqual(["repo-A gap", "repo-B gap"]);
    expect(store.agentResults.filter((a) => a.agentKey === "code")).toHaveLength(2);
  });

  it("#763 connector-scoped replace and #741 resume-append coexist without clobber or double-count", async () => {
    const persistCode = (title: string, connectorId: string, mode?: "replace" | "append") =>
      persistAgentResult({
        analysisId: ANALYSIS_ID,
        agentKey: "code",
        status: "completed",
        output: codeOutput(title),
        startedAt: new Date(),
        completedAt: new Date(),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        connectorId,
        mode,
      });

    // Original multi-repo run: two connectors, each default (replace) but scoped
    // by its own connectorId — neither clobbers the other.
    await persistCode("repo-A gap", "repo-A");
    await persistCode("repo-B gap", "repo-B");

    // #741 resume: a previously-skipped connector C merges via append.
    await persistCode("repo-C gap", "repo-C", "append");

    // A re-run of connector A (replace, same connectorId) updates ONLY A's row —
    // B and C are untouched, and A is not duplicated.
    await persistCode("repo-A gap v2", "repo-A");

    const flat = await readFlattenedFindings(ANALYSIS_ID);
    expect(flat.map((f) => f.title).sort()).toEqual(["repo-A gap v2", "repo-B gap", "repo-C gap"]);
    // Exactly one code row per connector — no orphan/duplicate accumulation.
    expect(store.agentResults.filter((a) => a.agentKey === "code")).toHaveLength(3);
  });

  it("default replace mode still clobbers the prior code row (regression guard)", async () => {
    await persistAgentResult({
      analysisId: ANALYSIS_ID,
      agentKey: "code",
      status: "completed",
      output: codeOutput("first"),
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await persistAgentResult({
      analysisId: ANALYSIS_ID,
      agentKey: "code",
      status: "completed",
      output: codeOutput("second"),
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const flat = await readFlattenedFindings(ANALYSIS_ID);
    expect(flat.map((f) => f.title)).toEqual(["second"]);
  });

  it("round-trips skippedRepos + repos-skipped-budget, and clearing removes the reason", async () => {
    await persistAnalysisCapability(
      ANALYSIS_ID,
      capability([{ connectorId: "c3", label: "worker" }]),
    );
    const read = await getAnalysisCapability(ANALYSIS_ID);
    expect(read?.skippedRepos).toEqual([{ connectorId: "c3", label: "worker" }]);
    expect(read?.reasons).toContain("repos-skipped-budget");

    // Post-resume: clear the skipped list — the reason disappears.
    await persistAnalysisCapability(ANALYSIS_ID, capability([]));
    const cleared = await getAnalysisCapability(ANALYSIS_ID);
    expect(cleared?.skippedRepos).toEqual([]);
    expect(cleared?.reasons).not.toContain("repos-skipped-budget");
  });

  it("returns null capability for an unknown analysis", async () => {
    expect(await getAnalysisCapability("does-not-exist")).toBeNull();
  });
});
