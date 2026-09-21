/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #294 (#305/#306) — INGEST-PATH wiring tests for the SQL-lineage extractors.
 *
 * These prove the blockers from the PR #315 review are fixed: that ingesting a
 * real source tree through {@link ingestCodeGraph} (the production entrypoint
 * used by the connector + scheduler flows) actually produces `sqlglot`-sourced
 * schema edges at runtime — NOT just in extractor unit isolation.
 *
 *   - #305: a TS/JS/Python/Go file with embedded SQL string literals.
 *   - #306: a SAS file with a `PROC SQL` block (data steps stay with mineSasRules).
 *
 * The sidecar is mocked at the module boundary (`extractUsageSafe`) so there is
 * NO live network. Prisma/DB is a hand-rolled in-memory mock (per
 * `server/tests/setup.ts` — never a real DB). Graceful degradation is asserted
 * both ways: feature-gate OFF and sidecar reporting DOWN both leave ingest
 * succeeding with zero `sqlglot` edges.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtractUsageParams,
  ExtractUsageResult,
} from "../../../src/lib/code-graph/sql-lineage-client.js";
import type { DbRoutineInfo, DbTableInfo } from "@metis/shared";

// ── Mock the sidecar client module ──────────────────────────────────────────
// `embedded-sql-extractor.ts`, `sas-rule-miner.ts`, and `ingest.ts` all consume
// `extractUsageSafe` / `isSqlLineageEnabled` from this module. Mocking here gives
// us a scripted sidecar with no HTTP, and a toggleable feature gate.
let sidecarEnabled = true;
let sidecarResponder: (params: ExtractUsageParams) => ExtractUsageResult | null = () => null;

vi.mock("../../../src/lib/code-graph/sql-lineage-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/code-graph/sql-lineage-client.js")>();
  return {
    ...actual,
    isSqlLineageEnabled: () => sidecarEnabled,
    extractUsageSafe: async (params: ExtractUsageParams) =>
      sidecarEnabled ? sidecarResponder(params) : null,
  };
});

// Imported AFTER the mock is registered.
const { ingestCodeGraph } = await import("../../../src/lib/code-graph/ingest.js");
// The reconciler/classifier path is NOT mocked — the runtime-edge test below
// proves an `executes` edge produced by ingest classifies a routine `used`
// through the EXISTING pipeline (no parallel path).
const { computeUsageClassification } =
  await import("../../../src/lib/impact-analysis/used-schema-service.js");

const EMPTY: ExtractUsageResult = {
  tables: [],
  columns: [],
  lineage_edges: [],
  uncertain: [],
  routines: [],
};

function tableResult(
  name: string,
  access: "read" | "write" | "persist",
  column = "id",
): ExtractUsageResult {
  return {
    tables: [{ schema: "", name, qualifiedName: name, access }],
    columns: [{ table: name, column, qualifiedName: `${name}.${column}`, access }],
    lineage_edges: [],
    uncertain: [],
    routines: [],
  };
}

/** A sidecar result that reports a routine INVOCATION (#316A). */
function routineResult(name: string, schema = ""): ExtractUsageResult {
  return {
    ...EMPTY,
    routines: [{ schema, name, qualifiedName: schema ? `${schema}.${name}` : name }],
  };
}

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
      findFirst: vi.fn(async () => null),
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

  return { prisma, store: { codeGraphs, codeSymbols, codeEdges } };
}

async function makeFixture(tree: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-ingest-sql-"));
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  return root;
}

/** Schema edges written by the SQL-lineage path are exactly those `source=sqlglot`. */
function sqlglotEdges(store: { codeEdges: Row[] }): Row[] {
  return store.codeEdges.filter((e) => (e as any).source === "sqlglot");
}

beforeEach(() => {
  vi.clearAllMocks();
  sidecarEnabled = true;
  sidecarResponder = () => null;
});

afterEach(() => {
  sidecarEnabled = true;
  sidecarResponder = () => null;
});

describe("ingestCodeGraph wires the SQL-lineage extractors (#294 #305/#306)", () => {
  it("#305: produces sqlglot edges for embedded SQL in TS at runtime", async () => {
    const root = await makeFixture({
      "src/repo.ts": `export function load() { return db.query("SELECT id FROM users WHERE active = 1"); }\n`,
    });
    sidecarResponder = (p) => (/select/i.test(p.sql) ? tableResult("users", "read") : EMPTY);

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    // The wiring ran and the edges flowed through the real graph writer → store.
    expect(stats.schemaEdges).toBeGreaterThan(0);
    const edges = sqlglotEdges(store);
    expect(edges.length).toBeGreaterThan(0);
    const tableEdge = edges.find((e) => (e as any).toQualifiedName === "users");
    expect((tableEdge as any)?.kind).toBe("reads");
    expect((tableEdge as any)?.source).toBe("sqlglot");
    // A table symbol with source=sqlglot was persisted too.
    expect(
      store.codeSymbols.some((s) => (s as any).kind === "table" && (s as any).source === "sqlglot"),
    ).toBe(true);
  });

  it("#305: produces sqlglot edges for embedded SQL in Python and Go", async () => {
    const root = await makeFixture({
      "app/dao.py": `def q():\n    return cur.execute("SELECT id FROM accounts")\n`,
      "pkg/store.go": "package store\nfunc f() string {\n\treturn `SELECT id FROM widgets`\n}\n",
    });
    sidecarResponder = (p) =>
      /accounts/i.test(p.sql)
        ? tableResult("accounts", "read")
        : /widgets/i.test(p.sql)
          ? tableResult("widgets", "read")
          : EMPTY;

    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    const tqns = new Set(sqlglotEdges(store).map((e) => (e as any).toQualifiedName));
    expect(tqns.has("accounts")).toBe(true);
    expect(tqns.has("widgets")).toBe(true);
  });

  it("#888: produces sqlglot edges for raw JDBC embedded SQL in Java at runtime", async () => {
    const root = await makeFixture({
      "src/main/java/OrderDao.java": [
        "class OrderDao {",
        "  void load(Connection conn) throws SQLException {",
        '    PreparedStatement ps = conn.prepareStatement("SELECT id FROM orders WHERE id = ?");',
        "  }",
        "}",
      ].join("\n"),
    });
    sidecarResponder = (p) => (/orders/i.test(p.sql) ? tableResult("orders", "read") : EMPTY);

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    // Proves the wiring is REACHED from the real ingest entrypoint, not just
    // exercised in extractor-unit isolation — removing the `file.language ===
    // "java"` branch in `extractSchemaUsage` (ingest.ts) makes this fail.
    expect(stats.schemaEdges).toBeGreaterThan(0);
    const edges = sqlglotEdges(store);
    const tableEdge = edges.find((e) => (e as any).toQualifiedName === "orders");
    expect((tableEdge as any)?.kind).toBe("reads");
    expect((tableEdge as any)?.source).toBe("sqlglot");
  });

  it("#889: assembles Java `+`-concatenated constant SQL and produces sqlglot edges at ingest", async () => {
    const root = await makeFixture({
      "src/main/java/OrderDao.java": [
        "class OrderDao {",
        "  void load(Connection conn) throws SQLException {",
        '    PreparedStatement ps = conn.prepareStatement("SELECT id " + "FROM orders");',
        "  }",
        "}",
      ].join("\n"),
    });
    // The sidecar only ever sees the ASSEMBLED string — proving the #889
    // concatenation assembly ran on the real ingest path (removing the java
    // branch in embedded-sql-extractor / ingest.ts makes this fail).
    let seenSql: string | undefined;
    sidecarResponder = (p) => {
      if (/orders/i.test(p.sql)) {
        seenSql = p.sql;
        return tableResult("orders", "read");
      }
      return EMPTY;
    };

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    expect(seenSql).toBe("SELECT id FROM orders");
    expect(stats.schemaEdges).toBeGreaterThan(0);
    const tableEdge = sqlglotEdges(store).find((e) => (e as any).toQualifiedName === "orders");
    expect((tableEdge as any)?.kind).toBe("reads");
    expect((tableEdge as any)?.source).toBe("sqlglot");
  });

  it("#889: a Java mixed constant+variable concat produces NO sqlglot edges at ingest (not mis-parsed)", async () => {
    const root = await makeFixture({
      "src/main/java/OrderDao.java": [
        "class OrderDao {",
        "  void load(Connection conn, String id) throws SQLException {",
        '    PreparedStatement ps = conn.prepareStatement("SELECT * FROM orders WHERE id = " + id);',
        "  }",
        "}",
      ].join("\n"),
    });
    let sidecarCalls = 0;
    sidecarResponder = (p) => {
      sidecarCalls++;
      return /orders/i.test(p.sql) ? tableResult("orders", "read") : EMPTY;
    };

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    // Dynamic concat is recorded uncertain upstream, never shipped to sqlglot.
    expect(sidecarCalls).toBe(0);
    expect(stats.schemaEdges).toBe(0);
    expect(sqlglotEdges(store)).toHaveLength(0);
  });

  it("#306: produces sqlglot edges for a SAS PROC SQL block at runtime", async () => {
    const root = await makeFixture({
      "etl/load.sas": `proc sql;\n  create table out as select id from staging;\nquit;\n`,
    });
    sidecarResponder = (p) => (/staging/i.test(p.sql) ? tableResult("staging", "read") : EMPTY);

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    expect(stats.schemaEdges).toBeGreaterThan(0);
    const edges = sqlglotEdges(store);
    const stagingEdge = edges.find((e) => (e as any).toQualifiedName === "staging");
    expect(stagingEdge).toBeDefined();
    expect((stagingEdge as any).source).toBe("sqlglot");
    // The PROC SQL origin symbol is the procsql@<line> method.
    expect(
      store.codeSymbols.some((s) => String((s as any).qualifiedName).includes("::procsql@")),
    ).toBe(true);
  });

  it("#306: non-PROC-SQL SAS data steps do NOT hit the sidecar (no regression / no sqlglot edges)", async () => {
    const root = await makeFixture({
      // Pure DATA step — mineSasRules territory; PROC SQL finder must skip it.
      "etl/clean.sas": `data out;\n  set raw;\n  if status = 'A';\n  keep id status;\nrun;\n`,
    });
    let sidecarCalls = 0;
    sidecarResponder = (p) => {
      sidecarCalls++;
      return /raw/i.test(p.sql) ? tableResult("raw", "read") : EMPTY;
    };

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    // No PROC SQL → extractor short-circuits before any sidecar call.
    expect(sidecarCalls).toBe(0);
    expect(stats.schemaEdges).toBe(0);
    expect(sqlglotEdges(store)).toHaveLength(0);
  });

  it("graceful degradation: feature gate OFF → ingest succeeds, zero sqlglot edges, no sidecar call", async () => {
    sidecarEnabled = false; // SQL_LINEAGE_MODE != sidecar
    let sidecarCalls = 0;
    sidecarResponder = () => {
      sidecarCalls++;
      return tableResult("users", "read");
    };
    const root = await makeFixture({
      "src/repo.ts": `const q = "SELECT id FROM users";\nexport function f() { return q; }\n`,
      "etl/load.sas": `proc sql;\n  select id from staging;\nquit;\n`,
    });

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    // Ingest still completes and produces ordinary code symbols/edges...
    expect(stats.filesParsed).toBeGreaterThan(0);
    // ...but the SQL-lineage path was entirely skipped.
    expect(sidecarCalls).toBe(0);
    expect(stats.schemaEdges).toBe(0);
    expect(sqlglotEdges(store)).toHaveLength(0);
  });

  it("graceful degradation: sidecar DOWN (returns null) → ingest succeeds, zero sqlglot edges", async () => {
    sidecarEnabled = true;
    sidecarResponder = () => null; // simulate unreachable/errored sidecar
    const root = await makeFixture({
      "src/repo.ts": `const q = "SELECT id FROM users";\nexport function f() { return q; }\n`,
    });

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    expect(stats.filesParsed).toBeGreaterThan(0); // ingest did not throw
    expect(stats.schemaEdges).toBe(0);
    expect(sqlglotEdges(store)).toHaveLength(0);
  });

  it("a throwing sidecar never breaks ingest (whole step is isolated)", async () => {
    sidecarEnabled = true;
    sidecarResponder = () => {
      throw new Error("boom");
    };
    const root = await makeFixture({
      "src/repo.ts": `const q = "SELECT id FROM users";\nexport function f() { return q; }\n`,
    });

    const { prisma } = makePrismaMock();
    // Must resolve (not reject) despite the extractor throwing.
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });
    expect(stats.filesParsed).toBeGreaterThan(0);
    expect(stats.schemaEdges).toBe(0);
  });
});

describe("#316A: code→routine `executes` edges at ingest", () => {
  it("produces an executes edge for a CALL invocation in TS", async () => {
    const root = await makeFixture({
      "src/svc.ts": `export function sync() { return db.query("CALL app.do_sync()"); }\n`,
    });
    sidecarResponder = (p) => (/do_sync/i.test(p.sql) ? routineResult("do_sync", "app") : EMPTY);

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    expect(stats.routineEdges).toBeGreaterThan(0);
    const execEdge = sqlglotEdges(store).find((e) => (e as Row).kind === "executes");
    expect(execEdge).toBeDefined();
    expect((execEdge as Row).toQualifiedName).toBe("app.do_sync");
    // A routine symbol (procedure) with source sqlglot was persisted.
    expect(
      store.codeSymbols.some(
        (s) => (s as Row).kind === "procedure" && (s as Row).qualifiedName === "app.do_sync",
      ),
    ).toBe(true);
  });

  // THE runtime-edge proof: an `executes` edge from ingest makes a live-introspected
  // routine classify `used` through the EXISTING reconciler/classifier — no parallel
  // path. This is the #316 end-to-end acceptance requirement.
  it("an executes edge makes a routine classify `used` via the existing classifier", async () => {
    const root = await makeFixture({
      "src/svc.ts": `export function run() { return db.query("CALL app.do_sync()"); }\n`,
    });
    sidecarResponder = (p) => (/do_sync/i.test(p.sql) ? routineResult("do_sync", "app") : EMPTY);

    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });
    // Sanity: ingest wrote the executes edge into the shared store.
    expect(
      sqlglotEdges(store).some(
        (e) => (e as Row).kind === "executes" && (e as Row).toQualifiedName === "app.do_sync",
      ),
    ).toBe(true);

    // Now run the REAL reconciler/classifier over the same persisted graph. The
    // routine is "live-introspected" (returned by the routines introspector) and
    // has an inbound executes edge → it must classify `used`.
    const classifyPrisma = {
      ...prisma,
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({
          schemaUsageClassification: {
            deleteMany: async () => ({ count: 0 }),
            createMany: async () => ({ count: 0 }),
          },
        }),
    };
    const introspectTables = async (): Promise<DbTableInfo[]> => [];
    const introspectRoutines = async (): Promise<DbRoutineInfo[]> => [
      { schema: "app", name: "do_sync", type: "procedure", signature: "" },
    ];

    const result = await computeUsageClassification(
      classifyPrisma as never,
      "p1",
      introspectTables,
      introspectRoutines,
    );

    const routine = result.classified.find((c) => c.tableName === "app.do_sync");
    expect(routine?.kind).toBe("procedure");
    expect(routine?.usageClass).toBe("used");
    expect(routine?.safeToReview).toBe(false);
  });
});

describe("#316B: routine-body `calls` edges at ingest", () => {
  it("parses routine bodies (read-only fetch) into routine→object `calls` edges", async () => {
    const root = await makeFixture({
      "src/noop.ts": `export const x = 1;\n`,
    });
    // The body fetcher is READ-ONLY: it returns text; nothing is executed.
    const fetchRoutineBody = vi.fn(
      async () => "CREATE PROCEDURE recalc AS BEGIN UPDATE orders SET total = 1; END;",
    );
    sidecarResponder = (p) =>
      /update orders/i.test(p.sql)
        ? {
            ...EMPTY,
            tables: [{ schema: "", name: "orders", qualifiedName: "orders", access: "write" }],
            columns: [
              { table: "orders", column: "total", qualifiedName: "orders.total", access: "write" },
            ],
            uncertain: [{ reason: "routine-body-unanalyzed", detail: "best-effort" }],
          }
        : EMPTY;

    const { prisma, store } = makePrismaMock();
    const stats = await ingestCodeGraph(prisma, {
      projectId: "p1",
      rootDir: root,
      routines: [{ schema: "app", name: "recalc", type: "procedure", signature: "" }],
      fetchRoutineBody,
    });

    expect(fetchRoutineBody).toHaveBeenCalledTimes(1);
    expect(stats.routineEdges).toBeGreaterThan(0);
    const callsEdges = sqlglotEdges(store).filter((e) => (e as Row).kind === "calls");
    expect(callsEdges.some((e) => (e as Row).toQualifiedName === "orders")).toBe(true);
    expect(callsEdges.some((e) => (e as Row).toQualifiedName === "orders.total")).toBe(true);
  });

  it("does not run routine-body extraction when no fetcher is supplied", async () => {
    const root = await makeFixture({ "src/noop.ts": `export const x = 1;\n` });
    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, {
      projectId: "p1",
      rootDir: root,
      routines: [{ schema: "app", name: "recalc", type: "procedure", signature: "" }],
      // fetchRoutineBody intentionally omitted
    });
    expect(sqlglotEdges(store).some((e) => (e as Row).kind === "calls")).toBe(false);
  });
});

describe("#317: introspected schema threaded into ingest extraction", () => {
  const STAR_SRC = `export function all() { return db.query("SELECT * FROM users"); }\n`;

  // The sidecar mock emulates sqlglot's documented behavior: a `SELECT *` yields
  // per-column edges ONLY when the introspected schema is supplied.
  function starResponder(params: ExtractUsageParams): ExtractUsageResult {
    if (!/select \*/i.test(params.sql)) return EMPTY;
    const base = tableResult("users", "read");
    if (params.schema && params.schema.public?.users) {
      const cols = Object.keys(params.schema.public.users);
      return {
        ...base,
        columns: cols.map((c) => ({
          table: "users",
          column: c,
          qualifiedName: `users.${c}`,
          access: "read" as const,
        })),
      };
    }
    // No schema → star cannot be expanded; table-level ref only, no columns.
    return { ...base, columns: [] };
  }

  it("expands SELECT * to per-column edges WHEN the schema is fed", async () => {
    const root = await makeFixture({ "src/svc.ts": STAR_SRC });
    sidecarResponder = starResponder;

    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, {
      projectId: "p1",
      rootDir: root,
      introspectedSchema: { public: { users: { id: "INT", name: "VARCHAR", email: "VARCHAR" } } },
    });

    const colEdges = sqlglotEdges(store).filter((e) =>
      String((e as Row).toQualifiedName ?? "").startsWith("users."),
    );
    const cols = new Set(colEdges.map((e) => (e as Row).toQualifiedName));
    expect(cols).toEqual(new Set(["users.id", "users.name", "users.email"]));
  });

  it("does NOT expand SELECT * columns when no schema is fed (no regression)", async () => {
    const root = await makeFixture({ "src/svc.ts": STAR_SRC });
    sidecarResponder = starResponder;

    const { prisma, store } = makePrismaMock();
    await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    const colEdges = sqlglotEdges(store).filter((e) =>
      String((e as Row).toQualifiedName ?? "").startsWith("users."),
    );
    expect(colEdges).toHaveLength(0);
    // The table-level edge is still produced — only column expansion is gated.
    expect(sqlglotEdges(store).some((e) => (e as Row).toQualifiedName === "users")).toBe(true);
  });
});

describe("#901: the INGESTED schema graph feeds column-level lineage (no live DB)", () => {
  // A Prisma model populates `users(id,email)` into the schema graph via the ORM
  // pass — WITHOUT any live DB. The reachability contract: even though NO
  // `introspectedSchema` is passed, ingest reconstructs one from those persisted
  // `table`/`column` symbols and threads it into the sidecar, so `SELECT *`
  // expands to per-column edges.
  const PRISMA_SRC = `model User {\n  id    Int    @id\n  email String\n  @@map("users")\n}\n`;
  const STAR_SRC = `export function all() { return db.query("SELECT * FROM users"); }\n`;

  /** Capture the schema the sidecar receives + expand SELECT * from it. */
  function makeCapturingResponder(): {
    responder: (p: ExtractUsageParams) => ExtractUsageResult;
    schemas: (ExtractUsageParams["schema"] | undefined)[];
  } {
    const schemas: (ExtractUsageParams["schema"] | undefined)[] = [];
    const responder = (params: ExtractUsageParams): ExtractUsageResult => {
      if (!/select \*/i.test(params.sql)) return EMPTY;
      schemas.push(params.schema);
      const base = tableResult("users", "read");
      const users = params.schema?.public?.users;
      if (users) {
        return {
          ...base,
          columns: Object.keys(users).map((c) => ({
            table: "users",
            column: c,
            qualifiedName: `users.${c}`,
            access: "read" as const,
          })),
        };
      }
      return { ...base, columns: [] };
    };
    return { responder, schemas };
  }

  it("reconstructs the sqlglot schema from persisted table/column symbols and resolves columns", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": PRISMA_SRC,
      "src/svc.ts": STAR_SRC,
    });
    const { responder, schemas } = makeCapturingResponder();
    sidecarResponder = responder;

    const { prisma, store } = makePrismaMock();
    // NOTE: no `introspectedSchema` — the schema must come from the graph itself.
    await ingestCodeGraph(prisma, { projectId: "p1", rootDir: root });

    // Reachability: the sidecar was handed a schema assembled from the ORM-ingested
    // `users` table (id + email columns). If the #901 wiring were removed this
    // would be null/undefined and the assertion would go red.
    const fed = schemas.find((s) => s?.public?.users);
    expect(fed).toBeDefined();
    expect(Object.keys(fed!.public.users).sort()).toEqual(["email", "id"]);

    // End-to-end: SELECT * expanded to per-column edges via the graph-derived schema.
    const cols = new Set(
      sqlglotEdges(store)
        .map((e) => (e as Row).toQualifiedName)
        .filter((q) => String(q ?? "").startsWith("users.")),
    );
    expect(cols).toEqual(new Set(["users.id", "users.email"]));
  });

  it("an explicitly-passed live schema still wins over the graph-derived one", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": PRISMA_SRC,
      "src/svc.ts": STAR_SRC,
    });
    const { responder, schemas } = makeCapturingResponder();
    sidecarResponder = responder;

    const { prisma } = makePrismaMock();
    await ingestCodeGraph(prisma, {
      projectId: "p1",
      rootDir: root,
      // Ground-truth introspection carries an extra `name` column the graph lacks.
      introspectedSchema: { public: { users: { id: "INT", email: "TEXT", name: "TEXT" } } },
    });

    const fed = schemas.find((s) => s?.public?.users);
    expect(fed).toBeDefined();
    // The live schema (with `name`) was used, not the 2-column graph-derived one.
    expect(Object.keys(fed!.public.users).sort()).toEqual(["email", "id", "name"]);
  });
});
