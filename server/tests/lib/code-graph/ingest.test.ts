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
    // #16 — persistParsed batches per-file writes in a transaction.
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
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
      createMany: vi.fn(async ({ data }: any) => {
        for (const d of data) codeEdges.push({ id: nextId(), ...d });
        return { count: data.length };
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

/** The persisted `calls` edges whose textual target is `name`. */
function callsTo(store: { codeEdges: Row[] }, name: string, filePath?: string): any[] {
  return store.codeEdges.filter(
    (e: any) =>
      e.kind === "calls" && e.toQualifiedName === name && (!filePath || e.filePath === filePath),
  );
}

function symbolId(store: { codeSymbols: Row[] }, filePath: string, name: string): string {
  const sym = store.codeSymbols.find((s: any) => s.filePath === filePath && s.name === name);
  if (!sym) throw new Error(`no symbol ${filePath}::${name}`);
  return sym.id;
}

describe("ingestCodeGraph — calls need evidence, not a matching name (#17)", () => {
  it("fixture from the issue: two files each defining `join`, callers using array.join() — neither gains in-degree", async () => {
    const root = await makeFixture({
      // Defines `join` AND calls `.join()` on an array inside it (same file).
      "src/strings.ts": `export function join(parts: string[]) { return parts.join("/"); }\nexport const SEP = "/";\n`,
      "src/path-utils.ts": `export class PathUtils {\n  join(a: string, b: string) { return [a, b].join("/"); }\n}\n`,
      // Imports a module that defines `join`, then calls `.join()` on an array.
      "src/caller.ts": `import { SEP } from "./strings.js";\nexport function csv(xs: string[]) { return xs.join(SEP); }\n`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const joins = callsTo(store, "join");
    expect(joins).toHaveLength(3);
    expect(joins.every((e) => e.toSymbolId === null)).toBe(true);
    const joinIds = new Set([
      symbolId(store, "src/strings.ts", "join"),
      symbolId(store, "src/path-utils.ts", "join"),
    ]);
    // In-degree as the overview counts it: inbound `calls` + `references`.
    const inbound = store.codeEdges.filter(
      (e: any) => (e.kind === "calls" || e.kind === "references") && joinIds.has(e.toSymbolId),
    );
    expect(inbound).toHaveLength(0);
  });

  it("a project-unique method name is not bound to an unrelated receiver's call", async () => {
    // The shape behind `ClarificationDialog.tsx::join` (in-degree 2,922): the only
    // `trim` in the project is one method; every `.trim()` elsewhere bound to it.
    const root = await makeFixture({
      "src/dialog.ts": `export class Cleaner {\n  trim(value: string) { return value; }\n}\n`,
      "src/form.ts": `export function clean(v: string) { return v.trim(); }\n`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const [edge] = callsTo(store, "trim", "src/form.ts");
    expect(edge).toBeDefined();
    expect(edge.toSymbolId).toBeNull();
  });

  it("test-framework globals and runtime imports never bind to a same-named project symbol", async () => {
    const root = await makeFixture({
      "src/helpers.ts": `export function beforeEach() { return 1; }\nexport const mock = (fn: unknown) => fn;\nexport function join(a: string, b: string) { return a + b; }\n`,
      "src/thing.test.ts": `import { vi } from "vitest";\nimport { join } from "node:path";\nvi.mock("./x");\nbeforeEach(() => {});\nexport function p() { return join("a", "b"); }\n`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    for (const name of ["mock", "beforeEach", "join"]) {
      const edges = callsTo(store, name, "src/thing.test.ts");
      expect(edges.length, name).toBeGreaterThan(0);
      expect(
        edges.every((e) => e.toSymbolId === null),
        name,
      ).toBe(true);
    }
  });

  it("still binds member calls that carry evidence: this., Class., module namespace, imported class method", async () => {
    const root = await makeFixture({
      "src/util.ts": `export function slugify(s: string) { return s; }\n`,
      "src/errors.ts": `export class AppError {\n  static notFound(m: string) { return new AppError(); }\n}\n`,
      "src/service.ts": `export class OrderService {\n  placeOrder(id: string) { return this.validate(id); }\n  validate(id: string) { return id; }\n}\n`,
      "src/main.ts": [
        `import * as util from "./util.js";`,
        `import { AppError } from "./errors.js";`,
        `import { OrderService } from "./service.js";`,
        `export function run(svc: OrderService) {`,
        `  util.slugify("x");`,
        `  AppError.notFound("x");`,
        `  return svc.placeOrder("1");`,
        `}`,
        ``,
      ].join("\n"),
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    expect(callsTo(store, "validate", "src/service.ts")[0].toSymbolId).toBe(
      symbolId(store, "src/service.ts", "validate"),
    );
    expect(callsTo(store, "slugify", "src/main.ts")[0].toSymbolId).toBe(
      symbolId(store, "src/util.ts", "slugify"),
    );
    expect(callsTo(store, "notFound", "src/main.ts")[0].toSymbolId).toBe(
      symbolId(store, "src/errors.ts", "notFound"),
    );
    expect(callsTo(store, "placeOrder", "src/main.ts")[0].toSymbolId).toBe(
      symbolId(store, "src/service.ts", "placeOrder"),
    );
  });

  it("resolves `@/` path-alias imports as evidence (Next.js `@/*` → `src/*`)", async () => {
    const root = await makeFixture({
      "ui/src/lib/api.ts": `export class Api {\n  fetchRules() { return []; }\n}\nexport const api = new Api();\n`,
      "ui/src/app/page.tsx": `import { api } from "@/lib/api";\nexport function Page() { return api.fetchRules(); }\n`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    expect(callsTo(store, "fetchRules", "ui/src/app/page.tsx")[0].toSymbolId).toBe(
      symbolId(store, "ui/src/lib/api.ts", "fetchRules"),
    );
  });

  it("resolves Java single-type imports to their file, so an instance call on an imported type binds", async () => {
    const root = await makeFixture({
      "src/main/java/com/acme/svc/OrderService.java": `package com.acme.svc;\npublic class OrderService {\n  public void placeOrder() {}\n}\n`,
      "src/main/java/com/acme/other/Audit.java": `package com.acme.other;\npublic class Audit {\n  public void placeOrder() {}\n}\n`,
      "src/main/java/com/acme/web/OrderController.java": `package com.acme.web;\nimport com.acme.svc.OrderService;\npublic class OrderController {\n  private OrderService orders;\n  public void submit() { orders.placeOrder(); }\n}\n`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    const [edge] = callsTo(store, "placeOrder", "src/main/java/com/acme/web/OrderController.java");
    expect(edge.toSymbolId).toBe(
      symbolId(store, "src/main/java/com/acme/svc/OrderService.java", "placeOrder"),
    );
  });

  it("binds a Go package-qualified call to the package's function", async () => {
    const root = await makeFixture({
      "billing/charge.go": `package billing\n\nfunc Charge() int { return 1 }\n`,
      "cmd/app/main.go": `package main\n\nimport "example.com/app/billing"\n\nfunc main() { billing.Charge() }\n`,
    });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });

    expect(callsTo(store, "Charge", "cmd/app/main.go")[0].toSymbolId).toBe(
      symbolId(store, "billing/charge.go", "Charge"),
    );
  });
});

describe("ingestCodeGraph — the event loop keeps turning (#16)", () => {
  /** Burn `ms` of CPU synchronously — what a better-sqlite3 statement does. */
  function spin(ms: number): void {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      /* busy */
    }
  }

  it("never holds the loop for more than a fraction of a second while persisting", async () => {
    // 1,500 calls in one file. Each simulated statement costs 1 ms of synchronous
    // work (a commit), plus 5 µs per row. Persisting row-by-row with no yield
    // would hold the loop for >= 1.5 s in one stretch.
    const calls = Array.from({ length: 1500 }, (_, i) => `  f${i % 10}();`).join("\n");
    const defs = Array.from({ length: 10 }, (_, i) => `function f${i}() { return ${i}; }`).join(
      "\n",
    );
    const root = await makeFixture({
      "src/big.ts": `${defs}\nexport function main() {\n${calls}\n}\n`,
    });
    const { prisma } = makePrismaMock();
    const slow = (model: any, op: string) => {
      const inner = model[op];
      model[op] = async (args: any) => {
        spin(1 + (Array.isArray(args?.data) ? args.data.length * 0.005 : 0));
        return inner(args);
      };
    };
    slow(prisma.codeSymbol, "create");
    slow(prisma.codeEdge, "create");
    slow(prisma.codeEdge, "createMany");

    let last = performance.now();
    let maxGap = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    try {
      await ingestCodeGraph(prisma, { projectId: "p", rootDir: root });
    } finally {
      // A loop blocked until the very end never fires its late tick — count the
      // gap that is still open, or a fully-blocked run reads as "no stall".
      maxGap = Math.max(maxGap, performance.now() - last);
      clearInterval(ticker);
    }
    expect(maxGap).toBeLessThan(500);
  });
});
