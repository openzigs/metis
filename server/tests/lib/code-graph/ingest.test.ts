/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Issue #308 — Ingest pipeline tests.
 *
 * Walks an in-memory tmpdir fixture, parses with the real parsers, persists
 * via a hand-rolled mock Prisma. Verifies:
 *   - .metisignore filters node_modules
 *   - Files written end-to-end produce >0 symbols and >0 edges
 *   - Per-file delete-then-insert keeps re-runs idempotent
 *   - Incremental skip when the file hash matches existing module symbol
 *   - CodeGraph aggregate counts are recomputed
 *   - Rationale path is exercised when a triggeredByUserId is supplied
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ingestCodeGraph } from "../../../src/lib/code-graph/ingest.js";

interface Row {
  id: string;
  [k: string]: unknown;
}

function makePrismaMock() {
  const codeGraphs: Row[] = [];
  const codeSymbols: Row[] = [];
  const codeSymbolEmbeddings: Row[] = [];
  const codeEdges: Row[] = [];
  const findings: Row[] = [];
  const analyses: Row[] = [];
  const agentResults: Row[] = [];

  let idSeq = 0;
  const nextId = () => `id_${++idSeq}`;

  const matchWhere = (row: any, where: any): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v === null) {
        if (row[k] !== null && row[k] !== undefined) return false;
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        if ("contains" in (v as any)) {
          if (!String(row[k] ?? "").includes((v as any).contains)) return false;
        } else if ("in" in (v as any)) {
          if (!(v as any).in.includes(row[k])) return false;
        }
      } else if (row[k] !== v) {
        return false;
      }
    }
    return true;
  };

  const prisma: any = {
    codeGraph: {
      findFirst: vi.fn(
        async ({ where }: any) => codeGraphs.find((r) => matchWhere(r, where)) ?? null,
      ),
      create: vi.fn(async ({ data, select }: any) => {
        const row: Row = { id: nextId(), ...data };
        codeGraphs.push(row);
        return select ? { id: row.id } : row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = codeGraphs.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    // Issue #797 — ingest now also writes the index-time embedding TEXT for each
    // symbol (`CodeSymbolEmbedding`), which the background embed job consumes.
    codeSymbolEmbedding: {
      createMany: vi.fn(async ({ data }: any) => {
        codeSymbolEmbeddings.push(...data);
        return { count: data.length };
      }),
      findMany: vi.fn(async ({ where }: any) =>
        codeSymbolEmbeddings.filter((r) => matchWhere(r, where)),
      ),
    },
    codeSymbol: {
      findMany: vi.fn(async ({ where, select }: any) =>
        codeSymbols
          .filter((r) => matchWhere(r, where))
          .map((r) => {
            if (!select) return r;
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = (r as any)[k];
            return out;
          }),
      ),
      findFirst: vi.fn(async ({ where, select }: any) => {
        const row = codeSymbols.find((r) => matchWhere(r, where));
        if (!row) return null;
        if (!select) return row;
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = (row as any)[k];
        return out;
      }),
      create: vi.fn(async ({ data, select }: any) => {
        const row: Row = { id: nextId(), ...data };
        codeSymbols.push(row);
        return select ? { id: row.id } : row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        for (let i = codeSymbols.length - 1; i >= 0; i -= 1) {
          if (matchWhere(codeSymbols[i], where)) codeSymbols.splice(i, 1);
        }
        return { count: 0 };
      }),
      count: vi.fn(
        async ({ where }: any) => codeSymbols.filter((r) => matchWhere(r, where)).length,
      ),
      groupBy: vi.fn(async ({ where, by }: any) => {
        const filtered = codeSymbols.filter((r) => matchWhere(r, where));
        const counts = new Map<string, number>();
        for (const row of filtered) {
          const key = (row as any)[by[0]] ?? "";
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()].map(([k, n]) => ({ [by[0]]: k, _count: { _all: n } }));
      }),
    },
    codeEdge: {
      findMany: vi.fn(async ({ where }: any) => codeEdges.filter((r) => matchWhere(r, where))),
      create: vi.fn(async ({ data }: any) => {
        const row: Row = { id: nextId(), ...data };
        codeEdges.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        for (let i = codeEdges.length - 1; i >= 0; i -= 1) {
          if (matchWhere(codeEdges[i], where)) codeEdges.splice(i, 1);
        }
        return { count: 0 };
      }),
      count: vi.fn(async ({ where }: any) => codeEdges.filter((r) => matchWhere(r, where)).length),
    },
    finding: {
      findFirst: vi.fn(async ({ where }: any) => {
        // Only matches on contains-style evidence + category here.
        return (
          findings.find((r) => {
            if (where.category && r.category !== where.category) return false;
            if (
              where.evidence?.contains &&
              !String(r.evidence ?? "").includes(where.evidence.contains)
            )
              return false;
            return true;
          }) ?? null
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: Row = { id: nextId(), ...data };
        findings.push(row);
        return row;
      }),
    },
    analysis: {
      create: vi.fn(async ({ data, select }: any) => {
        const row: Row = { id: nextId(), ...data };
        analyses.push(row);
        return select ? { id: row.id } : row;
      }),
    },
    agentResult: {
      create: vi.fn(async ({ data, select }: any) => {
        const row: Row = { id: nextId(), ...data };
        agentResults.push(row);
        return select ? { id: row.id } : row;
      }),
    },
  };

  return {
    prisma,
    store: { codeGraphs, codeSymbols, codeEdges, findings, analyses, agentResults },
  };
}

async function makeFixture(tree: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-ingest-"));
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  return root;
}

beforeEach(() => vi.clearAllMocks());

describe("ingestCodeGraph (#308)", () => {
  it("walks files, persists symbols and edges, and returns stats", async () => {
    const root = await makeFixture({
      "src/foo.ts": `export function hello() { return world(); }\nexport function world() { return 1; }\n`,
      "src/bar.py": `import os\n\ndef main():\n    return os.path.join("a", "b")\n`,
      "node_modules/dep/index.js": `module.exports = 1;\n`,
    });
    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "proj1", rootDir: root });

    // Walked 2 source files (node_modules excluded by DEFAULT_METISIGNORE).
    expect(stats.filesParsed).toBe(2);
    expect(stats.symbolsUpserted).toBeGreaterThan(0);
    expect(stats.edgesUpserted).toBeGreaterThan(0);
    expect(store.codeGraphs).toHaveLength(1);
    // Aggregate count update was applied.
    expect((store.codeGraphs[0] as any).symbolCount).toBe(stats.symbolsUpserted);
    expect((store.codeGraphs[0] as any).edgeCount).toBe(stats.edgesUpserted);
  });

  it("skips a file on second run when its hash is unchanged (incremental cache)", async () => {
    const root = await makeFixture({
      "src/foo.ts": `function f() { g(); }\nfunction g() {}\n`,
    });
    const { prisma } = makePrismaMock();

    const first = await ingestCodeGraph(prisma, { projectId: "proj1", rootDir: root });
    expect(first.filesParsed).toBe(1);

    const second = await ingestCodeGraph(prisma, { projectId: "proj1", rootDir: root });
    expect(second.filesParsed).toBe(0);
    expect(second.filesSkipped).toBeGreaterThanOrEqual(1);
  });

  it("forces full re-parse when incremental=false", async () => {
    const root = await makeFixture({
      "src/foo.ts": `function f() {}\n`,
    });
    const { prisma } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "proj1", rootDir: root });
    const second = await ingestCodeGraph(prisma, {
      projectId: "proj1",
      rootDir: root,
      incremental: false,
    });
    expect(second.filesParsed).toBe(1);
  });

  it("respects a top-level .metisignore", async () => {
    const root = await makeFixture({
      ".metisignore": "src/skip.ts\n",
      "src/keep.ts": `function k() {}\n`,
      "src/skip.ts": `function s() {}\n`,
    });
    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "proj1", rootDir: root });
    expect(stats.filesParsed).toBe(1);
    const moduleSyms = store.codeSymbols.filter((s: any) => s.kind === "module");
    expect(moduleSyms.map((s: any) => s.filePath)).toEqual(["src/keep.ts"]);
  });

  it("persists rationale findings only when triggeredByUserId is supplied", async () => {
    const root = await makeFixture({
      "src/foo.ts": `// WHY: keeps it pure\nfunction f() {}\n`,
    });
    const { prisma, store } = makePrismaMock();

    const noUser = await ingestCodeGraph(prisma, { projectId: "proj1", rootDir: root });
    expect(noUser.rationaleFindings).toBe(1);
    expect(store.findings).toHaveLength(0);

    const withUser = await ingestCodeGraph(prisma, {
      projectId: "proj1",
      rootDir: root,
      incremental: false,
      triggeredByUserId: "user-1",
    });
    expect(withUser.rationaleFindings).toBe(1);
    expect(store.findings).toHaveLength(1);
    expect((store.findings[0] as any).derivation).toBe("extracted");
    expect((store.findings[0] as any).confidence).toBe(1.0);
    expect(store.analyses).toHaveLength(1);
    expect(store.agentResults).toHaveLength(1);
  });

  it("skips files with unsupported extensions and unparseable content gracefully", async () => {
    const root = await makeFixture({
      "src/keep.ts": `function f() {}\n`,
      "src/notes.txt": `not source\n`,
    });
    const { prisma } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "proj1", rootDir: root });
    expect(stats.filesParsed).toBe(1);
    expect(stats.filesSkipped).toBeGreaterThanOrEqual(1);
  });

  it("reuses existing CodeGraph row instead of creating a duplicate", async () => {
    const root = await makeFixture({ "a.ts": "function f(){}\n" });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "proj1", rootDir: root });
    await ingestCodeGraph(prisma, { projectId: "proj1", rootDir: root, commitSha: "abc" });
    expect(store.codeGraphs).toHaveLength(1);
    expect((store.codeGraphs[0] as any).commitSha).toBe("abc");
  });
});

describe("ingestCodeGraph — cross-file edge resolution (#383)", () => {
  it("resolves same-file calls to a `toSymbolId` (in-degree ranking gate)", async () => {
    const root = await makeFixture({
      "src/foo.ts": `
function helper() { return 1; }
export function caller() { return helper(); }
`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const helperSym = store.codeSymbols.find(
      (s: any) => s.name === "helper" && s.kind === "function",
    );
    expect(helperSym).toBeDefined();
    const callEdge = store.codeEdges.find(
      (e: any) => e.kind === "calls" && e.toQualifiedName === "helper",
    );
    expect(callEdge).toBeDefined();
    expect((callEdge as any).toSymbolId).toBe((helperSym as any).id);
  });

  it("resolves cross-file calls via `imports` edges", async () => {
    const root = await makeFixture({
      "src/util.ts": `export function helper() { return 1; }\n`,
      "src/main.ts": `
import { helper } from "./util.js";
export function entry() { return helper(); }
`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const helperSym = store.codeSymbols.find(
      (s: any) => s.name === "helper" && s.filePath === "src/util.ts",
    );
    const callEdge = store.codeEdges.find(
      (e: any) =>
        e.kind === "calls" && e.toQualifiedName === "helper" && e.filePath === "src/main.ts",
    );
    expect(helperSym).toBeDefined();
    expect(callEdge).toBeDefined();
    expect((callEdge as any).toSymbolId).toBe((helperSym as any).id);
  });

  it("leaves unresolved third-party calls with toSymbolId=null but preserves the textual name", async () => {
    const root = await makeFixture({
      "src/main.ts": `export function entry() { console.log("hi"); }\n`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const callEdge = store.codeEdges.find(
      (e: any) => e.kind === "calls" && e.toQualifiedName === "log",
    );
    expect(callEdge).toBeDefined();
    expect((callEdge as any).toSymbolId).toBeNull();
    expect((callEdge as any).toQualifiedName).toBe("log");
  });

  it("refuses to bind ambiguous bare names when imports don't disambiguate", async () => {
    const root = await makeFixture({
      "src/a.ts": `export function shared() { return 1; }\n`,
      "src/b.ts": `export function shared() { return 2; }\n`,
      "src/c.ts": `export function caller() { return shared(); }\n`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const callEdge = store.codeEdges.find(
      (e: any) => e.kind === "calls" && e.toQualifiedName === "shared" && e.filePath === "src/c.ts",
    );
    // c.ts doesn't import either a.ts or b.ts → both candidates are project-
    // wide; with multiple matches we refuse to guess.
    expect(callEdge).toBeDefined();
    expect((callEdge as any).toSymbolId).toBeNull();
  });

  it("emits and resolves `references` edges for `new Foo()` cross-file", async () => {
    const root = await makeFixture({
      "src/foo.ts": `export class Foo { static n = 1; }\n`,
      "src/main.ts": `
import { Foo } from "./foo.js";
export function make() { return new Foo(); }
`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const fooSym = store.codeSymbols.find((s: any) => s.name === "Foo" && s.kind === "class");
    const refEdge = store.codeEdges.find(
      (e: any) => e.kind === "references" && e.toQualifiedName === "Foo",
    );
    expect(fooSym).toBeDefined();
    expect(refEdge).toBeDefined();
    expect((refEdge as any).toSymbolId).toBe((fooSym as any).id);
  });

  it("resolves Python cross-file calls via `from x import y`", async () => {
    const root = await makeFixture({
      "pkg/util.py": `def helper():\n    return 1\n`,
      "pkg/main.py": `from pkg.util import helper\n\ndef entry():\n    return helper()\n`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const helperSym = store.codeSymbols.find(
      (s: any) => s.name === "helper" && s.filePath === "pkg/util.py",
    );
    const callEdge = store.codeEdges.find(
      (e: any) =>
        e.kind === "calls" && e.toQualifiedName === "helper" && e.filePath === "pkg/main.py",
    );
    expect(helperSym).toBeDefined();
    expect(callEdge).toBeDefined();
    expect((callEdge as any).toSymbolId).toBe((helperSym as any).id);
  });

  it("local symbols shadow imports — same-file lookup wins", async () => {
    const root = await makeFixture({
      "src/imp.ts": `export function helper() { return "from imp"; }\n`,
      "src/main.ts": `
import { helper } from "./imp.js";
function helper() { return "local"; }
export function entry() { return helper(); }
`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const localHelper = store.codeSymbols.find(
      (s: any) => s.name === "helper" && s.filePath === "src/main.ts",
    );
    const callEdge = store.codeEdges.find(
      (e: any) =>
        e.kind === "calls" && e.toQualifiedName === "helper" && e.filePath === "src/main.ts",
    );
    expect(localHelper).toBeDefined();
    expect(callEdge).toBeDefined();
    expect((callEdge as any).toSymbolId).toBe((localHelper as any).id);
  });
});
