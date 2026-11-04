/**
 * #1776 — an impact run with edit candidates ranked once per request
 * (`IMPACT_REQUEST_EDIT_RANKING`), across every change and project. Every
 * assertion reads what the engine PERSISTED: the items and their affected
 * symbols, the rows the read path and the UI read.
 */
import { describe, expect, it, vi } from "vitest";
import type { GraphSymbol } from "../code-graph/query-service.js";
import type { ChangeSeeds } from "./change-seeds.js";
import type { ChangedRequirement } from "./extract-changes.js";

vi.mock("../code-graph/project-code-searcher.js", () => ({
  createDefaultCodeSearcher: () => ({ search: async () => [] }),
  createRunScopedSymbolIndex: () => ({}),
}));
// Pass-through, so a test can read which seeding options the engine asked for.
vi.mock("./change-seeds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./change-seeds.js")>();
  return { ...actual, resolveChangeSeeds: vi.fn(actual.resolveChangeSeeds) };
});
const changeSeeds = await import("./change-seeds.js");
const { executeImpactAnalysis, InMemoryCodeGraphDataSource } =
  await import("./impact-analysis-engine.js");
type ProjectExecutionAccess = import("./impact-analysis-engine.js").ProjectExecutionAccess;

const change = (title: string): ChangedRequirement => ({
  requirementId: null,
  title,
  body: `${title}.`,
  changeType: "added",
  bodyDelta: 10,
});
const SAVE = change("Save the order total");
const SHOW = change("Show the order total");

const symbol = (id: string, filePath: string): GraphSymbol => ({
  id,
  qualifiedName: `${filePath}::${id}`,
  kind: "function",
  filePath,
  language: "go",
  startLine: 1,
  endLine: 9,
});

/** Each project: an edit file per change, and a caller of each. */
const FILES: Record<string, Record<string, string>> = {
  strong: { [SAVE.title]: "save.go", [SHOW.title]: "show.go" },
  weak: { [SAVE.title]: "weak-save.go", [SHOW.title]: "weak-show.go" },
};
// #1784 — the fused (RRF) scores tie, as rank 1 does in every search; the
// vector cosine says the weak project's best answer is far further away.
const SCORES: Record<string, number> = { strong: 0.06, weak: 0.06 };
const COSINES: Record<string, number> = { strong: 0.76, weak: 0.55 };

function graphFor(projectId: string) {
  const files = Object.values(FILES[projectId] ?? {});
  return new InMemoryCodeGraphDataSource(
    files.flatMap((f) => [
      symbol(`${projectId}:${f}`, f),
      symbol(`${projectId}:caller:${f}`, "main.go"),
    ]),
    files.map((f, i) => ({
      id: `${projectId}-e${i}`,
      fromSymbolId: `${projectId}:caller:${f}`,
      toSymbolId: `${projectId}:${f}`,
      kind: "calls",
    })),
  );
}

/** A split seeding that names one file per change in each project, at the project's score. */
const seedChange = vi.fn(async (c: ChangedRequirement, projectId: string): Promise<ChangeSeeds> => {
  const filePath = FILES[projectId]![c.title]!;
  const score = SCORES[projectId]!;
  return {
    editCandidates: [
      {
        codeSymbolId: `${projectId}:${filePath}`,
        filePath,
        qualifiedName: `${filePath}::${projectId}:${filePath}`,
        startLine: 1,
        endLine: 9,
        confidence: 1,
      },
    ],
    related: [],
    schemaSeeds: [],
    editFileScores: [{ filePath, score, cosine: COSINES[projectId]! }],
  };
});

function prismaMock() {
  const analyses = new Map<string, Record<string, unknown>>([
    ["ia", { id: "ia", sourceText: "two changes", documentId: null }],
  ]);
  const items: Array<Record<string, unknown> & { id: string }> = [];
  const affected: Record<string, unknown>[] = [];
  const prisma = {
    impactAnalysis: {
      findFirst: async ({ where }: { where: { id: string } }) => analyses.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        analyses.set(where.id, { ...analyses.get(where.id), ...data });
        return analyses.get(where.id);
      },
    },
    impactItem: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `item-${items.length + 1}`, ...data };
        items.push(row);
        return row;
      },
    },
    impactAffectedSymbol: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        affected.push(...data.map((d) => ({ ...d })));
        return { count: data.length };
      },
    },
    impactAffectedTable: { createMany: async () => ({ count: 0 }) },
    knowledgeChunk: { findMany: async () => [] },
    quarantineChunk: { findMany: async () => [] },
    document: {},
    codeSymbol: { findMany: async () => [] },
    codeEdge: { findMany: async () => [] },
  };
  return { prisma, analyses, items, affected };
}

async function run(requestEditRanking: boolean) {
  seedChange.mockClear();
  const m = prismaMock();
  const projectAccess = vi.fn(async (projectId: string): Promise<ProjectExecutionAccess> =>
    projectId === "hidden" ? "restricted" : "accessible",
  );
  await executeImpactAnalysis("ia", ["strong", "weak", "hidden"], {
    prisma: m.prisma as never,
    extractor: { extract: async () => [SAVE, SHOW] },
    seedChange,
    dataSourceFor: graphFor,
    includeSchemaImpact: false,
    projectAccess,
    ...(requestEditRanking ? { requestEditRanking } : {}),
  });
  const projectOf = new Map(m.items.map((i) => [i.id, String(i.projectId)]));
  const rows = m.affected.map((a) => ({
    project: projectOf.get(String(a.impactItemId))!,
    id: String(a.codeSymbolId),
    relation: String(a.relation),
    depth: Number(a.depth),
  }));
  return { ...m, rows, projectAccess };
}

const ids = (rows: Array<{ project: string; id: string }>) =>
  rows.map((r) => `${r.project}/${r.id}`).sort();

describe("edit candidates ranked once per request (#1776)", () => {
  it("names the weak project's files for review only, and still reaches their callers", async () => {
    const on = await run(true);
    expect(on.analyses.get("ia")?.status).toBe("completed");
    const direct = on.rows.filter((r) => r.relation === "direct").map((r) => r.id);
    expect(direct.sort()).toEqual(["strong:save.go", "strong:show.go"]);
    const weak = on.rows.filter((r) => r.project === "weak");
    expect(weak).toEqual(
      expect.arrayContaining([
        { project: "weak", id: "weak:weak-save.go", relation: "related", depth: 1 },
        expect.objectContaining({ id: "weak:caller:weak-save.go", depth: 1 }),
        expect.objectContaining({ id: "weak:caller:weak-show.go", depth: 1 }),
      ]),
    );
  });

  it("reaches exactly the symbols the per-change ranking reaches: only their roles move", async () => {
    const off = await run(false);
    const on = await run(true);
    expect(off.rows.filter((r) => r.relation === "direct")).toHaveLength(4);
    expect(ids(on.rows)).toEqual(ids(off.rows));
  });

  it("seeds each change once per accessible project, never one the starter cannot open", async () => {
    const on = await run(true);
    expect(seedChange.mock.calls.map(([c, p]) => `${p}/${c.title}`)).toEqual([
      "strong/Save the order total",
      "strong/Show the order total",
      "weak/Save the order total",
      "weak/Show the order total",
    ]);
    expect(on.projectAccess.mock.calls.map(([p]) => p)).toEqual(["strong", "weak", "hidden"]);
  });
});

describe("the default seeding with per-request ranking (#1776)", () => {
  it("asks resolveChangeSeeds for each edit file's score only when the ranking is on", async () => {
    const seeded = vi.mocked(changeSeeds.resolveChangeSeeds);
    for (const requestEditRanking of [false, true]) {
      seeded.mockClear();
      const { prisma } = prismaMock();
      await executeImpactAnalysis("ia", ["strong"], {
        prisma: prisma as never,
        extractor: { extract: async () => [SAVE] },
        dataSourceFor: graphFor,
        includeSchemaImpact: false,
        ...(requestEditRanking ? { requestEditRanking } : {}),
      });
      expect(seeded).toHaveBeenCalledTimes(1);
      expect(seeded.mock.calls[0]![2].editFileScores).toBe(requestEditRanking || undefined);
    }
  });
});
