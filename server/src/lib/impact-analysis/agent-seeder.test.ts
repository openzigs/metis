/**
 * #1759 — the Analysis code agent's stored citations lead the files to edit.
 *
 * The hybrid side is the #1036 CAPTURE of production's `HybridCodeSearch` on
 * Miniflux #4478 (`__fixtures__/miniflux-4478-hits.json`), replayed, so "every
 * hybrid seed survives with its score" is checked on a real ranking.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { impactSeedEvidenceSchema } from "@metis/shared";
import {
  AGENT_SEEDS_FLAG,
  MAX_AGENT_LEAD_FILES,
  MAX_AGENT_TAIL_FILES,
  citationOrder,
  impactAgentSeedsEnabled,
  leadWithAgentCitations,
  prismaAgentCitationDeps,
  type AgentCitationDeps,
} from "./agent-seeder.js";
import { extractChangesByShape } from "./change-request.js";
import {
  RELATED_CONFIDENCE_FACTOR,
  resolveChangeSeeds,
  type ChangeSeeds,
  type SeedSearcher,
  type SeedSearchHit,
  type SeedSymbolRow,
  type StoredLinkRow,
} from "./change-seeds.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "__fixtures__", name), "utf8");
const CAPTURE = JSON.parse(read("miniflux-4478-hits.json")) as {
  queries: { query: string; hits: SeedSearchHit[] }[];
  symbols: SeedSymbolRow[];
};
const capturedSearcher: SeedSearcher = {
  async search(query) {
    const captured = CAPTURE.queries.find((q) => q.query === query);
    if (!captured) throw new Error(`no capture for query: ${query.slice(0, 60)}`);
    return captured.hits;
  },
};
const capturedLoader = async (ids: string[]) => CAPTURE.symbols.filter((s) => ids.includes(s.id));
const [CHANGE_4478] = extractChangesByShape(read("miniflux-4478.md"));

function row(id: string, filePath: string, over: Partial<SeedSymbolRow> = {}): SeedSymbolRow {
  return {
    id,
    qualifiedName: `${filePath}::${id}`,
    filePath,
    kind: "function",
    language: "go",
    startLine: 1,
    endLine: 9,
    ...over,
  };
}

function cite(filePath: string, over: Partial<StoredLinkRow> = {}): StoredLinkRow {
  return {
    codeSymbolId: null,
    filePath,
    startLine: null,
    endLine: null,
    confidence: 0.5,
    source: "analysis-grounding",
    ...over,
  };
}

/** New files only the agent names, each in the graph. */
const AGENT_FILES = Array.from({ length: 14 }, (_, i) => `internal/agent/f${i}.go`);
const GRAPH = [
  ...CAPTURE.symbols,
  ...AGENT_FILES.flatMap((f, i) => [
    row(`A${i}-1`, f, { startLine: 1, endLine: 20 }),
    row(`A${i}-2`, f, { startLine: 30, endLine: 40 }),
    row(`A${i}-MOD`, f, { kind: "module", startLine: 1, endLine: 99 }),
  ]),
];

function citationDeps(links: StoredLinkRow[], graph: SeedSymbolRow[] = GRAPH) {
  return {
    loadCitations: vi.fn(async () => links),
    loadFileSymbols: vi.fn(async (files: string[]) =>
      graph.filter((r) => files.includes(r.filePath)),
    ),
  } satisfies AgentCitationDeps;
}

let HYBRID: ChangeSeeds;
beforeAll(async () => {
  HYBRID = await resolveChangeSeeds(CHANGE_4478!, "p1", {
    searcher: capturedSearcher,
    loadSymbols: capturedLoader,
  });
});

const files = (seeds: ChangeSeeds) => [...new Set(seeds.editCandidates.map((m) => m.filePath))];
const lead = (links: StoredLinkRow[], seeds: ChangeSeeds = HYBRID, graph?: SeedSymbolRow[]) =>
  leadWithAgentCitations(seeds, "req-1", "p1", citationDeps(links, graph));

describe("leadWithAgentCitations (#1759)", () => {
  it("the capture gives a real ranking to lead: several hybrid edit files, and related hits", () => {
    expect(files(HYBRID).length).toBeGreaterThanOrEqual(3);
    expect(HYBRID.related.length).toBeGreaterThan(0);
  });

  it("every hybrid seed survives with its original score, whatever the agent cites", async () => {
    const hybridFiles = files(HYBRID);
    const scenarios: StoredLinkRow[][] = [
      [],
      [cite("gone/nowhere.go")],
      AGENT_FILES.map((f) => cite(f, { confidence: 1 })),
      [...hybridFiles].reverse().map((f) => cite(f, { confidence: 0 })),
      [cite(hybridFiles[2]!), ...AGENT_FILES.map((f) => cite(f))],
    ];
    for (const links of scenarios) {
      const out = await lead(links);
      for (const m of HYBRID.editCandidates) {
        // The same object, so the same score, the same symbol and the same lines.
        expect(out.editCandidates).toContain(m);
      }
      // None of these files is a related one: every related hit stays, as itself.
      for (const m of HYBRID.related) expect(out.related).toContain(m);
      expect(out.schemaSeeds).toBe(HYBRID.schemaSeeds);
    }
  });

  it("puts the cited files first, in citation order, and keeps the rest in their order", async () => {
    const hybridFiles = files(HYBRID);
    const out = await lead([
      cite(AGENT_FILES[0]!),
      cite(hybridFiles[2]!),
      cite(AGENT_FILES[0]!, { startLine: 30, endLine: 35 }),
      cite(AGENT_FILES[1]!),
    ]);
    expect(files(out)).toEqual([
      AGENT_FILES[0],
      hybridFiles[2],
      AGENT_FILES[1],
      ...hybridFiles.filter((f) => f !== hybridFiles[2]),
    ]);
    // A cited hybrid file moves as its own objects, not as new ones.
    expect(out.editCandidates.filter((m) => m.filePath === hybridFiles[2])).toEqual(
      HYBRID.editCandidates.filter((m) => m.filePath === hybridFiles[2]),
    );
    // A new file is seeded with the graph's symbols on the cited lines, at the citation's confidence.
    const a0 = out.editCandidates.filter((m) => m.filePath === AGENT_FILES[0]);
    expect(a0.map((m) => m.codeSymbolId)).toEqual(["A0-1", "A0-2"]);
    expect(a0.every((m) => m.confidence === 0.5)).toBe(true);
    expect(out.evidence?.agentCitations).toEqual({
      used: 4,
      stale: 0,
      led: 3,
      demotedStaleCitations: 0,
      unverifiedCitations: 4,
    });
  });

  it("leads with at most MAX_AGENT_LEAD_FILES files; later citations follow the candidates", async () => {
    const hybridFiles = files(HYBRID);
    const out = await lead([
      ...AGENT_FILES.slice(0, MAX_AGENT_LEAD_FILES).map((f) => cite(f)),
      cite(hybridFiles[1]!),
      cite(AGENT_FILES[5]!),
    ]);
    expect(files(out)).toEqual([
      ...AGENT_FILES.slice(0, MAX_AGENT_LEAD_FILES),
      ...hybridFiles,
      AGENT_FILES[5],
    ]);
    expect(out.evidence?.agentCitations?.led).toBe(MAX_AGENT_LEAD_FILES);
    // A hybrid file cited past the lead keeps its place, and is marked as cited.
    const second = out.evidence!.editCandidates.find((e) => e.filePath === hybridFiles[1]);
    expect(second?.channels).toEqual(["hybrid", "code-agent"]);
  });

  it("reads the surer citations first, then in stored order (#1818)", async () => {
    const out = await lead([
      cite(AGENT_FILES[0]!, { confidence: 0.5 }),
      cite(AGENT_FILES[1]!, { confidence: 0.9 }),
      cite(AGENT_FILES[2]!, { confidence: 0.5 }),
      cite(AGENT_FILES[3]!, { confidence: 0.9 }),
    ]);
    expect(files(out).slice(0, 4)).toEqual([
      AGENT_FILES[1],
      AGENT_FILES[3],
      AGENT_FILES[0],
      AGENT_FILES[2],
    ]);
  });

  it("caps the tail; a cited file past it is listed under related and seeds nothing (#1818)", async () => {
    const cited = AGENT_FILES.slice(0, MAX_AGENT_LEAD_FILES + MAX_AGENT_TAIL_FILES + 2);
    const out = await lead(cited.map((f) => cite(f)));
    const lead5 = cited.slice(0, MAX_AGENT_LEAD_FILES);
    const tail = cited.slice(MAX_AGENT_LEAD_FILES, MAX_AGENT_LEAD_FILES + MAX_AGENT_TAIL_FILES);
    const overflow = cited.slice(MAX_AGENT_LEAD_FILES + MAX_AGENT_TAIL_FILES);
    expect(files(out)).toEqual([...lead5, ...files(HYBRID), ...tail]);
    expect(out.editCandidates.some((m) => overflow.includes(m.filePath))).toBe(false);
    const listed = out.related.filter((m) => overflow.includes(m.filePath));
    expect([...new Set(listed.map((m) => m.filePath))]).toEqual(overflow);
    expect(listed.every((m) => m.confidence === 0.5 * RELATED_CONFIDENCE_FACTOR)).toBe(true);
    for (const m of HYBRID.related) expect(out.related).toContain(m);
    expect(out.evidence?.agentCitations).toEqual({
      used: cited.length,
      stale: 0,
      led: 5,
      demotedStaleCitations: 0,
      unverifiedCitations: cited.length,
    });
  });

  it("a cited file that is already a candidate takes no tail slot (#1825)", async () => {
    const hybridFiles = files(HYBRID);
    const lead5 = AGENT_FILES.slice(0, MAX_AGENT_LEAD_FILES);
    const tail = AGENT_FILES.slice(
      MAX_AGENT_LEAD_FILES,
      MAX_AGENT_LEAD_FILES + MAX_AGENT_TAIL_FILES,
    );
    // Past the lead: a hybrid candidate first, then a full tail of new files.
    const out = await lead([...lead5, hybridFiles[1]!, ...tail].map((f) => cite(f)));
    // Every new file past the lead is still to edit: the candidate used no slot.
    expect(files(out)).toEqual([...lead5, ...hybridFiles, ...tail]);
    expect(out.related.some((m) => tail.includes(m.filePath))).toBe(false);
    // And the candidate's hits are listed once, where the hybrid search put them.
    const theirs = HYBRID.editCandidates.filter((m) => m.filePath === hybridFiles[1]);
    expect(out.editCandidates.filter((m) => m.filePath === hybridFiles[1])).toEqual(theirs);
  });

  it("a cited file past the tail that is already related is listed there once (#1825)", async () => {
    const relatedFile = HYBRID.related.find((m) => !files(HYBRID).includes(m.filePath))!.filePath;
    const before = HYBRID.related.filter((m) => m.filePath === relatedFile);
    const cited = AGENT_FILES.slice(0, MAX_AGENT_LEAD_FILES + MAX_AGENT_TAIL_FILES);
    const out = await lead([...cited, relatedFile].map((f) => cite(f)));
    // The graph holds the file: the citation is used, and it overflows the tail.
    expect(out.evidence?.agentCitations?.used).toBe(cited.length + 1);
    expect(files(out)).not.toContain(relatedFile);
    // Its related hits are the search's, unchanged, and not added a second time.
    expect(out.related.filter((m) => m.filePath === relatedFile)).toEqual(before);
  });

  it("removes a cited file's hits from related: never both to edit and related (#1818)", async () => {
    const relatedFile = HYBRID.related.find((m) => !files(HYBRID).includes(m.filePath))!.filePath;
    const out = await lead([cite(relatedFile)]);
    expect(files(out)[0]).toBe(relatedFile);
    expect(out.related).toEqual(HYBRID.related.filter((m) => m.filePath !== relatedFile));
  });

  it("drops and counts a citation whose file the graph no longer holds; every named file resolves", async () => {
    const out = await lead([
      cite("gone/one.go"),
      cite(AGENT_FILES[3]!),
      cite("gone/two.go"),
      cite("gone/one.go", { startLine: 4, endLine: 6 }),
    ]);
    expect(out.evidence?.agentCitations).toEqual({
      used: 1,
      stale: 3,
      led: 1,
      demotedStaleCitations: 0,
      unverifiedCitations: 1,
    });
    const graphFiles = new Set(GRAPH.map((r) => r.filePath));
    expect(out.editCandidates.every((m) => graphFiles.has(m.filePath))).toBe(true);
    expect(files(out)[0]).toBe(AGENT_FILES[3]);
  });

  it("with no usable citation, leaves the candidates as they were and counts what it read", async () => {
    const none = await lead([]);
    expect(none.editCandidates).toEqual(HYBRID.editCandidates);
    expect(none.evidence?.agentCitations).toEqual({
      used: 0,
      stale: 0,
      led: 0,
      demotedStaleCitations: 0,
      unverifiedCitations: 0,
    });
    const stale = await lead([cite("gone/one.go")]);
    expect(stale.editCandidates).toEqual(HYBRID.editCandidates);
    expect(stale.evidence?.agentCitations).toEqual({
      used: 0,
      stale: 1,
      led: 0,
      demotedStaleCitations: 0,
      unverifiedCitations: 0,
    });
    expect(stale.evidence?.editCandidates.map((e) => e.filePath)).toEqual(files(HYBRID));
  });

  it("never throws: a lookup fault keeps the seeds and counts nothing", async () => {
    const deps: AgentCitationDeps = {
      loadCitations: async () => {
        throw new Error("db down");
      },
      loadFileSymbols: vi.fn(async () => []),
    };
    const out = await leadWithAgentCitations(HYBRID, "req-1", "p1", deps);
    expect(out.editCandidates).toEqual(HYBRID.editCandidates);
    expect(out.evidence?.agentCitations).toEqual({
      used: 0,
      stale: 0,
      led: 0,
      demotedStaleCitations: 0,
      unverifiedCitations: 0,
    });
    expect(deps.loadFileSymbols).not.toHaveBeenCalled();
  });

  it("reads the requirement's citations in the given project, and symbols in that project only", async () => {
    const deps = citationDeps([cite(AGENT_FILES[0]!)]);
    await leadWithAgentCitations(HYBRID, "req-9", "proj-9", deps);
    expect(deps.loadCitations).toHaveBeenCalledWith("req-9", "proj-9");
    expect(deps.loadFileSymbols).toHaveBeenCalledWith([AGENT_FILES[0]], "proj-9");
  });

  it("keeps an earlier channel's evidence and adds code-agent to the files it cites", async () => {
    const hybridFiles = files(HYBRID);
    const seeds: ChangeSeeds = {
      ...HYBRID,
      evidence: {
        storedLinks: { used: 1, stale: 0 },
        editCandidates: hybridFiles.map((filePath, i) => ({
          filePath,
          channels: i === 0 ? ["hybrid", "stored-link"] : ["hybrid"],
          baseScore: 1 - i / 10,
          ...(i === 1 ? { verdict: { kind: "doubtful" as const, reason: "unrelated" } } : {}),
        })),
      },
    };
    const out = await lead([cite(hybridFiles[1]!), cite(AGENT_FILES[0]!)], seeds);
    const evidence = impactSeedEvidenceSchema.parse(out.evidence);
    expect(evidence.storedLinks).toEqual({ used: 1, stale: 0 });
    expect(evidence.editCandidates.map((e) => e.filePath)).toEqual([
      hybridFiles[1],
      AGENT_FILES[0],
      hybridFiles[0],
      ...hybridFiles.slice(2),
    ]);
    expect(evidence.editCandidates[0]).toEqual({
      filePath: hybridFiles[1],
      channels: ["hybrid", "code-agent"],
      baseScore: 0.9,
      verdict: { kind: "doubtful", reason: "unrelated" },
    });
    expect(evidence.editCandidates[1]).toEqual({
      filePath: AGENT_FILES[0],
      channels: ["code-agent"],
    });
    expect(evidence.editCandidates[2]?.channels).toEqual(["hybrid", "stored-link"]);
  });

  it("seeds a cited symbol by its own id when the citation names one in the graph", async () => {
    const out = await lead([cite(AGENT_FILES[2]!, { codeSymbolId: "A2-2", confidence: 3 })]);
    const head = out.editCandidates[0]!;
    expect(head).toMatchObject({ codeSymbolId: "A2-2", filePath: AGENT_FILES[2] });
    // A model-reported confidence is clamped to [0, 1].
    expect(head.confidence).toBe(1);
  });
});

describe("citationOrder (#1818)", () => {
  it("puts the surer first and keeps the stored order between equal confidences", () => {
    const links = [
      cite("a.go", { confidence: 0.5 }),
      cite("b.go", { confidence: 0.8 }),
      cite("c.go", { confidence: 0.5 }),
      cite("d.go", { confidence: 0.8 }),
      cite("e.go", { confidence: 0.2 }),
    ];
    expect(citationOrder(links).map((l) => l.filePath)).toEqual([
      "b.go",
      "d.go",
      "a.go",
      "c.go",
      "e.go",
    ]);
    // It does not reorder the caller's array.
    expect(links.map((l) => l.filePath)).toEqual(["a.go", "b.go", "c.go", "d.go", "e.go"]);
  });
});

describe("freshness demotion (#1832)", () => {
  it("a stale citation is not in the lead files and the fresh one is first", async () => {
    const out = await lead([
      cite(AGENT_FILES[0]!, { confidence: 0.9, freshness: "stale" }),
      cite(AGENT_FILES[1]!, { confidence: 0.4, freshness: "fresh" }),
    ]);
    expect(files(out)[0]).toBe(AGENT_FILES[1]);
    expect(files(out)).not.toContain(AGENT_FILES[0]);
    expect(out.related.map((m) => m.filePath)).not.toContain(AGENT_FILES[0]);
    expect(out.evidence?.agentCitations).toEqual({
      used: 1,
      stale: 0,
      led: 1,
      demotedStaleCitations: 1,
      unverifiedCitations: 0,
    });
  });

  it("a stale citation of a file the hybrid search found leaves that file where search ranked it", async () => {
    const hybridFiles = files(HYBRID);
    const searched = hybridFiles[2]!;
    const out = await lead([
      cite(searched, { confidence: 1, freshness: "stale" }),
      cite(AGENT_FILES[0]!, { freshness: "fresh" }),
    ]);
    // The search's own order after the lead: the stale citation did not move it up.
    expect(files(out)).toEqual([AGENT_FILES[0], ...hybridFiles]);
    expect(out.editCandidates.filter((m) => m.filePath === searched)).toEqual(
      HYBRID.editCandidates.filter((m) => m.filePath === searched),
    );
    const channels = out.evidence?.editCandidates.find((e) => e.filePath === searched)?.channels;
    expect(channels).toEqual(["hybrid"]);
  });

  it("unverified citations rank after fresh and moved ones, and are not dropped", async () => {
    const out = await lead([
      cite(AGENT_FILES[0]!, { confidence: 1 }), // no column read: unverified
      cite(AGENT_FILES[1]!, { confidence: 1, freshness: "unverified" }),
      cite(AGENT_FILES[2]!, { confidence: 0.1, freshness: "moved" }),
      cite(AGENT_FILES[3]!, { confidence: 0.2, freshness: "fresh" }),
    ]);
    expect(files(out).slice(0, 4)).toEqual([
      AGENT_FILES[3],
      AGENT_FILES[2],
      AGENT_FILES[0],
      AGENT_FILES[1],
    ]);
    expect(out.evidence?.agentCitations).toMatchObject({
      used: 4,
      led: 4,
      demotedStaleCitations: 0,
      unverifiedCitations: 2,
    });
  });

  it("only stale citations: the seeds are as they were, and every one is counted", async () => {
    const out = await lead([
      cite(AGENT_FILES[0]!, { freshness: "stale" }),
      cite(AGENT_FILES[1]!, { freshness: "stale" }),
    ]);
    expect(out.editCandidates).toEqual(HYBRID.editCandidates);
    expect(out.evidence?.agentCitations).toEqual({
      used: 0,
      stale: 0,
      led: 0,
      demotedStaleCitations: 2,
      unverifiedCitations: 0,
    });
  });

  it("citationOrder: freshness tier first, then confidence, then stored order", () => {
    const order = citationOrder([
      cite("u.go", { confidence: 0.9 }),
      cite("m.go", { confidence: 0.1, freshness: "moved" }),
      cite("f2.go", { confidence: 0.3, freshness: "fresh" }),
      cite("f1.go", { confidence: 0.6, freshness: "fresh" }),
    ]);
    expect(order.map((l) => l.filePath)).toEqual(["f1.go", "f2.go", "m.go", "u.go"]);
  });
});

describe("prismaAgentCitationDeps (#1759)", () => {
  it("reads only the code agent's links, for the requirement AND the project, in stored order", async () => {
    const mappings = vi.fn(async () => [] as StoredLinkRow[]);
    const symbols = vi.fn(async () => [] as SeedSymbolRow[]);
    const deps = prismaAgentCitationDeps({
      requirementCodeMapping: { findMany: mappings },
      codeSymbol: { findMany: symbols },
    } as never);
    await deps.loadCitations("req-1", "proj-1");
    expect(mappings).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requirementId: "req-1", projectId: "proj-1", source: "analysis-grounding" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
    await deps.loadFileSymbols(["a.go"], "proj-1");
    expect(symbols).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "proj-1", filePath: { in: ["a.go"] } } }),
    );
  });
});

describe("impactAgentSeedsEnabled (#1759)", () => {
  const prior = process.env[AGENT_SEEDS_FLAG];
  afterEach(() => {
    if (prior === undefined) delete process.env[AGENT_SEEDS_FLAG];
    else process.env[AGENT_SEEDS_FLAG] = prior;
  });

  it("is on by default (#1823) and off only when the flag says so", () => {
    delete process.env[AGENT_SEEDS_FLAG];
    expect(impactAgentSeedsEnabled()).toBe(true);
    process.env[AGENT_SEEDS_FLAG] = "0";
    expect(impactAgentSeedsEnabled()).toBe(false);
    process.env[AGENT_SEEDS_FLAG] = "false";
    expect(impactAgentSeedsEnabled()).toBe(false);
    process.env[AGENT_SEEDS_FLAG] = "1";
    expect(impactAgentSeedsEnabled()).toBe(true);
  });
});
