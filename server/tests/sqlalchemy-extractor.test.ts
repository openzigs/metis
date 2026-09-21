/**
 * Issue #898 (Epic #883) — SQLAlchemy Core & ORM query-lineage extractor.
 *
 * Covers the pure parsing (`parseSqlAlchemyOrmEntities` / `parseSqlAlchemyCoreTables`),
 * the shared-resolver factory (`buildSqlAlchemyEntityResolver`), the query
 * call-site scanner (`findSqlAlchemyCallSites`), and edge persistence
 * (`persistSqlAlchemyCallSiteEdges`). The ingest seam is covered separately by
 * `ingest-sqlalchemy-wiring.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";
import { buildSqlAlchemyEntityResolver } from "../src/lib/code-graph/entity-resolver.js";
import {
  findSqlAlchemyCallSites,
  parseSqlAlchemyCoreTables,
  parseSqlAlchemyEntities,
  parseSqlAlchemyOrmEntities,
  persistSqlAlchemyCallSiteEdges,
} from "../src/lib/code-graph/sqlalchemy-extractor.js";
import type { EnclosingSymbol } from "../src/lib/code-graph/orm-callsite-extractor.js";

const FIX = join(__dirname, "fixtures", "sqlalchemy");
const modelsPy = readFileSync(join(FIX, "models.py"), "utf8");
const queriesPy = readFileSync(join(FIX, "queries.py"), "utf8");

interface Recorded {
  symbols: SchemaSymbolCreateData[];
  edges: SchemaEdgeCreateData[];
}

function fakeWriter(): { writer: SchemaGraphWriter; recorded: Recorded } {
  const recorded: Recorded = { symbols: [], edges: [] };
  let n = 0;
  const prisma: SchemaGraphPrisma = {
    codeSymbol: {
      create: async ({ data }) => {
        recorded.symbols.push(data);
        return { id: `sym-${++n}` };
      },
    },
    codeEdge: {
      create: async ({ data }) => {
        recorded.edges.push(data);
        return undefined;
      },
    },
  } as unknown as SchemaGraphPrisma;
  return { writer: new SchemaGraphWriter(prisma, "g1", "p1"), recorded };
}

describe("parseSqlAlchemyOrmEntities (#898)", () => {
  it("maps a declarative class to its __tablename__ + schema and columns", () => {
    const entities = parseSqlAlchemyOrmEntities(modelsPy);
    const user = entities.find((e) => e.entityName === "User");
    expect(user).toBeDefined();
    expect(user?.table).toBe("users");
    expect(user?.schema).toBe("crm");
    // Explicit Column("email_address") override wins over the attribute name.
    expect(user?.fields).toContainEqual({ field: "email", column: "email_address" });
    // A bare Column(String) defaults to the (lower-cased) attribute name.
    expect(user?.fields).toContainEqual({ field: "display_name", column: "display_name" });
    expect(user?.fields).toContainEqual({ field: "id", column: "id" });
  });

  it("skips a mixin/abstract class with no __tablename__ — never guesses a table", () => {
    const entities = parseSqlAlchemyOrmEntities(modelsPy);
    expect(entities.some((e) => e.entityName === "AbstractMixin")).toBe(false);
  });
});

describe("parseSqlAlchemyCoreTables (#898)", () => {
  it("maps a Core Table variable to its physical table, schema, and columns", () => {
    const tables = parseSqlAlchemyCoreTables(modelsPy);
    const orders = tables.find((t) => t.entityName === "orders");
    expect(orders).toBeDefined();
    expect(orders?.table).toBe("orders");
    expect(orders?.schema).toBe("sales");
    // Core columns are referenced as `table.c.<name>`, so field === column.
    expect(orders?.fields).toContainEqual({ field: "total", column: "total" });
  });

  it("combines ORM classes and Core tables in parseSqlAlchemyEntities", () => {
    const names = parseSqlAlchemyEntities(modelsPy).map((e) => e.entityName);
    expect(names).toContain("User");
    expect(names).toContain("orders");
  });

  it("skips a Table() whose first positional arg is not a string literal", () => {
    const src = "t = Table(name_var, metadata, Column('id'))\n";
    expect(parseSqlAlchemyCoreTables(src)).toHaveLength(0);
  });

  it("skips a Table() with an unbalanced paren (never throws)", () => {
    const src = "t = Table('t', metadata, Column('id')\n";
    expect(parseSqlAlchemyCoreTables(src)).toHaveLength(0);
  });

  it("dedupes repeated Column names within one Core Table", () => {
    const src = "t = Table('t', metadata, Column('id'), Column('id'))\n";
    const [table] = parseSqlAlchemyCoreTables(src);
    expect(table.fields).toEqual([{ field: "id", column: "id" }]);
  });
});

describe("buildSqlAlchemyEntityResolver (#898)", () => {
  const resolver = buildSqlAlchemyEntityResolver(new Map([["models.py", modelsPy]]));

  it("resolves an ORM class name to its physical table + schema", () => {
    expect(resolver.resolveEntity("User")).toEqual({ table: "users", schema: "crm" });
  });

  it("resolves a Core Table variable to its physical table + schema", () => {
    expect(resolver.resolveEntity("orders")).toEqual({ table: "orders", schema: "sales" });
  });

  it("resolves an explicit Column(name=) field to its physical column", () => {
    expect(resolver.resolveField("User", "email")).toEqual({
      table: "users",
      schema: "crm",
      column: "email_address",
    });
  });

  it("returns null for an unknown entity and for the skipped mixin", () => {
    expect(resolver.resolveEntity("Nope")).toBeNull();
    expect(resolver.resolveEntity("AbstractMixin")).toBeNull();
  });

  it("ignores files with no SQLAlchemy markers (returns an empty resolver)", () => {
    const empty = buildSqlAlchemyEntityResolver(
      new Map([["plain.py", "def f():\n    return 1\n"]]),
    );
    expect(empty.resolveEntity("User")).toBeNull();
  });
});

describe("findSqlAlchemyCallSites (#898)", () => {
  const sites = findSqlAlchemyCallSites(queriesPy);
  const ref = (entityRef: string, field: string | null, kind: "reads" | "writes") =>
    sites.some((s) => s.entityRef === entityRef && s.field === field && s.kind === kind);

  it("classifies session.query(Class) as a table read", () => {
    expect(ref("User", null, "reads")).toBe(true);
  });

  it("captures a column reference in query(Class.field)", () => {
    expect(ref("User", "email", "reads")).toBe(true);
  });

  it("classifies update()/delete() function form as writes", () => {
    expect(ref("User", null, "writes")).toBe(true);
  });

  it("classifies a Core select(table) as a read and table.insert() method form as a write", () => {
    expect(ref("orders", null, "reads")).toBe(true);
    expect(ref("orders", null, "writes")).toBe(true);
  });

  it("does not treat a raw psycopg cursor.execute string as a SQLAlchemy call site", () => {
    // `audit_log` only appears inside the raw SQL string, never as an entity ref.
    expect(sites.some((s) => s.entityRef === "audit_log")).toBe(false);
    // `cursor`/`execute` are not SQLAlchemy verbs.
    expect(sites.some((s) => s.entityRef === "cursor")).toBe(false);
  });
});

describe("persistSqlAlchemyCallSiteEdges (#898)", () => {
  const resolver = buildSqlAlchemyEntityResolver(new Map([["models.py", modelsPy]]));
  // One wide enclosing function symbol spanning the whole queries fixture.
  const symbols: EnclosingSymbol[] = [{ id: "fn-1", startLine: 1, endLine: 400 }];

  it("writes reads/writes edges with source 'orm' anchored to the enclosing symbol", async () => {
    const { writer, recorded } = fakeWriter();
    const n = await persistSqlAlchemyCallSiteEdges(
      writer,
      resolver,
      "queries.py",
      queriesPy,
      symbols,
    );
    expect(n).toBeGreaterThan(0);
    expect(recorded.edges.length).toBe(n);
    expect(recorded.edges.every((e) => e.source === "orm")).toBe(true);
    expect(recorded.edges.every((e) => e.fromSymbolId === "fn-1")).toBe(true);
    expect(recorded.edges.some((e) => e.kind === "reads")).toBe(true);
    expect(recorded.edges.some((e) => e.kind === "writes")).toBe(true);
    // The users table AND the email_address column both got edges.
    expect(recorded.symbols.some((s) => s.kind === "table" && s.name === "users")).toBe(true);
    expect(recorded.symbols.some((s) => s.kind === "column" && s.name === "email_address")).toBe(
      true,
    );
    // The Core orders table resolved too (read + write).
    expect(recorded.symbols.some((s) => s.kind === "table" && s.name === "orders")).toBe(true);
  });

  it("skips call sites with no enclosing persisted symbol", async () => {
    const { writer, recorded } = fakeWriter();
    const n = await persistSqlAlchemyCallSiteEdges(writer, resolver, "queries.py", queriesPy, []);
    expect(n).toBe(0);
    expect(recorded.edges).toHaveLength(0);
  });

  it("emits no edge for an unresolved entity reference", async () => {
    const { writer, recorded } = fakeWriter();
    const src = "def f(session):\n    return session.query(Unknown).all()\n";
    const n = await persistSqlAlchemyCallSiteEdges(writer, resolver, "x.py", src, [
      { id: "fn-x", startLine: 1, endLine: 2 },
    ]);
    expect(n).toBe(0);
    expect(recorded.edges).toHaveLength(0);
  });

  it("dedupes a repeated (from, table, kind) reference within a file", async () => {
    const { writer, recorded } = fakeWriter();
    const src = "def f(session):\n    session.query(User)\n    session.query(User)\n";
    await persistSqlAlchemyCallSiteEdges(writer, resolver, "x.py", src, [
      { id: "fn-x", startLine: 1, endLine: 3 },
    ]);
    const readsToUsers = recorded.edges.filter(
      (e) => e.kind === "reads" && e.toQualifiedName === "crm.users",
    );
    expect(readsToUsers).toHaveLength(1);
  });
});
