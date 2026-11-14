/**
 * #2319 — the store arm R saves its readings in, so the eval reads a document
 * the way an analysis does: through `readDocumentOnce`, which looks a saved
 * reading up, saves a whole one and tidies the document's older readings.
 *
 * The eval has no database, and a corpus document is no `Document` row, so
 * this is an in-process stand-in for the two delegates `readDocumentOnce`
 * touches (`savedDocumentReading`, `document`). It applies every `where`
 * field it is given, `NOT` included. An upsert whose `where` misses (another
 * project's row of the same key) resolves null and writes nothing, as Prisma 7
 * does on Postgres and SQLite, so a reading the eval reuses is one production
 * would reuse. A filter operator or a delegate method it does not implement
 * throws and is recorded (`problems`): `readDocumentOnce` swallows a failed
 * lookup and reads again, so the arm checks `problems` after each read. It
 * lives as long as the arm: a second run of the same invocation
 * (`--runs 2`) finds the first run's readings.
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
type Fail = (msg: string) => never;

const isScalar = (v: unknown): boolean =>
  v === null || ["string", "number", "boolean", "undefined"].includes(typeof v);

/**
 * A value that is not a scalar (`{ in: [...] }`, `{ not: ... }`, a `NOT` list)
 * is a filter this stand-in does not implement: `fail` throws rather than let
 * it quietly match nothing. Checked on every call, rows or none.
 */
function validate(where: Where, fail: Fail): void {
  for (const [k, v] of Object.entries(where)) {
    if (k === "NOT") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        fail("unsupported filter: NOT takes one object of fields");
      }
      validate(v as Where, fail);
    } else if (!isScalar(v)) {
      fail(`unsupported filter on "${k}": only equality is implemented`);
    }
  }
}

/** Every field equal; `NOT` holds when its own fields do not all match. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) =>
    k === "NOT" ? !matches(row, v as Where) : row[k] === v,
  );
}

export interface EvalReadingStore {
  /** The store, in the shape `readDocumentOnce` takes. */
  db: NonNullable<ReadingCacheDeps["db"]>;
  /** Register `text` as a live document under `documentId`; returns its saved-reading key. */
  register(documentId: string, text: string): SavedDocumentKey;
  /** The saved readings, for a test or a diagnostic. */
  readings(): readonly Row[];
  /** Every call or filter the stand-in does not implement, in order; empty when it was faithful. */
  problems(): readonly string[];
}

export function createEvalReadingStore(): EvalReadingStore {
  const rows: Row[] = [];
  const documents = new Map<string, Row>();
  const problems: string[] = [];
  let nextId = 1;

  const fail: Fail = (msg) => {
    const message = `reading store stand-in: ${msg}`;
    problems.push(message);
    throw new Error(message);
  };
  /** Validate the filter before it is applied, so an empty table cannot hide an unsupported one. */
  const find = (where: Where): ((row: Row) => boolean) => {
    validate(where, fail);
    return (row) => matches(row, where);
  };
  /** A delegate that throws on any method the stand-in does not implement. */
  const strict = <T extends object>(name: string, delegate: T): T =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        if (prop in target || typeof prop === "symbol" || prop === "then") {
          return Reflect.get(target, prop, receiver);
        }
        return async () => fail(`unsupported call ${name}.${prop}`);
      },
    });

  const savedDocumentReading = {
    async findFirst({ where }: { where: Where }) {
      return rows.find(find(where)) ?? null;
    },
    async upsert(args: {
      where: { documentId_checksum_readerVersion_model_textHash: Where } & Where;
      create: Row;
      update: Row;
    }) {
      const { documentId_checksum_readerVersion_model_textHash: key, ...rest } = args.where;
      const existing = rows.find(find(key));
      if (existing) {
        // Another project's row: the extended where matches nothing, and Prisma
        // resolves null without writing.
        if (!find(rest)(existing)) return null;
        Object.assign(existing, args.update);
        return existing;
      }
      const created: Row = { id: `saved-${nextId++}`, createdAt: new Date(), ...args.create };
      rows.push(created);
      return created;
    },
    async deleteMany({ where }: { where: Where }) {
      const isMatch = find(where);
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (isMatch(rows[i]!)) rows.splice(i, 1);
      return { count: before - rows.length };
    },
  };
  const document = {
    async findFirst({ where }: { where: Where }) {
      const isMatch = find(where);
      for (const d of documents.values()) if (isMatch(d)) return d;
      return null;
    },
  };
  const db = {
    savedDocumentReading: strict("savedDocumentReading", savedDocumentReading),
    document: strict("document", document),
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
    problems: () => problems,
  };
}
