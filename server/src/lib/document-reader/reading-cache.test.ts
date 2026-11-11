/**
 * #2280 — `readDocumentOnce`: a whole reading is saved, and the next read of
 * the same document, file, reader, model and text reuses it with no model
 * call. Any change to the key reads again; a failed, partial or empty reading
 * is never saved; pasted text is never saved; a lookup is scoped to the
 * document's own project; a store failure never fails the read.
 *
 * The store is an in-memory double of `prisma.savedDocumentReading` that
 * applies every `where` field it is given, so a lookup that drops the project
 * filter would match here as it would in the database. The real table, its key
 * and its cascade are exercised in
 * `tests/document-reading-cache-2280.sqlite.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../ai/types.js";
import type { DocumentReading } from "./reader.js";
import { READER_VERSION } from "./reader.js";
import {
  isSavableReading,
  readDocumentOnce,
  readingTextHash,
  type ReadingCacheDeps,
  type SavedDocumentKey,
} from "./reading-cache.js";

type Row = {
  id: string;
  projectId: string;
  documentId: string;
  checksum: string;
  readerVersion: string;
  model: string;
  textHash: string;
  reading: string;
  usage: string;
  createdAt: Date;
};

function memoryStore() {
  const rows: Row[] = [];
  /** #2293 — the documents the store's tidy-up checks: live and in project `p-1` unless changed. */
  const documents = [
    { id: "d-1", projectId: "p-1", checksum: "sum-1", deletedAt: null as Date | null },
  ];
  // Every field, and `NOT` (none of its fields all equal), as the database applies them.
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) =>
      k === "NOT" ? !matches(row, v as Record<string, unknown>) : row[k] === v,
    );
  const db = {
    savedDocumentReading: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return rows.find((r) => matches(r, where)) ?? null;
      }),
      upsert: vi.fn(
        async (args: {
          where: {
            documentId_checksum_readerVersion_model_textHash: Record<string, unknown>;
            projectId?: string;
          };
          create: Omit<Row, "id" | "createdAt">;
          update: Partial<Row>;
        }) => {
          const { documentId_checksum_readerVersion_model_textHash: key, ...extra } = args.where;
          const existing = rows.find((r) => matches(r, key));
          if (existing && matches(existing, extra)) {
            Object.assign(existing, args.update);
            return existing;
          }
          // As the database does: the where missed, so the create hits the unique key.
          if (existing) throw new Error("Unique constraint failed: saved_document_readings_key");
          const row = { id: `r${rows.length + 1}`, createdAt: new Date(), ...args.create };
          rows.push(row);
          return row;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i]!, where)) rows.splice(i, 1);
        return { count: before - rows.length };
      }),
    },
    document: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return documents.find((d) => matches(d, where)) ?? null;
      }),
    },
  };
  return { rows, documents, db: db as unknown as NonNullable<ReadingCacheDeps["db"]> };
}

const provider = { key: "anthropic", model: "claude-sonnet-5-5" } as unknown as AIProvider;
const TEXT = "# FRD\n\n## 1 Access\n\nThe portal shall lock an account after five failed attempts.";
const DOC: SavedDocumentKey = { projectId: "p-1", documentId: "d-1", checksum: "sum-1" };

function reading(over: Partial<DocumentReading> = {}): DocumentReading {
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
    outputTokenCap: 8192,
    usage: { promptTokens: 1500, completionTokens: 200, totalTokens: 1700 },
    ...over,
  };
}

function reader(result: () => DocumentReading | Promise<DocumentReading>) {
  return vi.fn(async () => result());
}

describe("readDocumentOnce", () => {
  it("saves a whole reading and reuses it on the next read, with no model call", async () => {
    const { rows, db } = memoryStore();
    const read = reader(() => reading());
    const first = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC },
      { db, read },
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(first.reused).toBeUndefined();
    expect(first.usage.totalTokens).toBe(1700);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: "p-1",
      documentId: "d-1",
      checksum: "sum-1",
      readerVersion: READER_VERSION,
      model: "claude-sonnet-5-5",
      textHash: readingTextHash(TEXT),
    });
    expect(JSON.parse(rows[0]!.usage)).toEqual(first.usage);

    const second = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC },
      { db, read },
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(second.reused).toEqual({ readAt: rows[0]!.createdAt, model: "claude-sonnet-5-5" });
    expect(second.calls).toBe(0);
    expect(second.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    // The reuse is the reading itself: same statements, same coverage.
    const { usage: _u1, calls: _c1, reused: _r1, ...a } = first;
    const { usage: _u2, calls: _c2, reused: _r2, ...b } = second;
    expect(b).toEqual(a);
  });

  it.each([
    ["the file (checksum)", { document: { ...DOC, checksum: "sum-2" } }],
    ["the model", { model: "claude-opus-5" }],
    ["the text read (image descriptions, a parser change)", { text: `${TEXT}\n\n[Image: a flow]` }],
  ])("reads again when %s changes", async (_what, change) => {
    const { db } = memoryStore();
    const read = reader(() => reading());
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC, ...change },
      { db, read },
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads again when the reader version changes", async () => {
    const { rows, db } = memoryStore();
    const read = reader(() => reading());
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    rows[0]!.readerVersion = "older";
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never reuses a reading across projects", async () => {
    const { db } = memoryStore();
    const read = reader(() => reading());
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    const other = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: { ...DOC, projectId: "p-2" } },
      { db, read },
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(other.reused).toBeUndefined();
    expect(db.savedDocumentReading.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "p-2", documentId: "d-1" }),
      }),
    );
  });

  it("re-read on demand reads again and replaces the saved reading", async () => {
    const { rows, db } = memoryStore();
    let n = 0;
    const read = reader(() => reading({ outputTokenCap: 1000 + ++n }));
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    const fresh = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC, reread: true },
      { db, read },
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(fresh.reused).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.reading).outputTokenCap).toBe(1002);
    const next = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC },
      { db, read },
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(next.outputTokenCap).toBe(1002);
  });

  it.each([
    ["empty", reading({ statements: [] })],
    [
      "partial: a batch unread",
      reading({ sections: [{ ...reading().sections[0]!, status: "unread" }] }),
    ],
    ["partial: the cross-section pass failed", reading({ merge: "failed" })],
  ])("never saves a reading that is %s, so the next run reads again", async (_what, result) => {
    const { rows, db } = memoryStore();
    const read = reader(() => result);
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    expect(rows).toHaveLength(0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never saves a failed reading: the error reaches the caller and nothing is stored", async () => {
    const { rows, db } = memoryStore();
    const read = vi.fn(async (): Promise<DocumentReading> => {
      throw new Error("provider down");
    });
    await expect(
      readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read }),
    ).rejects.toThrow("provider down");
    expect(rows).toHaveLength(0);
  });

  it("never saves pasted text (no document)", async () => {
    const { db } = memoryStore();
    const read = reader(() => reading());
    await readDocumentOnce({ title: "Pasted text", text: TEXT, provider }, { db, read });
    await readDocumentOnce(
      { title: "Pasted text", text: TEXT, provider, document: null },
      { db, read },
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(db.savedDocumentReading.findFirst).not.toHaveBeenCalled();
    expect(db.savedDocumentReading.upsert).not.toHaveBeenCalled();
  });

  it("does not pass its own fields to the reader", async () => {
    const { db } = memoryStore();
    const read = reader(() => reading());
    await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC, reread: true },
      { db, read },
    );
    expect(read).toHaveBeenCalledWith({ title: "FRD", text: TEXT, provider });
  });

  it("reads again when the saved row is not a reading it can use", async () => {
    const { rows, db } = memoryStore();
    const read = reader(() => reading());
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    const good = reading();
    for (const bad of [
      "not json",
      "null",
      JSON.stringify({ ...good, statements: [] }),
      // #2293 — each element is checked, not only the lists.
      JSON.stringify({ ...good, statements: [null] }),
      JSON.stringify({ ...good, statements: [{ ...good.statements[0], quote: 7 }] }),
      JSON.stringify({ ...good, statements: [{ ...good.statements[0], kind: "made-up" }] }),
      JSON.stringify({ ...good, statements: [{ ...good.statements[0], headingPath: "x" }] }),
      JSON.stringify({ ...good, sections: ["x"] }),
      JSON.stringify({ ...good, sections: [{ ...good.sections[0], status: "maybe" }] }),
      JSON.stringify({ ...good, sections: [{ ...good.sections[0], kinds: null }] }),
    ]) {
      rows[0]!.reading = bad;
      const r = await readDocumentOnce(
        { title: "FRD", text: TEXT, provider, document: DOC },
        { db, read },
      );
      expect(r.reused).toBeUndefined();
    }
    expect(read).toHaveBeenCalledTimes(11);
  });

  it("#2293 — never overwrites another project's reading of the same key", async () => {
    const { rows, db } = memoryStore();
    const read = reader(() => reading({ outputTokenCap: 1111 }));
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    expect(rows).toHaveLength(1);
    const wrong = reader(() => reading({ outputTokenCap: 2222 }));
    const r = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: { ...DOC, projectId: "p-2" }, reread: true },
      { db, read: wrong },
    );
    // The read still reaches the caller; the store keeps p-1's row as it was.
    expect(r.outputTokenCap).toBe(2222);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: "p-1" });
    expect(JSON.parse(rows[0]!.reading).outputTokenCap).toBe(1111);
  });

  it("#2293 — a save deletes the document's readings of an earlier file or reader, and keeps other models'", async () => {
    const { rows, documents, db } = memoryStore();
    const read = reader(() => reading());
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC, model: "claude-opus-5" },
      { db, read },
    );
    rows[0]!.readerVersion = "older";
    rows.push({ ...rows[1]!, id: "other-doc", documentId: "d-2" });
    expect(rows).toHaveLength(3);

    documents[0]!.checksum = "sum-2";
    await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: { ...DOC, checksum: "sum-2" } },
      { db, read },
    );
    // The older reader's row and the old file's row are gone; the new file's
    // row and the other document's row stay.
    expect(rows.map((r) => [r.documentId, r.checksum, r.readerVersion, r.model])).toEqual([
      ["d-2", "sum-1", READER_VERSION, "claude-opus-5"],
      ["d-1", "sum-2", READER_VERSION, "claude-sonnet-5-5"],
    ]);
  });

  it("#2293 — a run that read an earlier file finishing late does not prune the current file's reading", async () => {
    const { rows, documents, db } = memoryStore();
    const read = reader(() => reading());
    // The newer run read the file as it is now (sum-2) and saved first.
    documents[0]!.checksum = "sum-2";
    await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: { ...DOC, checksum: "sum-2" } },
      { db, read },
    );
    // The older run, which read sum-1, finishes afterwards.
    await readDocumentOnce(
      { title: "FRD", text: TEXT + " ", provider, document: DOC },
      { db, read },
    );
    expect(rows.some((r) => r.checksum === "sum-2")).toBe(true);
    const back = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: { ...DOC, checksum: "sum-2" } },
      { db, read },
    );
    expect(back.reused).toBeDefined();
  });

  it("#2293 — a reading of another model of the same file stays, and is reused when that model reads again", async () => {
    const { rows, db } = memoryStore();
    const read = reader(() => reading());
    await readDocumentOnce({ title: "FRD", text: TEXT, provider, document: DOC }, { db, read });
    await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC, model: "claude-opus-5" },
      { db, read },
    );
    expect(rows).toHaveLength(2);
    const back = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC },
      { db, read },
    );
    expect(back.reused).toBeDefined();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("#2293 — a document deleted while it was read keeps no reading", async () => {
    const { rows, documents, db } = memoryStore();
    const read = reader(() => {
      // `deleteDocument` ran during the read: it deleted what existed then.
      documents[0]!.deletedAt = new Date();
      return reading();
    });
    const r = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC },
      { db, read },
    );
    expect(r.statements).toHaveLength(1);
    expect(rows).toEqual([]);
  });

  it("#2293 — a reading saved under a project the document is not in is dropped", async () => {
    const { rows, db } = memoryStore();
    const read = reader(() => reading());
    await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: { ...DOC, projectId: "p-2" } },
      { db, read },
    );
    expect(rows).toEqual([]);
  });

  it("#2293 — a tidy-up that fails never fails the read, and the saved reading stays", async () => {
    const { rows, db } = memoryStore();
    (db.savedDocumentReading.deleteMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("database is locked"),
    );
    const r = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC },
      { db, read: reader(() => reading()) },
    );
    expect(r.statements).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("a store that fails to look up or save never fails the read", async () => {
    const db = {
      savedDocumentReading: {
        findFirst: vi.fn(async () => {
          throw new Error("no such table");
        }),
        upsert: vi.fn(async () => {
          throw new Error("no such table");
        }),
      },
    } as unknown as NonNullable<ReadingCacheDeps["db"]>;
    const read = reader(() => reading());
    const r = await readDocumentOnce(
      { title: "FRD", text: TEXT, provider, document: DOC },
      { db, read },
    );
    expect(r.statements).toHaveLength(1);
    expect(db.savedDocumentReading.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("isSavableReading", () => {
  it("is a reading with every section read, the merge not failed, and a statement", () => {
    expect(isSavableReading(reading())).toBe(true);
    expect(isSavableReading(reading({ merge: "done" }))).toBe(true);
    expect(isSavableReading(reading({ statements: [] }))).toBe(false);
    expect(isSavableReading(reading({ merge: "failed" }))).toBe(false);
  });
});

describe("readingTextHash", () => {
  it("is the text's SHA-256, different for a different text", () => {
    expect(readingTextHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(readingTextHash("abc ")).not.toBe(readingTextHash("abc"));
  });
});
