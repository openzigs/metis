/**
 * #1036 — the engine reads an issue as one change, seeds it with hybrid search,
 * and reports edit candidates apart from the blast radius.
 *
 * The issue text is the VERBATIM run-7 #4478 paste and the search hits are a
 * capture of what production's `HybridCodeSearch` returned for it (see
 * `change-seeds.test.ts`), so the end-to-end assertions here run on real inputs
 * with no model and no embedder in the loop.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { impactFileLists, impactSymbolRole } from "@metis/shared";
import type { CodeGraphDataSource, GraphSymbol } from "../code-graph/query-service.js";
import type { SeedSearchHit, SeedSymbolRow } from "./change-seeds.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "__fixtures__", name), "utf8");
const ISSUE_4478 = read("miniflux-4478.md");
const CAPTURE = JSON.parse(read("miniflux-4478-hits.json")) as {
  queries: { query: string; hits: SeedSearchHit[] }[];
  symbols: SeedSymbolRow[];
};

/** What the replayed searcher says about its channels; null = says nothing. */
let reportedMode: "hybrid" | "bm25-only" | null = null;
const search = vi.fn(
  async (
    query: string,
    _projectId: string,
    opts?: { onRetrievalMode?: (mode: "hybrid" | "bm25-only") => void },
  ) => {
    const captured = CAPTURE.queries.find((q) => q.query === query);
    if (!captured) throw new Error(`no capture for: ${query.slice(0, 60)}`);
    if (reportedMode) opts?.onRetrievalMode?.(reportedMode);
    return captured.hits;
  },
);
const RUN_INDEX = { name: "run-scoped index over the injected client" };
const createRunScopedSymbolIndex = vi.fn((_client?: unknown) => RUN_INDEX);
const createDefaultCodeSearcher = vi.fn((_deps?: unknown) => ({ search }));
vi.mock("../code-graph/project-code-searcher.js", () => ({
  createDefaultCodeSearcher: (deps?: unknown) => createDefaultCodeSearcher(deps),
  createRunScopedSymbolIndex: (client: unknown) => createRunScopedSymbolIndex(client),
}));

const mapRequirementToCode = vi.fn(async () => []);
vi.mock("../traceability/requirement-code-mapping.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../traceability/requirement-code-mapping.js")>()),
  mapRequirementToCode: (...args: unknown[]) => mapRequirementToCode(...(args as [])),
}));

const { computeProjectImpact, executeImpactAnalysis, InMemoryCodeGraphDataSource } =
  await import("./impact-analysis-engine.js");
const { extractChangesByShape } = await import("./change-request.js");

beforeEach(() => {
  reportedMode = null;
  createRunScopedSymbolIndex.mockClear();
  search.mockClear();
  createDefaultCodeSearcher.mockClear();
  mapRequirementToCode.mockClear();
});

function sym(id: string, filePath: string): GraphSymbol {
  return {
    id,
    qualifiedName: `${filePath}::${id}`,
    kind: "function",
    filePath,
    language: "go",
    startLine: 1,
    endLine: 9,
  };
}

function match(id: string, filePath: string, confidence: number) {
  return {
    codeSymbolId: id,
    filePath,
    qualifiedName: `${filePath}::${id}`,
    startLine: 1,
    endLine: 9,
    confidence,
  };
}

const change = {
  requirementId: null,
  title: "t",
  body: "b",
  changeType: "added" as const,
  bodyDelta: 1,
};

describe("computeProjectImpact — split seeding (#1036)", () => {
  // edit ← caller ; related ← relatedCaller (must NOT be walked)
  const symbols = [
    sym("edit", "storage/entry.go"),
    sym("caller", "api/handler.go"),
    sym("related", "ui/page.go"),
    sym("relatedCaller", "ui/router.go"),
  ];
  const graph = new InMemoryCodeGraphDataSource(symbols, [
    { id: "e1", fromSymbolId: "caller", toSymbolId: "edit", kind: "calls" },
    { id: "e2", fromSymbolId: "relatedCaller", toSymbolId: "related", kind: "calls" },
  ]);
  const seedChange = vi.fn(async () => ({
    editCandidates: [match("edit", "storage/entry.go", 1)],
    related: [match("related", "ui/page.go", 0.4)],
    schemaSeeds: [],
  }));
  const mapRequirement = vi.fn(async () => [match("ignored", "x.go", 1)]);

  const run = (extra: Record<string, unknown> = {}) =>
    computeProjectImpact(change, "p1", {
      mapRequirement,
      seedChange,
      dataSourceFor: () => graph,
      ...extra,
    });

  it("uses the split seeding instead of the mapper", async () => {
    const result = await run();
    expect(seedChange).toHaveBeenCalledWith(change, "p1");
    expect(mapRequirement).not.toHaveBeenCalled();
    expect(result.affectedSymbols.map((s) => s.codeSymbolId)).not.toContain("ignored");
  });

  it("reports the selected symbol as an edit candidate and the rest as blast radius", async () => {
    const result = await run();
    const roles = Object.fromEntries(
      result.affectedSymbols.map((s) => [s.codeSymbolId, `${s.relation}:${impactSymbolRole(s)}`]),
    );
    expect(roles).toEqual({
      edit: "direct:edit-candidate",
      caller: "caller:blast-radius",
      related: "related:blast-radius",
    });
    expect(impactFileLists(result.affectedSymbols)).toEqual({
      editCandidateFiles: ["storage/entry.go"],
      blastRadiusFiles: ["storage/entry.go", "api/handler.go", "ui/page.go"],
    });
  });

  it("walks callers from the edit candidates only — a related hit is not a seed", async () => {
    const result = await run();
    expect(result.affectedSymbols.map((s) => s.codeSymbolId)).not.toContain("relatedCaller");
  });

  it("crosses into the schema from the edit candidates and their callers, not from related hits", async () => {
    const getSchemaEdgesFrom = vi.fn(async () => []);
    await run({
      schemaDataSourceFor: () => ({ getSchemaEdgesFrom, getSchemaSymbolsByIds: async () => [] }),
    });
    const crossed = new Set(
      getSchemaEdgesFrom.mock.calls.flatMap((c) => (c as unknown as [string[]])[0]),
    );
    expect(crossed.has("edit")).toBe(true);
    expect(crossed.has("caller")).toBe(true);
    expect(crossed.has("related")).toBe(false);
  });

  it("grades the match on the edit candidates alone", async () => {
    const result = await run();
    expect(result.confidence).toBe(1);
    expect(result.matchQuality).toBe("strong");
  });

  it("adds a structural twin of a retrieved function to the blast radius", async () => {
    const names = (extra: string) => new Set(["a", "b", "c", "d", "e", "f", "g", extra]);
    const twinGraph = new InMemoryCodeGraphDataSource(
      [...symbols, sym("twin", "ui/other_page.go")],
      [],
      new Map([
        ["related", names("x")],
        ["twin", names("y")],
      ]),
    );
    const result = await run({ dataSourceFor: () => twinGraph });
    const twin = result.affectedSymbols.find((s) => s.codeSymbolId === "twin");
    expect(twin?.relation).toBe("related");
    expect(impactSymbolRole(twin!)).toBe("blast-radius");
  });

  it("keeps the retrieval when the twin lookup fails", async () => {
    const broken: CodeGraphDataSource = Object.assign(Object.create(graph), {
      calleeNameSets: () => {
        throw new Error("boom");
      },
    });
    const result = await run({ dataSourceFor: () => broken });
    expect(result.affectedSymbols.map((s) => s.codeSymbolId)).toContain("related");
  });

  it("still uses the mapper when no split seeding is wired", async () => {
    const result = await run({ seedChange: undefined });
    expect(mapRequirement).toHaveBeenCalled();
    expect(result.affectedSymbols.map((s) => s.codeSymbolId)).toEqual(["ignored"]);
  });
});

describe("computeProjectImpact — a column among the best hits (#1036)", () => {
  const graph = new InMemoryCodeGraphDataSource([sym("edit", "storage/entry.go")], []);
  const column = {
    codeSymbolId: "col",
    filePath: "internal/database/migrations.go",
    qualifiedName: "api_keys.last_used_at",
    startLine: 332,
    endLine: 332,
    confidence: 0.9,
  };
  const schemaSymbols = [
    {
      id: "col",
      kind: "column" as const,
      name: "last_used_at",
      qualifiedName: "api_keys.last_used_at",
      source: "sqlglot" as const,
    },
  ];
  const getSchemaEdgesFrom = vi.fn(async () => []);
  const run = (extra: Record<string, unknown> = {}) =>
    computeProjectImpact(change, "p1", {
      mapRequirement: async () => [],
      seedChange: async () => ({
        editCandidates: [match("edit", "storage/entry.go", 1)],
        related: [],
        schemaSeeds: [column],
      }),
      dataSourceFor: () => graph,
      schemaDataSourceFor: () => ({
        getSchemaEdgesFrom,
        getSchemaSymbolsByIds: async (ids: string[]) =>
          schemaSymbols.filter((x) => ids.includes(x.id)),
      }),
      ...extra,
    });

  it("is listed for review, never as code to edit, and still surfaces its table", async () => {
    const result = await run();
    const row = result.affectedSymbols.find((x) => x.codeSymbolId === "col")!;
    expect(row.relation).toBe("related");
    expect(impactSymbolRole(row)).toBe("blast-radius");
    expect(result.affectedTables.map((t) => `${t.tableName}.${t.columnName}`)).toContain(
      "api_keys.last_used_at",
    );
    // The edit candidates alone grade the match and set the headline confidence.
    expect(result.confidence).toBe(1);
  });

  it("is dropped once the relevance filter judges its table tangential", async () => {
    const result = await run({
      tableRelevanceFilter: async (_text: string, rows: { tableName: string }[]) => ({
        primary: [],
        secondary: rows.map((r) => ({ ...r, relevanceTier: "unlikely" })),
      }),
    });
    expect(result.affectedSymbols.map((x) => x.codeSymbolId)).toEqual(["edit"]);
  });
});

describe("computeProjectImpact — data model of a table that gains a column (#1036)", () => {
  const graph = new InMemoryCodeGraphDataSource([sym("edit", "storage/entry.go")], []);
  const schemaSymbols = [
    {
      id: "tbl",
      kind: "table" as const,
      name: "entries",
      qualifiedName: "entries",
      source: "sqlglot" as const,
    },
  ];
  const getDataModelSymbols = vi.fn(async () => [
    {
      id: "Entry",
      kind: "class",
      qualifiedName: "internal/model/entry.go::Entry",
      filePath: "internal/model/entry.go",
      startLine: 27,
      endLine: 60,
      language: "go",
    },
  ]);
  const run = (body: string, over: Record<string, unknown> = {}) =>
    computeProjectImpact({ ...change, title: "Track reading time", body }, "p1", {
      mapRequirement: async () => [],
      seedChange: async () => ({
        editCandidates: [match("edit", "storage/entry.go", 1)],
        related: [],
        schemaSeeds: [],
      }),
      dataSourceFor: () => graph,
      schemaDataSourceFor: () => ({
        getSchemaEdgesFrom: async (ids: string[]) =>
          ids.includes("edit")
            ? [{ fromSymbolId: "edit", toSymbolId: "tbl", kind: "writes" as const }]
            : [],
        getSchemaSymbolsByIds: async (ids: string[]) =>
          schemaSymbols.filter((s) => ids.includes(s.id)),
        getDataModelSymbols,
        ...over,
      }),
    });

  beforeEach(() => getDataModelSymbols.mockClear());

  it("names the table's types as edit candidates when the request states the DDL", async () => {
    const result = await run("ALTER TABLE entries ADD COLUMN read_at TIMESTAMPTZ;");
    expect(getDataModelSymbols).toHaveBeenCalledWith(["entries"]);
    const model = result.affectedSymbols.find((s) => s.codeSymbolId === "Entry")!;
    expect(model.relation).toBe("data-model");
    expect(impactSymbolRole(model)).toBe("edit-candidate");
    expect(result.affectedFileCount).toBe(2);
  });

  it("does not look for a data model when no table gains a column", async () => {
    const result = await run("Show the entry's reading time on the entry page.");
    expect(getDataModelSymbols).not.toHaveBeenCalled();
    expect(result.affectedSymbols.map((s) => s.relation)).toEqual(["direct"]);
  });

  it("keeps the code impact when the data-model lookup fails", async () => {
    const result = await run("ALTER TABLE entries ADD COLUMN read_at TIMESTAMPTZ;", {
      getDataModelSymbols: async () => {
        throw new Error("db down");
      },
    });
    expect(result.affectedSymbols.map((s) => s.codeSymbolId)).toEqual(["edit"]);
  });
});

describe("the verbatim run-7 #4478 issue, end to end on captured search hits (#1036)", () => {
  const symbols: GraphSymbol[] = CAPTURE.symbols.map((s) => ({
    id: s.id,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    filePath: s.filePath,
    language: s.language,
    startLine: s.startLine ?? 1,
    endLine: s.endLine ?? 1,
  }));
  const graph = new InMemoryCodeGraphDataSource(symbols, []);

  function prismaMock() {
    const analyses = new Map<string, Record<string, unknown>>([
      ["ia", { id: "ia", sourceText: ISSUE_4478, documentId: null }],
    ]);
    const items: Record<string, unknown>[] = [];
    const affected: Record<string, unknown>[] = [];
    const prisma = {
      impactAnalysis: {
        findFirst: async ({ where }: { where: { id: string } }) => analyses.get(where.id) ?? null,
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          analyses.set(where.id, { ...analyses.get(where.id), ...data });
          return analyses.get(where.id);
        },
      },
      impactItem: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          items.push(data);
          return { id: `item-${items.length}`, ...data };
        },
      },
      impactAffectedSymbol: {
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          affected.push(...data);
          return { count: data.length };
        },
      },
      impactAffectedTable: { createMany: async () => ({ count: 0 }) },
      knowledgeChunk: { findMany: async () => [] },
      quarantineChunk: { findMany: async () => [] },
      document: {},
      codeSymbol: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          CAPTURE.symbols.filter((s) => where.id.in.includes(s.id)),
      },
      codeEdge: {},
    };
    return { prisma, analyses, items, affected };
  }

  it("is one primary request, where the splitter made five", () => {
    expect(extractChangesByShape(ISSUE_4478)).toHaveLength(1);
  });

  it("with nothing injected: one item, seeded by the hybrid searcher and not by names-only BM25", async () => {
    const { prisma, analyses, items } = prismaMock();
    await executeImpactAnalysis("ia", ["p1"], {
      prisma: prisma as never,
      dataSourceFor: () => graph,
      includeSchemaImpact: false,
    });
    expect(analyses.get("ia")?.status).toBe("completed");
    expect(items).toHaveLength(1);
    expect(items[0]!.requirementTitle).toBe("Mark all as read older than X");
    expect(createDefaultCodeSearcher).toHaveBeenCalledTimes(1);
    // The searcher's lexical index is built over the INJECTED client, the one the
    // hits are hydrated from — not the module-global one (PR #1090 review).
    expect(createRunScopedSymbolIndex).toHaveBeenCalledWith(prisma);
    // PR #1126 review — and with the snippet read off: seeding reads a hit's id
    // and score, never its snippet.
    expect(createDefaultCodeSearcher).toHaveBeenCalledWith({
      snippetLookup: null,
      symbolIndex: RUN_INDEX,
    });
    // Title, then the request without its rejected alternatives.
    expect(search.mock.calls.map((c) => c[0])).toEqual(CAPTURE.queries.map((q) => q.query));
    expect(mapRequirementToCode).not.toHaveBeenCalled();
  });

  it("persists MarkAllAsReadBeforeDate (storage) as an edit candidate", async () => {
    const { prisma, affected } = prismaMock();
    await executeImpactAnalysis("ia", ["p1"], {
      prisma: prisma as never,
      dataSourceFor: () => graph,
      includeSchemaImpact: false,
    });
    const row = affected.find(
      (s) => s.qualifiedName === "internal/storage/entry.go::MarkAllAsReadBeforeDate",
    )!;
    expect(row.relation).toBe("direct");
    expect(row.depth).toBe(0);
    const { editCandidateFiles, blastRadiusFiles } = impactFileLists(
      affected as { filePath: string; depth: number }[],
    );
    expect(editCandidateFiles).toContain("internal/storage/entry.go");
    expect(editCandidateFiles).toContain("internal/ui/unread_mark_all_read.go");
    expect(editCandidateFiles.length).toBeLessThanOrEqual(5);
    expect(blastRadiusFiles.length).toBeGreaterThan(editCandidateFiles.length);
  });

  it("says on the run when the code search was keywords only (PR #1090 review)", async () => {
    const run = async (mode: typeof reportedMode) => {
      reportedMode = mode;
      const { prisma, analyses } = prismaMock();
      await executeImpactAnalysis("ia", ["p1"], {
        prisma: prisma as never,
        dataSourceFor: () => graph,
        includeSchemaImpact: false,
      });
      return String(analyses.get("ia")?.summary);
    };
    const degraded = await run("bm25-only");
    expect(degraded).toMatch(
      /^Impacted \d+ symbol\(s\) across 1 project\(s\) from 1 change\(s\)\./,
    );
    expect(degraded).toContain(
      "\n\nCode search ran on keywords only (BM25) for this project: symbol embeddings were missing or still building",
    );
    // A hybrid run, and a searcher that does not say, add nothing.
    expect(await run("hybrid")).not.toContain("keywords only");
    expect(await run(null)).not.toContain("keywords only");
  });

  it("an injected mapper is used as-is — the opt-in seeding flags keep their path", async () => {
    const { prisma } = prismaMock();
    const mapRequirement = vi.fn(async () => []);
    await executeImpactAnalysis("ia", ["p1"], {
      prisma: prisma as never,
      mapRequirement,
      dataSourceFor: () => graph,
      includeSchemaImpact: false,
    });
    expect(mapRequirement).toHaveBeenCalledTimes(1);
    expect(createDefaultCodeSearcher).not.toHaveBeenCalled();
  });
});
