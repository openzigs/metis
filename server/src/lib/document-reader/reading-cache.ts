/**
 * #2280 (Epic #2227) — a document's reading, saved and reused.
 *
 * Reading a document costs about $0.20 on Sonnet 5.5 (#2229), the largest
 * single model cost of a document-driven run, and a stored file never changes
 * under its `Document.checksum`. So Requirements Analysis and Impact Analysis
 * both read a stored document through {@link readDocumentOnce}: the first run
 * reads it and saves the reading (`SavedDocumentReading`); every later run with
 * the same key reuses it and makes no model call.
 *
 * The key is everything that changes what the reading says:
 *
 *   - the document and its file (`documentId`, `checksum`);
 *   - the reader ({@link READER_VERSION}, bumped when its prompts, schemas,
 *     batching or verification change);
 *   - the model that read it — a different model reads again;
 *   - the SHA-256 of the exact text the model read. A run reads the parsed file,
 *     or, when the file's images were described at ingest, the stored chunks
 *     that hold those descriptions (`impact-analysis/document-source.ts`); so
 *     switching the image describer on, re-ingesting, or a parser change gives
 *     another text and reads again. It also keeps every saved quote offset
 *     pointing into the text the caller holds.
 *
 * Only a whole reading is saved: never a failed one (it throws), a partial one
 * (a batch whose reply could not be read, or a cross-section pass that failed),
 * or an empty one. Pasted text has no document and is never saved.
 *
 * Access is the caller's: a run consults this only after it has checked the
 * user may read the document (the impact route's `assertDocumentReadable`;
 * Requirements Analysis loads only its own project's documents). Every lookup
 * filters on the document's own project as well as its id, so a reading never
 * crosses projects. A failure to read or write the store never fails the run:
 * the document is read as it would have been without one.
 *
 * #2293 — the save keeps the store to the readings that can still be used:
 *
 *   - it overwrites only a row of the same project (the upsert's `where` names
 *     `projectId`), so a caller that passes another project cannot replace
 *     that project's reading: its create fails on the key and is logged;
 *   - it deletes the document's readings of an earlier file (`checksum`) or
 *     reader (`READER_VERSION`), which no later lookup can match. Readings by
 *     another model or of another text stay: switching the model back, or the
 *     image describer, matches them again;
 *   - when the document was deleted while it was being read, or is not the
 *     named project's, it deletes what it saved: `deleteDocument` removes the
 *     readings that exist when it runs, not one saved after.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { STATEMENT_KINDS } from "./prompts.js";
import {
  READER_VERSION,
  readDocument,
  type DocumentReading,
  type ReadDocumentInput,
  type ReadStatement,
  type SectionCoverage,
} from "./reader.js";

const log = createChildLogger("document-reading-cache");

/** A stored document a reading can be saved under. */
export interface SavedDocumentKey {
  /** The document's own project: every lookup filters on it with the id. */
  projectId: string;
  documentId: string;
  /** `Document.checksum`: its stored file's. */
  checksum: string;
}

export interface ReadDocumentOnceInput extends ReadDocumentInput {
  /** The stored document the text was read from; absent for pasted text, which is never saved. */
  document?: SavedDocumentKey | null;
  /** Read the document again even when a saved reading matches ("Read the document again"). */
  reread?: boolean;
}

type ReadingStore = Pick<PrismaClient, "savedDocumentReading" | "document">;

export interface ReadingCacheDeps {
  db?: ReadingStore;
  read?: (input: ReadDocumentInput) => Promise<DocumentReading>;
}

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** The SHA-256 of the text a reading was made from. */
export function readingTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Whether a reading may be saved: every section read, the cross-section pass done, and something found. */
export function isSavableReading(reading: DocumentReading): boolean {
  return (
    reading.statements.length > 0 &&
    reading.merge !== "failed" &&
    reading.sections.every((s) => s.status === "read")
  );
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** #2293 — a saved statement, element by element: what the callers read from it. */
function isSavedStatement(value: unknown): value is ReadStatement {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    (STATEMENT_KINDS as readonly unknown[]).includes(s.kind) &&
    typeof s.statement === "string" &&
    typeof s.quote === "string" &&
    typeof s.start === "number" &&
    typeof s.end === "number" &&
    typeof s.sectionId === "string" &&
    isStringList(s.headingPath) &&
    isStringList(s.refersTo)
  );
}

/** #2293 — a saved section's coverage, element by element. */
function isSavedSection(value: unknown): value is SectionCoverage {
  if (value === null || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.sectionId === "string" &&
    isStringList(c.headingPath) &&
    typeof c.start === "number" &&
    typeof c.end === "number" &&
    (c.status === "read" || c.status === "unread") &&
    c.kinds !== null &&
    typeof c.kinds === "object" &&
    !Array.isArray(c.kinds) &&
    typeof c.statements === "number" &&
    typeof c.unverified === "number" &&
    typeof c.repeats === "number"
  );
}

/** The saved row's reading, or null when it is not one this reader wrote. */
function parseSaved(json: string): Omit<DocumentReading, "usage" | "reused"> | null {
  try {
    const r = JSON.parse(json) as Partial<DocumentReading> | null;
    if (
      !r ||
      (r.mode !== "whole" && r.mode !== "sectioned") ||
      !Array.isArray(r.statements) ||
      r.statements.length === 0 ||
      !r.statements.every(isSavedStatement) ||
      !Array.isArray(r.sections) ||
      !r.sections.every(isSavedSection) ||
      typeof r.droppedUnverified !== "number" ||
      typeof r.outputTokenCap !== "number" ||
      (r.merge !== "done" && r.merge !== "skipped")
    ) {
      return null;
    }
    return {
      mode: r.mode,
      statements: r.statements,
      sections: r.sections,
      droppedUnverified: r.droppedUnverified,
      merge: r.merge,
      calls: 0,
      outputTokenCap: r.outputTokenCap,
    };
  } catch {
    return null;
  }
}

/**
 * Read `input.text`, or reuse the saved reading of the same document, file,
 * reader, model and text. A reused reading carries `reused` (when and with
 * which model it was read) and zero `calls` and `usage`: no model was called.
 */
export async function readDocumentOnce(
  input: ReadDocumentOnceInput,
  deps: ReadingCacheDeps = {},
): Promise<DocumentReading> {
  const { document, reread, ...readInput } = input;
  const read = deps.read ?? readDocument;
  if (!document) return read(readInput);

  const db = deps.db ?? prisma;
  const key = {
    documentId: document.documentId,
    checksum: document.checksum,
    readerVersion: READER_VERSION,
    model: input.model ?? input.provider.model,
    textHash: readingTextHash(input.text),
  };

  if (!reread) {
    try {
      const row = await db.savedDocumentReading.findFirst({
        where: { projectId: document.projectId, ...key },
        select: { reading: true, model: true, createdAt: true },
      });
      const saved = row ? parseSaved(row.reading) : null;
      if (row && saved) {
        return {
          ...saved,
          usage: { ...ZERO_USAGE },
          reused: { readAt: row.createdAt, model: row.model },
        };
      }
    } catch (err) {
      log.warn("saved document reading could not be looked up; reading the document", {
        documentId: document.documentId,
        error: String(err),
      });
    }
  }

  const reading = await read(readInput);
  if (!isSavableReading(reading)) return reading;
  const { usage, reused: _reused, ...toSave } = reading;
  const data = { reading: JSON.stringify(toSave), usage: JSON.stringify(usage) };
  try {
    await db.savedDocumentReading.upsert({
      // #2293 — only this project's row is overwritten; another project's fails the create.
      where: {
        documentId_checksum_readerVersion_model_textHash: key,
        projectId: document.projectId,
      },
      create: { projectId: document.projectId, ...key, ...data },
      update: { ...data, createdAt: new Date() },
    });
  } catch (err) {
    log.warn("document reading could not be saved; the next run reads it again", {
      documentId: document.documentId,
      error: String(err),
    });
    return reading;
  }
  await tidyAfterSave(db, document);
  return reading;
}

/**
 * #2293 — after a save: drop the document's readings no lookup can match any
 * more (an earlier file or reader), and drop every reading of it when it was
 * deleted while being read, or is not the named project's. Best-effort, like
 * every store write.
 */
async function tidyAfterSave(db: ReadingStore, document: SavedDocumentKey): Promise<void> {
  const scope = { projectId: document.projectId, documentId: document.documentId };
  try {
    await db.savedDocumentReading.deleteMany({
      where: { ...scope, NOT: { checksum: document.checksum, readerVersion: READER_VERSION } },
    });
    const live = await db.document.findFirst({
      where: { id: document.documentId, projectId: document.projectId, deletedAt: null },
      select: { id: true },
    });
    if (!live) {
      await db.savedDocumentReading.deleteMany({ where: scope });
      log.info(
        "document was deleted (or is not this project's) while it was read; reading dropped",
        {
          documentId: document.documentId,
        },
      );
    }
  } catch (err) {
    log.warn("saved document readings could not be tidied", {
      documentId: document.documentId,
      error: String(err),
    });
  }
}
