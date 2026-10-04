/**
 * Integration test for the analysis-grounding seeding hook
 * (branch feat/req-code-traceability).
 *
 * Exercises the REAL `persistRequirements` (which encodes evidence finding ids
 * as `finding:<id>` labels) followed by `seedRequirementCodeLinksFromFindings`,
 * against an in-memory fake of the `../prisma.js` module. Asserts that after the
 * post-synthesis hook runs, a RequirementCodeMapping spine row exists for the
 * requirement — i.e. the label-encoding contract the seeder depends on holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
}
interface FindingRow {
  id: string;
  evidence: string | null;
  confidence: number | null;
}
interface MappingRow {
  id: string;
  requirementId: string;
  projectId: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  source: string;
}

interface DocumentRow {
  id: string;
  projectId: string;
  source: string;
  filename: string;
}

interface CodeSymbolRow {
  id: string;
  projectId: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

const store = {
  requirements: [] as ReqRow[],
  findings: [] as FindingRow[],
  documents: [] as DocumentRow[],
  codeSymbols: [] as CodeSymbolRow[],
  mappings: [] as MappingRow[],
  seq: 0,
};

vi.mock("../prisma.js", () => ({
  prisma: {
    // Issue #769 — `persistRequirements` reads the analysis metadata first.
    analysis: { findFirst: vi.fn(async () => ({ metadata: null })) },
    requirement: {
      // Issue #769 — this fake models no review work and no prior set, so the
      // replacement guard proceeds; the guard itself is exercised against a real
      // SQLite database in tests/requirement-set-preservation-769.sqlite.test.ts.
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        store.requirements = store.requirements.filter((r) => r.analysisId !== where.analysisId);
        return { count: 0 };
      }),
      create: vi.fn(async ({ data }: { data: Omit<ReqRow, "id"> }) => {
        const row: ReqRow = { id: `req-${++store.seq}`, ...data };
        store.requirements.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; projectId: string } }) =>
          store.requirements.find((r) => r.id === where.id && r.projectId === where.projectId) ??
          null,
      ),
    },
    finding: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        store.findings.filter((f) => where.id.in.includes(f.id)),
      ),
    },
    document: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; projectId: string } }) =>
        store.documents.filter(
          (document) => where.id.in.includes(document.id) && document.projectId === where.projectId,
        ),
      ),
    },
    codeSymbol: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            projectId: string;
            kind?: string;
            id?: { in: string[] };
            filePath?: { in: string[] };
          };
        }) =>
          store.codeSymbols.filter(
            (symbol) =>
              symbol.projectId === where.projectId &&
              (where.kind === undefined || symbol.kind === where.kind) &&
              (where.id === undefined || where.id.in.includes(symbol.id)) &&
              (where.filePath === undefined || where.filePath.in.includes(symbol.filePath)),
          ),
      ),
    },
    requirementCodeMapping: {
      findMany: vi.fn(async ({ where }: { where: { requirementId: string; projectId: string } }) =>
        store.mappings.filter(
          (m) => m.requirementId === where.requirementId && m.projectId === where.projectId,
        ),
      ),
      create: vi.fn(async ({ data }: { data: Omit<MappingRow, "id"> }) => {
        const row: MappingRow = { id: `mapping-${++store.seq}`, ...data };
        store.mappings.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        const count = store.mappings.filter((mapping) => ids.has(mapping.id)).length;
        store.mappings = store.mappings.filter((mapping) => !ids.has(mapping.id));
        return { count };
      }),
    },
  },
}));

import { persistRequirements } from "../analysis/analysis-service.js";
import { seedRequirementCodeLinksFromFindings } from "./seed-code-links-from-findings.js";

beforeEach(() => {
  store.requirements = [];
  store.findings = [];
  store.documents = [];
  store.codeSymbols = [];
  store.mappings = [];
  store.seq = 0;
});

describe("synthesis hook → requirement→code spine", () => {
  it("creates a symbol-bound row after requirements are persisted with a code citation", async () => {
    store.codeSymbols.push({
      id: "symbol-auth",
      projectId: "proj-1",
      kind: "function",
      filePath: "server/src/auth.ts",
      startLine: 3,
      endLine: 12,
    });
    store.findings.push({
      id: "find-1",
      evidence: JSON.stringify({
        citations: [
          {
            filePath: "server/src/auth.ts",
            startLine: 5,
            endLine: 8,
            symbolId: "symbol-auth",
          },
        ],
        tags: [],
        requirementId: null,
      }),
      confidence: 0.7,
    });

    // Persist a requirement whose evidence references finding index 0 → find-1.
    const requirementIds = await persistRequirements({
      analysisId: "an-1",
      projectId: "proj-1",
      findingIdsByIndex: ["find-1"],
      synthesis: {
        requirements: [
          {
            type: "functional",
            title: "Authenticate users",
            body: "Users must log in.",
            priority: "high",
            labels: ["security"],
            evidenceFindingIndexes: [0],
            storyPoints: null,
          },
        ],
        // The rest of the SynthesisOutput shape is unused by persistRequirements.
      } as never,
    });

    expect(requirementIds).toHaveLength(1);

    const summary = await seedRequirementCodeLinksFromFindings({
      analysisId: "an-1",
      projectId: "proj-1",
      requirementIds,
    });

    expect(summary.linksCreated).toBe(1);
    const rows = store.mappings.filter((m) => m.requirementId === requirementIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      filePath: "server/src/auth.ts",
      codeSymbolId: "symbol-auth",
      startLine: 5,
      endLine: 8,
      source: "analysis-grounding",
      confidence: 0.7,
    });
  });
});
