/**
 * Canonical SchemaObjectIdentity service tests — Epic #295 Phase 4 (#308).
 *
 * Covers reconcile dedupe (same object from multiple projects -> one identity),
 * the usageClass rollup across linked projects, the affected-table link, the
 * recursive-CTE SQL builder shape, and the PURE lineage traversal (cycle-safe,
 * depth-bounded). Prisma fully mocked — no real DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildLineageCteSql,
  detectLineageSqlEngine,
  linkAffectedTableToIdentity,
  reconcileIdentity,
  rollupIdentityUsage,
  traverseLineage,
  traverseLineageDb,
  type IdentityPrisma,
  type LineageEdge,
} from "../src/lib/cross-project/schema-object-identity-service.js";

interface IdRow {
  id: string;
  databaseResourceId: string;
  schemaName: string | null;
  objectName: string;
  objectType: string;
  usageClass: string | null;
}

function makeFakePrisma(opts?: {
  classifications?: { projectId: string; tableName: string; usageClass: string }[];
  failCreateOnce?: boolean;
}) {
  const identities: IdRow[] = [];
  const affectedLinks: Record<string, string> = {};
  let seq = 0;
  let failCreateOnce = opts?.failCreateOnce ?? false;
  const keyOf = (r: {
    databaseResourceId: string;
    schemaName: string | null;
    objectName: string;
    objectType: string;
  }) => `${r.databaseResourceId}|${r.schemaName}|${r.objectName}|${r.objectType}`;

  const prisma = {
    schemaObjectIdentity: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) =>
        identities.find((r) => keyOf(r) === keyOf(where)) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async ({ data }: any) => {
        if (failCreateOnce) {
          failCreateOnce = false;
          seq += 1;
          identities.push({ id: `id_race_${seq}`, usageClass: null, ...data });
          throw new Error("UNIQUE constraint failed");
        }
        seq += 1;
        const row: IdRow = { id: `id_${seq}`, usageClass: null, ...data };
        identities.push(row);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async ({ where, data }: any) => {
        const row = identities.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    schemaUsageClassification: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) =>
        (opts?.classifications ?? []).filter(
          (c) => where.projectId.in.includes(c.projectId) && c.tableName === where.tableName,
        ),
    },
    impactAffectedTable: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async ({ where, data }: any) => {
        affectedLinks[where.id] = data.schemaObjectIdentityId;
        return { id: where.id };
      },
    },
  } as unknown as IdentityPrisma;

  return { prisma, identities, affectedLinks };
}

beforeEach(() => vi.clearAllMocks());

describe("reconcileIdentity — cross-project dedupe", () => {
  it("returns the SAME identity for the same object reconciled from two projects", async () => {
    const { prisma, identities } = makeFakePrisma();
    const key = { schemaName: "public", objectName: "orders", objectType: "table" as const };
    const a = await reconcileIdentity("res-1", key, prisma);
    const b = await reconcileIdentity("res-1", key, prisma);
    expect(a).toBe(b);
    expect(identities).toHaveLength(1);
  });

  it("treats an empty schemaName as null (single bucket)", async () => {
    const { prisma, identities } = makeFakePrisma();
    const a = await reconcileIdentity(
      "res-1",
      { schemaName: "", objectName: "t", objectType: "table" },
      prisma,
    );
    const b = await reconcileIdentity(
      "res-1",
      { schemaName: null, objectName: "t", objectType: "table" },
      prisma,
    );
    expect(a).toBe(b);
    expect(identities).toHaveLength(1);
    expect(identities[0].schemaName).toBeNull();
  });

  it("distinguishes different objectTypes (table vs column)", async () => {
    const { prisma, identities } = makeFakePrisma();
    await reconcileIdentity(
      "res-1",
      { schemaName: null, objectName: "x", objectType: "table" },
      prisma,
    );
    await reconcileIdentity(
      "res-1",
      { schemaName: null, objectName: "x", objectType: "column" },
      prisma,
    );
    expect(identities).toHaveLength(2);
  });

  it("retries as a find when a create loses the unique race", async () => {
    const { prisma } = makeFakePrisma({ failCreateOnce: true });
    const id = await reconcileIdentity(
      "res-1",
      { schemaName: null, objectName: "t", objectType: "table" },
      prisma,
    );
    expect(id).toMatch(/^id_race_/);
  });
});

describe("rollupIdentityUsage", () => {
  it("rolls up to used when any linked project uses the object", async () => {
    const { prisma, identities } = makeFakePrisma({
      classifications: [
        { projectId: "pA", tableName: "public.orders", usageClass: "unreferenced" },
        { projectId: "pB", tableName: "public.orders", usageClass: "used" },
      ],
    });
    const id = await reconcileIdentity(
      "res-1",
      { schemaName: "public", objectName: "orders", objectType: "table" },
      prisma,
    );
    const rolled = await rollupIdentityUsage(
      id,
      { schemaName: "public", objectName: "orders", objectType: "table" },
      ["pA", "pB"],
      prisma,
    );
    expect(rolled).toBe("used");
    expect(identities.find((r) => r.id === id)?.usageClass).toBe("used");
  });

  it("returns null when no project has classified the object", async () => {
    const { prisma } = makeFakePrisma({ classifications: [] });
    const id = await reconcileIdentity(
      "res-1",
      { schemaName: null, objectName: "t", objectType: "table" },
      prisma,
    );
    const rolled = await rollupIdentityUsage(
      id,
      { schemaName: null, objectName: "t", objectType: "table" },
      ["pA"],
      prisma,
    );
    expect(rolled).toBeNull();
  });

  it("returns null for an empty project set", async () => {
    const { prisma } = makeFakePrisma();
    const rolled = await rollupIdentityUsage(
      "id-x",
      { schemaName: null, objectName: "t", objectType: "table" },
      [],
      prisma,
    );
    expect(rolled).toBeNull();
  });
});

describe("linkAffectedTableToIdentity", () => {
  it("sets the affected-table FK to the identity", async () => {
    const { prisma, affectedLinks } = makeFakePrisma();
    await linkAffectedTableToIdentity("aff-1", "id-9", prisma);
    expect(affectedLinks["aff-1"]).toBe("id-9");
  });
});

describe("traverseLineage — pure, cycle-safe, depth-bounded", () => {
  const edges: LineageEdge[] = [
    { fromSymbolId: "a", toSymbolId: "b" },
    { fromSymbolId: "b", toSymbolId: "c" },
    { fromSymbolId: "c", toSymbolId: "d" },
  ];

  it("returns all transitively reachable nodes (excluding seeds)", () => {
    expect(new Set(traverseLineage(["a"], edges))).toEqual(new Set(["b", "c", "d"]));
  });

  it("does not loop forever on a cycle", () => {
    const cyclic: LineageEdge[] = [
      { fromSymbolId: "a", toSymbolId: "b" },
      { fromSymbolId: "b", toSymbolId: "a" },
    ];
    expect(new Set(traverseLineage(["a"], cyclic))).toEqual(new Set(["b"]));
  });

  it("respects maxDepth", () => {
    // depth 1 from 'a' reaches only 'b'.
    expect(traverseLineage(["a"], edges, 1)).toEqual(["b"]);
  });

  it("returns [] for empty seeds", () => {
    expect(traverseLineage([], edges)).toEqual([]);
  });

  it("dedupes when multiple seeds reach the same node", () => {
    const diamond: LineageEdge[] = [
      { fromSymbolId: "a", toSymbolId: "x" },
      { fromSymbolId: "b", toSymbolId: "x" },
    ];
    expect(traverseLineage(["a", "b"], diamond)).toEqual(["x"]);
  });
});

describe("detectLineageSqlEngine", () => {
  // The env stub below must not survive a failed assertion — `vi.restoreAllMocks()` in
  // tests/setup.ts does not unstub envs.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns sqlite for a file: URL (the runtime default)", () => {
    expect(detectLineageSqlEngine("file:./dev.db")).toBe("sqlite");
  });
  it("returns sqlite for an empty URL", () => {
    expect(detectLineageSqlEngine("")).toBe("sqlite");
  });
  it("falls back to DATABASE_URL when called with no argument", () => {
    // #876 — an omitted argument reads the AMBIENT datasource, so this case has to pin it.
    // Asserting only the sqlite half made the test pass or fail on the developer's shell.
    vi.stubEnv("DATABASE_URL", "file:./dev.db");
    expect(detectLineageSqlEngine(undefined as unknown as string)).toBe("sqlite");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@h:5432/db");
    expect(detectLineageSqlEngine(undefined as unknown as string)).toBe("postgres");
  });
  it("returns postgres for postgres:// and postgresql:// URLs", () => {
    expect(detectLineageSqlEngine("postgres://u:p@h:5432/db")).toBe("postgres");
    expect(detectLineageSqlEngine("postgresql://u:p@h:5432/db")).toBe("postgres");
  });
  it("returns postgres for a prisma+postgres:// URL", () => {
    expect(detectLineageSqlEngine("prisma+postgres://accelerate/db")).toBe("postgres");
  });
});

describe("buildLineageCteSql", () => {
  it("emits a WITH RECURSIVE valid on both dialects with the right placeholder counts", () => {
    const sql = buildLineageCteSql(2, 3);
    expect(sql).toContain("WITH RECURSIVE");
    expect(sql).toContain("code_edges");
    expect(sql).toContain("r.depth < 32");
    // 2 seed placeholders + 3 kind placeholders = 5 total `?`.
    expect((sql.match(/\?/g) ?? []).length).toBe(5);
    // No dialect-specific functions.
    expect(sql).not.toMatch(/gen_random_uuid|JSON_|::/);
  });

  it("uses `?` placeholders for sqlite (the default engine)", () => {
    const sql = buildLineageCteSql(2, 1, "sqlite");
    expect((sql.match(/\?/g) ?? []).length).toBe(3);
    // sqlite must NOT emit positional `$n` placeholders.
    expect(sql).not.toMatch(/\$\d/);
  });

  it("uses positional `$1..$n` placeholders for postgres (no `?`)", () => {
    const sql = buildLineageCteSql(2, 3, "postgres");
    // postgres binds positionally: seeds = $1,$2; kinds = $3,$4,$5.
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
    expect(sql).toContain("$3");
    expect(sql).toContain("$4");
    expect(sql).toContain("$5");
    expect(sql).not.toMatch(/\$6/);
    // postgres must NOT use the sqlite `?` style.
    expect(sql).not.toContain("?");
  });

  it("numbers postgres placeholders contiguously across seeds then kinds", () => {
    // 1 seed then 1 kind → seed is $1, kind is $2 (kinds continue the sequence).
    const sql = buildLineageCteSql(1, 1, "postgres");
    expect(sql).toMatch(/IN \(\$1\)/);
    expect(sql).toMatch(/IN \(\$2\)/);
  });
});

describe("traverseLineageDb", () => {
  it("binds seeds + kinds and maps rows (no interpolation)", async () => {
    const queryRawUnsafe = vi.fn(async () => [{ symbol_id: "s1" }, { symbol_id: "s2" }]);
    const out = await traverseLineageDb(
      { $queryRawUnsafe: queryRawUnsafe } as never,
      ["a"],
      ["reads"],
    );
    expect(out).toEqual(["s1", "s2"]);
    // First arg is the SQL; the rest are bound params (seed then kind).
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("WITH RECURSIVE"),
      "a",
      "reads",
    );
  });

  it("short-circuits to [] for empty seeds (no query)", async () => {
    const queryRawUnsafe = vi.fn();
    expect(
      await traverseLineageDb({ $queryRawUnsafe: queryRawUnsafe } as never, [], ["reads"]),
    ).toEqual([]);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("emits sqlite `?` placeholders when the engine is sqlite", async () => {
    const queryRawUnsafe = vi.fn(async () => []);
    await traverseLineageDb(
      { $queryRawUnsafe: queryRawUnsafe } as never,
      ["a"],
      ["reads"],
      "sqlite",
    );
    const sql = queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain("?");
    expect(sql).not.toMatch(/\$\d/);
  });

  it("emits postgres `$n` placeholders when the engine is postgres (bound, no interpolation)", async () => {
    const queryRawUnsafe = vi.fn(async () => [{ symbol_id: "s1" }]);
    const out = await traverseLineageDb(
      { $queryRawUnsafe: queryRawUnsafe } as never,
      ["a", "b"],
      ["reads"],
      "postgres",
    );
    expect(out).toEqual(["s1"]);
    const sql = queryRawUnsafe.mock.calls[0][0] as string;
    // 2 seeds + 1 kind → $1,$2 (seeds), $3 (kind); never the sqlite `?` style.
    expect(sql).toContain("$1");
    expect(sql).toContain("$3");
    expect(sql).not.toContain("?");
    // Params are still bound positionally (seeds then kinds) — no interpolation.
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("WITH RECURSIVE"),
      "a",
      "b",
      "reads",
    );
  });
});
