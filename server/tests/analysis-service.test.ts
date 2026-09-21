/**
 * Tests for the persistence service: Analysis row creation, AgentResult +
 * Finding writes, requirement persistence, label round-trip, and snapshot
 * shape. Prisma is stubbed in-memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AnalysisRow {
  id: string;
  projectId: string;
  startedById: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorMessage: string | null;
  metadata: string | null;
  deletedAt: Date | null;
}
interface AgentResultRow {
  id: string;
  analysisId: string;
  agentKey: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  output: string | null;
  errorMessage: string | null;
  findings: FindingRow[];
}
interface FindingRow {
  id: string;
  agentResultId: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  evidence: string | null;
}
interface RequirementRow {
  id: string;
  analysisId: string;
  projectId: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  labels: string;
  reviewStatus: string | null;
  storyPoints: number | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
}

interface CrossDocRow {
  id: string;
  analysisId: string;
  kind: string;
  severity: string;
  title: string;
  detail: string;
  evidenceIds: string;
  scope: string | null;
  createdAt: Date;
}

const analyses = new Map<string, AnalysisRow>();
const agentResults = new Map<string, AgentResultRow>();
const requirements = new Map<string, RequirementRow>();
const crossDocFindings = new Map<string, CrossDocRow>();
const documents = new Map<string, { id: string; filename: string }>();
let id = 0;
const nid = (p: string) => `${p}_${++id}`;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    analysis: {
      create: vi.fn(async ({ data }: { data: Partial<AnalysisRow> }) => {
        const row: AnalysisRow = {
          id: nid("ana"),
          projectId: data.projectId!,
          startedById: data.startedById!,
          status: data.status ?? "running",
          startedAt: new Date(),
          completedAt: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          errorMessage: null,
          metadata: data.metadata ?? null,
          deletedAt: null,
        };
        analyses.set(row.id, row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = analyses.get(where.id) as unknown as Record<string, unknown>;
          if (!row) throw new Error("not found");
          // Honour Prisma's `{ increment: n }` so finalizeAnalysisDelta works.
          for (const [k, v] of Object.entries(data)) {
            if (
              v &&
              typeof v === "object" &&
              "increment" in (v as Record<string, unknown>) &&
              typeof (v as { increment: unknown }).increment === "number"
            ) {
              const cur = typeof row[k] === "number" ? (row[k] as number) : 0;
              row[k] = cur + (v as { increment: number }).increment;
            } else {
              row[k] = v;
            }
          }
          return row;
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; deletedAt?: null } }) => {
        const row = where.id ? analyses.get(where.id) : null;
        if (!row || row.deletedAt) return null;
        const ars = [...agentResults.values()]
          .filter((a) => a.analysisId === row.id)
          .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
        const reqs = [...requirements.values()]
          .filter((r) => r.analysisId === row.id && !r.deletedAt)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return { ...row, agentResults: ars, requirements: reqs };
      }),
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) =>
        [...analyses.values()]
          .filter((a) => a.projectId === where.projectId && !a.deletedAt)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()),
      ),
    },
    agentResult: {
      findFirst: vi.fn(
        async ({ where }: { where: { analysisId: string; agentKey: string } }) =>
          [...agentResults.values()].find(
            (a) => a.analysisId === where.analysisId && a.agentKey === where.agentKey,
          ) ?? null,
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        agentResults.delete(where.id);
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<AgentResultRow> }) => {
        const row: AgentResultRow = {
          id: nid("agr"),
          analysisId: data.analysisId!,
          agentKey: data.agentKey!,
          status: data.status ?? "completed",
          startedAt: data.startedAt ?? new Date(),
          completedAt: data.completedAt ?? null,
          output: data.output ?? null,
          errorMessage: data.errorMessage ?? null,
          findings: [],
        };
        agentResults.set(row.id, row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { analysisId: string } }) =>
        [...agentResults.values()]
          .filter((a) => a.analysisId === where.analysisId)
          .map((a) => ({ ...a })),
      ),
    },
    finding: {
      create: vi.fn(async ({ data }: { data: Partial<FindingRow> }) => {
        const row: FindingRow = {
          id: nid("fnd"),
          agentResultId: data.agentResultId!,
          category: data.category!,
          severity: data.severity!,
          title: data.title!,
          body: data.body!,
          evidence: data.evidence ?? null,
        };
        const ar = agentResults.get(row.agentResultId);
        if (ar) ar.findings.push(row);
        return row;
      }),
      // Issue #448 — batched evidence resolution reads findings by id across all
      // agent results. Mirrors `findMany({ where: { id: { in } }, select })`.
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const wanted = new Set(where.id.in);
        const out: Array<{ id: string; title: string; evidence: string | null }> = [];
        for (const ar of agentResults.values()) {
          for (const f of ar.findings) {
            if (wanted.has(f.id)) {
              out.push({ id: f.id, title: f.title, evidence: f.evidence });
            }
          }
        }
        return out;
      }),
    },
    requirement: {
      deleteMany: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        for (const [k, v] of requirements) {
          if (v.analysisId === where.analysisId) requirements.delete(k);
        }
        return { count: 0 };
      }),
      create: vi.fn(async ({ data }: { data: Partial<RequirementRow> }) => {
        const row: RequirementRow = {
          id: nid("req"),
          analysisId: data.analysisId!,
          projectId: data.projectId!,
          type: data.type ?? "feature",
          title: data.title!,
          body: data.body!,
          priority: data.priority ?? "medium",
          labels: data.labels ?? "[]",
          reviewStatus: data.reviewStatus ?? null,
          storyPoints: data.storyPoints ?? null,
          version: data.version ?? 1,
          deletedAt: null,
          createdAt: new Date(),
        };
        requirements.set(row.id, row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; analysisId?: string; deletedAt: null } }) => {
          const r = requirements.get(where.id);
          if (!r || r.deletedAt) return null;
          if (where.analysisId !== undefined && r.analysisId !== where.analysisId) return null;
          return r;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<RequirementRow> }) => {
          const r = requirements.get(where.id);
          if (!r) throw new Error("not found");
          Object.assign(r, data);
          return r;
        },
      ),
    },
    // Epic #203 (#221) — cross-doc findings. Backed by `crossDocFindings` so
    // Issue #448 read-time enrichment tests can seed rows; default empty so
    // getAnalysisSnapshot returns crossDocFindings=null in the pre-existing tests.
    crossDocFinding: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: { analysisId: string } }) => ({
        id: nid("cdf"),
        ...data,
        createdAt: new Date(),
      })),
      findMany: vi.fn(async ({ where }: { where: { analysisId: string } }) =>
        [...crossDocFindings.values()]
          .filter((r) => r.analysisId === where.analysisId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
    },
    // Issue #448 — documentId → filename resolution for citations that carry a
    // documentId but no inline filename.
    document: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .map((docId) => documents.get(docId))
          .filter((d): d is { id: string; filename: string } => d !== undefined),
      ),
    },
  },
}));

import {
  createAnalysis,
  finalizeAnalysisDelta,
  getAnalysisSnapshot,
  getStructuredRequirements,
  listAnalysesForProject,
  markAnalysisCancelled,
  markAnalysisCompleted,
  markAnalysisFailed,
  persistAgentResult,
  persistAnalysisEnhancement,
  persistAnalysisCapability,
  persistRequirements,
  readCrossDocFindings,
  readFlattenedFindings,
  toResolvedEvidenceRef,
  updateRequirementRow,
} from "../src/lib/analysis/analysis-service.js";

beforeEach(() => {
  analyses.clear();
  agentResults.clear();
  requirements.clear();
  crossDocFindings.clear();
  documents.clear();
  id = 0;
});

afterEach(() => vi.clearAllMocks());

describe("createAnalysis", () => {
  it("persists agentKeys and document subset in metadata", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document", "code"],
      documentIds: ["doc-1234567890"],
      model: "stub",
    });
    expect(a.status).toBe("running");
    const meta = JSON.parse(a.metadata!);
    expect(meta.agentKeys).toEqual(["document", "code"]);
    expect(meta.documentIds).toEqual(["doc-1234567890"]);
    expect(meta.model).toBe("stub");
  });
});

describe("persistAgentResult + readFlattenedFindings", () => {
  it("writes findings and reads them back flattened", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    await persistAgentResult({
      analysisId: a.id,
      agentKey: "document",
      status: "completed",
      output: {
        agentKey: "document",
        summary: "ok",
        findings: [
          {
            category: "compliance",
            severity: "high",
            title: "NERC CIP",
            body: "Audit logs must be retained 7y.",
            tags: ["compliance"],
            citations: [{ documentId: "doc-1234567890", chunkIndex: 0 }],
          },
        ],
        notes: [],
      },
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const flat = await readFlattenedFindings(a.id);
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({
      agentKey: "document",
      category: "compliance",
      tags: ["compliance"],
    });
  });

  it("regenerate replaces the prior AgentResult row", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    const first = await persistAgentResult({
      analysisId: a.id,
      agentKey: "document",
      status: "completed",
      output: { agentKey: "document", summary: "v1", findings: [], notes: [] },
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    const second = await persistAgentResult({
      analysisId: a.id,
      agentKey: "document",
      status: "completed",
      output: { agentKey: "document", summary: "v2", findings: [], notes: [] },
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    expect(second.id).not.toBe(first.id);
    expect(agentResults.size).toBe(1);
  });
});

describe("persistRequirements", () => {
  it("links requirements to findings via labels", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    const ar = await persistAgentResult({
      analysisId: a.id,
      agentKey: "document",
      status: "completed",
      output: {
        agentKey: "document",
        summary: "ok",
        findings: [
          {
            category: "other",
            severity: "low",
            title: "Tracked",
            body: "...",
            tags: ["x"],
            citations: [],
          },
        ],
        notes: [],
      },
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    expect(ar.findingIds).toHaveLength(1);
    const ids = await persistRequirements({
      analysisId: a.id,
      projectId: "proj-abcdefghij",
      synthesis: {
        summary: "s",
        requirements: [
          {
            type: "feature",
            title: "Build",
            body: "Body",
            priority: "high",
            labels: ["x"],
            evidenceFindingIndexes: [0],
          },
        ],
      },
      findingIdsByIndex: ar.findingIds,
    });
    expect(ids).toHaveLength(1);
    const stored = requirements.get(ids[0])!;
    const labels = JSON.parse(stored.labels) as string[];
    expect(labels).toContain(`finding:${ar.findingIds[0]}`);
  });
});

describe("snapshot + lifecycle", () => {
  it("rolls up totals and exposes cancelled status", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["code"],
    });
    await markAnalysisCompleted(a.id, {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    const snap = await getAnalysisSnapshot(a.id);
    expect(snap?.status).toBe("completed");
    expect(snap?.totalTokens).toBe(150);
    expect(snap?.metadata).toMatchObject({ agentKeys: ["code"] });

    await markAnalysisCancelled(a.id, {
      promptTokens: 200,
      completionTokens: 0,
      totalTokens: 200,
    });
    const snap2 = await getAnalysisSnapshot(a.id);
    expect(snap2?.status).toBe("cancelled");
    expect(snap2?.totalTokens).toBe(200);

    await markAnalysisFailed(a.id, "boom", {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    const snap3 = await getAnalysisSnapshot(a.id);
    expect(snap3?.status).toBe("failed");
    expect(snap3?.errorMessage).toBe("boom");
  });

  it("returns null for unknown analyses", async () => {
    expect(await getAnalysisSnapshot("missing-id-12345")).toBeNull();
  });
});

describe("listAnalysesForProject", () => {
  it("orders by startedAt desc", async () => {
    const a1 = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["code"],
    });
    const a2 = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["code"],
    });
    // Force ordering by stamping startedAt explicitly.
    analyses.get(a1.id)!.startedAt = new Date(2026, 3, 1);
    analyses.get(a2.id)!.startedAt = new Date(2026, 3, 24);
    const items = await listAnalysesForProject("proj-abcdefghij");
    expect(items[0].id).toBe(a2.id);
  });

  it("excludes background rows (code-graph-ingest + docs-gen-domain-research) but keeps real runs", async () => {
    const real = await createAnalysis({
      projectId: "proj-bg-filter",
      startedById: "user-1234567890",
      agentKeys: ["code"],
    });
    const ingest = await createAnalysis({
      projectId: "proj-bg-filter",
      startedById: "user-1234567890",
      agentKeys: [],
    });
    const domain = await createAnalysis({
      projectId: "proj-bg-filter",
      startedById: "user-1234567890",
      agentKeys: [],
    });
    // Tag the two synthetic/background rows the way their producers do.
    analyses.get(ingest.id)!.metadata = JSON.stringify({ source: "code-graph-ingest" });
    analyses.get(domain.id)!.metadata = JSON.stringify({ source: "docs-gen-domain-research" });

    const items = await listAnalysesForProject("proj-bg-filter");
    const ids = items.map((i) => i.id);
    expect(ids).toContain(real.id);
    expect(ids).not.toContain(ingest.id);
    expect(ids).not.toContain(domain.id);
  });
});

describe("updateRequirementRow", () => {
  it("preserves finding traceability when relabelling", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    const ar = await persistAgentResult({
      analysisId: a.id,
      agentKey: "document",
      status: "completed",
      output: {
        agentKey: "document",
        summary: "ok",
        findings: [
          { category: "other", severity: "low", title: "t", body: "b", tags: [], citations: [] },
        ],
        notes: [],
      },
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    const ids = await persistRequirements({
      analysisId: a.id,
      projectId: "proj-abcdefghij",
      synthesis: {
        summary: "s",
        requirements: [
          {
            type: "feature",
            title: "OAuth",
            body: "b",
            priority: "medium",
            labels: ["auth"],
            evidenceFindingIndexes: [0],
          },
        ],
      },
      findingIdsByIndex: ar.findingIds,
    });
    const updated = await updateRequirementRow({
      analysisId: a.id,
      requirementId: ids[0],
      patch: { labels: ["security"], reviewStatus: "approved" },
    });
    expect(updated).not.toBeNull();
    const labels = JSON.parse(updated!.labels) as string[];
    expect(labels).toContain("security");
    // Review status now lives on the typed column, not in the labels blob.
    expect((updated as unknown as { reviewStatus: string }).reviewStatus).toBe("approved");
    expect(labels.some((l) => l.startsWith("review:"))).toBe(false);
    expect(labels).toContain(`finding:${ar.findingIds[0]}`);
  });

  it("returns null when the requirement does not exist", async () => {
    const updated = await updateRequirementRow({
      analysisId: "ana_missing",
      requirementId: "missing-id-12345",
      patch: { reviewStatus: "rejected" },
    });
    expect(updated).toBeNull();
  });

  it("returns null when the requirement belongs to a different analysis (IDOR guard)", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    const other = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    const ids = await persistRequirements({
      analysisId: a.id,
      projectId: "proj-abcdefghij",
      synthesis: {
        summary: "s",
        requirements: [
          {
            type: "feature",
            title: "Cross-tenant target",
            body: "b",
            priority: "low",
            labels: [],
            evidenceFindingIndexes: [],
          },
        ],
      },
      findingIdsByIndex: [],
    });
    // Attacker tries to PATCH this requirement under the OTHER analysis id.
    const updated = await updateRequirementRow({
      analysisId: other.id,
      requirementId: ids[0],
      patch: { reviewStatus: "approved" },
    });
    expect(updated).toBeNull();
  });
});

describe("finalizeAnalysisDelta", () => {
  it("increments token columns atomically (no read/modify/write)", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    await markAnalysisCompleted(a.id, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    await finalizeAnalysisDelta({
      id: a.id,
      status: "completed",
      delta: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
    const after = analyses.get(a.id)!;
    expect(after.inputTokens).toBe(13);
    expect(after.outputTokens).toBe(7);
    expect(after.totalTokens).toBe(20);
    expect(after.status).toBe("completed");
  });

  it("records errorMessage and status=failed", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    await finalizeAnalysisDelta({
      id: a.id,
      status: "failed",
      delta: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      errorMessage: "regenerate exploded",
    });
    const after = analyses.get(a.id)!;
    expect(after.status).toBe("failed");
    expect(after.errorMessage).toBe("regenerate exploded");
  });
});

describe("getAnalysisSnapshot rendering", () => {
  it("renders agent results, findings (with citations + tags), and requirements", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    const ar = await persistAgentResult({
      analysisId: a.id,
      agentKey: "document",
      status: "completed",
      output: {
        agentKey: "document",
        summary: "specialist summary",
        findings: [
          {
            category: "compliance",
            severity: "high",
            title: "Audit retention",
            body: "must retain 7y",
            tags: ["compliance", "audit"],
            citations: [{ documentId: "doc-1234567890", chunkIndex: 1, snippet: "ev" }],
          },
        ],
        notes: ["A trailing note."],
      },
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await persistRequirements({
      analysisId: a.id,
      projectId: "proj-abcdefghij",
      synthesis: {
        summary: "s",
        requirements: [
          {
            type: "feature",
            title: "Wire audit log",
            body: "Add long-term storage",
            priority: "high",
            labels: ["audit"],
            evidenceFindingIndexes: [0],
          },
        ],
      },
      findingIdsByIndex: ar.findingIds,
    });
    await markAnalysisCompleted(a.id, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    const snap = await getAnalysisSnapshot(a.id);
    expect(snap).not.toBeNull();
    expect(snap!.agents).toHaveLength(1);
    const docAgent = snap!.agents[0];
    expect(docAgent.summary).toBe("specialist summary");
    expect(docAgent.notes).toEqual(["A trailing note."]);
    expect(docAgent.findings[0].tags).toEqual(["compliance", "audit"]);
    expect(docAgent.findings[0].citations[0].snippet).toBe("ev");
    expect(snap!.requirements).toHaveLength(1);
    expect(snap!.requirements[0].evidenceFindingIds).toEqual(ar.findingIds);
    // Default review status when neither column nor label present.
    expect(snap!.requirements[0].reviewStatus).toBe("draft");
    // Epic #34 (AC2/M2) — optimistic-lock version is surfaced on the snapshot so
    // the edit form can submit the rendered version.
    expect(snap!.requirements[0].version).toBe(1);
  });

  it("falls back to the legacy `review:*` label when the typed column is null (M4 backward-compat)", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    const ar = await persistAgentResult({
      analysisId: a.id,
      agentKey: "document",
      status: "completed",
      output: {
        agentKey: "document",
        summary: "ok",
        findings: [
          { category: "other", severity: "low", title: "t", body: "b", tags: [], citations: [] },
        ],
        notes: [],
      },
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    const ids = await persistRequirements({
      analysisId: a.id,
      projectId: "proj-abcdefghij",
      synthesis: {
        summary: "s",
        requirements: [
          {
            type: "feature",
            title: "Legacy",
            body: "b",
            priority: "low",
            labels: [],
            evidenceFindingIndexes: [0],
          },
        ],
      },
      findingIdsByIndex: ar.findingIds,
    });
    // Simulate a row written before the migration: only the legacy label,
    // no `reviewStatus` column value.
    const row = requirements.get(ids[0])!;
    row.labels = JSON.stringify(["audit", "review:approved", `finding:${ar.findingIds[0]}`]);
    row.reviewStatus = null;
    const snap = await getAnalysisSnapshot(a.id);
    expect(snap!.requirements[0].reviewStatus).toBe("approved");
    // The legacy label was stripped from the surfaced labels list.
    expect(snap!.requirements[0].labels).not.toContain("review:approved");
  });

  it("ignores unknown agent keys when assembling the snapshot", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    // Sneak a row with an unknown agentKey directly into the in-memory store.
    const fakeId = nid("agr");
    agentResults.set(fakeId, {
      id: fakeId,
      analysisId: a.id,
      agentKey: "rogue-agent",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      output: null,
      errorMessage: null,
      findings: [],
    });
    const snap = await getAnalysisSnapshot(a.id);
    expect(snap!.agents.every((x) => x.agentKey !== ("rogue-agent" as never))).toBe(true);
  });

  it("survives malformed agent output JSON, malformed metadata, and unknown reviewStatus values", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    const ar = await persistAgentResult({
      analysisId: a.id,
      agentKey: "document",
      status: "completed",
      output: {
        agentKey: "document",
        summary: "ok",
        findings: [
          { category: "other", severity: "low", title: "t", body: "b", tags: [], citations: [] },
        ],
        notes: [],
      },
      startedAt: new Date(),
      completedAt: new Date(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    // Force the agent output blob to be unparseable.
    const arRow = agentResults.get(ar.id)!;
    arRow.output = "{not-json";
    // Force the analysis metadata to be unparseable.
    const aRow = analyses.get(a.id)!;
    (aRow as unknown as { metadata: string }).metadata = "{also-bad";
    // Inject a requirement with an unknown reviewStatus column value to exercise
    // the "candidate not in REQUIREMENT_REVIEW_STATUSES → draft" branch.
    const reqId = nid("req");
    requirements.set(reqId, {
      id: reqId,
      analysisId: a.id,
      projectId: "proj-abcdefghij",
      type: "feature",
      title: "Bogus",
      body: "b",
      priority: "low",
      labels: JSON.stringify([]),
      storyPoints: null,
      reviewStatus: "totally-bogus-status",
      createdAt: new Date(),
      deletedAt: null,
    });
    const snap = await getAnalysisSnapshot(a.id);
    expect(snap).not.toBeNull();
    // Malformed agent JSON ⇒ summary null + empty notes (catch branch).
    expect(snap!.agents[0].summary).toBeNull();
    expect(snap!.agents[0].notes).toEqual([]);
    // Malformed metadata ⇒ metadata is null on the snapshot (catch branch).
    expect(snap!.metadata).toBeNull();
    // Unknown reviewStatus ⇒ falls back to "draft" (validation branch).
    const bogus = snap!.requirements.find((r) => r.id === reqId);
    expect(bogus?.reviewStatus).toBe("draft");
  });
});

describe("persistAnalysisEnhancement + getStructuredRequirements (Epic #922)", () => {
  it("merges enhancement keys into metadata without clobbering existing keys", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
      documentIds: ["doc-1234567890"],
      model: "stub",
    });

    await persistAnalysisEnhancement(a.id, {
      enhancement: { enableWebResearch: true, enableClarification: false },
    });
    await persistAnalysisEnhancement(a.id, {
      structuredRequirements: {
        requirements: [
          {
            id: "req-1",
            title: "Audit logging",
            description: "Retain audit logs",
            type: "feature",
            stakeholders: [],
            priority: "high",
            ambiguities: [],
            evidenceNeeds: [],
            rawSource: "raw",
          },
        ],
        totalAmbiguities: 2,
        totalEvidenceNeeds: 1,
      },
    });

    const meta = JSON.parse(analyses.get(a.id)!.metadata!);
    // Original createAnalysis keys survive the merge.
    expect(meta.agentKeys).toEqual(["document"]);
    expect(meta.model).toBe("stub");
    // Both enhancement patches are present.
    expect(meta.enhancement).toEqual({ enableWebResearch: true, enableClarification: false });
    expect(meta.structuredRequirements.totalAmbiguities).toBe(2);

    const structured = await getStructuredRequirements(a.id);
    expect(structured?.requirements).toHaveLength(1);
    expect(structured?.requirements[0].title).toBe("Audit logging");
  });

  it("persists webResearch digests", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    await persistAnalysisEnhancement(a.id, {
      webResearch: {
        digests: [
          {
            id: "dig-1",
            requirementId: "req-1",
            evidenceNeedId: "ev-1",
            query: "NERC CIP retention",
            sources: [],
            digest: "Logs must be retained 3 years.",
            needsHumanReview: true,
          },
        ],
        totalSources: 0,
        reviewRequired: 1,
      },
    });
    const meta = JSON.parse(analyses.get(a.id)!.metadata!);
    expect(meta.webResearch.digests).toHaveLength(1);
    expect(meta.webResearch.reviewRequired).toBe(1);
  });

  // Epic #202 (#216) — promotion-gating state persisted to analysis metadata.
  it("persists and overwrites the promotionBlocked marker", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    await persistAnalysisEnhancement(a.id, {
      promotionBlocked: { blocked: true, pendingCount: 2, rejectedCount: 1 },
    });
    let meta = JSON.parse(analyses.get(a.id)!.metadata!);
    expect(meta.promotionBlocked).toEqual({ blocked: true, pendingCount: 2, rejectedCount: 1 });

    // A later patch clears the marker once promotion succeeds.
    await persistAnalysisEnhancement(a.id, {
      promotionBlocked: { blocked: false, pendingCount: 0, rejectedCount: 0 },
    });
    meta = JSON.parse(analyses.get(a.id)!.metadata!);
    expect(meta.promotionBlocked.blocked).toBe(false);
  });

  it("returns null structured requirements when extraction never ran", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    expect(await getStructuredRequirements(a.id)).toBeNull();
  });
});

// ── Issue #733 — capability record persistence + snapshot surfacing ──────────
describe("persistAnalysisCapability + snapshot surfacing (#733)", () => {
  const capabilityFixture = {
    codeAnalysisRequested: true,
    databaseAnalysisRequested: false,
    codeGraphPresent: false,
    agentMode: "single-shot" as const,
    repoSourceIngested: false,
    fusedCodeRetrievalEnabled: false,
    schemaContextEnabled: false,
    quarantineFallbackUsed: false,
    skippedRepos: [],
    reasons: ["no-code-graph", "source-not-ingested"] as const,
  };

  it("merges the capability into metadata without clobbering existing keys", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
      model: "stub",
    });
    await persistAnalysisCapability(a.id, { ...capabilityFixture });
    const meta = JSON.parse(analyses.get(a.id)!.metadata!);
    // createAnalysis keys survive.
    expect(meta.agentKeys).toEqual(["document"]);
    expect(meta.model).toBe("stub");
    expect(meta.capability.reasons).toEqual(["no-code-graph", "source-not-ingested"]);
  });

  it("surfaces the persisted capability as a typed snapshot field", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    await persistAnalysisCapability(a.id, { ...capabilityFixture });
    const snap = await getAnalysisSnapshot(a.id);
    expect(snap?.capability?.agentMode).toBe("single-shot");
    expect(snap?.capability?.reasons).toContain("no-code-graph");
  });

  it("returns capability=null on runs with no persisted record", async () => {
    const a = await createAnalysis({
      projectId: "proj-abcdefghij",
      startedById: "user-1234567890",
      agentKeys: ["document"],
    });
    const snap = await getAnalysisSnapshot(a.id);
    expect(snap?.capability).toBeNull();
  });
});

// ── Issue #448 (epic #407) — read-time evidence enrichment ───────────────────

/** Seed a `Finding` row (with evidence JSON) reachable by the batched query. */
function seedFinding(idValue: string, evidence: string | null, title = "Finding") {
  const arId = nid("agr");
  agentResults.set(arId, {
    id: arId,
    analysisId: "ana-x",
    agentKey: "document",
    status: "completed",
    startedAt: new Date(),
    completedAt: new Date(),
    output: null,
    errorMessage: null,
    findings: [
      {
        id: idValue,
        agentResultId: arId,
        category: "compliance",
        severity: "high",
        title,
        body: "secret body must not leak",
        evidence,
      },
    ],
  });
}

/** Seed a persisted `CrossDocFinding` row referencing the given evidence ids. */
function seedCrossDoc(analysisId: string, evidenceIds: string[], createdAtMs: number) {
  const cid = nid("cdf");
  crossDocFindings.set(cid, {
    id: cid,
    analysisId,
    kind: "contradiction",
    severity: "high",
    title: "Conflict",
    detail: "x",
    evidenceIds: JSON.stringify(evidenceIds),
    scope: "pairwise",
    createdAt: new Date(createdAtMs),
  });
}

/** Seed a `Document` row so `documentId → filename` resolution can find it. */
function seedDocument(docId: string, filename: string) {
  documents.set(docId, { id: docId, filename });
}

describe("toResolvedEvidenceRef (#448) — pure mapper", () => {
  it("AC1 builds a readable ref from a citation with filename + chunkIndex", () => {
    const ref = toResolvedEvidenceRef("fnd-1", {
      documentId: "doc-1234567890",
      chunkIndex: 7,
      filename: "requirements.md",
    });
    expect(ref).toEqual({
      chunkId: "fnd-1",
      sourceLabel: "requirements.md",
      sourceId: "doc-1234567890",
      line: 7,
    });
  });

  it("AC1 surfaces line 0 (a real first-chunk position)", () => {
    const ref = toResolvedEvidenceRef("fnd-1", {
      documentId: "doc-1234567890",
      chunkIndex: 0,
      filename: "spec.pdf",
    });
    expect(ref?.line).toBe(0);
  });

  it("#448 resolves documentId → the Document's filename when the citation has no inline filename", () => {
    const docNameById = new Map([["doc-1234567890", "D100 - UC101 Regional Hubs.docx"]]);
    const ref = toResolvedEvidenceRef(
      "fnd-1",
      { documentId: "doc-1234567890", chunkIndex: 2 },
      docNameById,
    );
    // The resolved document NAME is the label — NOT the raw documentId cuid.
    expect(ref?.sourceLabel).toBe("D100 - UC101 Regional Hubs.docx");
    expect(ref?.sourceId).toBe("doc-1234567890");
    expect(ref?.line).toBe(2);
  });

  it("#448 omits the ref (no raw-cuid label) when neither filename nor a resolved doc name exists", () => {
    // No inline filename and the document name is unresolvable → omit so the
    // client degrades to the raw id, rather than printing a documentId cuid.
    expect(
      toResolvedEvidenceRef("fnd-1", { documentId: "doc-1234567890", chunkIndex: 2 }),
    ).toBeUndefined();
    expect(
      toResolvedEvidenceRef("fnd-1", { documentId: "doc-1234567890", chunkIndex: 2 }, new Map()),
    ).toBeUndefined();
  });

  it("AC2 returns undefined when there is no citation (unresolvable)", () => {
    expect(toResolvedEvidenceRef("fnd-1", undefined)).toBeUndefined();
  });

  it("OWASP — never surfaces a snippet/body even if present on the citation", () => {
    const ref = toResolvedEvidenceRef("fnd-1", {
      documentId: "doc-1234567890",
      chunkIndex: 1,
      filename: "spec.pdf",
      // @ts-expect-error — snippet is on Citation but deliberately not read here.
      snippet: "leaked-secret-snippet",
    });
    expect(JSON.stringify(ref)).not.toContain("leaked-secret-snippet");
  });
});

describe("readCrossDocFindings (#448) — batched enrichment", () => {
  it("AC5 resolves multiple ids across findings in ONE batched query (no N+1)", async () => {
    seedFinding(
      "fnd-a",
      JSON.stringify({ citations: [{ documentId: "doc-a", chunkIndex: 3, filename: "a.md" }] }),
    );
    seedFinding(
      "fnd-b",
      JSON.stringify({ citations: [{ documentId: "doc-b", chunkIndex: 0, filename: "b.md" }] }),
    );
    // Two cross-doc rows referencing the two findings → one finding.findMany call.
    seedCrossDoc("ana-1", ["fnd-a"], 1000);
    seedCrossDoc("ana-1", ["fnd-b"], 2000);

    const { prisma } = await import("../src/lib/prisma.js");
    const findManyMock = prisma.finding.findMany as unknown as { mock: { calls: unknown[][] } };
    findManyMock.mock.calls.length = 0;

    const bundle = await readCrossDocFindings("ana-1");
    expect(bundle).not.toBeNull();
    expect(bundle!.findings).toHaveLength(2);
    // Exactly one batched query — not one per finding/evidence id.
    expect(findManyMock.mock.calls).toHaveLength(1);

    const evA = bundle!.findings.find((f) => f.evidenceIds[0] === "fnd-a")!;
    expect(evA.evidence).toEqual([
      { chunkId: "fnd-a", sourceLabel: "a.md", sourceId: "doc-a", line: 3 },
    ]);
    const evB = bundle!.findings.find((f) => f.evidenceIds[0] === "fnd-b")!;
    expect(evB.evidence?.[0]?.sourceLabel).toBe("b.md");
  });

  it("#448 resolves the document name when a citation has a documentId but no inline filename", async () => {
    // Citation carries documentId only (the agent didn't record the filename),
    // but the Document IS named — the chip must show the name, not a doc cuid.
    seedFinding(
      "fnd-noname",
      JSON.stringify({ citations: [{ documentId: "doc-x", chunkIndex: 6 }] }),
    );
    seedDocument("doc-x", "D100 - UC101 Regional Hubs WMS_OMS Data Exchange_v0.8.docx");
    seedCrossDoc("ana-doc", ["fnd-noname"], 1000);

    const bundle = await readCrossDocFindings("ana-doc");
    expect(bundle!.findings[0]!.evidence).toEqual([
      {
        chunkId: "fnd-noname",
        sourceLabel: "D100 - UC101 Regional Hubs WMS_OMS Data Exchange_v0.8.docx",
        sourceId: "doc-x",
        line: 6,
      },
    ]);
  });

  it("#448 degrades to the raw id (no doc-cuid label) when the document is unresolvable", async () => {
    // documentId present, no inline filename, Document not seeded → unresolvable.
    seedFinding(
      "fnd-unres",
      JSON.stringify({ citations: [{ documentId: "doc-gone", chunkIndex: 1 }] }),
    );
    seedCrossDoc("ana-unres", ["fnd-unres"], 1000);

    const bundle = await readCrossDocFindings("ana-unres");
    // Raw id preserved; NO enriched ref emitted (so the client shows the raw id,
    // never a documentId cuid as the label).
    expect(bundle!.findings[0]!.evidenceIds).toEqual(["fnd-unres"]);
    expect(bundle!.findings[0]!.evidence).toBeUndefined();
  });

  it("AC2/AC5 degrades when a finding is missing: emits no enriched ref, keeps raw id", async () => {
    seedFinding(
      "fnd-present",
      JSON.stringify({ citations: [{ documentId: "doc-a", chunkIndex: 1, filename: "a.md" }] }),
    );
    // Reference one resolvable id and one that has no Finding row (deleted/legacy).
    seedCrossDoc("ana-2", ["fnd-present", "fnd-missing"], 1000);

    const bundle = await readCrossDocFindings("ana-2");
    const f = bundle!.findings[0]!;
    // Raw evidenceIds preserved intact for graceful degradation.
    expect(f.evidenceIds).toEqual(["fnd-present", "fnd-missing"]);
    // Only the resolvable id produced an enriched ref.
    expect(f.evidence).toEqual([
      { chunkId: "fnd-present", sourceLabel: "a.md", sourceId: "doc-a", line: 1 },
    ]);
  });

  it("AC2 omits the `evidence` field entirely when nothing resolves", async () => {
    seedCrossDoc("ana-3", ["fnd-missing-1", "fnd-missing-2"], 1000);
    const bundle = await readCrossDocFindings("ana-3");
    const f = bundle!.findings[0]!;
    expect(f.evidence).toBeUndefined();
    expect(f.evidenceIds).toEqual(["fnd-missing-1", "fnd-missing-2"]);
  });

  it("skips the finding query when no findings carry evidence ids", async () => {
    seedCrossDoc("ana-4", [], 1000);
    const { prisma } = await import("../src/lib/prisma.js");
    const findManyMock = prisma.finding.findMany as unknown as { mock: { calls: unknown[][] } };
    findManyMock.mock.calls.length = 0;
    const bundle = await readCrossDocFindings("ana-4");
    expect(findManyMock.mock.calls).toHaveLength(0);
    expect(bundle!.findings[0]!.evidence).toBeUndefined();
  });

  it("returns null when detection never ran (no cross-doc rows)", async () => {
    expect(await readCrossDocFindings("ana-none")).toBeNull();
  });
});
