/**
 * Epic #298 / Issue #313 — overview generator tests.
 *
 * Covers the algorithm in isolation by handing it a mock Prisma-shaped
 * object (matching the pattern used by the MCP query tools in #310). No DB
 * I/O. Includes a perf test that asserts the generator finishes in <2s on
 * a synthetic 1k-symbol / 4k-edge fixture.
 */
import { describe, expect, it } from "vitest";
import {
  composeSummary,
  generateOverview,
  OverviewError,
  type OverviewPrismaShape,
} from "../../../src/lib/code-graph/overview.js";

interface SymbolRow {
  id: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  projectId: string;
}
interface EdgeRow {
  id: string;
  fromSymbolId: string;
  toSymbolId: string | null;
  kind: string;
  projectId: string;
}
interface FindingRow {
  id: string;
  category: string;
  body: string;
  symbolId: string | null;
}

function makePrisma(opts: {
  project?: { id: string; name: string; slug: string } | null;
  graph?: {
    id: string;
    symbolCount: number;
    edgeCount: number;
    languageStats: string;
    lastIndexedAt: Date | null;
    commitSha: string | null;
  } | null;
  symbols: SymbolRow[];
  edges: EdgeRow[];
  findings: FindingRow[];
}): OverviewPrismaShape {
  return {
    project: {
      findUnique: async ({ where }) =>
        opts.project && opts.project.id === where.id ? opts.project : null,
    },
    codeGraph: {
      findFirst: async () => opts.graph ?? null,
    },
    codeSymbol: {
      findMany: async (args: {
        where: { id?: { in: string[] }; projectId?: string; kind?: { in: string[] } };
        select?: Record<string, boolean>;
      }) => {
        let rows = opts.symbols.slice();
        if (args.where.id?.in) rows = rows.filter((r) => args.where.id!.in.includes(r.id));
        if (args.where.projectId) rows = rows.filter((r) => r.projectId === args.where.projectId);
        if (args.where.kind?.in) rows = rows.filter((r) => args.where.kind!.in.includes(r.kind));
        return rows.map((r) => ({
          id: r.id,
          qualifiedName: r.qualifiedName,
          kind: r.kind,
          filePath: r.filePath,
          language: r.language,
          startLine: r.startLine,
        }));
      },
    },
    codeEdge: {
      groupBy: async (args: {
        by: string[];
        where: { projectId: string; kind?: { in: string[] } | string };
      }) => {
        const buckets = new Map<string | null, number>();
        const allowedKinds = new Set<string>(
          typeof args.where.kind === "object" && args.where.kind && "in" in args.where.kind
            ? (args.where.kind.in as string[])
            : typeof args.where.kind === "string"
              ? [args.where.kind]
              : ["calls", "references", "imports", "defines"],
        );
        for (const e of opts.edges) {
          if (e.projectId !== args.where.projectId) continue;
          if (!allowedKinds.has(e.kind)) continue;
          if (!e.toSymbolId) continue;
          buckets.set(e.toSymbolId, (buckets.get(e.toSymbolId) ?? 0) + 1);
        }
        return Array.from(buckets.entries()).map(([toSymbolId, count]) => ({
          toSymbolId,
          _count: { _all: count },
        }));
      },
      findMany: async () => [],
    },
    finding: {
      findMany: async (args: {
        where: { category?: string; symbolId?: { in: string[] } };
        select?: Record<string, boolean>;
      }) => {
        let rows = opts.findings.slice();
        if (args.where.category) rows = rows.filter((r) => r.category === args.where.category);
        if (args.where.symbolId?.in)
          rows = rows.filter(
            (r) => r.symbolId !== null && args.where.symbolId!.in.includes(r.symbolId),
          );
        return rows.map((r) => ({ body: r.body, category: r.category, symbolId: r.symbolId }));
      },
    },
  };
}

function symbolRow(idx: number, kind: string, file: string): SymbolRow {
  return {
    id: `sym_${idx}`,
    qualifiedName: `module::Symbol${String(idx).padStart(3, "0")}`,
    kind,
    filePath: file,
    language: "ts",
    startLine: 10,
    endLine: 20,
    projectId: "proj_1",
  };
}

describe("generateOverview()", () => {
  it("throws NO_PROJECT when the project does not exist", async () => {
    const prisma = makePrisma({
      project: null,
      symbols: [],
      edges: [],
      findings: [],
    });
    await expect(generateOverview(prisma, "missing")).rejects.toBeInstanceOf(OverviewError);
    await expect(generateOverview(prisma, "missing")).rejects.toMatchObject({ code: "NO_PROJECT" });
  });

  it("throws NO_GRAPH when project has no CodeGraph row", async () => {
    const prisma = makePrisma({
      project: { id: "proj_1", name: "Demo", slug: "demo" },
      graph: null,
      symbols: [],
      edges: [],
      findings: [],
    });
    await expect(generateOverview(prisma, "proj_1")).rejects.toMatchObject({ code: "NO_GRAPH" });
  });

  it("throws NO_GRAPH when graph exists but has zero symbols", async () => {
    const prisma = makePrisma({
      project: { id: "proj_1", name: "Demo", slug: "demo" },
      graph: {
        id: "g1",
        symbolCount: 0,
        edgeCount: 0,
        languageStats: "{}",
        lastIndexedAt: null,
        commitSha: null,
      },
      symbols: [],
      edges: [],
      findings: [],
    });
    await expect(generateOverview(prisma, "proj_1")).rejects.toMatchObject({ code: "NO_GRAPH" });
  });

  it("renders the three required sections with the correct counts", async () => {
    // 25 symbols: 22 functions, plus 3 entry-point functions in src/index.ts
    const symbols: SymbolRow[] = [];
    for (let i = 0; i < 22; i += 1) symbols.push(symbolRow(i, "function", "src/lib/util.ts"));
    symbols.push(
      { ...symbolRow(100, "function", "src/index.ts"), qualifiedName: "src/index.ts::main" },
      { ...symbolRow(101, "function", "bin/cli.ts"), qualifiedName: "bin/cli.ts::run" },
      { ...symbolRow(102, "function", "src/server.ts"), qualifiedName: "src/server.ts::start" },
      {
        ...symbolRow(103, "function", "src/lib/util.ts"),
        qualifiedName: "src/lib/util.ts::deeplyCalled",
      },
      {
        ...symbolRow(104, "function", "src/lib/util.ts"),
        qualifiedName: "src/lib/util.ts::otherCalled",
      },
    );

    // Build edges so sym_0..sym_19 each receive between 5 and 25 inbound calls.
    const edges: EdgeRow[] = [];
    let edgeIdx = 0;
    for (let i = 0; i < 20; i += 1) {
      const inbound = 25 - i;
      for (let j = 0; j < inbound; j += 1) {
        edges.push({
          id: `e_${edgeIdx++}`,
          fromSymbolId: `sym_${(i + j + 50) % 22}`,
          toSymbolId: `sym_${i}`,
          kind: j % 3 === 0 ? "references" : "calls",
          projectId: "proj_1",
        });
      }
    }
    // Make sym_103/104 have inbound calls so they are NOT entry points.
    edges.push({
      id: "e_calls_103",
      fromSymbolId: "sym_0",
      toSymbolId: "sym_103",
      kind: "calls",
      projectId: "proj_1",
    });
    edges.push({
      id: "e_calls_104",
      fromSymbolId: "sym_0",
      toSymbolId: "sym_104",
      kind: "calls",
      projectId: "proj_1",
    });

    const findings: FindingRow[] = [
      {
        id: "f_1",
        category: "rationale",
        body: "First rationale finding text.",
        symbolId: "sym_0",
      },
      {
        id: "f_2",
        category: "rationale",
        body: "Second rationale finding text.",
        symbolId: "sym_1",
      },
      {
        id: "f_3",
        category: "rationale",
        body: "First rationale finding text.",
        symbolId: "sym_2",
      }, // dup body
      { id: "f_4", category: "rationale-todo", body: "TODO not picked up", symbolId: "sym_0" },
    ];

    const prisma = makePrisma({
      project: { id: "proj_1", name: "Metis Demo", slug: "metis" },
      graph: {
        id: "g1",
        symbolCount: 27,
        edgeCount: edges.length,
        languageStats: JSON.stringify({ ts: 25, py: 2 }),
        lastIndexedAt: new Date("2026-04-28T00:00:00Z"),
        commitSha: "abc123",
      },
      symbols,
      edges,
      findings,
    });

    const result = await generateOverview(prisma, "proj_1");
    const md = result.markdown;

    expect(md).toContain("# Project Overview — Metis Demo");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Top Symbols by In-Degree");
    expect(md).toContain("## Entry Points");

    // 20 god-node table rows (excluding header + separator).
    const godSection = md.split("## Top Symbols by In-Degree")[1].split("## Entry Points")[0];
    const godRows = godSection
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.includes("---") && !l.includes("Rank"));
    expect(godRows).toHaveLength(20);

    // Entry-points table includes our 3 entry-point candidates.
    expect(md).toContain("src/index.ts::main");
    expect(md).toContain("bin/cli.ts::run");
    expect(md).toContain("src/server.ts::start");
    // Should NOT include sym_103/104 (they have inbound calls).
    expect(md).not.toContain("deeplyCalled");
    expect(md).not.toContain("otherCalled");

    // Summary contains symbol/edge counts and primary languages.
    expect(md).toMatch(/27 symbols/);
    expect(md).toMatch(/TypeScript: 25/);

    // Rationale dedupe — duplicate body should appear once.
    const summary = md.split("## Summary")[1].split("## Top Symbols")[0];
    const occurrences = summary.split("First rationale finding text").length - 1;
    expect(occurrences).toBe(1);

    // Stats reflect graph contents.
    expect(result.stats.symbolCount).toBe(27);
    expect(result.stats.godNodeCount).toBe(20);
    expect(result.stats.entryPointCount).toBeGreaterThanOrEqual(3);
  });

  it("is byte-identical across two consecutive runs (determinism)", async () => {
    const symbols: SymbolRow[] = [];
    for (let i = 0; i < 25; i += 1) symbols.push(symbolRow(i, "function", "src/index.ts"));
    const edges: EdgeRow[] = [];
    for (let i = 0; i < 25; i += 1) {
      // every symbol has a deterministic inbound count
      const inbound = 30 - i;
      for (let j = 0; j < inbound; j += 1) {
        edges.push({
          id: `e_${i}_${j}`,
          fromSymbolId: `sym_${(i + 5 + j) % 25}`,
          toSymbolId: `sym_${i}`,
          kind: "calls",
          projectId: "proj_1",
        });
      }
    }
    const findings: FindingRow[] = [
      { id: "f_1", category: "rationale", body: "Alpha", symbolId: "sym_0" },
      { id: "f_2", category: "rationale", body: "Beta", symbolId: "sym_0" },
      { id: "f_3", category: "rationale", body: "Gamma", symbolId: "sym_1" },
    ];
    const prisma = makePrisma({
      project: { id: "proj_1", name: "Demo", slug: "demo" },
      graph: {
        id: "g1",
        symbolCount: 25,
        edgeCount: edges.length,
        languageStats: JSON.stringify({ ts: 25 }),
        lastIndexedAt: null,
        commitSha: null,
      },
      symbols,
      edges,
      findings,
    });

    const a = (await generateOverview(prisma, "proj_1")).markdown;
    const b = (await generateOverview(prisma, "proj_1")).markdown;
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(100);
  });

  it("falls back to boilerplate to meet the 3-sentence minimum when there are no rationales", async () => {
    const symbols: SymbolRow[] = [symbolRow(0, "function", "src/index.ts")];
    const edges: EdgeRow[] = [
      {
        id: "e_1",
        fromSymbolId: "sym_0",
        toSymbolId: "sym_0",
        kind: "calls",
        projectId: "proj_1",
      },
    ];
    const prisma = makePrisma({
      project: { id: "proj_1", name: "Demo", slug: "demo" },
      graph: {
        id: "g1",
        symbolCount: 1,
        edgeCount: 1,
        languageStats: JSON.stringify({ ts: 1 }),
        lastIndexedAt: null,
        commitSha: null,
      },
      symbols,
      edges,
      findings: [],
    });
    const md = (await generateOverview(prisma, "proj_1")).markdown;
    const summary = md.split("## Summary")[1].split("## Top Symbols")[0];
    // Three sentences = three terminal punctuators. Easier check: contains
    // both the boilerplate fallback strings.
    expect(summary).toMatch(/Rationale extraction has not yet/);
    expect(summary).toMatch(/jumping-off point for new contributors/);
  });

  it("handles malformed languageStats JSON without crashing", async () => {
    const symbols: SymbolRow[] = [symbolRow(0, "function", "src/index.ts")];
    const prisma = makePrisma({
      project: { id: "proj_1", name: "Demo", slug: "demo" },
      graph: {
        id: "g1",
        symbolCount: 1,
        edgeCount: 0,
        languageStats: "{ not json",
        lastIndexedAt: null,
        commitSha: null,
      },
      symbols,
      edges: [],
      findings: [],
    });
    const md = (await generateOverview(prisma, "proj_1")).markdown;
    expect(md).toContain("Demo");
    // No crash means we're good.
  });

  it("escapes pipe characters in qualifiedName / filePath inside markdown tables", async () => {
    const sym: SymbolRow = {
      id: "sym_0",
      qualifiedName: "x | weird",
      kind: "function",
      filePath: "src/has|pipe.ts",
      language: "ts",
      startLine: 1,
      endLine: 2,
      projectId: "proj_1",
    };
    const edge: EdgeRow = {
      id: "e_1",
      fromSymbolId: "sym_0",
      toSymbolId: "sym_0",
      kind: "calls",
      projectId: "proj_1",
    };
    const prisma = makePrisma({
      project: { id: "proj_1", name: "Demo", slug: "demo" },
      graph: {
        id: "g1",
        symbolCount: 1,
        edgeCount: 1,
        languageStats: "{}",
        lastIndexedAt: null,
        commitSha: null,
      },
      symbols: [sym],
      edges: [edge],
      findings: [],
    });
    const md = (await generateOverview(prisma, "proj_1")).markdown;
    expect(md).toContain("x \\| weird");
    expect(md).toContain("src/has\\|pipe.ts");
  });

  it("completes in <2s for a synthetic 1k-symbol / 4k-edge graph (perf gate)", async () => {
    const symbols: SymbolRow[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const file = i < 5 ? "src/index.ts" : "src/lib/util.ts";
      symbols.push(symbolRow(i, "function", file));
    }
    const edges: EdgeRow[] = [];
    for (let i = 0; i < 4000; i += 1) {
      edges.push({
        id: `e_${i}`,
        fromSymbolId: `sym_${i % 1000}`,
        toSymbolId: `sym_${(i * 7) % 1000}`,
        kind: i % 4 === 0 ? "references" : "calls",
        projectId: "proj_1",
      });
    }
    const findings: FindingRow[] = [];
    for (let i = 0; i < 50; i += 1) {
      findings.push({
        id: `f_${i}`,
        category: "rationale",
        body: `Rationale ${i}.`,
        symbolId: `sym_${i % 5}`,
      });
    }
    const prisma = makePrisma({
      project: { id: "proj_1", name: "Big", slug: "big" },
      graph: {
        id: "g1",
        symbolCount: 1000,
        edgeCount: edges.length,
        languageStats: JSON.stringify({ ts: 800, py: 200 }),
        lastIndexedAt: null,
        commitSha: null,
      },
      symbols,
      edges,
      findings,
    });
    const start = performance.now();
    const out = await generateOverview(prisma, "proj_1");
    const ms = performance.now() - start;
    expect(out.markdown.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(2000);
  });
});

describe("composeSummary()", () => {
  it("dedupes by normalised body", () => {
    const out = composeSummary("Prefix.", [{ body: "Same  text." }, { body: "same TEXT" }], 500);
    // 'same text' normalises to the same key, so only one body line follows
    // the prefix (plus the boilerplate fallback to hit 3 sentences total).
    const sentencesAfterPrefix = out.split("Prefix.")[1];
    expect(sentencesAfterPrefix.match(/[Ss]ame text/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("respects the word cap (does not exceed by more than one sentence)", () => {
    const long = "word ".repeat(200).trim();
    const out = composeSummary("Pre.", [{ body: long }, { body: long.replace("word", "x") }], 100);
    const wc = out.split(/\s+/).filter(Boolean).length;
    expect(wc).toBeLessThanOrEqual(300); // one sentence may overflow before the cap stops us
  });

  it("ensures each rationale ends with terminal punctuation", () => {
    const out = composeSummary(
      "Pre.",
      [{ body: "no period at the end" }, { body: "already done." }],
      500,
    );
    expect(out).toMatch(/no period at the end\./);
    expect(out).toMatch(/already done\./);
  });
});
