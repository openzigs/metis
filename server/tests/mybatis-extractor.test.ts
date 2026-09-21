import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandDynamicTags,
  expandIncludeRefs,
  extractMyBatis,
  extractSqlRefs,
  parseMyBatisAnnotations,
  parseMyBatisXml,
  persistMyBatisFile,
  stripMyBatisPlaceholders,
} from "../src/lib/code-graph/mybatis-extractor.js";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";

const FIX = join(__dirname, "fixtures", "mybatis");
const xml = readFileSync(join(FIX, "UserMapper.xml"), "utf8");
const java = readFileSync(join(FIX, "OrderMapper.java"), "utf8");
const dynamicXml = readFileSync(join(FIX, "DynamicMapper.xml"), "utf8");

function fakeWriter(): {
  writer: SchemaGraphWriter;
  symbols: SchemaSymbolCreateData[];
  edges: SchemaEdgeCreateData[];
} {
  const symbols: SchemaSymbolCreateData[] = [];
  const edges: SchemaEdgeCreateData[] = [];
  let n = 0;
  const prisma: SchemaGraphPrisma = {
    codeSymbol: {
      create: async ({ data }) => {
        symbols.push(data);
        return { id: `${data.kind}-${++n}` };
      },
    },
    codeEdge: {
      create: async ({ data }) => {
        edges.push(data);
        return undefined;
      },
    },
  };
  return { writer: new SchemaGraphWriter(prisma, "g", "p"), symbols, edges };
}

describe("stripMyBatisPlaceholders", () => {
  it("neutralizes #{} bind params to ? but leaves ${} raw substitution untouched (#886)", () => {
    // #{} is always a safe bind param — never a table/column ref. ${} is raw
    // string substitution (frequently a table/column NAME) and must survive
    // this step so table-position matching can still see it.
    expect(stripMyBatisPlaceholders("a = #{id} AND b = ${flag}")).toBe("a = ? AND b = ${flag}");
  });
});

describe("extractSqlRefs — ${} unresolved/dynamic refs (#886)", () => {
  it("marks a ${} table as unresolved instead of dropping it or a bogus concrete table", () => {
    const refs = extractSqlRefs("SELECT * FROM ${tableName} WHERE id = #{id}", "select");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ unresolved: true, placeholder: "tableName", access: "read" });
  });

  it("does not create a phantom table from a ${} in a non-identifier (value) position", () => {
    const refs = extractSqlRefs("SELECT * FROM real_table WHERE status = '${status}'", "select");
    expect(refs).toHaveLength(1);
    expect(refs[0].table).toBe("real_table");
    expect(refs[0].unresolved).toBeUndefined();
  });

  it("#{} bind params never produce a ref on their own", () => {
    const refs = extractSqlRefs("SELECT * FROM real_table WHERE id = #{id}", "select");
    expect(refs).toHaveLength(1);
    expect(refs[0].table).toBe("real_table");
  });

  it("dedupes repeated occurrences of the same ${} placeholder within one statement", () => {
    const refs = extractSqlRefs(
      "SELECT * FROM ${tableName} a JOIN ${tableName} b ON a.id = b.id",
      "select",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ unresolved: true, placeholder: "tableName" });
  });

  it("drops a bare empty ${} in table position rather than emitting a nameless unresolved ref", () => {
    expect(extractSqlRefs("SELECT * FROM ${} WHERE id = ?", "select")).toEqual([]);
  });

  it("does not leak a ${} appearing in the SELECT column list as a bogus concrete column", () => {
    const refs = extractSqlRefs("SELECT ${sortColumn}, id FROM real_table", "select");
    expect(refs[0].columns).toEqual(["id"]);
  });
});

describe("extractSqlRefs", () => {
  it("reads table + select columns", () => {
    const refs = extractSqlRefs("SELECT id, email FROM users WHERE id = ?", "select");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ table: "users", access: "read" });
    expect(refs[0].columns.sort()).toEqual(["email", "id"]);
  });

  it("captures schema-qualified tables and strips aliases", () => {
    const refs = extractSqlRefs("SELECT * FROM app.users u WHERE u.id = ?", "select");
    expect(refs[0]).toMatchObject({ schema: "app", table: "users" });
  });

  it("captures insert columns as persist", () => {
    const refs = extractSqlRefs("INSERT INTO users (email, name) VALUES (?, ?)", "insert");
    expect(refs[0].access).toBe("persist");
    expect(refs[0].columns.sort()).toEqual(["email", "name"]);
  });

  it("captures update SET columns as write", () => {
    const refs = extractSqlRefs("UPDATE users SET email = ?, name = ? WHERE id = ?", "update");
    expect(refs[0].access).toBe("write");
    expect(refs[0].columns.sort()).toEqual(["email", "name"]);
  });

  it("captures delete table as write with no columns", () => {
    const refs = extractSqlRefs("DELETE FROM users WHERE id = ?", "delete");
    expect(refs[0]).toMatchObject({ table: "users", access: "write" });
  });

  it("captures joined tables", () => {
    const refs = extractSqlRefs(
      "SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id",
      "select",
    );
    expect(refs.map((r) => r.table).sort()).toEqual(["user_roles", "users"]);
  });

  it("returns nothing for empty sql", () => {
    expect(extractSqlRefs("   ", "select")).toEqual([]);
  });
});

describe("parseMyBatisXml", () => {
  const statements = parseMyBatisXml(xml);

  it("captures the namespace as qualifiedName prefix", () => {
    const findById = statements.find((s) => s.statementId === "findById");
    expect(findById?.qualifiedName).toBe("com.example.mapper.UserMapper.findById");
    expect(findById?.namespace).toBe("com.example.mapper.UserMapper");
  });

  it("expands <include> fragments into the select columns", () => {
    const findById = statements.find((s) => s.statementId === "findById");
    const ref = findById?.refs[0];
    expect(ref?.table).toBe("users");
    expect(ref?.columns).toEqual(expect.arrayContaining(["id", "email", "display_name"]));
  });

  it("classifies access per statement kind", () => {
    const byId = (id: string) => statements.find((s) => s.statementId === id);
    expect(byId("findById")?.refs[0].access).toBe("read");
    expect(byId("insert")?.refs[0].access).toBe("persist");
    expect(byId("updateEmail")?.refs[0].access).toBe("write");
    expect(byId("deleteById")?.refs[0].access).toBe("write");
  });

  it("captures multiple joined tables", () => {
    const list = statements.find((s) => s.statementId === "listWithRoles");
    expect(list?.refs.map((r) => r.table).sort()).toEqual(["roles", "user_roles", "users"]);
  });
});

describe("expandIncludeRefs (#885 — nested/missing/self-referential <include>)", () => {
  it("resolves a nested include chain (fragment including another fragment)", () => {
    const fragments = new Map([
      ["base", "id, status"],
      ["summary", '<include refid="base"/>, email'],
    ]);
    const resolved = expandIncludeRefs('<include refid="summary"/>', fragments);
    expect(resolved).toBe("id, status, email");
  });

  it("drops an <include> whose refid has no matching <sql> fragment", () => {
    const resolved = expandIncludeRefs('SELECT <include refid="missing"/> FROM t', new Map());
    expect(resolved).toBe("SELECT  FROM t");
  });

  it("breaks a self-referential include cycle instead of recursing forever", () => {
    const fragments = new Map([["cyclic", '<include refid="cyclic"/>, id']]);
    const resolved = expandIncludeRefs('<include refid="cyclic"/>', fragments);
    // Cycle guard drops the re-entrant <include/> but keeps the surrounding text.
    expect(resolved).toBe(", id");
  });

  it("breaks a mutual (A -> B -> A) include cycle", () => {
    const fragments = new Map([
      ["a", '<include refid="b"/>, a_col'],
      ["b", '<include refid="a"/>, b_col'],
    ]);
    const resolved = expandIncludeRefs('<include refid="a"/>', fragments);
    expect(resolved).toBe(", b_col, a_col");
  });
});

describe("expandDynamicTags (#885 — union branches, never evaluate OGNL test=)", () => {
  it("returns a single variant unchanged when there are no dynamic tags", () => {
    expect(expandDynamicTags("SELECT * FROM users")).toEqual(["SELECT * FROM users"]);
  });

  it("always includes <if> content (union, not conditional)", () => {
    const variants = expandDynamicTags('a <if test="x">b</if> c');
    expect(variants).toEqual(["a b c"]);
  });

  it("produces one variant per <choose> branch", () => {
    const variants = expandDynamicTags(
      '<choose><when test="a">FROM t1</when><when test="b">FROM t2</when><otherwise>FROM t3</otherwise></choose>',
    );
    expect(variants.sort()).toEqual(["FROM t1", "FROM t2", "FROM t3"]);
  });

  it("drops <bind> entirely (contributes no SQL text)", () => {
    const variants = expandDynamicTags('a <bind name="p" value="x"/> b');
    expect(variants).toEqual(["a  b"]);
  });

  it("takes a <foreach> loop body exactly once", () => {
    const variants = expandDynamicTags(
      'WHERE id IN (<foreach item="i" collection="ids" separator=",">#{i}</foreach>)',
    );
    expect(variants).toEqual(["WHERE id IN (#{i})"]);
  });

  it("reduces <where> to a WHERE clause, stripping a leading AND/OR", () => {
    const variants = expandDynamicTags("<where> AND status = ? </where>");
    expect(variants).toEqual(["WHERE status = ?"]);
  });

  it("reduces <set> to a SET clause, stripping a trailing comma", () => {
    const variants = expandDynamicTags("<set> name = ?, </set>");
    expect(variants).toEqual(["SET name = ?"]);
  });

  it("honors <trim> prefix/prefixOverrides/suffixOverrides attributes", () => {
    const variants = expandDynamicTags(
      '<trim prefix="WHERE" prefixOverrides="AND |OR "> AND a = 1 </trim>',
    );
    expect(variants).toEqual(["WHERE a = 1"]);
  });

  it("omits an empty reduced clause instead of emitting a bare keyword", () => {
    // An all-whitespace <where> body must reduce to "" rather than "WHERE ".
    expect(expandDynamicTags("<where>   </where>")).toEqual([""]);
  });

  it("keeps content contributed by an always-taken <if> inside a <where>", () => {
    const variants = expandDynamicTags('<where><if test="never">status = 1</if></where>');
    expect(variants).toEqual(["WHERE status = 1"]);
  });

  it("cartesian-combines nested <choose> blocks", () => {
    const variants = expandDynamicTags(
      '<choose><when test="a">FROM t1 <choose><when test="x">JOIN j1</when><otherwise>JOIN j2</otherwise></choose></when><otherwise>FROM t2</otherwise></choose>',
    );
    expect(variants.sort()).toEqual(["FROM t1 JOIN j1", "FROM t1 JOIN j2", "FROM t2"]);
  });

  it("falls back gracefully on an unclosed dynamic tag", () => {
    // No closing </if> — must not throw, and must not silently drop the SQL.
    expect(() => expandDynamicTags('SELECT * FROM t <if test="x"> WHERE 1=1')).not.toThrow();
    expect(expandDynamicTags('SELECT * FROM t <if test="x"> WHERE 1=1')[0]).toContain(
      "SELECT * FROM t",
    );
  });

  it("drops a malformed <choose> branch (unclosed <when>) instead of throwing", () => {
    // No closing </when> for the sole branch — chooseBranchBodies bails out
    // with zero branches, which reduces to a single empty variant.
    expect(expandDynamicTags('<choose><when test="a">FROM t1</choose>')).toEqual([""]);
  });

  it("leaves a <trim> body unprefixed when no prefix attribute is given", () => {
    expect(expandDynamicTags("<trim> a = 1 </trim>")).toEqual(["a = 1"]);
  });

  it("skips empty segments in a `|`-separated overrides list and leaves non-matching bodies untouched", () => {
    // Leading "|" in prefixOverrides yields an empty first segment.
    expect(expandDynamicTags('<trim prefixOverrides="|AND "> AND a = 1 </trim>')).toEqual([
      "a = 1",
    ]);
    // Leading "|" in suffixOverrides yields an empty first segment.
    expect(expandDynamicTags('<trim suffixOverrides="|,"> a = 1, </trim>')).toEqual(["a = 1"]);
    // suffixOverrides given but nothing at the end matches it.
    expect(expandDynamicTags('<trim suffixOverrides="XYZ"> a = 1 </trim>')).toEqual(["a = 1"]);
  });

  it("caps combinatorial growth from a <choose> with many branches", () => {
    const whens = Array.from({ length: 70 }, (_, i) => `<when test="c${i}">T${i}</when>`).join("");
    const variants = expandDynamicTags(`<choose>${whens}</choose>`);
    expect(variants).toHaveLength(64);
  });
});

describe("parseMyBatisXml — dynamic-tag branch expansion (#885)", () => {
  const statements = parseMyBatisXml(dynamicXml);

  it("captures every table any <choose>/<when>/<otherwise> branch could touch, plus an <if>-gated JOIN", () => {
    const stmt = statements.find((s) => s.statementId === "findAccount");
    expect(stmt?.refs.map((r) => r.table).sort()).toEqual([
      "account_profiles",
      "accounts",
      "archived_accounts",
    ]);
  });

  it("resolves a nested <include> chain (userSummaryColumns -> baseColumns) into select columns", () => {
    const stmt = statements.find((s) => s.statementId === "findAccount");
    const accounts = stmt?.refs.find((r) => r.table === "accounts");
    expect(accounts?.columns.sort()).toEqual(["email", "id", "status"]);
  });

  it("does not drop the primary table when <where>/<set>/<trim> wrap the statement", () => {
    const stmt = statements.find((s) => s.statementId === "bulkTagAccounts");
    expect(stmt?.refs.map((r) => r.table)).toEqual(["accounts"]);
    expect(stmt?.refs[0].access).toBe("write");
  });

  it("reinstates the SET keyword so <set>-wrapped columns are still captured", () => {
    // Naive tag-stripping loses the literal "SET" text entirely (it comes
    // from the <set> tag itself, not its children), which would silently
    // drop this column from the write-set regex match.
    const stmt = statements.find((s) => s.statementId === "bulkTagAccounts");
    expect(stmt?.refs[0].columns).toContain("tag");
  });

  it("takes the <foreach> loop body once (no duplicate table refs)", () => {
    const stmt = statements.find((s) => s.statementId === "bulkTagAccounts");
    expect(stmt?.refs).toHaveLength(1);
  });
});

describe("parseMyBatisAnnotations", () => {
  const statements = parseMyBatisAnnotations(java);

  it("derives the namespace from package + interface", () => {
    const f = statements.find((s) => s.statementId === "findById");
    expect(f?.qualifiedName).toBe("com.example.mapper.OrderMapper.findById");
  });

  it("extracts all four annotation kinds", () => {
    expect(statements.map((s) => s.sqlKind).sort()).toEqual([
      "delete",
      "insert",
      "select",
      "update",
    ]);
    expect(statements.every((s) => s.refs[0].table === "orders")).toBe(true);
    expect(statements.every((s) => s.refs[0].schema === "shop")).toBe(true);
  });
});

describe("extractMyBatis dispatch", () => {
  it("routes .xml to the XML parser", () => {
    expect(extractMyBatis("UserMapper.xml", xml).length).toBeGreaterThan(0);
  });
  it("routes .java to the annotation parser", () => {
    expect(extractMyBatis("OrderMapper.java", java).length).toBe(4);
  });
  it("ignores non-mapper files", () => {
    expect(extractMyBatis("readme.md", "# hi")).toEqual([]);
    expect(extractMyBatis("Plain.java", "class Plain {}")).toEqual([]);
    expect(extractMyBatis("other.xml", "<beans/>")).toEqual([]);
  });
});

describe("parseMyBatisXml + persistMyBatisFile — ${} unresolved/dynamic edges (#886, load-bearing)", () => {
  // Escaped `\${...}` so the JS template literal doesn't try to interpolate it.
  const dynamicUnresolvedXml = `<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.mapper.DynamicTableMapper">
  <select id="findDynamic">
    SELECT * FROM \${tableName} WHERE id = #{id}
  </select>
  <select id="findReal">
    SELECT * FROM real_table WHERE id = #{id}
  </select>
  <select id="findByStatus">
    SELECT * FROM real_table WHERE status = '\${status}'
  </select>
</mapper>`;

  it("marks the ${} table unresolved and neutralizes the #{id} bind param", () => {
    const statements = parseMyBatisXml(dynamicUnresolvedXml);
    const findDynamic = statements.find((s) => s.statementId === "findDynamic");
    expect(findDynamic?.refs).toHaveLength(1);
    expect(findDynamic?.refs[0]).toMatchObject({ unresolved: true, placeholder: "tableName" });
  });

  it("still resolves a normal table concretely alongside dynamic statements", () => {
    const statements = parseMyBatisXml(dynamicUnresolvedXml);
    const findReal = statements.find((s) => s.statementId === "findReal");
    expect(findReal?.refs).toEqual([expect.objectContaining({ table: "real_table" })]);
  });

  it("creates no phantom table from a ${} in a WHERE-clause value position", () => {
    const statements = parseMyBatisXml(dynamicUnresolvedXml);
    const findByStatus = statements.find((s) => s.statementId === "findByStatus");
    expect(findByStatus?.refs).toHaveLength(1);
    expect(findByStatus?.refs[0].table).toBe("real_table");
    expect(findByStatus?.refs[0].unresolved).toBeUndefined();
  });

  it("persists an unresolved edge carrying placeholder/statementId/mapper metadata, and a normal edge for the concrete table", async () => {
    const { writer, symbols, edges } = fakeWriter();
    await persistMyBatisFile(writer, "DynamicTableMapper.xml", dynamicUnresolvedXml);

    const unresolvedEdge = edges.find(
      (e) => e.toQualifiedName === "?dynamic:tablename" && e.kind === "reads",
    );
    expect(unresolvedEdge).toBeDefined();
    const metadata = JSON.parse(unresolvedEdge!.metadata as string);
    expect(metadata).toMatchObject({
      unresolved: true,
      placeholder: "tableName",
      statementId: "findDynamic",
      mapper: "com.example.mapper.DynamicTableMapper",
    });

    // The synthetic placeholder symbol is persisted as a `table`-kind symbol so
    // impact-crossing still works; it must NOT collide with any real table name.
    expect(
      symbols.some((s) => s.kind === "table" && s.qualifiedName === "?dynamic:tablename"),
    ).toBe(true);

    // The concrete `real_table` statement resolves to an ordinary edge with no
    // unresolved metadata.
    const concreteEdge = edges.find((e) => e.toQualifiedName === "real_table");
    expect(concreteEdge?.metadata).toBeNull();

    // No symbol/edge exists for the value-position ${status} — it never reached
    // an identifier position.
    expect(symbols.some((s) => s.qualifiedName.includes("status"))).toBe(false);
  });
});

describe("persistMyBatisFile", () => {
  it("writes table/column symbols and mybatis edges", async () => {
    const { writer, symbols, edges } = fakeWriter();
    const count = await persistMyBatisFile(writer, "OrderMapper.java", java);
    expect(count).toBeGreaterThan(0);
    expect(edges.every((e) => e.source === "mybatis")).toBe(true);
    expect(edges.some((e) => e.kind === "reads")).toBe(true);
    expect(edges.some((e) => e.kind === "persists-to")).toBe(true);
    expect(edges.some((e) => e.kind === "writes")).toBe(true);
    expect(symbols.some((s) => s.kind === "table" && s.qualifiedName === "shop.orders")).toBe(true);
    expect(symbols.some((s) => s.kind === "column")).toBe(true);
    expect(symbols.some((s) => s.kind === "method")).toBe(true);
  });

  it("writes nothing for a non-mapper file", async () => {
    const { writer, edges } = fakeWriter();
    expect(await persistMyBatisFile(writer, "x.txt", "nope")).toBe(0);
    expect(edges).toHaveLength(0);
  });
});
