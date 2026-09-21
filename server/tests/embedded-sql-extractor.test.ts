/**
 * Tests for the embedded-SQL extractor — Epic #294 (#305).
 *
 * Uses the REAL tree-sitter parsers to locate string literals across
 * TS/JS/Python/Go, a STUBBED sql-lineage client (no live sidecar / network), and
 * an in-memory schema-graph writer. Verifies edges land with source `sqlglot`,
 * dynamic SQL surfaces as uncertain, and the extractor degrades gracefully when
 * the sidecar returns null.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initCodeGraphParsers } from "../src/lib/code-graph/parsers.js";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";
import {
  extractEmbeddedSql,
  findEmbeddedSqlCandidates,
  looksLikeSql,
} from "../src/lib/code-graph/embedded-sql-extractor.js";
import type {
  ExtractUsageParams,
  ExtractUsageResult,
  SqlLineageClient,
} from "../src/lib/code-graph/sql-lineage-client.js";

interface Recorded {
  symbols: SchemaSymbolCreateData[];
  edges: SchemaEdgeCreateData[];
}

function fakePrisma(): { prisma: SchemaGraphPrisma; recorded: Recorded } {
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
  };
  return { prisma, recorded };
}

/** A stub sql-lineage client that returns a scripted result per SQL substring. */
function stubClient(
  responder: (params: ExtractUsageParams) => ExtractUsageResult,
): SqlLineageClient {
  return {
    extractUsage: async (params: ExtractUsageParams) => responder(params),
  } as unknown as SqlLineageClient;
}

const EMPTY: ExtractUsageResult = {
  tables: [],
  columns: [],
  lineage_edges: [],
  uncertain: [],
  routines: [],
};

function tableResult(name: string, access: "read" | "write" | "persist"): ExtractUsageResult {
  return {
    tables: [{ schema: "", name, qualifiedName: name, access }],
    columns: [{ table: name, column: "id", qualifiedName: `${name}.id`, access }],
    lineage_edges: [],
    uncertain: [],
    routines: [],
  };
}

beforeAll(async () => {
  await initCodeGraphParsers();
  process.env.SQL_LINEAGE_MODE = "sidecar"; // enable the gate; client is stubbed
});

describe("looksLikeSql", () => {
  it("accepts real SQL statements", () => {
    expect(looksLikeSql("SELECT id FROM users")).toBe(true);
    expect(looksLikeSql("insert into orders (id) values (1)")).toBe(true);
    expect(looksLikeSql("UPDATE accounts SET n = 1 WHERE id = 2")).toBe(true);
    expect(looksLikeSql("WITH r AS (SELECT 1) SELECT * FROM r")).toBe(true);
  });

  it("rejects non-SQL strings", () => {
    expect(looksLikeSql("hello world")).toBe(false);
    expect(looksLikeSql("/users/:id")).toBe(false);
    expect(looksLikeSql("select")).toBe(false); // too short / no shape
    expect(looksLikeSql("")).toBe(false);
  });
});

describe("findEmbeddedSqlCandidates", () => {
  it("locates SQL literals in TypeScript", () => {
    const src = `
      const q = "SELECT id, name FROM users WHERE active = 1";
      const notSql = "just a label";
      db.query(\`UPDATE orders SET status = 'x' WHERE id = 5\`);
    `;
    const found = findEmbeddedSqlCandidates(src, "ts");
    expect(found.map((c) => c.sql.slice(0, 6))).toEqual(["SELECT", "UPDATE"]);
  });

  it("flags interpolated SQL as dynamic", () => {
    const src = "const q = `SELECT * FROM users WHERE id = ${id}`;";
    const found = findEmbeddedSqlCandidates(src, "ts");
    expect(found).toHaveLength(1);
    expect(found[0].dynamic).toBe(true);
  });

  it("locates SQL literals in C# ADO.NET / Dapper call-sites (#900)", () => {
    const src = `
      public class Repo {
        public void Find() {
          var cmd = new SqlCommand("SELECT id, name FROM users WHERE active = 1");
          var label = "just a label";
          var rows = connection.Query<User>("SELECT * FROM orders WHERE id = @id");
          connection.Execute("UPDATE orders SET status = 'x' WHERE id = 5");
        }
      }
    `;
    const found = findEmbeddedSqlCandidates(src, "cs");
    expect(found.map((c) => c.sql.slice(0, 6)).sort()).toEqual(["SELECT", "SELECT", "UPDATE"]);
    // Plain C# string literals (no `$` interpolation) are never dynamic.
    expect(found.every((c) => !c.dynamic)).toBe(true);
  });

  it('flags interpolated C# SQL ($"...") as dynamic (#900)', () => {
    const src = 'class R { void M() { var q = $"SELECT * FROM users WHERE id = {id}"; } }';
    const found = findEmbeddedSqlCandidates(src, "cs");
    expect(found).toHaveLength(1);
    expect(found[0].dynamic).toBe(true);
  });

  it("locates SQL literals in Java JDBC call-sites (#888)", () => {
    const src = `
      class Dao {
        void find() {
          String sql = "SELECT id, name FROM users WHERE active = 1";
          String label = "just a label";
          PreparedStatement ps = conn.prepareStatement(sql);
        }
      }
    `;
    const found = findEmbeddedSqlCandidates(src, "java");
    expect(found.map((c) => c.sql.slice(0, 6))).toEqual(["SELECT"]);
    // A plain Java string_literal has no interpolation grammar — never dynamic.
    expect(found[0].dynamic).toBe(false);
  });

  it("assembles Java `+`-concatenated string constants into one candidate (#889)", () => {
    const src = `
      class Dao {
        void find() {
          String sql = "SELECT id " + "FROM orders " + "WHERE status = 'open'";
        }
      }
    `;
    const found = findEmbeddedSqlCandidates(src, "java");
    expect(found).toHaveLength(1);
    expect(found[0].sql).toBe("SELECT id FROM orders WHERE status = 'open'");
    expect(found[0].dynamic).toBe(false);
  });

  it("flags a Java `+` concat with a non-constant operand as dynamic (#889)", () => {
    const src = `
      class Dao {
        void find(String id) {
          String sql = "SELECT * FROM foo WHERE x = " + id + " AND y = 1";
        }
      }
    `;
    const found = findEmbeddedSqlCandidates(src, "java");
    expect(found).toHaveLength(1);
    expect(found[0].dynamic).toBe(true);
    // The static fragments are still joined (for the SQL-shape check); the
    // runtime operand simply contributes nothing.
    expect(found[0].sql).toContain("SELECT * FROM foo WHERE x =");
  });

  it("assembles a Java StringBuilder constant append chain (#889)", () => {
    const src = `
      class Dao {
        void find() {
          StringBuilder sb = new StringBuilder();
          sb.append("SELECT id ");
          sb.append("FROM bar ");
          sb.append("WHERE y = 1");
          String sql = sb.toString();
        }
      }
    `;
    const found = findEmbeddedSqlCandidates(src, "java");
    expect(found).toHaveLength(1);
    expect(found[0].sql).toBe("SELECT id FROM bar WHERE y = 1");
    expect(found[0].dynamic).toBe(false);
  });

  it("assembles a fluent StringBuilder chain and honours the constructor seed (#889)", () => {
    const src = `
      class Dao {
        void find() {
          StringBuilder sb = new StringBuilder("SELECT id ");
          sb.append("FROM baz ").append("WHERE z = 2");
          String sql = sb.toString();
        }
      }
    `;
    const found = findEmbeddedSqlCandidates(src, "java");
    expect(found).toHaveLength(1);
    expect(found[0].sql).toBe("SELECT id FROM baz WHERE z = 2");
    expect(found[0].dynamic).toBe(false);
  });

  it("flags a StringBuilder chain with a non-constant append as dynamic (#889)", () => {
    const src = `
      class Dao {
        void find(int status) {
          StringBuilder sb = new StringBuilder();
          sb.append("SELECT * FROM qux WHERE a = ");
          sb.append(status);
          sb.append(" AND b = 1");
          String sql = sb.toString();
        }
      }
    `;
    const found = findEmbeddedSqlCandidates(src, "java");
    expect(found).toHaveLength(1);
    expect(found[0].dynamic).toBe(true);
    expect(found[0].sql).toContain("SELECT * FROM qux WHERE a =");
  });

  it("unwraps a parenthesized Java concat and ignores non-SQL `+` expressions (#889)", () => {
    const src = `
      class Dao {
        void find() {
          int n = 1 + 2;
          String path = "a/" + "b/";
          String sql = ("SELECT id " + "FROM parend");
        }
      }
    `;
    const found = findEmbeddedSqlCandidates(src, "java");
    // Only the SQL-shaped concat survives the shape filter; the numeric `+` and
    // the non-SQL path string are dropped.
    expect(found).toHaveLength(1);
    expect(found[0].sql).toBe("SELECT id FROM parend");
    expect(found[0].dynamic).toBe(false);
  });

  it("does not double-count StringBuilder fragments as lone literals (#889)", () => {
    const src = `
      class Dao {
        void find() {
          StringBuilder sb = new StringBuilder();
          sb.append("SELECT id FROM solo");
          String sql = sb.toString();
        }
      }
    `;
    const found = findEmbeddedSqlCandidates(src, "java");
    // Exactly one candidate — the appended literal is consumed by the assembly,
    // not re-emitted as a bare literal.
    expect(found).toHaveLength(1);
    expect(found[0].sql).toBe("SELECT id FROM solo");
  });
});

describe("extractEmbeddedSql persistence", () => {
  it("writes sqlglot reads edges for a SELECT in TS", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `const q = "SELECT id FROM users";`;
    const client = stubClient(() => tableResult("users", "read"));
    const result = await extractEmbeddedSql(writer, "src/repo.ts", src, { client });

    expect(result.candidates).toBe(1);
    expect(result.resolved).toBe(1);
    const tableEdge = recorded.edges.find((e) => e.toQualifiedName === "users");
    expect(tableEdge?.kind).toBe("reads");
    expect(tableEdge?.source).toBe("sqlglot");
    const colEdge = recorded.edges.find((e) => e.toQualifiedName === "users.id");
    expect(colEdge?.source).toBe("sqlglot");
  });

  it("maps INSERT to persists-to and UPDATE to writes", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `
      x("INSERT INTO orders (id) VALUES (1)");
      y("UPDATE orders SET n = 1 WHERE id = 2");
    `;
    const client = stubClient((p) =>
      /insert/i.test(p.sql) ? tableResult("orders", "persist") : tableResult("orders", "write"),
    );
    await extractEmbeddedSql(writer, "src/repo.ts", src, { client });
    const kinds = new Set(
      recorded.edges.filter((e) => e.toQualifiedName === "orders").map((e) => e.kind),
    );
    expect(kinds.has("persists-to")).toBe(true);
    expect(kinds.has("writes")).toBe(true);
  });

  it("handles Python embedded SQL", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = 'q = "SELECT id FROM accounts"\ncur.execute(q)\n';
    const client = stubClient(() => tableResult("accounts", "read"));
    const res = await extractEmbeddedSql(writer, "app/dao.py", src, { client });
    expect(res.resolved).toBe(1);
    expect(recorded.edges.some((e) => e.toQualifiedName === "accounts")).toBe(true);
  });

  it("handles Go embedded SQL (raw + interpreted strings)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = "func f() {\n  q := `SELECT id FROM widgets`\n  _ = q\n}\n";
    const client = stubClient(() => tableResult("widgets", "read"));
    const res = await extractEmbeddedSql(writer, "pkg/store.go", src, { client });
    expect(res.resolved).toBe(1);
    expect(recorded.edges.some((e) => e.toQualifiedName === "widgets")).toBe(true);
  });

  it("captures database/sql + sqlx raw-SQL call arguments in Go (#899)", async () => {
    // #899: verify the existing sqlglot Go path already covers the raw-SQL
    // strings passed to database/sql (`db.Query`/`db.Exec`) and sqlx
    // (`db.Get`/`db.Select`) — the SQL is an ordinary string literal, so it is
    // located regardless of the enclosing call. GORM struct lineage is the
    // NEW, separate path (`gorm-extractor.ts`), not this one.
    const src = [
      "func repo(db *sqlx.DB) {",
      '  db.Query("SELECT id FROM users WHERE age > 18")',
      '  db.Exec("UPDATE accounts SET balance = 0")',
      '  db.Get(&u, "SELECT id, email FROM users WHERE id = $1", id)',
      '  db.Select(&rows, "SELECT * FROM orders")',
      "}",
    ].join("\n");
    const candidates = findEmbeddedSqlCandidates(src, "go");
    const sqls = candidates.map((c) => c.sql);
    expect(sqls).toContain("SELECT id FROM users WHERE age > 18");
    expect(sqls).toContain("UPDATE accounts SET balance = 0");
    expect(sqls).toContain("SELECT id, email FROM users WHERE id = $1");
    expect(sqls).toContain("SELECT * FROM orders");
  });

  it("handles Java raw JDBC embedded SQL (#888)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `
      class OrderDao {
        void load(Connection conn) throws SQLException {
          String label = "not sql, just a log line";
          PreparedStatement ps = conn.prepareStatement("SELECT id FROM orders WHERE id = ?");
        }
      }
    `;
    const client = stubClient(() => tableResult("orders", "read"));
    const res = await extractEmbeddedSql(writer, "src/main/java/OrderDao.java", src, { client });

    // The non-SQL literal never reached the sidecar / was not misclassified.
    expect(res.candidates).toBe(1);
    expect(res.resolved).toBe(1);
    expect(recorded.edges.some((e) => e.toQualifiedName === "orders" && e.kind === "reads")).toBe(
      true,
    );
  });

  it("persists edges from Java `+`-assembled constant SQL (#889)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `
      class Dao {
        void find() {
          PreparedStatement ps = conn.prepareStatement("SELECT id " + "FROM orders");
        }
      }
    `;
    let seenSql: string | undefined;
    const client = stubClient((p) => {
      seenSql = p.sql;
      return tableResult("orders", "read");
    });
    const res = await extractEmbeddedSql(writer, "src/main/java/Dao.java", src, { client });
    // The sidecar received the ASSEMBLED string, not a fragment.
    expect(seenSql).toBe("SELECT id FROM orders");
    expect(res.resolved).toBe(1);
    expect(recorded.edges.some((e) => e.toQualifiedName === "orders" && e.kind === "reads")).toBe(
      true,
    );
  });

  it("records a Java mixed concat as uncertain WITHOUT calling the sidecar (#889)", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `
      class Dao {
        void find(String id) {
          PreparedStatement ps =
            conn.prepareStatement("SELECT * FROM foo WHERE x = " + id);
        }
      }
    `;
    let called = false;
    const client = stubClient(() => {
      called = true;
      return tableResult("foo", "read");
    });
    const res = await extractEmbeddedSql(writer, "src/main/java/Dao.java", src, { client });
    // The dynamic candidate is NOT parsed (no sidecar call, no fabricated edges)…
    expect(called).toBe(false);
    expect(res.edges).toBe(0);
    expect(recorded.edges).toHaveLength(0);
    // …but it is preserved as an unresolved/dynamic ref, never dropped.
    expect(res.uncertain.some((u) => u.reason === "dynamic-reference")).toBe(true);
  });

  it("defaults Java to the Oracle dialect (configurable)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `String sql = "SELECT id FROM orders";`;
    let seenDialect: string | undefined;
    const client = stubClient((p) => {
      seenDialect = p.dialect;
      return tableResult("orders", "read");
    });
    await extractEmbeddedSql(writer, "src/main/java/Dao.java", src, { client });
    expect(seenDialect).toBe("oracle");
  });

  it("Java: writes to a Statement.executeUpdate/executeQuery call still resolve as sqlglot edges", async () => {
    const { prisma, recorded } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `
      class Dao {
        void run(Statement st) throws SQLException {
          st.executeUpdate("UPDATE orders SET status = 'shipped' WHERE id = 1");
          st.executeQuery("SELECT id FROM orders");
        }
      }
    `;
    const client = stubClient((p) =>
      /update/i.test(p.sql) ? tableResult("orders", "write") : tableResult("orders", "read"),
    );
    const res = await extractEmbeddedSql(writer, "src/main/java/Dao.java", src, { client });
    expect(res.candidates).toBe(2);
    const kinds = new Set(
      recorded.edges.filter((e) => e.toQualifiedName === "orders").map((e) => e.kind),
    );
    expect(kinds.has("writes")).toBe(true);
    expect(kinds.has("reads")).toBe(true);
  });

  it("forwards the introspected schema to the sidecar", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = `const q = "SELECT * FROM users";`;
    let seenSchema: unknown;
    const client = stubClient((p) => {
      seenSchema = p.schema;
      return tableResult("users", "read");
    });
    await extractEmbeddedSql(writer, "src/repo.ts", src, {
      client,
      schema: { public: { users: { id: "INT" } } },
    });
    expect(seenSchema).toEqual({ public: { users: { id: "INT" } } });
  });

  it("records uncertain refs from the sidecar (never dropped)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const src = "const q = `SELECT * FROM users WHERE id = ${id}`;";
    const client = stubClient(() => ({
      ...EMPTY,
      uncertain: [{ reason: "dynamic-reference", detail: "interpolated" }],
    }));
    const res = await extractEmbeddedSql(writer, "src/repo.ts", src, { client });
    expect(res.uncertain).toHaveLength(1);
    expect(res.uncertain[0].reason).toBe("dynamic-reference");
  });

  it("returns zeroed result when no SQL is present (no sidecar call)", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    let called = false;
    const client = stubClient(() => {
      called = true;
      return EMPTY;
    });
    const res = await extractEmbeddedSql(writer, "src/repo.ts", `const x = "hello";`, { client });
    expect(res.candidates).toBe(0);
    expect(called).toBe(false);
  });

  it("ignores unsupported file types", async () => {
    const { prisma } = fakePrisma();
    const writer = new SchemaGraphWriter(prisma, "g1", "p1");
    const res = await extractEmbeddedSql(writer, "notes.md", "SELECT id FROM users", {});
    expect(res.candidates).toBe(0);
  });

  it("degrades gracefully (records dynamic uncertain) when the sidecar is unavailable", async () => {
    // No client passed + mode in-process => extractUsageSafe returns null.
    const prevMode = process.env.SQL_LINEAGE_MODE;
    process.env.SQL_LINEAGE_MODE = "in-process";
    try {
      const { prisma, recorded } = fakePrisma();
      const writer = new SchemaGraphWriter(prisma, "g1", "p1");
      const src = "const q = `SELECT * FROM users WHERE id = ${id}`;";
      const res = await extractEmbeddedSql(writer, "src/repo.ts", src, {});
      expect(res.edges).toBe(0);
      expect(recorded.edges).toHaveLength(0);
      // The dynamic candidate is preserved as uncertain, not silently dropped.
      expect(res.uncertain.some((u) => u.reason === "dynamic-reference")).toBe(true);
    } finally {
      process.env.SQL_LINEAGE_MODE = prevMode;
    }
  });
});
