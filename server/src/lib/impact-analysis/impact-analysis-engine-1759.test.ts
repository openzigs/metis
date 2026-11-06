/**
 * #1759 — an impact run about stored requirements, with the Analysis code
 * agent's stored citations leading the files to edit (`IMPACT_AGENT_SEEDS`).
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
import { impactSeedEvidenceSchema } from "@metis/shared";
import type { GraphSymbol } from "../code-graph/query-service.js";
import type { ChangeSeeds, SeedSearchHit, SeedSymbolRow, StoredLinkRow } from "./change-seeds.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "__fixtures__", name), "utf8");
const ISSUE_4478 = read("miniflux-4478.md");
const CAPTURE = JSON.parse(read("miniflux-4478-hits.json")) as {
  queries: { query: string; hits: SeedSearchHit[] }[];
  symbols: SeedSymbolRow[];
};

const search = vi.fn(async (query: string) => {
  const captured = CAPTURE.queries.find((q) => q.query === query);
  return captured ? captured.hits : CAPTURE.queries[0]!.hits;
});
vi.mock("../code-graph/project-code-searcher.js", () => ({
  createDefaultCodeSearcher: () => ({ search }),
  createRunScopedSymbolIndex: () => ({}),
}));

const {
  executeImpactAnalysis,
  computeProjectImpact,
  InMemoryCodeGraphDataSource,
  agentCitationNotice,
} = await import("./impact-analysis-engine.js");

/** A file only the code agent cites: not in the captured hits. */
const CITED_FILE = "internal/reader/processor/age.go";
const CITED: SeedSymbolRow = {
  id: "CITED-1",
  qualifiedName: `${CITED_FILE}::filterByAge`,
  filePath: CITED_FILE,
  kind: "function",
  language: "go",
  startLine: 10,
  endLine: 40,
};
const GRAPH_ROWS = [...CAPTURE.symbols, CITED];
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

type Link = StoredLinkRow & { requirementId: string; projectId: string };

function prismaMock(run: Record<string, unknown>, links: Link[] = []) {
  const analyses = new Map<string, Record<string, unknown>>([["ia", { id: "ia", ...run }]]);
  const items: Record<string, unknown>[] = [];
  const affected: Record<string, unknown>[] = [];
  const mappingFindMany = vi.fn(
    async ({ where }: { where: { requirementId: string; projectId: string; source?: string } }) =>
      links.filter(
        (l) =>
          l.requirementId === where.requirementId &&
          l.projectId === where.projectId &&
          (where.source === undefined || l.source === where.source),
      ),
  );
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
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [REQ].filter((r) => where.id.in.includes(r.id)),
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

const reqRun = () => ({
  sourceText: null,
  documentId: null,
  requirementIds: JSON.stringify([REQ.id]),
});

const cite = (filePath: string, over: Partial<Link> = {}): Link => ({
  requirementId: REQ.id,
  projectId: "p1",
  codeSymbolId: null,
  filePath,
  startLine: null,
  endLine: null,
  confidence: 0.6,
  source: "analysis-grounding",
  ...over,
});

const run = (prisma: unknown, extra: Record<string, unknown> = {}) =>
  executeImpactAnalysis("ia", ["p1"], {
    prisma: prisma as never,
    dataSourceFor: () => graph,
    includeSchemaImpact: false,
    ...extra,
  });

const evidenceOf = (item: Record<string, unknown>) =>
  impactSeedEvidenceSchema.parse(JSON.parse(String(item.seedEvidence)));

beforeEach(() => search.mockClear());

describe("a run about stored requirements with IMPACT_AGENT_SEEDS (#1759)", () => {
  it("with the flag off: the stored citations change nothing (as if none were stored)", async () => {
    // #1818 — the reference has NO citation stored, so a flag-off run that
    // read or applied the citations would differ from it. (Comparing the flag
    // absent with the flag false ran one branch twice and proved nothing.)
    const plain = prismaMock(reqRun(), []);
    await run(plain.prisma);
    const off = prismaMock(reqRun(), [cite(CITED_FILE)]);
    await run(off.prisma, { agentSeeds: false });
    expect(off.mappingFindMany).not.toHaveBeenCalled();
    expect("seedEvidence" in off.items[0]!).toBe(false);
    expect(off.items).toEqual(plain.items);
    expect(off.affected).toEqual(plain.affected);
    expect(off.analyses.get("ia")?.summary).toEqual(plain.analyses.get("ia")?.summary);
  });

  it("with the flag on: the cited file leads the edit order, and the run says so", async () => {
    const { prisma, items, affected, analyses } = prismaMock(reqRun(), [
      cite(CITED_FILE),
      cite("internal/reader/removed.go"),
      // Another channel's link: not the code agent's, so not read here.
      cite("internal/model/user.go", { source: "manual" }),
    ]);
    await run(prisma, { agentSeeds: true });
    const evidence = evidenceOf(items[0]!);
    expect(evidence.agentCitations).toEqual({
      used: 1,
      stale: 1,
      led: 1,
      demotedStaleCitations: 0,
      unverifiedCitations: 1,
    });
    expect(evidence.editCandidates[0]).toEqual({ filePath: CITED_FILE, channels: ["code-agent"] });
    expect(evidence.editCandidates.slice(1).every((e) => e.channels.includes("hybrid"))).toBe(true);
    expect(affected.find((s) => s.codeSymbolId === "CITED-1")).toMatchObject({
      relation: "direct",
      depth: 0,
      confidence: 0.6,
    });
    expect(String(analyses.get("ia")?.summary)).toContain(
      '\n\n1 code-agent citation from "Evaluate new requirements" put 1 file at the top of the files to edit; every file the search picked is still listed. 1 code-agent citation was dropped: the cited file is no longer in the code graph.',
    );
  });

  it("with the flag on: every hybrid seed is persisted with its original score", async () => {
    const off = prismaMock(reqRun(), [cite(CITED_FILE)]);
    await run(off.prisma);
    const on = prismaMock(reqRun(), [cite(CITED_FILE)]);
    await run(on.prisma, { agentSeeds: true });
    const direct = (rows: Record<string, unknown>[]) =>
      rows.filter((r) => r.relation === "direct" && r.codeSymbolId !== "CITED-1");
    expect(direct(off.affected).length).toBeGreaterThan(0);
    expect(direct(on.affected)).toEqual(direct(off.affected));
  });

  it("leaves a pasted-text run exactly as it was, flag on or off", async () => {
    const textRun = () => ({ sourceText: ISSUE_4478, documentId: null });
    const off = prismaMock(textRun(), [cite(CITED_FILE)]);
    await run(off.prisma);
    const on = prismaMock(textRun(), [cite(CITED_FILE)]);
    await run(on.prisma, { agentSeeds: true });
    expect(on.items).toEqual(off.items);
    expect(on.affected).toEqual(off.affected);
    expect(on.analyses.get("ia")?.summary).toEqual(off.analyses.get("ia")?.summary);
    expect(on.mappingFindMany).not.toHaveBeenCalled();
  });

  it("does not read another project's citations for the same requirement", async () => {
    const { prisma, mappingFindMany, items } = prismaMock(reqRun(), [
      cite(CITED_FILE, { projectId: "p-other" }),
    ]);
    await run(prisma, { agentSeeds: true });
    expect(mappingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requirementId: REQ.id, projectId: "p1", source: "analysis-grounding" },
      }),
    );
    expect(evidenceOf(items[0]!).agentCitations).toEqual({
      used: 0,
      stale: 0,
      led: 0,
      demotedStaleCitations: 0,
      unverifiedCitations: 0,
    });
  });
});

describe("computeProjectImpact: the citations lead after the LLM re-order (#1759)", () => {
  const SEED = (id: string, filePath: string) => ({
    codeSymbolId: id,
    filePath,
    qualifiedName: `${filePath}::${id}`,
    startLine: 1,
    endLine: 9,
    confidence: id === "S1" ? 1 : 0.8,
  });
  const seeds: ChangeSeeds = {
    editCandidates: [SEED("S1", "a.go"), SEED("S2", "b.go")],
    related: [],
    schemaSeeds: [],
    filePool: [
      { filePath: "a.go", score: 1, editCandidate: true, symbols: [] },
      { filePath: "b.go", score: 0.8, editCandidate: true, symbols: [] },
    ],
  };
  const cGraph = new InMemoryCodeGraphDataSource(
    [
      {
        id: "S1",
        qualifiedName: "a",
        kind: "function",
        filePath: "a.go",
        language: "go",
        startLine: 1,
        endLine: 9,
      },
      {
        id: "S2",
        qualifiedName: "b",
        kind: "function",
        filePath: "b.go",
        language: "go",
        startLine: 1,
        endLine: 9,
      },
    ],
    [],
  );
  const change = {
    requirementId: "req-1",
    title: "t",
    body: "b",
    changeType: "modified" as const,
    bodyDelta: 1,
  };

  it("a re-order that ranks a.go first cannot push the cited b.go down", async () => {
    const reranker = vi.fn(async () => ({
      applied: true,
      picks: [
        {
          filePath: "a.go",
          line: 2,
          reason: "r",
          symbol: {
            id: "S1",
            qualifiedName: "a",
            filePath: "a.go",
            kind: "function",
            language: "go",
            startLine: 1,
            endLine: 9,
          },
        },
      ],
      droppedPicks: 0,
      namedFiles: ["a.go"],
    }));
    const loadCitations = vi.fn(async () => [
      {
        codeSymbolId: "S2",
        filePath: "b.go",
        startLine: 1,
        endLine: 9,
        confidence: 0.5,
        source: "analysis-grounding",
      },
    ]);
    const result = await computeProjectImpact(change, "p1", {
      mapRequirement: async () => [],
      seedChange: async () => seeds,
      editCandidateReranker: reranker,
      agentSeeds: {
        loadCitations,
        loadFileSymbols: async (files) =>
          files.includes("b.go")
            ? [
                {
                  id: "S2",
                  qualifiedName: "b",
                  filePath: "b.go",
                  kind: "function",
                  language: "go",
                  startLine: 1,
                  endLine: 9,
                },
              ]
            : [],
      },
      dataSourceFor: () => cGraph,
      includeSchemaImpact: false,
    });
    expect(reranker).toHaveBeenCalled();
    expect(loadCitations).toHaveBeenCalledWith("req-1", "p1");
    expect(result.seedEvidence?.editCandidates.map((e) => e.filePath)).toEqual(["b.go", "a.go"]);
    expect(result.seedEvidence?.reranker).toBeDefined();
    expect(result.seedEvidence?.agentCitations).toEqual({
      used: 1,
      stale: 0,
      led: 1,
      demotedStaleCitations: 0,
      unverifiedCitations: 1,
    });
  });

  it("a change with no tracked requirement reads no citation", async () => {
    const loadCitations = vi.fn(async () => []);
    const result = await computeProjectImpact({ ...change, requirementId: null }, "p1", {
      mapRequirement: async () => [],
      seedChange: async () => seeds,
      agentSeeds: { loadCitations, loadFileSymbols: async () => [] },
      dataSourceFor: () => cGraph,
      includeSchemaImpact: false,
    });
    expect(loadCitations).not.toHaveBeenCalled();
    expect(result.seedEvidence).toBeUndefined();
  });
});

describe("agentCitationNotice (#1759)", () => {
  it("names the led files, and the stale citations only when there are some", () => {
    expect(agentCitationNotice({ used: 3, stale: 0, led: 2 })).toBe(
      '3 code-agent citations from "Evaluate new requirements" put 2 files at the top of the files to edit; every file the search picked is still listed.',
    );
    expect(agentCitationNotice({ used: 0, stale: 0, led: 0 })).toBe(
      'No code-agent citation from "Evaluate new requirements" seeded the files to edit.',
    );
    expect(agentCitationNotice({ used: 0, stale: 2, led: 0 })).toBe(
      'No code-agent citation from "Evaluate new requirements" seeded the files to edit. 2 code-agent citations were dropped: the cited file is no longer in the code graph.',
    );
  });

  it("#1832 — says how many out-of-date citations were set aside, only when there are some", () => {
    expect(agentCitationNotice({ used: 1, stale: 0, led: 1, demoted: 0 })).toBe(
      agentCitationNotice({ used: 1, stale: 0, led: 1 }),
    );
    expect(agentCitationNotice({ used: 1, stale: 1, led: 1, demoted: 2 })).toBe(
      '1 code-agent citation from "Evaluate new requirements" put 1 file at the top of the files to edit; every file the search picked is still listed. 1 code-agent citation was dropped: the cited file is no longer in the code graph. 2 code-agent citations were set aside: the code they cite changed since the analysis.',
    );
  });
});

describe("IMPACT_AGENT_SEEDS off: freshness changes nothing (#1832)", () => {
  it("a run with fresh, stale and unverified citations is the run with none (snapshot)", async () => {
    const plain = prismaMock(reqRun(), []);
    await run(plain.prisma);
    const off = prismaMock(reqRun(), [
      cite(CITED_FILE, { freshness: "stale", confidence: 0.99 }),
      cite("internal/reader/fresh.go", { freshness: "fresh" }),
      cite("internal/reader/old.go", { freshness: "unverified" }),
    ]);
    await run(off.prisma, { agentSeeds: false });
    expect(off.mappingFindMany).not.toHaveBeenCalled();
    expect(off.items).toEqual(plain.items);
    expect(off.affected).toEqual(plain.affected);
    expect(off.analyses.get("ia")?.summary).toEqual(plain.analyses.get("ia")?.summary);
    const directFiles = [
      ...new Set(
        off.affected.filter((a) => a.relation === "direct").map((a) => String(a.filePath)),
      ),
    ];
    expect({ items: off.items.length, directFiles }).toMatchInlineSnapshot(`
      {
        "directFiles": [
          "internal/ui/unread_mark_all_read.go",
          "client/client.go",
          "internal/storage/entry.go",
          "internal/ui/static/js/app.js",
          "internal/storage/feed.go",
        ],
        "items": 1,
      }
    `);
  });
});
