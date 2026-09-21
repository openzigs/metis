/**
 * Issue #897 (Epic #883) — jOOQ generated table-class lineage: symbol
 * resolution (generated `TableImpl` class -> physical table), NOT SQL
 * parsing. Covers table-class recognition, the constant->table map, DSL
 * call-site detection, and edge persistence anchored to the real enclosing
 * code symbol (mirrors `orm-callsite-extractor.test.ts`'s coverage of #872).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJooqTableMap,
  extractJooqTableClasses,
  findJooqCallSites,
  persistJooqCallSiteEdges,
  toUpperSnakeCase,
} from "../src/lib/code-graph/jooq-extractor.js";
import { SchemaGraphWriter } from "../src/lib/code-graph/schema-graph.js";

const FIX = join(__dirname, "fixtures", "jooq");
const bookSrc = readFileSync(join(FIX, "Book.java"), "utf8");
const tablesSrc = readFileSync(join(FIX, "Tables.java"), "utf8");
const bookDaoSrc = readFileSync(join(FIX, "BookDao.java"), "utf8");

describe("toUpperSnakeCase", () => {
  it("converts PascalCase/camelCase to jOOQ's UPPER_SNAKE_CASE convention", () => {
    expect(toUpperSnakeCase("Book")).toBe("BOOK");
    expect(toUpperSnakeCase("AuthorBook")).toBe("AUTHOR_BOOK");
    expect(toUpperSnakeCase("HTTPBook")).toBe("HTTP_BOOK");
  });
});

describe("extractJooqTableClasses", () => {
  it("recognises a generated TableImpl class and resolves BOOK -> book via the self-registration signature", () => {
    const classes = extractJooqTableClasses(bookSrc);
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({
      className: "Book",
      constantName: "BOOK",
      target: { table: "book" },
    });
    expect(classes[0].line).toBeGreaterThan(0);
  });

  it("returns [] for a file with no TableImpl subclass (the aggregator Tables.java)", () => {
    expect(extractJooqTableClasses(tablesSrc)).toEqual([]);
  });

  it("returns [] for an unrelated .java file", () => {
    expect(extractJooqTableClasses(bookDaoSrc)).toEqual([]);
  });

  it("prefers an explicit getName() override over the self-registration signature", () => {
    const src = `
      public class Author extends TableImpl<AuthorRecord> {
        public static final Author AUTHOR = new Author();
        @Override
        public String getName() {
          return "authors_tbl";
        }
        public Author() {
          this(DSL.name("author"), null);
        }
      }
    `;
    expect(extractJooqTableClasses(src)[0].target.table).toBe("authors_tbl");
  });

  it('falls back to the legacy super("...") string-literal signature', () => {
    const src = `
      public class Genre extends TableImpl<GenreRecord> {
        public static final Genre GENRE = new Genre();
        public Genre() {
          super("genre", null, null);
        }
      }
    `;
    expect(extractJooqTableClasses(src)[0].target.table).toBe("genre");
  });

  it("falls back to the UPPER_SNAKE_CASE class-name convention when no explicit signal is present", () => {
    const src = `
      public class AuthorBook extends TableImpl<AuthorBookRecord> {
        public static final AuthorBook AUTHOR_BOOK = new AuthorBook();
      }
    `;
    const cls = extractJooqTableClasses(src)[0];
    expect(cls.target.table).toBe("author_book");
    expect(cls.constantName).toBe("AUTHOR_BOOK");
  });

  it("derives the constant name from the class name when no self-registering singleton is declared", () => {
    const src = `
      public class Genre extends TableImpl<GenreRecord> {
        // no public static final Genre GENRE = new Genre(); line
      }
    `;
    const cls = extractJooqTableClasses(src)[0];
    expect(cls.constantName).toBe("GENRE");
  });

  it("never sets a schema (jOOQ runtime render-mapping is out of static-analysis scope)", () => {
    expect(extractJooqTableClasses(bookSrc)[0].target.schema).toBeUndefined();
  });
});

describe("buildJooqTableMap", () => {
  it("maps the BOOK constant to the physical table across captured generated-class sources", () => {
    const map = buildJooqTableMap(
      new Map([
        ["Book.java", bookSrc],
        ["Tables.java", tablesSrc],
      ]),
    );
    expect(map.get("BOOK")).toEqual({ table: "book" });
  });

  it("first registration wins on a constant-name collision", () => {
    const first = `
      public class A extends TableImpl<ARecord> {
        public static final A X = new A();
        public A() { this(DSL.name("a_table"), null); }
      }
    `;
    const second = `
      public class B extends TableImpl<BRecord> {
        public static final B X = new B();
        public B() { this(DSL.name("b_table"), null); }
      }
    `;
    const map = buildJooqTableMap(
      new Map([
        ["A.java", first],
        ["B.java", second],
      ]),
    );
    expect(map.get("X")?.table).toBe("a_table");
  });

  it("returns an empty map for no sources", () => {
    expect(buildJooqTableMap(new Map()).size).toBe(0);
  });
});

describe("findJooqCallSites", () => {
  const TABLES = buildJooqTableMap(new Map([["Book.java", bookSrc]]));

  it("detects reads (from) and writes (insertInto/update/deleteFrom) against the known BOOK constant", () => {
    const sites = findJooqCallSites(bookDaoSrc, TABLES);
    expect(sites.map((s) => `${s.op}:${s.kind}`).sort()).toEqual(
      ["deleteFrom:writes", "from:reads", "insertInto:writes", "update:writes"].sort(),
    );
    expect(sites.every((s) => s.constant === "BOOK" && s.target.table === "book")).toBe(true);
  });

  it("resolves a dot-qualified reference (Tables.BOOK) to the same bare constant", () => {
    const sites = findJooqCallSites("ctx.select().from(Tables.BOOK).fetch();", TABLES);
    expect(sites).toHaveLength(1);
    expect(sites[0].constant).toBe("BOOK");
  });

  it("matches every comma-separated Table argument in a multi-table from(...)", () => {
    const map = buildJooqTableMap(
      new Map([
        ["Book.java", bookSrc],
        [
          "Author.java",
          `
          public class Author extends TableImpl<AuthorRecord> {
            public static final Author AUTHOR = new Author();
            public Author() { this(DSL.name("author"), null); }
          }
        `,
        ],
      ]),
    );
    const sites = findJooqCallSites("ctx.select().from(BOOK, AUTHOR).fetch();", map);
    expect(sites.map((s) => s.constant).sort()).toEqual(["AUTHOR", "BOOK"]);
  });

  it("ignores an unknown identifier, a string-literal argument, and a bare join() with no table match", () => {
    const sites = findJooqCallSites(
      ["ctx.select().from(UNKNOWN_TABLE).fetch();", 'ctx.select().from("book").fetch();'].join(
        "\n",
      ),
      TABLES,
    );
    expect(sites).toHaveLength(0);
  });

  it("ignores DSL verbs that are not on the read/write list", () => {
    expect(findJooqCallSites("ctx.select(BOOK.ID).fetch();", TABLES)).toHaveLength(0);
  });

  it("returns [] immediately when there are no known tables", () => {
    expect(findJooqCallSites(bookDaoSrc, new Map())).toEqual([]);
  });
});

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
        return undefined;
      },
    },
  };
  return { writer: new SchemaGraphWriter(prisma as never, "g", "p"), symbols, edges };
}

describe("persistJooqCallSiteEdges", () => {
  const TABLES = buildJooqTableMap(new Map([["Book.java", bookSrc]]));

  it("persists reads/writes edges FROM the real enclosing symbol, source = jooq", async () => {
    const { writer, symbols, edges } = fakeWriter();
    const written = await persistJooqCallSiteEdges(writer, "src/BookDao.java", bookDaoSrc, TABLES, [
      { id: "m-findAllBooks", startLine: 10, endLine: 12 },
      { id: "m-createBook", startLine: 14, endLine: 16 },
      { id: "m-renameBook", startLine: 18, endLine: 20 },
      { id: "m-deleteBook", startLine: 22, endLine: 24 },
    ]);
    expect(written).toBe(4);
    expect(edges.every((e: any) => e.source === "jooq")).toBe(true);
    expect(edges.map((e: any) => e.kind).sort()).toEqual(["reads", "writes", "writes", "writes"]);
    const readsEdge = edges.find((e: any) => e.kind === "reads");
    expect(readsEdge.fromSymbolId).toBe("m-findAllBooks");
    // Only ONE table symbol created despite 4 call sites — dedup via ensureTable's cache.
    expect(symbols.filter((s: any) => s.kind === "table")).toHaveLength(1);
  });

  it("dedupes repeated (from, table, kind) call sites within one enclosing symbol", async () => {
    const { writer, edges } = fakeWriter();
    const src = [
      "function twoReads() {", // line 1
      "  ctx.select().from(BOOK).fetch();", // read
      "  ctx.select().from(BOOK).fetch();", // read, same (from, table, kind) — deduped
      "}",
    ].join("\n");
    const written = await persistJooqCallSiteEdges(writer, "src/x.java", src, TABLES, [
      { id: "fn", startLine: 1, endLine: 4 },
    ]);
    expect(written).toBe(1);
    expect(edges).toHaveLength(1);
  });

  it("skips call sites with no enclosing persisted symbol — never fabricates origins", async () => {
    const { writer, edges } = fakeWriter();
    const written = await persistJooqCallSiteEdges(
      writer,
      "src/x.java",
      "ctx.select().from(BOOK).fetch();",
      TABLES,
      [],
    );
    expect(written).toBe(0);
    expect(edges).toHaveLength(0);
  });

  it("is a no-op when there are no call sites", async () => {
    const { writer, edges } = fakeWriter();
    const written = await persistJooqCallSiteEdges(
      writer,
      "src/x.java",
      "// nothing here",
      TABLES,
      [{ id: "fn", startLine: 1, endLine: 1 }],
    );
    expect(written).toBe(0);
    expect(edges).toHaveLength(0);
  });
});
