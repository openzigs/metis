/**
 * Issue #884 (epic #879) — guards that MyBatis schema extraction is WIRED into
 * the ingest pipeline. The extractor itself (`persistMyBatisFile`) is covered
 * by `mybatis-extractor.test.ts`; this test covers the seam that was
 * missing — `extractMyBatis`/`persistMyBatisFile` existed with ZERO
 * production callers, so a MyBatis project's XML mappers and `@Select`/
 * `@Insert`/`@Update`/`@Delete` annotation mappers never populated the
 * schema graph. Mirrors the ORM wiring fix (#849/#872, `ingest-orm-wiring.test.ts`).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractMyBatisSchema,
  ingestCodeGraph,
  isMyBatisXmlFile,
  type IngestStats,
} from "../src/lib/code-graph/ingest.js";

const FIX = join(__dirname, "fixtures", "mybatis");
const userMapperXml = readFileSync(join(FIX, "UserMapper.xml"), "utf8");
const orderMapperJava = readFileSync(join(FIX, "OrderMapper.java"), "utf8");

function fakePrisma(existingSymbols: any[] = []) {
  const symbols: any[] = [];
  const edges: any[] = [];
  const deletes: { table: "codeSymbol" | "codeEdge"; where: any }[] = [];
  let n = 0;
  const prisma = {
    codeSymbol: {
      create: vi.fn(async ({ data }: any) => {
        symbols.push(data);
        return { id: `${data.kind}-${++n}` };
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const kinds: string[] = where?.kind?.in ?? [];
        return existingSymbols.filter((s) => kinds.includes(s.kind));
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        deletes.push({ table: "codeSymbol", where });
        return { count: 0 };
      }),
    },
    codeEdge: {
      create: vi.fn(async ({ data }: any) => {
        edges.push(data);
        return undefined;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        deletes.push({ table: "codeEdge", where });
        return { count: 0 };
      }),
    },
  };
  return { prisma, symbols, edges, deletes };
}

const stats = (): IngestStats => ({ schemaEdges: 0 }) as unknown as IngestStats;

describe("isMyBatisXmlFile", () => {
  it("recognises .xml (the extension the walk otherwise skips) and nothing else", () => {
    expect(isMyBatisXmlFile("mapper/UserMapper.xml")).toBe(true);
    expect(isMyBatisXmlFile("mapper/UserMapper.XML")).toBe(true);
    // .java annotation mappers are captured via the parsed-file path, not this predicate.
    expect(isMyBatisXmlFile("OrderMapper.java")).toBe(false);
    expect(isMyBatisXmlFile("src/index.ts")).toBe(false);
    expect(isMyBatisXmlFile("notes.txt")).toBe(false);
  });
});

describe("extractMyBatisSchema wiring (#884)", () => {
  it("turns a captured MyBatis XML mapper into table/column symbols + reads/persists-to/writes edges", async () => {
    const { prisma, symbols, edges } = fakePrisma();
    const s = stats();
    await extractMyBatisSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["mapper/UserMapper.xml", userMapperXml]]),
      [], // no parsed files
      s,
    );
    expect(symbols.some((x) => x.kind === "table")).toBe(true);
    expect(symbols.some((x) => x.kind === "column")).toBe(true);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.source === "mybatis")).toBe(true);
    expect(edges.some((e) => e.kind === "reads")).toBe(true);
    expect(edges.some((e) => e.kind === "persists-to")).toBe(true);
    expect(edges.some((e) => e.kind === "writes")).toBe(true);
    expect(s.schemaEdges).toBeGreaterThan(0);
  });

  it("wipes prior rows for NON-parsed MyBatis files (.xml mappers) to stay idempotent", async () => {
    const { prisma, deletes } = fakePrisma();
    await extractMyBatisSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["mapper/UserMapper.xml", userMapperXml]]),
      [],
      stats(),
    );
    const paths = deletes.map((d) => d.where.filePath?.in).filter(Boolean);
    expect(paths.length).toBe(2); // codeEdge + codeSymbol
    expect(paths.every((p: string[]) => p.includes("mapper/UserMapper.xml"))).toBe(true);
  });

  it("does NOT wipe PARSED MyBatis files (annotation .java) — persistParsed already cleared them", async () => {
    const { prisma, deletes, symbols } = fakePrisma();
    await extractMyBatisSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["mapper/OrderMapper.java", orderMapperJava]]),
      [{ filePath: "mapper/OrderMapper.java" }] as never,
      stats(),
    );
    expect(deletes).toHaveLength(0);
    expect(symbols.some((x) => x.kind === "table")).toBe(true);
  });

  it("is a no-op with no MyBatis sources (no writes, no deletes)", async () => {
    const { prisma, symbols, edges, deletes } = fakePrisma();
    await extractMyBatisSchema(prisma as never, "g1", "p1", new Map(), [], stats());
    expect(symbols).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    expect(prisma.codeSymbol.create).not.toHaveBeenCalled();
  });

  it("never throws when persistence fails — a MyBatis problem must not fail ingest", async () => {
    const { prisma } = fakePrisma();
    prisma.codeSymbol.create = vi.fn(async () => {
      throw new Error("db down");
    }) as never;
    const s = stats();
    await expect(
      extractMyBatisSchema(
        prisma as never,
        "g1",
        "p1",
        new Map([["mapper/UserMapper.xml", userMapperXml]]),
        [],
        s,
      ),
    ).resolves.toBeUndefined();
    expect(s.schemaEdges).toBe(0);
  });
});

/** Minimal in-memory Prisma covering exactly the surface a MyBatis-only ingest touches. */
function fakeIngestPrisma() {
  const created: any[] = [];
  const edgesCreated: any[] = [];
  let n = 0;
  const graph = { id: "cg1" };
  const prisma = {
    codeGraph: {
      findFirst: async () => null,
      create: async () => graph,
      update: async () => graph,
    },
    codeSymbol: {
      findMany: async ({ where }: any = {}) =>
        created.filter(
          (s) =>
            (!where?.kind?.in || where.kind.in.includes(s.kind)) &&
            (!where?.filePath?.in || where.filePath.in.includes(s.filePath)),
        ),
      findFirst: async () => null,
      create: async ({ data }: any) => {
        const row = { ...data, id: `s${++n}` };
        created.push(row);
        return { id: row.id };
      },
      deleteMany: async () => ({ count: 0 }),
      count: async () => created.length,
      groupBy: async () => [],
    },
    codeEdge: {
      create: async ({ data }: any = {}) => {
        edgesCreated.push(data);
        return undefined;
      },
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
    },
    codeSymbolEmbedding: { createMany: async () => ({ count: 0 }) },
    finding: { create: async () => ({}), findFirst: async () => null },
  };
  return { prisma, created, edgesCreated };
}

describe("ingestCodeGraph wires MyBatis extraction end-to-end (#884, neuter-and-red)", () => {
  it("populates table/column symbols + reads/writes/persists-to edges from an XML mapper the walk would otherwise skip", async () => {
    // A repo whose ONLY file is a MyBatis XML mapper (not a tree-sitter language,
    // and no `<mapper>` extension predicate exists on the walk today). Before this
    // wiring the walk skipped it and no schema symbols were ever produced.
    const dir = mkdtempSync(join(tmpdir(), "mybatis-ingest-xml-"));
    writeFileSync(join(dir, "UserMapper.xml"), userMapperXml);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // Proof the MyBatis pass ran THROUGH ingest. Remove the extractMyBatisSchema
    // call (or the .xml capture) from ingestCodeGraph and these assertions fail —
    // this is the neuter-and-red guard.
    const table = created.find((s) => s.kind === "table" && s.name === "users");
    expect(table).toBeDefined();
    expect(created.some((s) => s.kind === "column")).toBe(true);
    expect(
      edgesCreated.some(
        (e) => e.kind === "reads" && e.source === "mybatis" && e.toSymbolId === table?.id,
      ),
    ).toBe(true);
    expect(edgesCreated.some((e) => e.kind === "persists-to" && e.source === "mybatis")).toBe(true);
    expect(edgesCreated.some((e) => e.kind === "writes" && e.source === "mybatis")).toBe(true);
  });

  it("populates table symbols + edges from an @Select/@Insert annotation mapper (.java, already-parsed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mybatis-ingest-java-"));
    writeFileSync(join(dir, "OrderMapper.java"), orderMapperJava);
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    const table = created.find((s) => s.kind === "table" && s.name === "orders");
    expect(table).toBeDefined();
    expect(
      edgesCreated.some(
        (e) => e.kind === "reads" && e.source === "mybatis" && e.toSymbolId === table?.id,
      ),
    ).toBe(true);
    expect(edgesCreated.some((e) => e.kind === "persists-to" && e.source === "mybatis")).toBe(true);
  });
});

describe("SchemaGraphWriter reuse across ORM + MyBatis passes (#884)", () => {
  it("a table created by the ORM pass is reused (not duplicated) by the MyBatis pass in the same ingest", async () => {
    // Regression guard for the design decision to run a fresh prewarm query for the
    // MyBatis pass AFTER the ORM pass, so the two extractors never fork the same
    // physical table into two symbol rows within one ingest.
    const dir = mkdtempSync(join(tmpdir(), "mybatis-orm-shared-table-"));
    writeFileSync(
      join(dir, "schema.prisma"),
      [
        "model User {",
        "  id    Int    @id @default(autoincrement())",
        "  email String",
        "",
        '  @@map("users")',
        "}",
      ].join("\n"),
    );
    // Deliberately unqualified `users` (no schema prefix) so it lines up with the
    // Prisma model's `@@map("users")` above — the shared fixture's `UserMapper.xml`
    // targets `app.users`, a distinct qualified name, which would not exercise reuse.
    writeFileSync(
      join(dir, "UserMapper.xml"),
      [
        '<mapper namespace="com.example.mapper.UserMapper">',
        '  <select id="findById" resultType="User">',
        "    SELECT id, email FROM users WHERE id = #{id}",
        "  </select>",
        "</mapper>",
      ].join("\n"),
    );
    const { prisma, created } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    const userTables = created.filter((s) => s.kind === "table" && s.name === "users");
    expect(userTables).toHaveLength(1);
  });
});
