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
 * Only documents of the analysis's own project are read (`projectId` and `id`
 * both filter the query), and only ones that are ready and not rejected: the
 * documents retrieval could serve today, through the approved index or its
 * quarantine fallback. A selected document that is not one of them, or that
 * cannot be loaded or read, is listed in the coverage report as unread with
 * the reason, never left out silently.
 */
import type {
  AgentFindingPayload,
  DocumentAgentOutput,
  DocumentReadingCoverage,
  DocumentReadingDocument,
  DocumentRequirement,
} from "@metis/shared";
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { parseDocument } from "../documents/parsers.js";
import { getDocumentStorage, type StorageBackend } from "../documents/storage.js";
import {
  DocumentReaderError,
  readDocument,
  type DocumentReading,
} from "../document-reader/reader.js";
import { REQUIREMENT_STATEMENT_KINDS, type StatementKind } from "../document-reader/prompts.js";
import { formatHeadingPath } from "../document-reader/sections.js";
import { prisma } from "../prisma.js";
import type { AgentRunResult } from "./agent-runner.js";
import type { SourceStatement } from "./requirements-extractor.js";

/** A selected document, parsed. `chunks` are its stored chunks, to cite by index. */
export interface ReaderDocument {
  documentId: string;
  filename: string;
  title: string;
  text: string;
  chunks: Array<{ index: number; text: string }>;
}

export type ReaderDocumentLoad =
  | { ok: true; document: ReaderDocument }
  | { ok: false; documentId: string; filename: string; reason: string };

/** Loads the selected documents of a project, in selection order. */
export type ReaderDocumentLoader = (
  projectId: string,
  documentIds: readonly string[],
) => Promise<ReaderDocumentLoad[]>;

const NOT_READY =
  "It is not ready to read (still processing, failed, rejected or deleted), or is not in this project.";

/** The production loader: the project's ready documents, from storage, parsed as ingest parses them. */
export function createReaderDocumentLoader(
  storage: StorageBackend = getDocumentStorage(),
): ReaderDocumentLoader {
  return async (projectId, documentIds) => {
    const rows = await prisma.document.findMany({
      where: {
        projectId,
        id: { in: [...documentIds] },
        deletedAt: null,
        status: "ready",
        indexState: { not: "rejected" },
      },
      select: { id: true, filename: true, title: true, mimeType: true, storagePath: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: ReaderDocumentLoad[] = [];
    for (const documentId of documentIds) {
      const row = byId.get(documentId);
      if (!row) {
        out.push({ ok: false, documentId, filename: documentId, reason: NOT_READY });
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
  };
}

export interface DocumentReaderAgentResult {
  result: AgentRunResult;
  coverage: DocumentReadingCoverage;
}

/**
 * Read the selected documents and build the document agent's result, or
 * `null` when none could be loaded (the caller then retrieves, as today).
 * A provider error or a cancellation throws, as the agent call it replaces did.
 */
export async function runDocumentReaderAgent(input: {
  provider: AIProvider;
  projectId: string;
  documentIds: readonly string[];
  model?: string;
  signal?: AbortSignal;
  load?: ReaderDocumentLoader;
}): Promise<DocumentReaderAgentResult | null> {
  const started = Date.now();
  const loads = await (input.load ?? createReaderDocumentLoader())(
    input.projectId,
    input.documentIds,
  );
  if (!loads.some((l) => l.ok)) return null;

  const coverage: DocumentReadingDocument[] = [];
  const requirements: DocumentRequirement[] = [];
  const findings: AgentFindingPayload[] = [];
  const readings: Array<{ documentId: string; reading: DocumentReading }> = [];
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastError: DocumentReaderError | null = null;

  for (const load of loads) {
    if (!load.ok) {
      coverage.push({
        documentId: load.documentId,
        filename: load.filename,
        status: "unread",
        reason: load.reason,
        sections: [],
        statements: 0,
        requirements: 0,
        droppedUnverified: 0,
      });
      continue;
    }
    const doc = load.document;
    let reading: DocumentReading;
    try {
      reading = await readDocument({
        title: doc.title,
        text: doc.text,
        provider: input.provider,
        ...(input.model ? { model: input.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (err) {
      if (!(err instanceof DocumentReaderError)) throw err;
      lastError = err;
      coverage.push({
        documentId: doc.documentId,
        filename: doc.filename,
        status: "unread",
        reason: err.message,
        sections: [],
        statements: 0,
        requirements: 0,
        droppedUnverified: 0,
      });
      continue;
    }
    usage = {
      promptTokens: usage.promptTokens + reading.usage.promptTokens,
      completionTokens: usage.completionTokens + reading.usage.completionTokens,
      totalTokens: usage.totalTokens + reading.usage.totalTokens,
      cacheReadTokens: (usage.cacheReadTokens ?? 0) + (reading.usage.cacheReadTokens ?? 0),
      cacheWriteTokens: (usage.cacheWriteTokens ?? 0) + (reading.usage.cacheWriteTokens ?? 0),
    };
    readings.push({ documentId: doc.documentId, reading });
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
          filename: doc.filename,
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
  if (readings.length === 0 && lastError) throw lastError;

  const read = coverage.filter((d) => d.status === "read");
  const sections = read.reduce((n, d) => n + d.sections.length, 0);
  const unread = coverage.length - read.length;
  const summary = clip(
    `Read ${read.length} of ${coverage.length} selected document${coverage.length === 1 ? "" : "s"} in full ` +
      `(${sections} section${sections === 1 ? "" : "s"}): ${requirements.length} requirement${requirements.length === 1 ? "" : "s"}, ` +
      `constraint${requirements.length === 1 ? "" : "s"} and business rule${requirements.length === 1 ? "" : "s"}, each with its source.` +
      (unread > 0 ? ` ${unread} could not be read; the coverage report says why.` : ""),
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
