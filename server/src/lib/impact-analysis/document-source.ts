/**
 * #2231 (Epic #2227) — what an impact run reads from a document source.
 *
 * Before this, a run started on a document re-joined its stored chunks with
 * `"\n\n"`. The chunker's windows overlap (`rag/chunker.ts`), so every overlap
 * was read twice, and every chunk boundary became a paragraph break the
 * document does not have. The heuristic splitter, which makes one change per
 * paragraph or bullet, then made a change of each duplicate and each half.
 *
 * Now the run reads the document itself:
 *
 *   1. {@link loadImpactDocumentText} — the stored file, parsed as ingest
 *      parses it (`parseDocument`). When the file cannot be read or parsed, the
 *      stored chunks (approved, else quarantined, as before) are joined with
 *      their overlap removed ({@link joinChunksWithoutOverlap}), never
 *      concatenated.
 *   2. {@link changesFromReading} — with the document reader on
 *      (`ANALYSIS_DOCUMENT_READER`), the model reads that text in full
 *      (`document-reader/reader.ts`) and each requirement, constraint or
 *      business rule it found is ONE change, carrying the section it sits in
 *      and the source's own words. The heuristic splitter stays for pasted
 *      short text and for issue shapes ({@link shouldReadWithModel}).
 *   3. {@link documentReadingNotice} — what the reading covered, on the run's
 *      summary, so nothing it left out is left out silently.
 *
 * #2280 — a document source carries its key (`saved`), so the reader reuses
 * a saved reading of the same file instead of paying to read it again
 * (`document-reader/reading-cache.ts`); the notice then says whose.
 */
import type { PrismaClient } from "@prisma/client";
import { parseDocument } from "../documents/parsers.js";
import type { StorageBackend } from "../documents/storage.js";
import type { DocumentReading } from "../document-reader/reader.js";
import type { SavedDocumentKey } from "../document-reader/reading-cache.js";
import { REQUIREMENT_STATEMENT_KINDS, type StatementKind } from "../document-reader/prompts.js";
import { formatHeadingPath } from "../document-reader/sections.js";
import { detectChangeType, type ChangedRequirement } from "./extract-changes.js";
import { parseChangeRequest } from "./change-request.js";

/** Pasted text shorter than this keeps the heuristic splitter: a request, not a document. */
export const READER_MIN_PASTED_CHARS = 2_000;
/**
 * The least overlap {@link joinChunksWithoutOverlap} removes. A shorter match
 * between one chunk's end and the next one's start (a full stop, a space) is
 * as likely chance as overlap; leaving a few repeated characters costs less
 * than cutting a few real ones.
 */
export const MIN_CHUNK_OVERLAP_CHARS = 8;

const TITLE_MAX = 120;

/** Reads a stored document file (the storage backend's `read`). */
export type ReadStoredFile = Pick<StorageBackend, "read">;

type DocumentSourcePrisma = Pick<PrismaClient, "document" | "knowledgeChunk" | "quarantineChunk">;

export interface ImpactDocumentText {
  text: string;
  /** `file`: the stored file, parsed. `chunks`: the stored chunks, de-overlapped. */
  from: "file" | "chunks";
  /** The document's title (else filename), for the reader's prompt. */
  title: string;
  /** #2280 — the stored document's key, under which its reading is saved; absent when no row was found. */
  saved?: SavedDocumentKey;
}

/**
 * The length of the longest suffix of `prev` that is also a prefix of `next`:
 * KMP, matching the start of `next` along the end of `prev`, linear in both.
 */
export function overlapLength(prev: string, next: string): number {
  const max = Math.min(prev.length, next.length);
  if (max === 0) return 0;
  const pattern = next.slice(0, max);
  const fail = new Array<number>(max).fill(0);
  for (let i = 1, k = 0; i < max; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = fail[k - 1]!;
    if (pattern[i] === pattern[k]) k++;
    fail[i] = k;
  }
  let k = 0;
  for (let i = prev.length - max; i < prev.length; i++) {
    while (k > 0 && (k === max || prev[i] !== pattern[k])) k = fail[k - 1]!;
    if (prev[i] === pattern[k]) k++;
  }
  return k;
}

/**
 * Stored chunks back into one text, each overlap kept once. A chunk that
 * starts with the previous chunk's last characters (the chunker's carry-over)
 * contributes only what follows them, with nothing in between: the two were
 * one run of text. A chunk with no overlap (a new section, or a window that
 * abutted) starts a new paragraph.
 */
export function joinChunksWithoutOverlap(chunks: readonly string[]): string {
  let out = "";
  let prev = "";
  for (const chunk of chunks) {
    if (!chunk) continue;
    if (!prev) {
      out = chunk;
    } else {
      const k = overlapLength(prev, chunk);
      out += k >= MIN_CHUNK_OVERLAP_CHARS ? chunk.slice(k) : `\n\n${chunk}`;
    }
    prev = chunk;
  }
  return out;
}

/**
 * The text an impact run reads for `documentId`: the stored file, parsed; or,
 * when the file cannot be read or parsed, the stored chunks with their overlap
 * removed. A user-selected document drives impact analysis whatever its RAG
 * approval state, so quarantined chunks are read when no approved ones exist
 * (quarantine governs knowledge-base search, not whether the user may analyse
 * a document they chose; the route checked they may read it).
 */
export async function loadImpactDocumentText(
  prisma: DocumentSourcePrisma,
  documentId: string,
  storage: ReadStoredFile,
): Promise<ImpactDocumentText> {
  let title = documentId;
  let saved: SavedDocumentKey | undefined;
  try {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        projectId: true,
        checksum: true,
        filename: true,
        title: true,
        mimeType: true,
        storagePath: true,
      },
    });
    if (doc) {
      title = doc.title ?? doc.filename;
      // Saved under the document's OWN project: the route checked the user may read it.
      saved = { projectId: doc.projectId, documentId, checksum: doc.checksum };
      const buffer = await storage.read(doc.storagePath);
      const parsed = await parseDocument({
        buffer,
        mimeType: doc.mimeType,
        filename: doc.filename,
      });
      if (parsed.ok && parsed.text.trim().length > 0) {
        // Ingest described a Word document's images with the project's vision
        // model and stored those descriptions in the chunks; this re-parse has no
        // describer, so it would turn each one into "image not read". When the
        // re-parse lost images and the chunks exist, read the chunks instead —
        // they hold what ingest saw, and describing again would be paid twice.
        if (!IMAGE_NOT_DESCRIBED.test(parsed.text)) {
          return { text: parsed.text, from: "file", title, ...(saved ? { saved } : {}) };
        }
        const fromChunks = await storedChunkText(prisma, documentId);
        if (fromChunks.trim().length > 0) {
          return { text: fromChunks, from: "chunks", title, ...(saved ? { saved } : {}) };
        }
        return { text: parsed.text, from: "file", title, ...(saved ? { saved } : {}) };
      }
    }
  } catch {
    // The file is gone or unreadable: the stored chunks below are what is left.
  }
  return {
    text: await storedChunkText(prisma, documentId),
    from: "chunks",
    title,
    ...(saved ? { saved } : {}),
  };
}

/** The placeholder a re-parse without an image describer writes for each image. */
const IMAGE_NOT_DESCRIBED = /image not read: no vision-capable model is configured/;

/** The document's stored chunks (approved, else quarantined), overlap removed. */
async function storedChunkText(prisma: DocumentSourcePrisma, documentId: string): Promise<string> {
  const approved = await prisma.knowledgeChunk.findMany({
    where: { documentId },
    orderBy: { position: "asc" },
    select: { text: true },
  });
  const chunks =
    approved.length > 0
      ? approved
      : await prisma.quarantineChunk.findMany({
          where: { documentId, ord: { gte: 0 } },
          orderBy: { ord: "asc" },
          select: { text: true },
        });
  return joinChunksWithoutOverlap(chunks.map((c) => c.text));
}

/**
 * Whether a source goes through the document reader. A document always does.
 * Pasted text does when it is long and not one issue: the splitter reads an
 * issue's structure (#1036) and a short request well, and neither needs a
 * model to read it.
 */
export function shouldReadWithModel(source: { fromDocument: boolean; text: string }): boolean {
  if (source.fromDocument) return true;
  if (source.text.trim().length < READER_MIN_PASTED_CHARS) return false;
  return parseChangeRequest(source.text) === null;
}

function clipTitle(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 3)}...` : one;
}

/**
 * One change per requirement, constraint or business rule the reader found,
 * in document order. Background, examples, definitions and assumptions are
 * not changes. Each change's body carries its document context: the section
 * it sits in and the source's own words, which the code search reads with it.
 */
export function changesFromReading(reading: DocumentReading): ChangedRequirement[] {
  return reading.statements
    .filter((s) => REQUIREMENT_STATEMENT_KINDS.has(s.kind))
    .map((s) => {
      const where = formatHeadingPath(s.headingPath);
      const body = `${s.statement}\n\nSection: ${where}\n> ${s.quote}`;
      return {
        requirementId: null,
        title: clipTitle(s.statement),
        body,
        changeType: detectChangeType(`${s.statement} ${s.quote}`),
        bodyDelta: body.length,
      };
    });
}

/** The change kinds, in the order the notice names them, with their singular and plural. */
const CHANGE_KINDS: ReadonlyArray<[StatementKind, string, string]> = [
  ["requirement", "requirement", "requirements"],
  ["constraint", "constraint", "constraints"],
  ["business-rule", "business rule", "business rules"],
];

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Up to three headings, then how many more. */
function named(headings: readonly string[]): string {
  const shown = headings.slice(0, 3).map((h) => `"${h}"`);
  const more = headings.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function sourceName(fromDocument: boolean): string {
  return fromDocument ? "the document" : "the pasted text";
}

/**
 * The run summary's account of the reading: how many changes came from it and
 * from how many sections, which sections gave none, which could not be read,
 * and how many statements were dropped because their quote is not in the
 * source. Every section is accounted for; none is left out silently.
 */
export function documentReadingNotice(reading: DocumentReading, fromDocument: boolean): string {
  const kinds = new Map<StatementKind, number>();
  for (const s of reading.statements) {
    if (REQUIREMENT_STATEMENT_KINDS.has(s.kind)) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  }
  const changes = [...kinds.values()].reduce((a, b) => a + b, 0);
  const parts = CHANGE_KINDS.filter(([k]) => (kinds.get(k) ?? 0) > 0).map(([k, one, many]) =>
    counted(kinds.get(k)!, one, many),
  );
  const read = `The model read ${sourceName(fromDocument)} (${counted(reading.sections.length, "section", "sections")})`;
  const head =
    changes === 0
      ? `${read} and found no requirement, constraint or business rule in it, so nothing from it was analysed.`
      : `${read} and found ${parts.join(", ")}; each is analysed as one change.`;
  const sentences = [head];
  const unread = reading.sections.filter((s) => s.status === "unread");
  if (unread.length > 0) {
    sentences.push(
      `${counted(unread.length, "section", "sections")} could not be read, so nothing from ${unread.length === 1 ? "it" : "them"} was analysed: ${named(unread.map((s) => formatHeadingPath(s.headingPath)))}.`,
    );
  }
  const none = reading.sections.filter(
    (s) =>
      s.status === "read" && ![...REQUIREMENT_STATEMENT_KINDS].some((k) => (s.kinds[k] ?? 0) > 0),
  );
  if (changes > 0 && none.length > 0) {
    sentences.push(
      `${counted(none.length, "section", "sections")} held none: ${named(none.map((s) => formatHeadingPath(s.headingPath)))}.`,
    );
  }
  if (reading.droppedUnverified > 0) {
    sentences.push(
      `${counted(reading.droppedUnverified, "statement was", "statements were")} dropped because ${reading.droppedUnverified === 1 ? "its" : "their"} quote is not in ${sourceName(fromDocument)}.`,
    );
  }
  if (reading.reused) sentences.push(impactReusedReadingSentence(reading.reused));
  return sentences.join(" ");
}

/**
 * #2280 — the notice's sentence when the reading was reused: when and with
 * which model it was made, and how to get a fresh one.
 */
export function impactReusedReadingSentence(reused: { readAt: Date; model: string }): string {
  return `This reading was saved on ${reused.readAt.toISOString().slice(0, 10)} (read with ${reused.model}) and reused, because the document's file has not changed; re-run with "Read the document again" for a fresh reading.`;
}

/**
 * The run summary's sentence when the reader was asked to read a source and
 * could not: the splitter's changes are what the run analysed.
 */
export function readerFailedNotice(fromDocument: boolean): string {
  return `The model could not read ${sourceName(fromDocument)}, so its changes were split by paragraph and bullet instead: one requirement may appear as several changes, and a table as one.`;
}
