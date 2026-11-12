/**
 * Issue #2236 — a clarification answer indexed in the project's RAG store, so
 * chat and later analyses retrieve and cite it like any other project
 * document.
 *
 * Each record is written as one small Markdown document (`documents` row,
 * source `upload`, uploaded by the person who answered) and queued for ingest
 * like an uploaded text: the same chunking, quarantine policy, ACL and
 * retrieval as the rest of the project's knowledge. When the answer changes,
 * the earlier document is deleted and the new one indexed, so a superseded
 * answer is never cited; when it is reopened (its paragraph changed), the
 * document is withdrawn ({@link withdrawClarification}).
 *
 * The answer and the quoted paragraph are user- and document-authored text.
 * They are written as text, never executed or interpolated into a query, and
 * every prompt that later reads a retrieved chunk carries it as data (the
 * retrieved-context fences); here the Markdown is only neutralised so an
 * answer cannot open a code fence or an HTML comment in the rendered document.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getDocumentStorage } from "../documents/storage.js";
import type { StorageBackend } from "../documents/storage-backend.js";
import { getIngestQueue } from "../rag/ingest-queue.js";
import { getKnowledgeService } from "../rag/knowledge-service.js";
import {
  setClarificationKnowledgeDocument,
  type StoredClarification,
} from "./clarification-records.js";

const log = createChildLogger("clarification-knowledge");

/** The longest question a document title carries. */
const TITLE_QUESTION_CHARS = 120;

/** Text as one Markdown-inert line: no fences, tags or comments, whitespace collapsed. */
export function inertLine(text: string): string {
  return text.replace(/`/g, "'").replace(/</g, "&lt;").replace(/\s+/g, " ").trim();
}

/** The filename a record's document is stored under. */
export function clarificationFilename(recordId: string): string {
  return `clarification-${recordId}.md`;
}

/** The document title a record is listed and cited by. */
export function clarificationTitle(record: Pick<StoredClarification, "question">): string {
  const q = inertLine(record.question);
  return `Clarification: ${q.length > TITLE_QUESTION_CHARS ? `${q.slice(0, TITLE_QUESTION_CHARS)}…` : q}`;
}

/** The Markdown a record is indexed as. */
export function renderClarificationDocument(record: StoredClarification): string {
  const where = record.source
    ? [record.source.filename ?? "", ...record.source.headingPath]
        .filter((p) => p.length > 0)
        .map(inertLine)
    : [];
  const origin =
    record.origin === "spec-kit"
      ? `Spec Kit /clarify${record.specKitFeature ? ` (feature ${inertLine(record.specKitFeature)})` : ""}`
      : `requirements analysis ${record.analysisId ?? ""}`.trim();
  return [
    `# ${clarificationTitle(record)}`,
    "",
    "A clarifying question METIS asked about this project, and the answer the analyst gave.",
    "",
    `- Answered: ${record.answeredAt.toISOString().slice(0, 10)}`,
    `- Asked in: ${origin}`,
    ...(record.requirementIds.length > 0
      ? [`- Applies to requirements: ${record.requirementIds.map(inertLine).join(", ")}`]
      : []),
    ...(where.length > 0 ? [`- Source: ${where.join(" › ")}`] : []),
    "",
    `**Question:** ${inertLine(record.question)}`,
    "",
    `**Answer:** ${inertLine(record.answer)}`,
    ...(record.source ? ["", `**Source paragraph:** ${inertLine(record.source.quote)}`] : []),
    "",
  ].join("\n");
}

export interface ClarificationIndexDeps {
  storage?: Pick<StorageBackend, "write">;
  /** Queue the document for ingest. Default: the ingest queue. */
  enqueue?: (documentId: string) => Promise<void>;
  /** Delete the superseded document. Default: the knowledge service. */
  deleteDocument?: (documentId: string) => Promise<void>;
}

/**
 * Index `record` as a project document, replacing the one it was indexed as
 * before. Returns the new document's id, or null when it could not be indexed:
 * no one to attribute it to (a record with no `answeredById`), or the write
 * failed. Never throws: the record is stored either way, and a failed index
 * is logged.
 */
export async function indexClarification(
  record: StoredClarification,
  deps: ClarificationIndexDeps = {},
): Promise<string | null> {
  if (!record.answeredById) {
    log.info("clarification not indexed: no user to attribute it to", { recordId: record.id });
    return null;
  }
  const deleteDocument =
    deps.deleteDocument ?? ((id: string) => getKnowledgeService().deleteDocument(id));
  try {
    if (record.knowledgeDocumentId) {
      await deleteDocument(record.knowledgeDocumentId);
    }
    const storage = deps.storage ?? getDocumentStorage();
    const stored = await storage.write({
      projectId: record.projectId,
      buffer: Buffer.from(renderClarificationDocument(record), "utf8"),
    });
    // The document quotes the source paragraph, so it carries the source's
    // ACL: a restricted source must not be republished as an unrestricted chunk.
    const sourceAcl = record.source?.documentId
      ? await prisma.document.findFirst({
          where: { id: record.source.documentId, projectId: record.projectId },
          select: { aclSubjects: true },
        })
      : null;
    const document = await prisma.document.create({
      data: {
        projectId: record.projectId,
        ...(sourceAcl ? { aclSubjects: sourceAcl.aclSubjects } : {}),
        filename: clarificationFilename(record.id),
        title: clarificationTitle(record),
        mimeType: "text/markdown",
        sizeBytes: stored.sizeBytes,
        storagePath: stored.storagePath,
        checksum: stored.checksum,
        uploadedById: record.answeredById,
        status: "pending",
      },
    });
    await setClarificationKnowledgeDocument(record.projectId, record.id, document.id);
    const enqueue =
      deps.enqueue ?? ((id: string) => getIngestQueue().enqueue(id, { priority: "manual" }));
    await enqueue(document.id);
    return document.id;
  } catch (err) {
    log.warn("clarification could not be indexed", {
      recordId: record.id,
      projectId: record.projectId,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Withdraw a reopened record's document from the project's knowledge: its
 * paragraph changed, so the answer no longer stands and must not be retrieved
 * or cited. The record keeps its answer (shown as reopened); it is indexed
 * again only when the question is answered again. Never throws: a failed
 * withdrawal is logged, and the link kept so a later index replaces it.
 */
export async function withdrawClarification(
  record: Pick<StoredClarification, "id" | "projectId" | "knowledgeDocumentId">,
  deps: Pick<ClarificationIndexDeps, "deleteDocument"> = {},
): Promise<boolean> {
  if (!record.knowledgeDocumentId) return false;
  const deleteDocument =
    deps.deleteDocument ?? ((id: string) => getKnowledgeService().deleteDocument(id));
  try {
    await deleteDocument(record.knowledgeDocumentId);
    await setClarificationKnowledgeDocument(record.projectId, record.id, null);
    return true;
  } catch (err) {
    log.warn("a reopened clarification's document could not be withdrawn", {
      recordId: record.id,
      projectId: record.projectId,
      error: (err as Error).message,
    });
    return false;
  }
}
