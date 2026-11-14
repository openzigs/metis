/**
 * #2319 — the eval's in-process reading store behaves as the table does for
 * every call `readDocumentOnce` makes: a lookup applies every field, a save
 * under another project resolves null and writes nothing, a delete honours `NOT`, and a
 * registered corpus document is live under the eval project.
 */
import { describe, expect, it } from "vitest";
import { EVAL_READING_PROJECT, createEvalReadingStore } from "./reading-store.js";

const KEY = {
  documentId: "doc:source.docx",
  checksum: "c1",
  readerVersion: "v1",
  model: "m",
  textHash: "h",
};

type Db = {
  savedDocumentReading: {
    findFirst(a: object): Promise<Record<string, unknown> | null>;
    upsert(a: object): Promise<Record<string, unknown>>;
    deleteMany(a: object): Promise<{ count: number }>;
  };
  document: { findFirst(a: object): Promise<Record<string, unknown> | null> };
};

function store() {
  const s = createEvalReadingStore();
  return { ...s, db: s.db as unknown as Db };
}

const save = (db: Db, projectId: string, reading: string) =>
  db.savedDocumentReading.upsert({
    where: { documentId_checksum_readerVersion_model_textHash: KEY, projectId },
    create: { projectId, ...KEY, reading, usage: "{}" },
    update: { reading },
  });

describe("createEvalReadingStore", () => {
  it("registers a corpus document as live under the eval project, its text's hash as checksum", async () => {
    const { db, register } = store();
    const key = register("doc:source.docx", "text");
    expect(key).toEqual({
      projectId: EVAL_READING_PROJECT,
      documentId: "doc:source.docx",
      checksum: "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1",
    });
    expect(
      await db.document.findFirst({
        where: { id: "doc:source.docx", projectId: EVAL_READING_PROJECT, deletedAt: null },
      }),
    ).toMatchObject({ checksum: key.checksum });
    expect(
      await db.document.findFirst({ where: { id: "doc:source.docx", projectId: "other" } }),
    ).toBeNull();
  });

  it("saves, finds by every field, and overwrites only the same project's row", async () => {
    const { db, readings } = store();
    await save(db, "p", "first");
    await save(db, "p", "second");
    expect(readings()).toHaveLength(1);
    expect(
      await db.savedDocumentReading.findFirst({ where: { projectId: "p", ...KEY } }),
    ).toMatchObject({ reading: "second" });
    expect(
      await db.savedDocumentReading.findFirst({ where: { projectId: "q", ...KEY } }),
    ).toBeNull();
    // As Prisma 7 does on Postgres and SQLite: another project's save resolves
    // null and writes nothing (it neither throws nor overwrites).
    expect(await save(db, "q", "theirs")).toBeNull();
    expect(readings()).toHaveLength(1);
    expect(readings()[0]).toMatchObject({ projectId: "p", reading: "second" });
  });

  it("gives every saved row its own id, even after a delete shrinks the table", async () => {
    const { db, readings } = store();
    const saveVersion = (readerVersion: string) =>
      db.savedDocumentReading.upsert({
        where: {
          documentId_checksum_readerVersion_model_textHash: { ...KEY, readerVersion },
          projectId: "p",
        },
        create: { projectId: "p", ...KEY, readerVersion, reading: "r", usage: "{}" },
        update: {},
      });
    await saveVersion("v1");
    await saveVersion("v0");
    await db.savedDocumentReading.deleteMany({ where: { readerVersion: "v1" } });
    await saveVersion("v2");
    const ids = readings().map((r) => r.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("throws, and records it, on a filter operator or a delegate method it does not implement", async () => {
    const { db, problems } = store();
    await expect(
      db.savedDocumentReading.findFirst({ where: { model: { in: ["m"] } } }),
    ).rejects.toThrow(/unsupported filter/);
    const raw = db as unknown as {
      savedDocumentReading: { findUnique(a: object): Promise<unknown> };
    };
    await expect(raw.savedDocumentReading.findUnique({ where: {} })).rejects.toThrow(
      /unsupported call .*findUnique/,
    );
    expect(problems()).toHaveLength(2);
  });

  it("deletes the rows a where matches, NOT included", async () => {
    const { db, readings } = store();
    await save(db, "p", "keep");
    await db.savedDocumentReading.upsert({
      where: {
        documentId_checksum_readerVersion_model_textHash: { ...KEY, readerVersion: "v0" },
        projectId: "p",
      },
      create: { projectId: "p", ...KEY, readerVersion: "v0", reading: "old", usage: "{}" },
      update: {},
    });
    expect(readings()).toHaveLength(2);
    const { count } = await db.savedDocumentReading.deleteMany({
      where: { projectId: "p", NOT: { checksum: "c1", readerVersion: "v1" } },
    });
    expect(count).toBe(1);
    expect(readings().map((r) => r.reading)).toEqual(["keep"]);
  });
});
