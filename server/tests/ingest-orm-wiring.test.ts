/**
 * Issue #849 — guards that ORM schema extraction is WIRED into the ingest
 * pipeline. The extractor itself (`persistOrmFile`) is covered by
 * `orm-extractor.test.ts`; this test covers the seam that was missing — ingest
 * turning captured ORM model files into schema-graph symbols/edges, idempotently.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractOrmSchema,
  ingestCodeGraph,
  isOrmSchemaFile,
  stripNulBytes,
  type IngestStats,
} from "../src/lib/code-graph/ingest.js";
import { SchemaGraphWriter } from "../src/lib/code-graph/schema-graph.js";
import {
  buildOrmModelTableMap,
  enclosingSymbolFor,
  findOrmCallSites,
  persistOrmCallSiteEdges,
} from "../src/lib/code-graph/orm-callsite-extractor.js";

const prismaSrc = readFileSync(join(__dirname, "fixtures", "orm", "schema.prisma"), "utf8");

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
      // Serves BOTH #872 queries: the table/column prewarm read and the
      // enclosing function/method lookup for the call-site pass.
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

describe("isOrmSchemaFile", () => {
  it("recognises .prisma (the file the walk otherwise skips) and nothing else", () => {
    expect(isOrmSchemaFile("server/prisma/schema.prisma")).toBe(true);
    expect(isOrmSchemaFile("schema.PRISMA")).toBe(true);
    // .java is captured via the parsed-file path, not this predicate.
    expect(isOrmSchemaFile("Customer.java")).toBe(false);
    expect(isOrmSchemaFile("src/index.ts")).toBe(false);
    expect(isOrmSchemaFile("notes.txt")).toBe(false);
  });
});

describe("extractOrmSchema wiring (#849)", () => {
  it("turns a captured schema.prisma into table/column symbols + persists-to edges", async () => {
    const { prisma, symbols, edges } = fakePrisma();
    const s = stats();
    await extractOrmSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["server/prisma/schema.prisma", prismaSrc]]),
      [], // no parsed files
      s,
    );
    expect(symbols.some((x) => x.kind === "table")).toBe(true);
    expect(symbols.some((x) => x.kind === "column")).toBe(true);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.kind === "persists-to" && e.source === "orm")).toBe(true);
    expect(s.schemaEdges).toBeGreaterThan(0);
  });

  it("wipes prior rows for NON-parsed ORM files (schema.prisma) to stay idempotent", async () => {
    const { prisma, deletes } = fakePrisma();
    await extractOrmSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["server/prisma/schema.prisma", prismaSrc]]),
      [],
      stats(),
    );
    // Both tables wiped by (codeGraphId, filePath in [schema.prisma]) before re-persist.
    const paths = deletes.map((d) => d.where.filePath?.in).filter(Boolean);
    expect(paths.length).toBe(2); // codeEdge + codeSymbol
    expect(paths.every((p: string[]) => p.includes("server/prisma/schema.prisma"))).toBe(true);
  });

  it("does NOT wipe PARSED ORM files (JPA .java) — persistParsed already cleared them", async () => {
    const { prisma, deletes, symbols } = fakePrisma();
    const java = readFileSync(join(__dirname, "fixtures", "orm", "Customer.java"), "utf8");
    await extractOrmSchema(
      prisma as never,
      "g1",
      "p1",
      new Map([["src/Customer.java", java]]),
      [{ filePath: "src/Customer.java" }] as never,
      stats(),
    );
    // The .java path is a parsed file → no explicit wipe (would delete tree-sitter symbols).
    expect(deletes).toHaveLength(0);
    // ...but its schema symbols are still persisted.
    expect(symbols.some((x) => x.kind === "table")).toBe(true);
  });

  it("is a no-op with no ORM sources (no writes, no deletes)", async () => {
    const { prisma, symbols, edges, deletes } = fakePrisma();
    await extractOrmSchema(prisma as never, "g1", "p1", new Map(), [], stats());
    expect(symbols).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    expect(prisma.codeSymbol.create).not.toHaveBeenCalled();
  });

  it("never throws when persistence fails — an ORM problem must not fail ingest", async () => {
    const { prisma } = fakePrisma();
    prisma.codeSymbol.create = vi.fn(async () => {
      throw new Error("db down");
    }) as never;
    const s = stats();
    await expect(
      extractOrmSchema(
        prisma as never,
        "g1",
        "p1",
        new Map([["server/prisma/schema.prisma", prismaSrc]]),
        [],
        s,
      ),
    ).resolves.toBeUndefined();
    expect(s.schemaEdges).toBe(0);
  });
});

/** Minimal in-memory Prisma covering exactly the surface a `.prisma`-only ingest touches. */
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
      // Serves the #872 prewarm + enclosing-symbol queries from what persistParsed
      // and the schema pass actually created (filtered by kind/filePath).
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

describe("ingestCodeGraph wires ORM extraction end-to-end (#849)", () => {
  it("populates table symbols from a schema.prisma the walk would otherwise skip", async () => {
    // A repo whose ONLY file is a schema.prisma (not a tree-sitter language). Before
    // #849 the walk skipped it and no schema symbols were ever produced.
    const dir = mkdtempSync(join(tmpdir(), "orm-ingest-"));
    writeFileSync(join(dir, "schema.prisma"), prismaSrc);
    const { prisma, created } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // Proof the ORM pass ran THROUGH ingest: table + column symbols exist. Remove the
    // extractOrmSchema call from ingestCodeGraph and this assertion fails.
    expect(created.some((s) => s.kind === "table")).toBe(true);
    expect(created.some((s) => s.kind === "column")).toBe(true);
  });
});

// ── #872 — application-code → table call-site edges ───────────────────────────

describe("orm call-site extraction (#872)", () => {
  const MODELS = buildOrmModelTableMap(new Map([["schema.prisma", prismaSrc]]));

  it("maps Prisma models to their client property + physical table (via @@map)", () => {
    // Fixture has `model Account` with @@map("accounts") and unmapped `model Post`.
    expect(MODELS.get("account")?.table).toBe("accounts");
    expect(MODELS.get("post")?.table).toBe("post");
    expect(MODELS.has("Account")).toBe(false); // client property is camelCased
  });

  it("detects read vs write delegate calls regardless of receiver, and nothing else", () => {
    const src = [
      "async function save(prisma: PrismaClient) {",
      "  await prisma.account.create({ data });", // write
      "  await this.prisma.account.findMany();", // read (this.prisma receiver)
      "  await tx.post.updateMany({});", // write (tx receiver)
      "  await prisma.unknownModel.create({});", // unknown model — ignored
      "  await prisma.account.disconnect();", // not a delegate op — ignored
      "  await foo.count(items);", // op alone never matches
      "}",
    ].join("\n");
    const sites = findOrmCallSites(src, MODELS);
    expect(sites.map((s) => `${s.model}.${s.op}:${s.kind}`)).toEqual([
      "account.create:writes",
      "account.findMany:reads",
      "post.updateMany:writes",
    ]);
  });

  it("anchors to the NARROWEST enclosing persisted symbol and skips orphan lines", () => {
    const symbols = [
      { id: "mod", startLine: 1, endLine: 100 },
      { id: "fn", startLine: 10, endLine: 20 },
    ];
    expect(enclosingSymbolFor(symbols, 15)?.id).toBe("fn");
    expect(enclosingSymbolFor(symbols, 5)?.id).toBe("mod");
    expect(enclosingSymbolFor(symbols, 200)).toBeNull();
  });

  it("persists reads/writes edges FROM the real enclosing symbol, deduped per (from, table, kind)", async () => {
    const { writer, symbols, edges } = (() => {
      // reuse the #849 fake-writer shape
      const syms: any[] = [];
      const eds: any[] = [];
      let n = 0;
      const prisma = {
        codeSymbol: {
          create: async ({ data }: any) => {
            syms.push(data);
            return { id: `${data.kind}-${++n}` };
          },
        },
        codeEdge: {
          create: async ({ data }: any) => {
            eds.push(data);
            return undefined;
          },
        },
      };
      return {
        writer: new SchemaGraphWriter(prisma as never, "g", "p"),
        symbols: syms,
        edges: eds,
      };
    })();
    const src = [
      "function saveTwice(prisma) {", // line 1
      "  prisma.account.create({});", // write
      "  prisma.account.createMany({});", // write, same (from, table, kind) — deduped
      "  prisma.account.findFirst({});", // read — distinct kind, kept
      "}",
    ].join("\n");
    const written = await persistOrmCallSiteEdges(writer, "src/save.ts", src, MODELS, [
      { id: "fn-save", startLine: 1, endLine: 5 },
    ]);
    expect(written).toBe(2); // one writes + one reads (createMany deduped)
    expect(edges.map((e: any) => e.kind).sort()).toEqual(["reads", "writes"]);
    expect(edges.every((e: any) => e.fromSymbolId === "fn-save" && e.source === "orm")).toBe(true);
    // No synthetic origin symbols — the ONLY symbol created is the table itself.
    expect(symbols.map((s: any) => s.kind)).toEqual(["table"]);
  });

  it("skips call sites with NO enclosing persisted symbol — never fabricates origins", async () => {
    const eds: any[] = [];
    const writer = new SchemaGraphWriter(
      {
        codeSymbol: { create: async () => ({ id: "t" }) },
        codeEdge: {
          create: async ({ data }: any) => {
            eds.push(data);
          },
        },
      },
      "g",
      "p",
    );
    const written = await persistOrmCallSiteEdges(
      writer,
      "src/x.ts",
      "prisma.account.create({});",
      MODELS,
      [], // no persisted symbols for the file
    );
    expect(written).toBe(0);
    expect(eds).toHaveLength(0);
  });
});

describe("SchemaGraphWriter.prewarm keeps table ids stable across ingests (#872)", () => {
  it("ensureTable reuses a prewarmed id instead of creating a duplicate", async () => {
    const create = vi.fn(async ({ data }: any) => ({ id: `new-${data.kind}` }));
    const writer = new SchemaGraphWriter(
      { codeSymbol: { create }, codeEdge: { create: async () => undefined } },
      "g",
      "p",
    );
    writer.prewarm([{ id: "stable-accounts", kind: "table", qualifiedName: "accounts" }]);
    const id = await writer.ensureTable("accounts", "orm", {});
    expect(id).toBe("stable-accounts");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("ingestCodeGraph emits app-code→table edges end-to-end (#872)", () => {
  it("a TS function calling prisma.account.create gets a writes edge to the accounts table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orm-callsite-"));
    writeFileSync(join(dir, "schema.prisma"), prismaSrc);
    writeFileSync(
      join(dir, "account-service.ts"),
      [
        "export async function createAccount(prisma: any, data: any) {",
        "  return prisma.account.create({ data });",
        "}",
        "",
      ].join("\n"),
    );
    const { prisma, created, edgesCreated } = fakeIngestPrisma();

    await ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false });

    // The REAL parsed function symbol for createAccount, persisted by persistParsed.
    const fn = created.find((s) => s.kind === "function" && s.name === "createAccount");
    expect(fn).toBeDefined();
    const table = created.find((s) => s.kind === "table" && s.name === "accounts");
    expect(table).toBeDefined();
    // The #872 edge: application code → table, kind writes. Remove the call-site
    // pass from extractOrmSchema and this fails (the neuter-and-red guard).
    const edge = edgesCreated.find(
      (e) => e.kind === "writes" && e.fromSymbolId === fn?.id && e.toSymbolId === table?.id,
    );
    expect(edge).toBeDefined();
  });
});

// ── NUL-byte sanitisation (#dev-pg parity): Postgres rejects 0x00 in text ─────

describe("stripNulBytes (#Postgres parity)", () => {
  const NUL = String.fromCharCode(0);
  it("removes literal NUL bytes; no-op for clean text", () => {
    expect(stripNulBytes(`a${NUL}b${NUL}c`)).toBe("abc");
    expect(stripNulBytes("clean text")).toBe("clean text");
    expect(stripNulBytes("")).toBe("");
    // must not contain a NUL afterwards
    expect(stripNulBytes(`x${NUL}`).includes(NUL)).toBe(false);
  });

  it("ingestCodeGraph ingests a source file containing a NUL without throwing, NUL-free", async () => {
    const NUL0 = String.fromCharCode(0);
    const dir = mkdtempSync(join(tmpdir(), "orm-nul-"));
    // A .ts file whose content carries a NUL (e.g. a NUL-handling fixture). On
    // Postgres the un-sanitised insert would throw `invalid byte sequence 0x00`.
    writeFileSync(
      join(dir, "svc.ts"),
      `export function handle() {\n  const s = "a${NUL0}b";\n  return s;\n}\n`,
    );
    const { prisma, created } = fakeIngestPrisma();
    await expect(
      ingestCodeGraph(prisma as never, { projectId: "p1", rootDir: dir, incremental: false }),
    ).resolves.toBeDefined();
    // No persisted symbol text carries a NUL (the read-chokepoint strip ran).
    expect(created.every((s) => !JSON.stringify(s).includes(NUL0))).toBe(true);
    expect(created.some((s) => s.kind === "function" && s.name === "handle")).toBe(true);
  });
});
