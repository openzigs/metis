/**
 * Issue #953 — PL/SQL package lineage (#893) is now WIRED into ingest.
 *
 * #893 shipped `extractPlsqlPackageLineage` with ZERO production callers, so
 * Oracle package/procedure bodies produced no `reads`/`writes` edges and impact
 * analysis could not trace through PL/SQL packages to their tables. This test is
 * the NEUTER-AND-RED REACHABILITY GUARD whose absence let #893 land dead: it
 * exercises the REAL ingest entry path (`extractSchemaUsage`) — NOT
 * `extractPlsqlPackageLineage` directly — and asserts that per-member
 * `reads`/`writes` edges from a PL/SQL package body exist after ingest.
 *
 * To prove it goes red: comment out (or delete) the `wiring.packages` block in
 * `extractSchemaUsage` (server/src/lib/code-graph/ingest.ts) and this suite
 * fails — no PL/SQL package-body edges are written.
 *
 * The package body is supplied by an injected READ-ONLY fetcher (never a real
 * DB), the sql-lineage client is stubbed (no live sidecar / network), and the
 * schema-graph writer persists into an in-memory Prisma fake. No PL/SQL is ever
 * executed — the body is only fetched and statically parsed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbDependencyInfo, DbPackageInfo } from "@metis/shared";
import { extractSchemaUsage, type IngestStats } from "../src/lib/code-graph/ingest.js";
import type { PackageBodyFetcher } from "../src/lib/code-graph/plsql-package-lineage.js";
import type {
  ExtractUsageParams,
  ExtractUsageResult,
  SqlLineageClient,
} from "../src/lib/code-graph/sql-lineage-client.js";

function fakePrisma() {
  const symbols: any[] = [];
  const edges: any[] = [];
  let n = 0;
  const prisma = {
    codeSymbol: {
      create: vi.fn(async ({ data }: any) => {
        symbols.push(data);
        return { id: `sym-${++n}` };
      }),
    },
    codeEdge: {
      create: vi.fn(async ({ data }: any) => {
        edges.push(data);
        return undefined;
      }),
    },
  };
  return { prisma, symbols, edges };
}

const stats = (): IngestStats => ({ schemaEdges: 0, routineEdges: 0 }) as unknown as IngestStats;

const EMPTY: ExtractUsageResult = {
  tables: [],
  columns: [],
  lineage_edges: [],
  uncertain: [],
  routines: [],
};

function stubClient(responder: (p: ExtractUsageParams) => ExtractUsageResult): SqlLineageClient {
  return {
    extractUsage: async (p: ExtractUsageParams) => responder(p),
  } as unknown as SqlLineageClient;
}

/**
 * The #891 package-spec metadata (members + hasSpec/hasBody) an Oracle
 * `introspectPackages` would yield.
 */
const ACCOUNT_PKG: DbPackageInfo = {
  schema: "APP",
  name: "ACCOUNT_PKG",
  hasSpec: true,
  hasBody: true,
  members: ["APPLY_FEE", "REFRESH_CACHE", "PURGE"],
};

/**
 * A real-shaped package BODY: `apply_fee` writes ACCOUNTS, `refresh_cache`
 * writes ACCOUNT_CACHE while reading ACCOUNTS, and `purge` uses EXECUTE
 * IMMEDIATE dynamic SQL (#892 records it, never dropped).
 */
const ACCOUNT_PKG_BODY = `
CREATE PACKAGE BODY app.account_pkg AS

  PROCEDURE apply_fee(p_id IN NUMBER) IS
  BEGIN
    UPDATE accounts SET balance = balance - 1 WHERE id = p_id;
  END apply_fee;

  PROCEDURE refresh_cache IS
  BEGIN
    INSERT INTO account_cache SELECT id FROM accounts;
  END refresh_cache;

  PROCEDURE purge(p_table_name IN VARCHAR2) IS
  BEGIN
    EXECUTE IMMEDIATE 'DELETE FROM ' || p_table_name;
  END purge;

END account_pkg;
`;

/** Keyword-routed stub so one client answers every isolated statement. */
function fixtureClient(): SqlLineageClient {
  return stubClient((params) => {
    if (/UPDATE\s+accounts/i.test(params.sql)) {
      return {
        ...EMPTY,
        tables: [
          { schema: "APP", name: "ACCOUNTS", qualifiedName: "APP.ACCOUNTS", access: "write" },
        ],
      };
    }
    if (/INSERT\s+INTO\s+account_cache/i.test(params.sql)) {
      return {
        ...EMPTY,
        tables: [
          {
            schema: "APP",
            name: "ACCOUNT_CACHE",
            qualifiedName: "APP.ACCOUNT_CACHE",
            access: "write",
          },
          { schema: "APP", name: "ACCOUNTS", qualifiedName: "APP.ACCOUNTS", access: "read" },
        ],
      };
    }
    return { ...EMPTY };
  });
}

/**
 * Tier-1 catalog-deps rows for `account_pkg`: ACCOUNTS (also seen by Tier-2) and
 * AUDIT_LOG — which Tier-2 never resolves (only reachable through the EXECUTE
 * IMMEDIATE dynamic statement), so it must surface as a cross-validation gap.
 */
const TIER1_DEPS: DbDependencyInfo[] = [
  {
    schema: "APP",
    name: "ACCOUNT_PKG",
    type: "PACKAGE BODY",
    referencedSchema: "APP",
    referencedName: "ACCOUNTS",
    referencedType: "TABLE",
  },
  {
    schema: "APP",
    name: "ACCOUNT_PKG",
    type: "PACKAGE BODY",
    referencedSchema: "APP",
    referencedName: "AUDIT_LOG",
    referencedType: "TABLE",
  },
];

async function runIngest(
  opts: {
    packages?: DbPackageInfo[];
    fetchPackageBody?: PackageBodyFetcher;
    dependencies?: DbDependencyInfo[];
    sqlLineageOverride?: boolean;
  } = {},
) {
  const { prisma, symbols, edges } = fakePrisma();
  const s = stats();
  await extractSchemaUsage(prisma as any, "graph-1", "proj-1", [], new Map(), s, {
    packages: opts.packages,
    fetchPackageBody: opts.fetchPackageBody,
    dependencies: opts.dependencies,
    sqlLineageOverride: opts.sqlLineageOverride ?? true,
    client: fixtureClient(),
  });
  return { symbols, edges, stats: s };
}

describe("extractSchemaUsage — PL/SQL package-body lineage wiring (#953)", () => {
  const original = process.env.SQL_LINEAGE_MODE;

  beforeEach(() => {
    process.env.SQL_LINEAGE_MODE = "in-process"; // platform default: disabled
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SQL_LINEAGE_MODE;
    else process.env.SQL_LINEAGE_MODE = original;
  });

  // --- AC #2: the neuter-and-red reachability guard ------------------------
  it("produces per-member reads AND writes edges from the PL/SQL package body via the real ingest path", async () => {
    const fetchBody: PackageBodyFetcher = async () => ACCOUNT_PKG_BODY;
    const { edges } = await runIngest({ packages: [ACCOUNT_PKG], fetchPackageBody: fetchBody });

    const writeEdges = edges.filter((e) => e.kind === "writes" && e.source === "sqlglot");
    const readEdges = edges.filter((e) => e.kind === "reads" && e.source === "sqlglot");

    // If the ingest wiring is neutered, BOTH of these collapse to zero.
    expect(writeEdges.length).toBeGreaterThan(0);
    expect(readEdges.length).toBeGreaterThan(0);
    expect(writeEdges.map((e) => e.toQualifiedName).sort()).toEqual([
      "APP.ACCOUNTS",
      "APP.ACCOUNT_CACHE",
    ]);
    expect(readEdges.map((e) => e.toQualifiedName)).toEqual(["APP.ACCOUNTS"]);
  });

  // --- AC #1: fixture (package spec + body) → member-attributed edges -------
  it("attributes each edge to the specific package MEMBER routine symbol, not the package as a whole", async () => {
    const fetchBody: PackageBodyFetcher = async () => ACCOUNT_PKG_BODY;
    const { symbols } = await runIngest({ packages: [ACCOUNT_PKG], fetchPackageBody: fetchBody });

    expect(symbols.some((s) => s.qualifiedName === "app.apply_fee" && s.kind === "procedure")).toBe(
      true,
    );
    expect(
      symbols.some((s) => s.qualifiedName === "app.refresh_cache" && s.kind === "procedure"),
    ).toBe(true);
    // Never a single whole-package symbol for the resolved (non-gap) edges.
    expect(symbols.some((s) => s.qualifiedName === "app.account_pkg")).toBe(false);
  });

  // --- AC #4: Tier-1/Tier-2 cross-validation + unresolved dynamic SQL -------
  it("keeps Tier-1/Tier-2 cross-validation reachable and never drops dynamic/unresolved statements", async () => {
    const fetchBody: PackageBodyFetcher = async () => ACCOUNT_PKG_BODY;
    const { edges } = await runIngest({
      packages: [ACCOUNT_PKG],
      fetchPackageBody: fetchBody,
      dependencies: TIER1_DEPS,
    });

    // The EXECUTE IMMEDIATE in `purge` (never statically resolved) is recorded
    // as a `calls` edge to a synthetic dynamic placeholder — never dropped.
    const dynamicCalls = edges.filter(
      (e) => e.kind === "calls" && e.source === "sqlglot" && e.metadata,
    );
    expect(dynamicCalls.length).toBeGreaterThan(0);

    // AUDIT_LOG is a Tier-1 dep Tier-2 never resolved → a cross-validation gap
    // `calls` edge (also carrying unresolvedRefMetadata), attributed to the pkg.
    // The edge carries the writer's canonical (lower-cased) qualified name.
    expect(
      edges.some(
        (e) => e.kind === "calls" && String(e.toQualifiedName).toLowerCase() === "app.audit_log",
      ),
    ).toBe(true);
  });

  // --- AC #5 / gating: sidecar gate stays intact ---------------------------
  it("writes NOTHING when the per-project override disables the sidecar (gate intact)", async () => {
    const fetchBody = vi.fn<PackageBodyFetcher>(async () => ACCOUNT_PKG_BODY);
    const { edges } = await runIngest({
      packages: [ACCOUNT_PKG],
      fetchPackageBody: fetchBody,
      sqlLineageOverride: false,
    });
    expect(edges).toHaveLength(0);
    // Read-only + gated: a disabled sidecar never even fetches the body.
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it("writes nothing (and never throws) when packages are supplied without a body fetcher", async () => {
    const { edges } = await runIngest({ packages: [ACCOUNT_PKG] });
    expect(edges).toHaveLength(0);
  });

  it("also runs under the platform SQL_LINEAGE_MODE=sidecar default (no per-project override)", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const { prisma, edges } = fakePrisma();
    const s = stats();
    await extractSchemaUsage(prisma as any, "graph-1", "proj-1", [], new Map(), s, {
      packages: [ACCOUNT_PKG],
      fetchPackageBody: async () => ACCOUNT_PKG_BODY,
      client: fixtureClient(),
    });
    expect(edges.some((e) => e.kind === "writes" && e.toQualifiedName === "APP.ACCOUNTS")).toBe(
      true,
    );
  });
});
