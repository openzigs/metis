/**
 * #2319 — the saved document reading (`readDocumentOnce`, #2280/#2293) on a
 * real Postgres.
 *
 * The unit suite runs against an in-memory double and the SQLite suite
 * (`document-reading-cache-2280.sqlite.test.ts`) against SQLite. The save is
 * an upsert whose `where` names the table's unique key AND a non-unique
 * column (`projectId`), so that another project's caller cannot overwrite a
 * row. That shape is Prisma's extended `where` on the unique input, and how
 * the miss surfaces is the engine's (Prisma 7 resolves null and writes
 * nothing; it does not throw), so it is proved here on the engine production
 * runs:
 *
 *   - a whole reading is saved and the next read reuses it with no reader call;
 *   - a save of the same key under another project resolves null and writes
 *     nothing, the row keeps its project and reading, no later read of that
 *     project returns it, and the read still reaches the caller;
 *   - a save deletes the document's readings of an earlier file, and of an
 *     earlier reader of the same file, and keeps another model's.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../src/lib/ai/types.js";
import type { DocumentReading } from "../src/lib/document-reader/reader.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { READER_VERSION } = await import("../src/lib/document-reader/reader.js");
const { readDocumentOnce } = await import("../src/lib/document-reader/reading-cache.js");

const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-2319pg-${SUFFIX}`;
const WORKSPACE = `ws-2319pg-${SUFFIX}`;
const PA = `pa-2319pg-${SUFFIX}`;
const PB = `pb-2319pg-${SUFFIX}`;
const DOC = `d-2319pg-${SUFFIX}`;
const TEXT = "# FRD\n\n## 1 Access\n\nThe portal shall lock an account after five failed attempts.";
const provider = { key: "anthropic", model: "claude-sonnet-5-5" } as unknown as AIProvider;

function reading(outputTokenCap = 8192): DocumentReading {
  return {
    mode: "whole",
    statements: [
      {
        id: "T1",
        kind: "requirement",
        statement: "Lock an account after five failed attempts.",
        quote: "The portal shall lock an account after five failed attempts.",
        start: 22,
        end: 82,
        sectionId: "S2",
        headingPath: ["FRD", "1 Access"],
        refersTo: [],
      },
    ],
    sections: [
      {
        sectionId: "S2",
        headingPath: ["FRD", "1 Access"],
        start: 7,
        end: 82,
        status: "read",
        kinds: { requirement: 1 },
        statements: 1,
        unverified: 0,
        repeats: 0,
      },
    ],
    droppedUnverified: 0,
    merge: "skipped",
    calls: 2,
    outputTokenCap,
    usage: { promptTokens: 1500, completionTokens: 200, totalTokens: 1700 },
  };
}

describe.skipIf(!enabled)("#2319 — saved document readings (Postgres)", () => {
  let db: PrismaClient;
  const rows = () =>
    db.savedDocumentReading.findMany({
      where: { documentId: DOC },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    await db.user.create({
      data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
    });
    await db.workspace.create({ data: { id: WORKSPACE, name: WORKSPACE, slug: WORKSPACE } });
    for (const id of [PA, PB]) {
      await db.project.create({
        data: { id, name: id, slug: id, createdById: USER, workspaceId: WORKSPACE },
      });
    }
    await db.document.create({
      data: {
        id: DOC,
        projectId: PA,
        filename: "frd.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
        storagePath: "/tmp/frd.md",
        checksum: "sum-1",
        uploadedById: USER,
        status: "ready",
      },
    });
  });

  beforeEach(async () => {
    await db.savedDocumentReading.deleteMany({ where: { documentId: DOC } });
    await db.document.update({ where: { id: DOC }, data: { checksum: "sum-1" } });
  });

  afterAll(async () => {
    if (!db) return;
    // The document and its saved readings cascade from the project.
    await db.project.deleteMany({ where: { id: { in: [PA, PB] } } });
    await db.workspace.deleteMany({ where: { id: WORKSPACE } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.$disconnect();
  });

  const doc = { projectId: PA, documentId: DOC, checksum: "sum-1" };

  it("saves a whole reading and reuses it with no reader call", async () => {
    const read = vi.fn(async () => reading());
    const first = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: doc },
      { db, read },
    );
    const second = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: doc },
      { db, read },
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(first.reused).toBeUndefined();
    expect(second.reused).toBeDefined();
    expect(second.calls).toBe(0);
    expect(second.statements).toEqual(first.statements);
    expect(await rows()).toHaveLength(1);
  });

  it("never overwrites another project's reading of the same key", async () => {
    await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: doc },
      { db, read: async () => reading(1111) },
    );
    const r = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: { ...doc, projectId: PB }, reread: true },
      { db, read: async () => reading(2222) },
    );
    expect(r.outputTokenCap).toBe(2222);
    const saved = await rows();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.projectId).toBe(PA);
    expect(JSON.parse(saved[0]!.reading).outputTokenCap).toBe(1111);

    // The mechanism, on the real client: the same upsert shape under another
    // project resolves null (it does not throw) and leaves the row as it was.
    const row = saved[0]!;
    const theirs = await db.savedDocumentReading.upsert({
      where: {
        documentId_checksum_readerVersion_model_textHash: {
          documentId: row.documentId,
          checksum: row.checksum,
          readerVersion: row.readerVersion,
          model: row.model,
          textHash: row.textHash,
        },
        projectId: PB,
      },
      create: {
        projectId: PB,
        documentId: row.documentId,
        checksum: row.checksum,
        readerVersion: row.readerVersion,
        model: row.model,
        textHash: row.textHash,
        reading: "{}",
        usage: "{}",
      },
      update: { reading: "{}" },
    });
    expect(theirs).toBeNull();
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ projectId: PA, reading: row.reading });

    // And project B never gets A's reading back: with no reread, B's read still
    // calls the reader.
    const read = vi.fn(async () => reading(3333));
    const b = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: { ...doc, projectId: PB } },
      { db, read },
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(b.reused).toBeUndefined();
    expect(b.outputTokenCap).toBe(3333);
  });

  it("a save deletes an earlier file's and an earlier reader's readings, and keeps another model's", async () => {
    const read = vi.fn(async () => reading());
    const base = {
      projectId: PA,
      documentId: DOC,
      model: "claude-sonnet-5-5",
      textHash: "h",
      reading: "{}",
      usage: "{}",
    };
    await db.savedDocumentReading.createMany({
      data: [
        // An earlier file: deleted.
        { ...base, checksum: "sum-1", readerVersion: READER_VERSION },
        // An earlier reader of the file saved now: deleted.
        { ...base, checksum: "sum-2", readerVersion: "older" },
        // Another model's reading of the file saved now: kept.
        { ...base, checksum: "sum-2", readerVersion: READER_VERSION, model: "claude-opus-5" },
      ],
    });
    await db.document.update({ where: { id: DOC }, data: { checksum: "sum-2" } });

    await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: { ...doc, checksum: "sum-2" } },
      { db, read },
    );
    const left = (await rows()).map((r) => [r.checksum, r.readerVersion, r.model]);
    expect(left).toHaveLength(2);
    expect(left).toContainEqual(["sum-2", READER_VERSION, "claude-sonnet-5-5"]);
    expect(left).toContainEqual(["sum-2", READER_VERSION, "claude-opus-5"]);
  });
});
