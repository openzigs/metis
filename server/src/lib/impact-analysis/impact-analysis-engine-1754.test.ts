/**
 * #1754 — an impact run about stored requirements, seeded from their stored
 * code links (`IMPACT_STORED_LINK_SEEDS`) as well as the hybrid search.
 *
 * The hybrid side replays the #1036 capture of production's `HybridCodeSearch`
 * on Miniflux #4478 (see `change-seeds.test.ts`); every assertion reads what
 * the engine PERSISTED (items, affected symbols, the run summary), the rows the
 * read path and the UI read.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { impactFileLists, impactSeedEvidenceSchema } from "@metis/shared";
import type { GraphSymbol } from "../code-graph/query-service.js";
import type { SeedSearchHit, SeedSymbolRow, StoredLinkRow } from "./change-seeds.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "__fixtures__", name), "utf8");
const ISSUE_4478 = read("miniflux-4478.md");
const CAPTURE = JSON.parse(read("miniflux-4478-hits.json")) as {
  queries: { query: string; hits: SeedSearchHit[] }[];
  symbols: SeedSymbolRow[];
};

const search = vi.fn(async (query: string) => {
  const captured = CAPTURE.queries.find((q) => q.query === query);
  // A stored requirement is searched by its own title and body: hand it the
  // capture's hits, as the same search over the same graph would.
  return captured ? captured.hits : CAPTURE.queries[0]!.hits;
});
vi.mock("../code-graph/project-code-searcher.js", () => ({
  createDefaultCodeSearcher: () => ({ search }),
  createRunScopedSymbolIndex: () => ({}),
}));

const {
  executeImpactAnalysis,
  InMemoryCodeGraphDataSource,
  loadRequirementChanges,
  parseRequirementIds,
  storedLinkNotice,
  triggerImpactAnalysis,
} = await import("./impact-analysis-engine.js");

/** A file only the stored link names: not in the captured hits. */
const LINKED_FILE = "internal/reader/processor/age.go";
const LINKED: SeedSymbolRow = {
  id: "LINKED-1",
  qualifiedName: `${LINKED_FILE}::filterByAge`,
  filePath: LINKED_FILE,
  kind: "function",
  language: "go",
  startLine: 10,
  endLine: 40,
};
const GRAPH_ROWS = [...CAPTURE.symbols, LINKED];
const graph = new InMemoryCodeGraphDataSource(
  GRAPH_ROWS.map((s): GraphSymbol => ({
    id: s.id,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    filePath: s.filePath,
    language: s.language,
    startLine: s.startLine ?? 1,
    endLine: s.endLine ?? 1,
  })),
  [],
);

const REQ = {
  id: "req-age",
  title: "Mark all as read older than X",
  body: "Let a reader mark every entry older than a chosen age as read.",
};

interface RunRow extends Record<string, unknown> {
  id: string;
  sourceText: string | null;
  documentId: string | null;
  requirementIds?: string | null;
}

function prismaMock(
  run: RunRow,
  links: Array<StoredLinkRow & { requirementId: string; projectId: string }> = [],
) {
  const analyses = new Map<string, Record<string, unknown>>([[run.id, run]]);
  const items: Record<string, unknown>[] = [];
  const affected: Record<string, unknown>[] = [];
  const requirements = [
    REQ,
    { id: "req-gone", title: "Gone", body: "Deleted.", deletedAt: new Date() },
  ];
  const mappingFindMany = vi.fn(
    async ({ where }: { where: { requirementId: string; projectId: string } }) =>
      links.filter(
        (l) => l.requirementId === where.requirementId && l.projectId === where.projectId,
      ),
  );
  const prisma = {
    impactAnalysis: {
      findFirst: async ({ where }: { where: { id: string } }) => analyses.get(where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "ia-new", status: "pending", ...data };
        analyses.set("ia-new", row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
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
        affected.push(...data.map((d) => ({ ...d })));
        return { count: data.length };
      },
    },
    impactAffectedTable: { createMany: async () => ({ count: 0 }) },
    knowledgeChunk: { findMany: async () => [] },
    quarantineChunk: { findMany: async () => [] },
    document: {},
    requirement: {
      // Honours `deletedAt: null` the way the database does, and only when asked.
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; deletedAt?: null } }) =>
        requirements.filter(
          (r) => where.id.in.includes(r.id) && !(where.deletedAt === null && "deletedAt" in r),
        ),
      ),
    },
    requirementCodeMapping: { findMany: mappingFindMany },
    codeSymbol: {
      findMany: async ({
        where,
      }: {
        where: { id?: { in: string[] }; filePath?: { in: string[] } };
      }) =>
        GRAPH_ROWS.filter((s) =>
          where.id ? where.id.in.includes(s.id) : where.filePath!.in.includes(s.filePath),
        ),
    },
    codeEdge: { findMany: async () => [] },
  };
  return { prisma, analyses, items, affected, mappingFindMany };
}

const reqRun = (ids: unknown = ["req-age"]): RunRow => ({
  id: "ia",
  sourceText: null,
  documentId: null,
  requirementIds: JSON.stringify(ids),
});

const link = (filePath: string, over: Partial<StoredLinkRow> = {}) => ({
  requirementId: "req-age",
  projectId: "p1",
  codeSymbolId: null,
  filePath,
  startLine: null,
  endLine: null,
  confidence: 0.9,
  source: "manual",
  ...over,
});

const run = (prisma: unknown, extra: Record<string, unknown> = {}) =>
  executeImpactAnalysis("ia", ["p1"], {
    prisma: prisma as never,
    dataSourceFor: () => graph,
    includeSchemaImpact: false,
    ...extra,
  });

beforeEach(() => search.mockClear());

describe("a run about stored requirements (#1754)", () => {
  it("analyses each requirement as one change carrying its id, title and body", async () => {
    const extract = vi.fn(async () => []);
    const { prisma, items, analyses } = prismaMock(reqRun(["req-age", "req-gone"]));
    await run(prisma, { extractor: { extract } });
    expect(analyses.get("ia")?.status).toBe("completed");
    expect(extract).not.toHaveBeenCalled();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ requirementId: "req-age", requirementTitle: REQ.title });
    expect(search.mock.calls.map((c) => c[0])).toEqual([REQ.title, `${REQ.title}\n\n${REQ.body}`]);
  });

  it("with the flag on: seeds the linked file, records the evidence, and says so on the run", async () => {
    const { prisma, items, affected, analyses } = prismaMock(reqRun(), [
      link(LINKED_FILE),
      link("internal/reader/removed.go", { source: "semantic", confidence: 0.6 }),
    ]);
    await run(prisma, { storedLinkSeeds: true });
    const linked = affected.find((s) => s.codeSymbolId === "LINKED-1")!;
    expect(linked).toMatchObject({ relation: "direct", depth: 0, confidence: 0.9 });
    const { editCandidateFiles } = impactFileLists(
      affected as { filePath: string; depth: number }[],
    );
    expect(editCandidateFiles.map((f) => f.filePath)).toContain(LINKED_FILE);
    const evidence = impactSeedEvidenceSchema.parse(JSON.parse(String(items[0]!.seedEvidence)));
    expect(evidence.storedLinks).toEqual({ used: 1, stale: 1 });
    expect(evidence.editCandidates.at(-1)).toEqual({
      filePath: LINKED_FILE,
      channels: ["stored-link"],
    });
    expect(evidence.editCandidates.slice(0, -1).every((e) => e.channels.includes("hybrid"))).toBe(
      true,
    );
    expect(String(analyses.get("ia")?.summary)).toContain(
      "\n\n1 stored requirement link seeded the files to edit. 1 stored requirement link was dropped: the linked file is no longer in the code graph.",
    );
  });

  it("with the flag on, keeps every hybrid edit candidate with its original score", async () => {
    const off = prismaMock(reqRun(), [link(LINKED_FILE)]);
    await run(off.prisma);
    const on = prismaMock(reqRun(), [link(LINKED_FILE)]);
    await run(on.prisma, { storedLinkSeeds: true });
    const direct = (rows: Record<string, unknown>[]) =>
      rows.filter((r) => r.relation === "direct" && r.codeSymbolId !== "LINKED-1");
    expect(direct(on.affected)).toEqual(direct(off.affected));
  });

  it("with the flag off: reads no link and records no evidence", async () => {
    const { prisma, items, analyses, mappingFindMany } = prismaMock(reqRun(), [link(LINKED_FILE)]);
    await run(prisma);
    expect(mappingFindMany).not.toHaveBeenCalled();
    expect("seedEvidence" in items[0]!).toBe(false);
    expect(String(analyses.get("ia")?.summary)).not.toContain("stored requirement link");
  });

  it("leaves a pasted-text run exactly as it was, flag on or off", async () => {
    const textRun = (): RunRow => ({ id: "ia", sourceText: ISSUE_4478, documentId: null });
    const off = prismaMock(textRun(), [link(LINKED_FILE)]);
    await run(off.prisma);
    const on = prismaMock(textRun(), [link(LINKED_FILE)]);
    await run(on.prisma, { storedLinkSeeds: true });
    expect(on.items).toEqual(off.items);
    expect(on.affected).toEqual(off.affected);
    expect(on.analyses.get("ia")?.summary).toEqual(off.analyses.get("ia")?.summary);
    expect(on.mappingFindMany).not.toHaveBeenCalled();
  });

  it("counts the stale links of a change that found nothing at all", async () => {
    search.mockResolvedValue([]);
    try {
      const { prisma, items, analyses } = prismaMock(reqRun(), [
        link("gone/one.go"),
        link("gone/two.go"),
      ]);
      await run(prisma, { storedLinkSeeds: true });
      expect(items).toHaveLength(0);
      expect(String(analyses.get("ia")?.summary)).toContain(
        "0 stored requirement links seeded the files to edit. 2 stored requirement links were dropped",
      );
    } finally {
      search.mockImplementation(async (query: string) => {
        const captured = CAPTURE.queries.find((q) => q.query === query);
        return captured ? captured.hits : CAPTURE.queries[0]!.hits;
      });
    }
  });

  it("does not read another project's links for the same requirement", async () => {
    const { prisma, mappingFindMany, items } = prismaMock(reqRun(), [
      { ...link(LINKED_FILE), projectId: "p-other" },
    ]);
    await run(prisma, { storedLinkSeeds: true });
    expect(mappingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { requirementId: "req-age", projectId: "p1" } }),
    );
    const evidence = JSON.parse(String(items[0]!.seedEvidence)) as { storedLinks: unknown };
    expect(evidence.storedLinks).toEqual({ used: 0, stale: 0 });
  });
});

describe("triggerImpactAnalysis with requirementIds (#1754)", () => {
  it("accepts stored requirements as the only source and persists them, deduplicated", async () => {
    const { prisma, analyses } = prismaMock({ id: "x", sourceText: null, documentId: null });
    const out = await triggerImpactAnalysis(
      { projectIds: ["p1"], requirementIds: ["req-age", "req-age"], actorId: "u" },
      { prisma: prisma as never, dataSourceFor: () => graph, includeSchemaImpact: false },
    );
    expect(out.id).toBe("ia-new");
    expect(analyses.get("ia-new")?.requirementIds).toBe('["req-age"]');
  });

  it("writes no requirementIds for a text run, and refuses a run with no source", async () => {
    const { prisma, analyses } = prismaMock({ id: "x", sourceText: null, documentId: null });
    await triggerImpactAnalysis(
      { projectIds: ["p1"], text: "x", actorId: "u" },
      { prisma: prisma as never, dataSourceFor: () => graph, includeSchemaImpact: false },
    );
    expect("requirementIds" in analyses.get("ia-new")!).toBe(false);
    await expect(
      triggerImpactAnalysis(
        { projectIds: ["p1"], requirementIds: [], actorId: "u" },
        { prisma: prisma as never },
      ),
    ).rejects.toThrow(/One of documentId, text or requirementIds is required/);
  });
});

describe("helpers (#1754)", () => {
  it("parseRequirementIds reads a JSON array of strings, and nothing else", () => {
    expect(parseRequirementIds('["a","b"]')).toEqual(["a", "b"]);
    expect(parseRequirementIds('["a",1,null]')).toEqual(["a"]);
    expect(parseRequirementIds('{"a":1}')).toEqual([]);
    expect(parseRequirementIds("not json")).toEqual([]);
    expect(parseRequirementIds(null)).toEqual([]);
  });

  it("loadRequirementChanges keeps the asked order and skips a deleted requirement", async () => {
    const { prisma } = prismaMock(reqRun());
    expect(await loadRequirementChanges(prisma as never, [])).toEqual([]);
    const changes = await loadRequirementChanges(prisma as never, ["req-gone", "req-age"]);
    expect(changes).toEqual([
      {
        requirementId: "req-age",
        title: REQ.title,
        body: REQ.body,
        // Classified like a pasted change: "Let a reader…" asks for something new.
        changeType: "added",
        bodyDelta: REQ.body.length,
      },
    ]);
  });

  it("storedLinkNotice names the stale links only when there are some", () => {
    expect(storedLinkNotice(2, 0)).toBe("2 stored requirement links seeded the files to edit.");
    expect(storedLinkNotice(1, 3)).toBe(
      "1 stored requirement link seeded the files to edit. 3 stored requirement links were dropped: the linked file is no longer in the code graph.",
    );
  });
});
