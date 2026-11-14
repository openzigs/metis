/**
 * #2319 — the store arm R saves its readings in, so the eval reads a document
 * the way an analysis does: through `readDocumentOnce`, which looks a saved
 * reading up, saves a whole one and tidies the document's older readings.
 *
 * The eval has no database, and a corpus document is no `Document` row, so
 * this is an in-process stand-in for the two delegates `readDocumentOnce`
 * touches (`savedDocumentReading`, `document`). It applies every `where`
 * field it is given, `NOT` included, and fails a create on the table's unique
 * key, as the database would, so a reading the eval reuses is one production
 * would reuse. It lives as long as the arm: a second run of the same
 * invocation (`--runs 2`) finds the first run's readings.
 *
 * Each corpus document is registered as a live document of one eval project,
 * under its synthetic id (`documentIdOf`) and the SHA-256 of its converted
 * text as the file's checksum: a changed corpus document is another file.
 */
import { createHash } from "node:crypto";
import type { ReadingCacheDeps, SavedDocumentKey } from "../../document-reader/reading-cache.js";

/** The project every corpus document is registered under. */
export const EVAL_READING_PROJECT = "eval-doc-understanding";

type Where = Record<string, unknown>;
type Row = Record<string, unknown>;

/** Every field equal; `NOT` holds when its own fields do not all match. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) =>
    k === "NOT" ? !matches(row, v as Where) : row[k] === v,
  );
}

const KEY_FIELDS = ["documentId", "checksum", "readerVersion", "model", "textHash"] as const;

export interface EvalReadingStore {
  /** The store, in the shape `readDocumentOnce` takes. */
  db: NonNullable<ReadingCacheDeps["db"]>;
  /** Register `text` as a live document under `documentId`; returns its saved-reading key. */
  register(documentId: string, text: string): SavedDocumentKey;
  /** The saved readings, for a test or a diagnostic. */
  readings(): readonly Row[];
}

export function createEvalReadingStore(): EvalReadingStore {
  const rows: Row[] = [];
  const documents = new Map<string, Row>();
  const keyOf = (row: Row): string => JSON.stringify(KEY_FIELDS.map((f) => row[f]));

  const db = {
    savedDocumentReading: {
      async findFirst({ where }: { where: Where }) {
        return rows.find((r) => matches(r, where)) ?? null;
      },
      async upsert(args: {
        where: { documentId_checksum_readerVersion_model_textHash: Where } & Where;
        create: Row;
        update: Row;
      }) {
        const { documentId_checksum_readerVersion_model_textHash: key, ...rest } = args.where;
        const existing = rows.find((r) => matches(r, key));
        if (existing && matches(existing, rest)) {
          Object.assign(existing, args.update);
          return existing;
        }
        const created: Row = {
          id: `saved-${rows.length + 1}`,
          createdAt: new Date(),
          ...args.create,
        };
        // The where missed (another project's row): the create meets the unique key.
        if (rows.some((r) => keyOf(r) === keyOf(created))) {
          throw new Error("Unique constraint failed on saved_document_readings key");
        }
        rows.push(created);
        return created;
      },
      async deleteMany({ where }: { where: Where }) {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i]!, where)) rows.splice(i, 1);
        return { count: before - rows.length };
      },
    },
    document: {
      async findFirst({ where }: { where: Where }) {
        for (const d of documents.values()) if (matches(d, where)) return d;
        return null;
      },
    },
  };

  return {
    db: db as unknown as NonNullable<ReadingCacheDeps["db"]>,
    register(documentId, text) {
      const checksum = createHash("sha256").update(text, "utf8").digest("hex");
      documents.set(documentId, {
        id: documentId,
        projectId: EVAL_READING_PROJECT,
        checksum,
        deletedAt: null,
      });
      return { projectId: EVAL_READING_PROJECT, documentId, checksum };
    },
    readings: () => rows,
  };
}
