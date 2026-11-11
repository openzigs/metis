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
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import {
  READER_VERSION,
  readDocument,
  type DocumentReading,
  type ReadDocumentInput,
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

type ReadingStore = Pick<PrismaClient, "savedDocumentReading">;

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

/** The saved row's reading, or null when it is not one this reader wrote. */
function parseSaved(json: string): Omit<DocumentReading, "usage" | "reused"> | null {
  try {
    const r = JSON.parse(json) as Partial<DocumentReading> | null;
    if (
      !r ||
      (r.mode !== "whole" && r.mode !== "sectioned") ||
      !Array.isArray(r.statements) ||
      r.statements.length === 0 ||
      !Array.isArray(r.sections) ||
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
      where: { documentId_checksum_readerVersion_model_textHash: key },
      create: { projectId: document.projectId, ...key, ...data },
      update: { ...data, createdAt: new Date() },
    });
  } catch (err) {
    log.warn("document reading could not be saved; the next run reads it again", {
      documentId: document.documentId,
      error: String(err),
    });
  }
  return reading;
}
