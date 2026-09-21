/**
 * Issue #896 (epic #883) — JPA/Hibernate query-lineage extraction. Covers
 * Spring Data repository discovery, `@Query` (HQL/JPQL) parsing, derived
 * query-method-name parsing, the `nativeQuery = true` fall-through, and
 * persistence (both the statement→table/column edges and the real-method→
 * synthetic-origin `executes` hop).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma/writer fakes */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractJpaQueries,
  parseSpringDataRepositories,
  persistJpaQueryFile,
  persistJpaQueryOriginEdges,
  type JpaQueryOrigin,
} from "../src/lib/code-graph/jpa-query-extractor.js";
import { buildJpaEntityResolver } from "../src/lib/code-graph/entity-resolver.js";
import { SchemaGraphWriter } from "../src/lib/code-graph/schema-graph.js";

const customerJava = readFileSync(join(__dirname, "fixtures", "orm", "Customer.java"), "utf8");
const repoJava = readFileSync(
  join(__dirname, "fixtures", "orm", "CustomerRepository.java"),
  "utf8",
);

describe("parseSpringDataRepositories", () => {
  it("finds a JpaRepository<Entity, Id> interface and its entity type param", () => {
    const repos = parseSpringDataRepositories(repoJava);
    expect(repos).toHaveLength(1);
    expect(repos[0].interfaceName).toBe("CustomerRepository");
    expect(repos[0].entityRef).toBe("Customer");
  });

  it("ignores a plain interface that doesn't extend a Spring Data base repository", () => {
    const src = "public interface NotARepository { void doStuff(); }";
    expect(parseSpringDataRepositories(src)).toHaveLength(0);
  });

  it("recognises CrudRepository too", () => {
    const src = "public interface FooRepo extends CrudRepository<Foo, String> {}";
    const repos = parseSpringDataRepositories(src);
    expect(repos[0].entityRef).toBe("Foo");
  });
});

describe("extractJpaQueries", () => {
  const statements = extractJpaQueries(repoJava);
  const byMethod = new Map(statements.map((s) => [s.methodName, s]));

  it("resolves a simple derived query method to a single field", () => {
    const s = byMethod.get("findByEmail");
    expect(s).toMatchObject({ kind: "reads", entityRef: "Customer", fields: ["email"] });
  });

  it("splits a compound derived query on And into separate fields", () => {
    const s = byMethod.get("findByDisplayNameAndTenantId");
    expect(s).toMatchObject({ kind: "reads", entityRef: "Customer" });
    expect(s?.fields).toEqual(["displayName", "tenantId"]);
  });

  it("classifies a deleteBy derived method as writes", () => {
    const s = byMethod.get("deleteByEmail");
    expect(s).toMatchObject({ kind: "writes", entityRef: "Customer", fields: ["email"] });
  });

  it("parses a SELECT @Query's FROM clause, alias, and alias.field references", () => {
    const s = byMethod.get("findCustomByEmail");
    expect(s).toMatchObject({ kind: "reads", entityRef: "Customer", fields: ["email"] });
  });

  it("classifies an UPDATE @Query as writes and extracts SET/WHERE alias fields", () => {
    const s = byMethod.get("renameCustomer");
    expect(s).toMatchObject({ kind: "writes", entityRef: "Customer" });
    expect(s?.fields).toEqual(["displayName", "id"]);
  });

  it("EXCLUDES a nativeQuery = true @Query — falls through to the SQL path", () => {
    expect(byMethod.has("findByEmailNative")).toBe(false);
    expect(statements).toHaveLength(5);
  });

  it("strips Spring Data operator-keyword suffixes to recover the base field name", () => {
    const src = [
      "public interface X extends JpaRepository<Account, Long> {",
      "  List<Account> findByAgeGreaterThanAndActiveTrue(int age, boolean active);",
      "  List<Account> findByNameContainingIgnoreCase(String name);",
      "}",
    ].join("\n");
    const [q1, q2] = extractJpaQueries(src);
    expect(q1.fields).toEqual(["age", "active"]);
    expect(q2.fields).toEqual(["name"]);
  });

  it("returns no statements for a repository with no query methods, and no repositories at all", () => {
    expect(extractJpaQueries("public interface Empty extends JpaRepository<Foo, Long> {}")).toEqual(
      [],
    );
    expect(extractJpaQueries("public class NotARepo {}")).toEqual([]);
  });

  it("tolerates a malformed @Query with no opening paren at all — never throws", () => {
    const src = ["public interface X extends JpaRepository<Foo, Long> {", "  @Query", "}"].join(
      "\n",
    );
    expect(extractJpaQueries(src)).toEqual([]);
  });

  it("tolerates a malformed @Query with an unbalanced (never-closed) paren — never throws", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      '  @Query("SELECT f FROM Foo f',
      "}",
    ].join("\n");
    expect(extractJpaQueries(src)).toEqual([]);
  });

  it("skips an @Query with no method declaration following it", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      '  @Query("SELECT f FROM Foo f")',
      "}",
    ].join("\n");
    expect(extractJpaQueries(src)).toEqual([]);
  });

  it("skips an @Query whose args carry no quoted JPQL string", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      "  @Query(timeout = 1000)",
      "  List<Foo> weirdQuery();",
      "}",
    ].join("\n");
    expect(extractJpaQueries(src)).toEqual([]);
  });

  it("skips an @Query whose JPQL has no FROM/UPDATE clause to anchor an entity", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      '  @Query("SELECT 1")',
      "  int constantQuery();",
      "}",
    ].join("\n");
    expect(extractJpaQueries(src)).toEqual([]);
  });

  it("treats an immediately-following JPQL keyword as NO alias (never a real alias) and skips field extraction", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      '  @Query("SELECT f FROM Foo WHERE f.id = 1")',
      "  Foo findConstantFoo();",
      "}",
    ].join("\n");
    const [stmt] = extractJpaQueries(src);
    expect(stmt.entityRef).toBe("Foo");
    expect(stmt.fields).toEqual([]);
  });

  it("skips a false-positive alias.field match that's actually a longer identifier's suffix", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      '  @Query("SELECT f FROM Foo f WHERE xf.email IS NOT NULL AND f.name = :name")',
      '  Foo findByWeirdText(@Param("name") String name);',
      "}",
    ].join("\n");
    const [stmt] = extractJpaQueries(src);
    // "xf.email" must NOT match (preceded by a word char); only the real "f.name" does.
    expect(stmt.fields).toEqual(["name"]);
  });

  it("skips an annotation-between-@Query-and-method with an unbalanced paren", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      '  @Query("SELECT f FROM Foo f")',
      "  @Modifying(clearAutomatically = true",
      "  int brokenAnnotation();",
      "}",
    ].join("\n");
    expect(extractJpaQueries(src)).toEqual([]);
  });

  it("skips over an intervening annotation with no parens (e.g. @Transactional) between @Query and the method", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      '  @Query("SELECT f FROM Foo f WHERE f.id = :id")',
      "  @Transactional",
      '  Foo findTransactionalFoo(@Param("id") Long id);',
      "}",
    ].join("\n");
    const [stmt] = extractJpaQueries(src);
    expect(stmt.methodName).toBe("findTransactionalFoo");
    expect(stmt.fields).toEqual(["id"]);
  });

  it("skips over a WELL-FORMED parenthesized intervening annotation (e.g. @Modifying(...)) between @Query and the method", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      '  @Query("UPDATE Foo f SET f.name = :name WHERE f.id = :id")',
      "  @Modifying(clearAutomatically = true)",
      '  int renameFoo(@Param("id") Long id, @Param("name") String name);',
      "}",
    ].join("\n");
    const [stmt] = extractJpaQueries(src);
    expect(stmt.methodName).toBe("renameFoo");
    expect(stmt.kind).toBe("writes");
    expect(stmt.fields).toEqual(["name", "id"]);
  });

  it("ignores an alias.field reference whose dot isn't followed by a valid identifier", () => {
    const src = [
      "public interface X extends JpaRepository<Foo, Long> {",
      '  @Query("SELECT f FROM Foo f WHERE f.9invalid IS NOT NULL AND f.name = :name")',
      '  Foo findWeirdFoo(@Param("name") String name);',
      "}",
    ].join("\n");
    const [stmt] = extractJpaQueries(src);
    expect(stmt.fields).toEqual(["name"]);
  });
});

describe("persistJpaQueryFile (#896)", () => {
  function fakeWriter() {
    const symbols: any[] = [];
    const edges: any[] = [];
    let n = 0;
    const prisma = {
      codeSymbol: {
        create: async ({ data }: any) => {
          symbols.push(data);
          return { id: `${data.kind}-${++n}` };
        },
      },
      codeEdge: {
        create: async ({ data }: any) => {
          edges.push(data);
        },
      },
    };
    return { writer: new SchemaGraphWriter(prisma as never, "g1", "p1"), symbols, edges };
  }

  it("persists a table edge + resolved column edge per statement, all source=orm", async () => {
    const resolver = buildJpaEntityResolver(new Map([["Customer.java", customerJava]]));
    const { writer, edges } = fakeWriter();
    const origins: JpaQueryOrigin[] = [];
    const written = await persistJpaQueryFile(
      writer,
      resolver,
      "src/CustomerRepository.java",
      repoJava,
      origins,
    );
    expect(written).toBeGreaterThan(0);
    expect(edges.every((e) => e.source === "orm")).toBe(true);
    // findByEmail: table edge (accounts... customers) + column edge (email_address).
    const tableEdges = edges.filter((e) => e.toQualifiedName === "crm.customers");
    expect(tableEdges.length).toBeGreaterThan(0);
    const colEdges = edges.filter((e) => e.toQualifiedName === "crm.customers.email_address");
    expect(colEdges.some((e) => e.kind === "reads")).toBe(true);
    // 6 declared methods, 5 resolvable statements (native excluded) -> 5 origins.
    expect(origins).toHaveLength(5);
  });

  it("skips a statement whose entity reference doesn't resolve — no edge fabricated", async () => {
    const resolver = buildJpaEntityResolver(new Map()); // empty — nothing resolves
    const { writer, edges } = fakeWriter();
    const origins: JpaQueryOrigin[] = [];
    const written = await persistJpaQueryFile(
      writer,
      resolver,
      "src/CustomerRepository.java",
      repoJava,
      origins,
    );
    expect(written).toBe(0);
    expect(edges).toHaveLength(0);
    expect(origins).toHaveLength(0);
  });

  it("still emits the table edge even when a field can't be resolved to a column", async () => {
    const resolver = buildJpaEntityResolver(new Map([["Customer.java", customerJava]]));
    const { writer, edges } = fakeWriter();
    const origins: JpaQueryOrigin[] = [];
    // tenantId doesn't resolve (real field name is `tenant`) — table edge must still land.
    await persistJpaQueryFile(writer, resolver, "src/CustomerRepository.java", repoJava, origins);
    const tenantColumnEdges = edges.filter((e) =>
      String(e.toQualifiedName ?? "").endsWith(".tenant_id_id"),
    );
    expect(tenantColumnEdges).toHaveLength(0); // never fabricated
    const findByBoth = origins.find((o) => o.methodName === "findByDisplayNameAndTenantId");
    expect(findByBoth).toBeDefined();
  });

  it("is a no-op for a file with no repository interfaces", async () => {
    const resolver = buildJpaEntityResolver(new Map([["Customer.java", customerJava]]));
    const { writer, edges } = fakeWriter();
    const origins: JpaQueryOrigin[] = [];
    const written = await persistJpaQueryFile(
      writer,
      resolver,
      "src/Plain.java",
      "class Plain {}",
      origins,
    );
    expect(written).toBe(0);
    expect(edges).toHaveLength(0);
  });
});

describe("persistJpaQueryOriginEdges (#896)", () => {
  function fakeWriter() {
    const edges: any[] = [];
    const prisma = {
      codeSymbol: { create: async () => ({ id: "unused" }) },
      codeEdge: {
        create: async ({ data }: any) => {
          edges.push(data);
        },
      },
    };
    return { writer: new SchemaGraphWriter(prisma as never, "g1", "p1"), edges };
  }

  it("connects the REAL repository method to its synthetic query origin via an executes edge", async () => {
    const { writer, edges } = fakeWriter();
    const origins: JpaQueryOrigin[] = [
      {
        symbolId: "origin-1",
        filePath: "src/CustomerRepository.java",
        methodName: "findByEmail",
        qualifiedName: "src/CustomerRepository.java::findByEmail#jpa-query",
        line: 11,
      },
    ];
    const methodSymbolsByFile = new Map([
      ["src/CustomerRepository.java", new Map([["findByEmail", "real-method-1"]])],
    ]);
    const written = await persistJpaQueryOriginEdges(writer, origins, methodSymbolsByFile);
    expect(written).toBe(1);
    expect(edges[0]).toMatchObject({
      kind: "executes",
      fromSymbolId: "real-method-1",
      toSymbolId: "origin-1",
      source: "orm",
    });
  });

  it("skips an origin with no matching real method symbol", async () => {
    const { writer, edges } = fakeWriter();
    const origins: JpaQueryOrigin[] = [
      {
        symbolId: "origin-1",
        filePath: "src/CustomerRepository.java",
        methodName: "findByEmail",
        qualifiedName: "x",
        line: 1,
      },
    ];
    const written = await persistJpaQueryOriginEdges(writer, origins, new Map());
    expect(written).toBe(0);
    expect(edges).toHaveLength(0);
  });
});
