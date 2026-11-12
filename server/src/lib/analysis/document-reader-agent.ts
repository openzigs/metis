/**
 * #2230 — Requirements Analysis's document step through the document reader.
 *
 * With `ANALYSIS_DOCUMENT_READER` on, the document specialist no longer reads
 * the ten chunks retrieval picks (`orchestrator.ts` `retrieveContext`): each
 * selected document is loaded from storage, parsed as ingest parses it
 * (`parseDocument`), and read in full by `readDocument`. What it found becomes
 * the document agent's output, in the shape every later step already reads:
 *
 *   - `requirements` — one per requirement, constraint or business rule, in
 *     document order (`REQ-001`, ...), each carrying its document and chunk;
 *   - `findings` — one per requirement, citing the verified quote, so the
 *     synthesis step drafts from the source's words rather than a paraphrase;
 *   - `reading` — every statement with its label and source span, and the
 *     coverage report, persisted with the agent's row.
 *
 * Retrieval stays for the code agent and for every other specialist.
 *
 * #2280 — a document is read through `readDocumentOnce`: an unchanged file
 * already read by the same reader and model is not read again, and the
 * summary and coverage report say whose reading was reused. `reread` reads
 * every selected document afresh ("Read the documents again").
 *
 * Only documents of the analysis's own project are read (`projectId` and `id`
 * both filter the query), and only ones that are ready and not rejected: the
 * documents retrieval could serve today, through the approved index or its
 * quarantine fallback. A selected document that is not one of them, or that
 * cannot be loaded or read, is listed in the coverage report as unread with
 * the reason, never left out silently.
 *
 * #2262 — and only documents the requester may see: the document's ACL
 * (`Document.aclSubjects`, mirrored onto its chunks) is checked against the
 * requester (`isVisibleTo`), as #2225 did for retrieval. A document they may
 * not see reads as unavailable, with the same reason as one that is not
 * ready, so the report is no oracle for a restricted document's existence.
 */
import type {
  AgentFindingPayload,
  DocumentAgentOutput,
  DocumentReadingCoverage,
  DocumentReadingDocument,
  DocumentRequirement,
} from "@metis/shared";
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { CONNECTOR_CODE_SOURCES } from "../documents/document-source.js";
import { parseDocument } from "../documents/parsers.js";
import { getDocumentStorage, type StorageBackend } from "../documents/storage.js";
import {
  DocumentReaderError,
  addUsage,
  spentUsageOf,
  withSpentUsage,
  type DocumentReading,
} from "../document-reader/reader.js";
import { readDocumentOnce, type ReadingCacheDeps } from "../document-reader/reading-cache.js";
import { REQUIREMENT_STATEMENT_KINDS, type StatementKind } from "../document-reader/prompts.js";
import { formatHeadingPath } from "../document-reader/sections.js";
import { prisma } from "../prisma.js";
import { isVisibleTo, parseAclSubjects, type AclActor } from "../rag/acl.js";
import type { AgentRunResult } from "./agent-runner.js";
import type { SourceStatement } from "./requirements-extractor.js";

/** A selected document, parsed. `chunks` are its stored chunks, to cite by index. */
export interface ReaderDocument {
  documentId: string;
  filename: string;
  title: string;
  text: string;
  chunks: Array<{ index: number; text: string }>;
  /** #2280 — `Document.checksum`; absent, the reading is not saved. */
  checksum?: string;
}

export type ReaderDocumentLoad =
  | { ok: true; document: ReaderDocument }
  | {
      ok: false;
      documentId: string;
      filename: string;
      reason: string;
      /** #2262 — withheld by its ACL: never fall back to retrieving it instead. */
      withheld?: true;
    };

/** Loads the selected documents of a project the actor may see, in selection order. */
export type ReaderDocumentLoader = (
  projectId: string,
  documentIds: readonly string[],
  actor: AclActor,
) => Promise<ReaderDocumentLoad[]>;

/** One reason for not-ready, not-in-project and not-yours alike (#2262): no existence oracle. */
const NOT_AVAILABLE =
  "It is not available to read: still processing, failed, rejected or deleted, not in this project, or not shared with you.";

/**
 * The production loader: the project's ready documents the actor may see,
 * from storage, parsed as ingest parses them.
 */
export function createReaderDocumentLoader(
  storage: StorageBackend = getDocumentStorage(),
): ReaderDocumentLoader {
  return async (projectId, documentIds, actor) => {
    const rows = await prisma.document.findMany({
      where: {
        projectId,
        id: { in: [...documentIds] },
        deletedAt: null,
        status: "ready",
        indexState: { not: "rejected" },
      },
      select: {
        id: true,
        filename: true,
        title: true,
        mimeType: true,
        storagePath: true,
        aclSubjects: true,
        checksum: true,
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: ReaderDocumentLoad[] = [];
    for (const documentId of documentIds) {
      const row = byId.get(documentId);
      if (!row) {
        out.push({ ok: false, documentId, filename: documentId, reason: NOT_AVAILABLE });
        continue;
      }
      if (!isVisibleTo({ subjects: parseAclSubjects(row.aclSubjects) }, actor)) {
        out.push({
          ok: false,
          documentId,
          filename: documentId,
          reason: NOT_AVAILABLE,
          withheld: true,
        });
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = await storage.read(row.storagePath);
      } catch {
        out.push({
          ok: false,
          documentId,
          filename: row.filename,
          reason: "Its stored file could not be read.",
        });
        continue;
      }
      const parsed = await parseDocument({
        buffer,
        mimeType: row.mimeType,
        filename: row.filename,
      });
      if (!parsed.ok) {
        out.push({
          ok: false,
          documentId,
          filename: row.filename,
          reason: "Its file could not be converted to text.",
        });
        continue;
      }
      out.push({
        ok: true,
        document: {
          documentId,
          filename: row.filename,
          title: row.title ?? row.filename,
          text: parsed.text,
          chunks: await storedChunks(projectId, documentId),
          checksum: row.checksum,
        },
      });
    }
    return out;
  };
}

/** The document's stored chunks (approved, else quarantined), by position. */
async function storedChunks(
  projectId: string,
  documentId: string,
): Promise<Array<{ index: number; text: string }>> {
  const approved = await prisma.knowledgeChunk.findMany({
    where: { projectId, documentId },
    select: { position: true, text: true },
    orderBy: { position: "asc" },
  });
  if (approved.length > 0) return approved.map((c) => ({ index: c.position, text: c.text }));
  const quarantined = await prisma.quarantineChunk.findMany({
    where: { projectId, documentId, ord: { gte: 0 } },
    select: { ord: true, text: true },
    orderBy: { ord: "asc" },
  });
  return quarantined.map((c) => ({ index: c.ord, text: c.text }));
}

/**
 * #2262 — with no document selected, the reader reads at most this many: the
 * most recently uploaded. Reading every ready upload in full made one
 * unselected analysis cost as much as the project is long.
 */
export const READER_IMPLICIT_MAX_DOCUMENTS = 5;

export interface ImplicitReaderSelection {
  documentIds: string[];
  /** Readable documents past the bound, each unread with the reason. */
  leftOut: DocumentReadingDocument[];
  /** Ready documents the actor may not see: not listed, and never retrieved instead. */
  withheld: number;
}

/**
 * The documents read when none is selected: the ready, unrejected uploads
 * (not repository or database rows, as `defaultAnalysisDocumentIds`) the actor
 * may see, newest first, at most {@link READER_IMPLICIT_MAX_DOCUMENTS}. The
 * rest are named in the coverage report, never cut silently (#2233).
 */
export async function implicitReaderSelection(
  projectId: string,
  actor: AclActor,
): Promise<ImplicitReaderSelection> {
  const rows = await prisma.document.findMany({
    where: {
      projectId,
      deletedAt: null,
      status: "ready",
      indexState: { not: "rejected" },
      source: { notIn: [...CONNECTOR_CODE_SOURCES] },
    },
    select: { id: true, filename: true, aclSubjects: true },
    orderBy: [{ uploadedAt: "desc" }, { id: "asc" }],
  });
  const visible = rows.filter((r) =>
    isVisibleTo({ subjects: parseAclSubjects(r.aclSubjects) }, actor),
  );
  const reason = `Not read: with no document selected, the analysis reads the ${READER_IMPLICIT_MAX_DOCUMENTS} most recently uploaded. Select it to have it read.`;
  return {
    documentIds: visible.slice(0, READER_IMPLICIT_MAX_DOCUMENTS).map((r) => r.id),
    leftOut: visible
      .slice(READER_IMPLICIT_MAX_DOCUMENTS)
      .map((r) => unreadDocument(r.id, r.filename, reason)),
    withheld: rows.length - visible.length,
  };
}

function unreadDocument(
  documentId: string,
  filename: string,
  reason: string,
): DocumentReadingDocument {
  return {
    documentId,
    filename,
    status: "unread",
    reason,
    sections: [],
    statements: 0,
    requirements: 0,
    droppedUnverified: 0,
  };
}

/**
 * `at` → the stored chunk whose text covers it. Each chunk is found in the
 * parsed text in order; a chunk that is not there (stored under other chunker
 * settings, say) covers nothing, and a statement no chunk covers is cited by
 * its quote alone.
 */
export function chunkIndexer(
  text: string,
  chunks: ReadonlyArray<{ index: number; text: string }>,
): (at: number) => number | undefined {
  const spans: Array<{ index: number; start: number; end: number }> = [];
  let from = 0;
  for (const c of chunks) {
    if (!c.text) continue;
    const at = text.indexOf(c.text, from);
    if (at === -1) continue;
    spans.push({ index: c.index, start: at, end: at + c.text.length });
    from = at + 1;
  }
  return (at) => spans.find((s) => at >= s.start && at < s.end)?.index;
}

const KIND_LABEL: Record<StatementKind, string> = {
  requirement: "Requirement",
  constraint: "Constraint",
  "business-rule": "Business rule",
  assumption: "Assumption",
  definition: "Definition",
  background: "Background",
  example: "Example",
};

const MAX_TITLE = 255;
const MAX_BODY = 4096;
const MAX_SNIPPET = 2048;
const MAX_REQUIREMENT_TEXT = 2048;
const MAX_SUMMARY = 2048;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function coverageOf(
  document: Pick<ReaderDocument, "documentId" | "filename">,
  reading: DocumentReading,
): DocumentReadingDocument {
  return {
    documentId: document.documentId,
    filename: document.filename,
    status: "read",
    mode: reading.mode,
    sections: reading.sections.map((s) => ({
      heading: formatHeadingPath(s.headingPath),
      status: s.status,
      statements: s.statements,
      kinds: { ...s.kinds },
    })),
    statements: reading.statements.length,
    requirements: reading.statements.filter((s) => REQUIREMENT_STATEMENT_KINDS.has(s.kind)).length,
    droppedUnverified: reading.droppedUnverified,
    merge: reading.merge,
    outputTokenCap: reading.outputTokenCap,
    ...(reading.reused
      ? { reused: { readAt: reading.reused.readAt.toISOString(), model: reading.reused.model } }
      : {}),
  };
}

/** #2280 — the summary's sentence about the readings reused instead of read again. */
export function reusedReadingsSentence(
  reused: ReadonlyArray<{ filename: string; readAt: Date; model: string }>,
): string {
  if (reused.length === 0) return "";
  const each = reused
    .slice(0, 3)
    .map((r) => `"${r.filename}" (read ${r.readAt.toISOString().slice(0, 10)} with ${r.model})`);
  const more = reused.length > 3 ? ` and ${reused.length - 3} more` : "";
  const one = reused.length === 1;
  return (
    ` The saved reading of ${each.join(", ")}${more} was reused: ${one ? "that document was" : "those documents were"} not read again, ` +
    `as ${one ? "its file has" : "their files have"} not changed. Start the analysis with "Read the documents again" for a fresh reading.`
  );
}

export interface DocumentReaderAgentResult {
  result: AgentRunResult;
  coverage: DocumentReadingCoverage;
}

/**
 * Read the selected documents (with none selected, the bounded
 * {@link implicitReaderSelection}) the actor may see, and build the document
 * agent's result. `null` when none could be loaded and none was withheld by
 * its ACL: the caller then retrieves, as today. A withheld document never
 * sends the caller to retrieval, which would read it unchecked.
 *
 * A provider error or a cancellation throws, as the agent call it replaces
 * did, carrying every token spent before it ({@link spentUsageOf}).
 */
export async function runDocumentReaderAgent(input: {
  provider: AIProvider;
  projectId: string;
  documentIds: readonly string[];
  /** #2262 — the requester, whose ACL decides which documents are read. */
  actor: AclActor;
  /** #2262 (#1237) — the operator's notes, given to every reading call. */
  operatorNotes?: string;
  model?: string;
  signal?: AbortSignal;
  load?: ReaderDocumentLoader;
  /** #2280 — read every document again instead of reusing a saved reading. */
  reread?: boolean;
  /** #2280 — test seam for the saved-reading store and the reader. */
  cache?: ReadingCacheDeps;
}): Promise<DocumentReaderAgentResult | null> {
  const started = Date.now();
  const selection: ImplicitReaderSelection =
    input.documentIds.length > 0
      ? { documentIds: [...input.documentIds], leftOut: [], withheld: 0 }
      : await implicitReaderSelection(input.projectId, input.actor);
  const loads =
    selection.documentIds.length > 0
      ? await (input.load ?? createReaderDocumentLoader())(
          input.projectId,
          selection.documentIds,
          input.actor,
        )
      : [];
  const withheld = selection.withheld + loads.filter((l) => !l.ok && l.withheld).length;
  if (!loads.some((l) => l.ok) && withheld === 0) return null;

  const coverage: DocumentReadingDocument[] = [];
  const requirements: DocumentRequirement[] = [];
  const findings: AgentFindingPayload[] = [];
  const readings: Array<{ documentId: string; reading: DocumentReading }> = [];
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastError: DocumentReaderError | null = null;
  const reused: Array<{ filename: string; readAt: Date; model: string }> = [];

  for (const load of loads) {
    if (!load.ok) {
      coverage.push(unreadDocument(load.documentId, load.filename, load.reason));
      continue;
    }
    const doc = load.document;
    let reading: DocumentReading;
    try {
      reading = await readDocumentOnce(
        {
          title: doc.title,
          text: doc.text,
          provider: input.provider,
          // The notes are part of the saved reading's key (`readingTextHash`).
          ...(input.operatorNotes ? { operatorNotes: input.operatorNotes } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          // The loader read only this project's documents, so the reading is saved under it.
          document: doc.checksum
            ? { projectId: input.projectId, documentId: doc.documentId, checksum: doc.checksum }
            : null,
          ...(input.reread ? { reread: true } : {}),
        },
        input.cache,
      );
    } catch (err) {
      // #2262 — what this document's read spent counts, whether it fails the agent or not.
      const spent = spentUsageOf(err);
      if (spent) usage = addUsage(usage, spent);
      if (!(err instanceof DocumentReaderError)) throw withSpentUsage(err, usage);
      lastError = err;
      coverage.push(unreadDocument(doc.documentId, doc.filename, err.message));
      continue;
    }
    usage = addUsage(usage, reading.usage);
    readings.push({ documentId: doc.documentId, reading });
    if (reading.reused) reused.push({ filename: doc.filename, ...reading.reused });
    coverage.push(coverageOf(doc, reading));

    const chunkAt = chunkIndexer(doc.text, doc.chunks);
    for (const s of reading.statements) {
      if (!REQUIREMENT_STATEMENT_KINDS.has(s.kind)) continue;
      const id = `REQ-${String(requirements.length + 1).padStart(3, "0")}`;
      const chunkIndex = chunkAt(s.start);
      const where = `${doc.filename} › ${formatHeadingPath(s.headingPath)}`;
      requirements.push({
        id,
        text: clip(s.statement, MAX_REQUIREMENT_TEXT),
        source: {
          documentId: doc.documentId,
          ...(chunkIndex !== undefined ? { chunkIndex } : {}),
          // #2235 — the verified paragraph, so its questions can quote it.
          filename: clip(doc.filename, 512),
          headingPath: s.headingPath.slice(0, 16).map((h) => clip(h, 512)),
          quote: clip(s.quote, MAX_SNIPPET),
        },
      });
      findings.push({
        category: "other",
        severity: "info",
        title: clip(`${KIND_LABEL[s.kind]}: ${s.statement}`, MAX_TITLE),
        body: clip(`${s.statement}\n\nSource: ${where}\n> ${s.quote}`, MAX_BODY),
        citations:
          chunkIndex !== undefined
            ? [
                {
                  documentId: doc.documentId,
                  chunkIndex,
                  filename: doc.filename,
                  snippet: clip(s.quote, MAX_SNIPPET),
                },
              ]
            : [],
        tags: ["document-reader", s.kind],
        requirementId: id,
      });
    }
  }

  // Every loaded document failed to read: the agent fails, as an unreadable reply did before.
  if (readings.length === 0 && lastError) throw withSpentUsage(lastError, usage);
  coverage.push(...selection.leftOut);

  const read = coverage.filter((d) => d.status === "read");
  const sections = read.reduce((n, d) => n + d.sections.length, 0);
  const unread = coverage.length - read.length;
  const summary = clip(
    `Read ${read.length} of ${coverage.length} selected document${coverage.length === 1 ? "" : "s"} in full ` +
      `(${sections} section${sections === 1 ? "" : "s"}): ${requirements.length} statement${requirements.length === 1 ? "" : "s"} to analyse, each with its source.` +
      (unread > 0 ? ` ${unread} could not be read; the coverage report says why.` : "") +
      reusedReadingsSentence(reused),
    MAX_SUMMARY,
  );

  const output: DocumentAgentOutput & {
    reading: unknown;
    documentReading: DocumentReadingCoverage;
  } = {
    agentKey: "document",
    summary,
    findings,
    notes: [],
    requirements,
    documentReading: { documents: coverage },
    reading: readings.map(({ documentId, reading }) => ({
      documentId,
      mode: reading.mode,
      merge: reading.merge,
      calls: reading.calls,
      statements: reading.statements,
    })),
  };
  return {
    result: { agentKey: "document", output, usage, durationMs: Date.now() - started },
    coverage: { documents: coverage },
  };
}

/**
 * A requirement of the document agent's output. #2235 — `source` is set when
 * the document reader (#2230) read it: the verified paragraph it came from.
 */
export interface ExtractedRequirement {
  id: string;
  text: string;
  source?: Omit<SourceStatement, "statement">;
}

/**
 * #2235 — the reader's paragraph on a stored requirement, or undefined when
 * the requirement carries none (the retrieval path, or output from before
 * #2235). Read defensively: the row is JSON a model helped write.
 */
export function readerSourceOf(
  ref: string,
  raw: unknown,
): ExtractedRequirement["source"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.quote !== "string" || r.quote.trim().length === 0) return undefined;
  return {
    ref,
    ...(typeof r.documentId === "string" ? { documentId: r.documentId } : {}),
    ...(typeof r.filename === "string" ? { filename: r.filename } : {}),
    headingPath: Array.isArray(r.headingPath)
      ? r.headingPath.filter((h): h is string => typeof h === "string")
      : [],
    quote: r.quote,
  };
}
