/**
 * Epic #157 — Document ingest quarantine (issue #106).
 *
 * Splits the existing ingest pipeline so chunks computed during ingestion are
 * parked in the `QuarantineChunk` table instead of going straight to the live
 * vector store. An operator (or the auto-approve flag) graduates the document
 * by calling `approveDocument`, which moves the embedded chunks into LanceDB +
 * `KnowledgeChunk` and flips the document's `indexState` to `indexed`.
 *
 * State machine on `Document.indexState`:
 *   pending      — freshly created (pre-ingest).
 *   quarantined  — chunks computed + embedded, parked in QuarantineChunk.
 *   reconciling  — SQL winner selected; external cleanup pending (not approvable).
 *   indexed      — chunks live and external cleanup completed.
 *   rejected     — operator declined; no chunks anywhere.
 *
 * Auto-approve precedence (most-specific wins):
 *   1. `Document.autoApproveTrusted = true`
 *   2. `Project.autoApproveTrustedSources = true`
 *
 * The `KnowledgeService.ingestDocument` integration delegates to this module
 * when an `IngestPlan` opts into quarantine mode.
 */
import { randomUUID } from "node:crypto";
import { parseAclSubjects, serializeAclSubjects } from "./acl.js";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { getKnowledgeService } from "./knowledge-service.js";
import { getVectorStore, type VectorRow } from "./vector-store.js";
import { getBM25Index } from "./bm25-index.js";
import {
  assertApprovalGeneration,
  withVectorSql,
  type ProjectWriteCapability,
  type ProjectVectorWrite,
} from "./project-vector-write.js";
import type { AclSubject } from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { resolveEvidencePolicy } from "../docs-gen/evidence-policy.js";
import { publicIndexingErrorMessage } from "./indexing-failure-message.js";

const log = createChildLogger("rag-quarantine");

export interface QuarantineWriteInput {
  documentId: string;
  projectId: string;
  filename: string;
  chunks: {
    ord: number;
    text: string;
    md5: string;
    embedding: number[];
    headings?: string[];
    metadata?: Record<string, unknown>;
  }[];
  embeddingModel: string;
  /**
   * Issue #1182 — the chunker generation that produced these boundaries
   * (`doc:v2:2048/256` — producer, version, effective parameters; the caller passes
   * `chunkerIdentity(...)`). Carried in the quarantine row's JSON metadata alongside
   * `embeddingModel`, so no `QuarantineChunk` schema change is needed; the value
   * is captured HERE, at chunk time, rather than recomputed at approve time,
   * because a document can sit in quarantine across a configuration change and
   * the tag must describe the cut that actually happened.
   *
   * Optional so a caller that predates the tag still writes a truthful row: an
   * absent value stays absent all the way to `KnowledgeChunk.chunkerIdentity`,
   * where NULL means "pre-#1182 generation".
   */
  chunkerIdentity?: string;
  /** Immutable generated revisions must never reset a completed approval. */
  onlyIfUnpublished?: boolean;
  /** Durable ordinary-ingest fence, registered before parsing/embedding. */
  ingestGeneration?: string;
  aclSubjects: AclSubject[];
}

export interface ApprovalActor {
  id: string;
  role?: string;
}

/** Optional dependency overrides — primarily for tests so they can swap in
 * the same `LocalVectorStore` instance the parent service uses. */
export interface ApprovalDeps {
  signal?: AbortSignal;
  vectorStore?: ProjectWriteCapability & {
    ensureTable: (projectId: string) => Promise<unknown>;
    deleteByDocument: (projectId: string, documentId: string) => Promise<unknown>;
    deleteByChunkIds: (projectId: string, chunkIds: string[]) => Promise<unknown>;
    upsert: (projectId: string, rows: VectorRow[]) => Promise<unknown>;
  };
  bm25?: {
    removeDocument: (projectId: string, documentId: string) => Promise<unknown>;
    removeChunkIds: (projectId: string, documentId: string, chunkIds: string[]) => Promise<unknown>;
    removeUnselectedChunks: (
      projectId: string,
      documentId: string,
      selected: Set<string>,
    ) => Promise<unknown>;
    documentChunkIds: (projectId: string, documentId: string) => Promise<string[]>;
    upsertDocumentChunks: (
      projectId: string,
      documentId: string,
      filename: string,
      chunks: { id: string; position: number; text: string }[],
      replace?: boolean,
    ) => Promise<unknown>;
  };
}

/**
 * Persist the chunks in `quarantine_chunks` and flip the document to
 * `quarantined`. Idempotent — a re-ingest first deletes any prior rows for the
 * document.
 */
export async function writeQuarantine(input: QuarantineWriteInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (input.ingestGeneration) {
      // Lock order is always document, then journal (including generation CAS).
      await tx.document.updateMany({
        where: { id: input.documentId },
        data: { id: input.documentId },
      });
      const generation = await tx.quarantineChunk.updateMany({
        where: { id: input.ingestGeneration, documentId: input.documentId, ord: -4 },
        data: { ord: -4 },
      });
      if (!generation.count)
        throw new Error(`Document ${input.documentId} ingest generation revoked`);
    }
    const held = await tx.document.updateMany({
      where: {
        id: input.documentId,
        deletedAt: null,
        ...(input.onlyIfUnpublished ? { indexState: { in: ["pending", "quarantined"] } } : {}),
      },
      data: { indexState: "quarantined" },
    });
    if (!held.count) return;
    // Replacing source rows starts a new ingest generation. The document write
    // serializes this revocation with attempt registration and winner selection.
    await tx.quarantineChunk.updateMany({
      where: { documentId: input.documentId, ord: { in: [-2, -3] } },
      data: { ord: -1 },
    });
    await tx.quarantineChunk.deleteMany({
      where: { documentId: input.documentId, ord: { gte: 0 } },
    });
    if (input.chunks.length > 0) {
      await tx.quarantineChunk.createMany({
        data: input.chunks.map((c) => ({
          documentId: input.documentId,
          projectId: input.projectId,
          ord: c.ord,
          text: c.text,
          embedding: JSON.stringify(c.embedding),
          metadata: JSON.stringify({
            md5: c.md5,
            embeddingModel: input.embeddingModel,
            // #1182 — omitted entirely when absent, so `approveDocument` writes NULL
            // rather than a string that would claim a generation nobody measured.
            ...(input.chunkerIdentity !== undefined
              ? { chunkerIdentity: input.chunkerIdentity }
              : {}),
            filename: input.filename,
            headings: c.headings ?? [],
            aclSubjects: input.aclSubjects,
            ...(c.metadata ?? {}),
          }),
        })),
      });
    }
    await tx.document.update({
      where: { id: input.documentId },
      data: {
        indexState: "quarantined",
        chunkCount: input.chunks.length,
        processedAt: new Date(),
        errorMessage: null,
        aclSubjects: serializeAclSubjects(input.aclSubjects),
      },
    });
  });
  log.info("quarantined document", {
    documentId: input.documentId,
    projectId: input.projectId,
    chunkCount: input.chunks.length,
  });
}

/** Should a freshly-ingested document skip quarantine and index immediately? */
export async function shouldAutoApprove(documentId: string): Promise<boolean> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: { autoApproveTrusted: true, projectId: true },
  });
  if (!doc) return false;
  if (doc.autoApproveTrusted) return true;
  const project = await prisma.project.findFirst({
    where: { id: doc.projectId },
    select: { autoApproveTrustedSources: true },
  });
  return Boolean(project?.autoApproveTrustedSources);
}

/**
 * Move a document from quarantine to indexed. Pulls quarantined chunks, hands
 * them to the vector store + KnowledgeChunk + BM25, then deletes the quarantine
 * rows. Audit-logged.
 */
export async function approveDocument(
  documentId: string,
  actor: ApprovalActor,
  deps: ApprovalDeps = {},
): Promise<{ chunkCount: number }> {
  const current = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null } });
  if (current?.indexState === "indexed" || current?.indexState === "reconciling") {
    await reconcileApprovalAttempts(documentId, current.projectId, deps);
    return { chunkCount: current.chunkCount };
  }
  const doc = await readApprovableDocument(documentId);
  const docAcl = parseAclSubjects(doc.aclSubjects);
  const aclJson = serializeAclSubjects(docAcl);

  const vectorStore = deps.vectorStore ?? getVectorStore();
  const bm25 = deps.bm25 ?? getBM25Index();
  deps.signal?.throwIfAborted();
  await vectorStore.ensureTable(doc.projectId);
  // Unique attempt IDs, including across processes and retries of one revision.
  // Journal under a SQL row lock; final CAS selects one attempt atomically. External
  // writes are additive and compensation always addresses immutable chunk IDs.
  const attemptId = randomUUID();
  let attemptChunkIds: string[] = [];
  const created: { id: string; vector: number[]; text: string; position: number }[] = [];
  const sqlRows: (Parameters<typeof prisma.knowledgeChunk.create>[0]["data"] & {
    embeddingModel: string;
  })[] = [];
  let committed = false;
  try {
    const rows = await prisma.$transaction(async (tx) => {
      deps.signal?.throwIfAborted();
      await fenceGeneratedApproval(tx, documentId, doc.projectId);
      const held = await tx.document.updateMany({
        where: { id: documentId, deletedAt: null, indexState: { in: ["pending", "quarantined"] } },
        data: { indexState: doc.indexState },
      });
      if (!held.count) throw new Error(`Document ${documentId} no longer approvable`);
      // Read source rows under the same lock as journal registration. A worker
      // cannot register old chunks after a reingest has replaced the generation.
      const source = await tx.quarantineChunk.findMany({
        where: { documentId, ord: { gte: 0 } },
        orderBy: { ord: "asc" },
      });
      attemptChunkIds = source.map((_, index) => `${attemptId}:${index}`);
      // Negative ord rows are durable attempt records, never source chunks. Do
      // not delete another attempt's tombstone: that worker may still be in an
      // external write when recovery runs. Keeping it makes later replay safe even
      // if that worker crashes immediately after the write.
      await tx.quarantineChunk.createMany({
        data: [
          {
            id: attemptId,
            documentId,
            projectId: doc.projectId,
            ord: -2,
            text: "",
            embedding: "[]",
            metadata: JSON.stringify({ approvalChunkIds: attemptChunkIds }),
          },
        ],
      });
      return source;
    });
    for (const [index, r] of rows.entries()) {
      const meta = safeParseJson(r.metadata) as {
        md5?: string;
        embeddingModel?: string;
        chunkerIdentity?: string;
        headings?: string[];
        [key: string]: unknown;
      } | null;
      const md5 = meta?.md5 ?? "";
      const embeddingModel = meta?.embeddingModel ?? "metis-offline-hash-v1";
      // #1182 — NULL, not a fabricated default. A quarantine row written before the
      // tag existed genuinely does not know its chunker generation, and the whole
      // point of the column is that unrecorded provenance is COUNTED AS OUTSTANDING
      // instead of being laundered into a value that would report a clean store.
      const chunkerIdentity = meta?.chunkerIdentity ?? null;
      const data = {
        id: attemptChunkIds[index],
        projectId: doc.projectId,
        documentId,
        position: r.ord,
        text: r.text,
        md5,
        embeddingModel,
        chunkerIdentity,
        metadata: JSON.stringify({ ...(meta ?? {}), headings: meta?.headings ?? [] }),
        aclSubjects: aclJson,
        vectorRef: attemptChunkIds[index],
      };
      sqlRows.push(data);
      const vector = safeParseJson(r.embedding);
      if (Array.isArray(vector)) {
        created.push({
          id: data.id,
          vector: vector as number[],
          text: r.text,
          position: r.ord,
        });
      }
    }

    if (created.length !== sqlRows.length) {
      throw new Error("Quarantine embedding missing; re-ingest before approval");
    }
    const vectorRows: VectorRow[] = created.map((c, index) => ({
      id: c.id,
      vector: c.vector,
      metadata: {
        chunkId: c.id,
        documentId,
        filename: doc.filename,
        position: c.position,
        text: c.text,
        ...(metaVectorMetadata(rows, c.position) ?? {}),
        embeddingModel: sqlRows[index].embeddingModel,
      },
    }));
    assertApprovalGeneration(null, vectorRows);
    deps.signal?.throwIfAborted();
    if (created.length > 0) {
      await vectorStore.upsert(doc.projectId, vectorRows);
    }

    // Includes the empty replacement: old sparse entries must not survive it.
    // Keep quarantine until ALL stores succeed, so failures are retryable after
    // restart as well as against an already-warm sparse index.
    deps.signal?.throwIfAborted();
    await bm25.upsertDocumentChunks(
      doc.projectId,
      documentId,
      doc.filename,
      created.map((c) => ({ id: c.id, position: c.position, text: c.text })),
      false,
    );

    const selectWinner = (write: Pick<ProjectVectorWrite, "sql" | "readGeneration" | "upsert">) =>
      withVectorSql(write, async (tx) => {
        deps.signal?.throwIfAborted();
        await fenceGeneratedApproval(tx, documentId, doc.projectId);
        const updated = await tx.document.updateMany({
          where: {
            id: documentId,
            deletedAt: null,
            indexState: { in: ["pending", "quarantined"] },
          },
          data: {
            indexState: "reconciling",
            status: "processing",
            chunkCount: created.length,
            processedAt: new Date(),
            errorMessage: null,
          },
        });
        if (!updated.count) throw new Error(`Document ${documentId} no longer approvable`);
        const active = await tx.quarantineChunk.updateMany({
          where: { id: attemptId, documentId, ord: -2 },
          data: { ord: -3 },
        });
        if (!active.count) throw new Error(`Document ${documentId} approval attempt revoked`);
        // Reindex may have replaced the live table since our speculative upsert.
        // Replay only after document-first journal CAS, holding project coordination
        // through SQL commit. No embedder calls (or budget bypass) at approval time.
        assertApprovalGeneration(await write.readGeneration(), vectorRows);
        if (vectorRows.length) await write.upsert(doc.projectId, vectorRows);
        deps.signal?.throwIfAborted();
        await tx.quarantineChunk.updateMany({ where: { documentId, ord: -2 }, data: { ord: -1 } });
        const old = await tx.knowledgeChunk.findMany({
          where: { documentId },
          select: { id: true },
        });
        if (old.length)
          await tx.quarantineChunk.createMany({
            data: [
              {
                id: randomUUID(),
                documentId,
                projectId: doc.projectId,
                ord: -1,
                text: "",
                embedding: "[]",
                metadata: JSON.stringify({ approvalChunkIds: old.map((row) => row.id) }),
              },
            ],
          });
        await tx.knowledgeChunk.deleteMany({ where: { documentId } });
        for (const data of sqlRows) await tx.knowledgeChunk.create({ data });
        await tx.quarantineChunk.deleteMany({ where: { documentId, ord: { gte: 0 } } });
        // The coordinated vector replay above can await external IO. Revalidate
        // live authorization again immediately before committing the selection.
        await fenceGeneratedApproval(tx, documentId, doc.projectId);
        return old.map((row) => row.id);
      });
    const obsolete = vectorStore.withProjectWrite
      ? await vectorStore.withProjectWrite(doc.projectId, selectWinner)
      : await selectWinner({
          // Compatibility for structural test doubles only. All shipped stores
          // implement withProjectWrite; failures there never fall back here.
          readGeneration: async () => null,
          upsert: (id, values) => vectorStore.upsert(id, values),
        });
    committed = true;
    await vectorStore.deleteByChunkIds(doc.projectId, obsolete);
    await bm25.removeChunkIds(doc.projectId, documentId, obsolete);
    await reconcileApprovalAttempts(documentId, doc.projectId, deps);
  } catch (error) {
    if (!committed) {
      // CAS cannot revoke a selected winner, including a lost commit ACK.
      await prisma.quarantineChunk.updateMany({
        where: { id: attemptId, ord: -2 },
        data: { ord: -1 },
      });
      await cleanupAbortedApproval(documentId, doc.projectId, deps, attemptChunkIds);
    }
    await setReconciliationStatus(documentId, attemptId, error);
    throw error;
  }

  audit({
    actor: { id: actor.id },
    action: "document.approve",
    target: { type: "document", id: documentId },
    metadata: {
      projectId: doc.projectId,
      chunkCount: created.length,
    },
  });

  // Touch the singleton so the search path picks up the new chunks via the
  // shared vector store. (Side-effect only — getKnowledgeService memoizes.)
  getKnowledgeService();

  return { chunkCount: created.length };
}

async function readApprovableDocument(documentId: string) {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
  });
  if (!doc) throw new Error(`Document ${documentId} not found`);
  if (!isStillApprovable(doc)) {
    throw new Error(`Document ${documentId} not in approvable state: ${doc.indexState}`);
  }
  return doc;
}

/** All approval entry points, including manual retries, share the publication
 * fence. Lock the generated parent BEFORE the synthetic document: version commit
 * and deletion write that same parent, so neither can pass our final SQL CAS.
 * Never substitute the approving operator for the persisted initiating principal.
 * Legacy/unversioned synthetic identities are read/cleanup-only. */
async function fenceGeneratedApproval(
  tx: Prisma.TransactionClient,
  documentId: string,
  projectId?: string,
): Promise<void> {
  if (!documentId.startsWith("gendoc-")) return;
  // Parent IDs are colon-free CUIDs; the revision is an opaque suffix that
  // contains colons (gendoc:<projectId>:<generatedDocumentId>:v<version>).
  // Keep it whole for the exact comparison with the parent's latest DB revision.
  const separator = documentId.indexOf(":", "gendoc-".length);
  const generatedDocumentId = documentId.slice("gendoc-".length, separator);
  const revisionId = documentId.slice(separator + 1);
  const deny = () => new Error("Generated document revision unavailable for approval");
  if (separator <= "gendoc-".length || !revisionId) throw deny();
  const held = await tx.generatedDocument.updateMany({
    where: { id: generatedDocumentId, ...(projectId ? { projectId } : {}), deletedAt: null },
    data: { id: generatedDocumentId },
  });
  if (!held.count) throw deny();
  const doc = await tx.generatedDocument.findFirstOrThrow({
    where: { id: generatedDocumentId },
    select: { id: true, projectId: true, scope: true, scopeFilter: true, evidencePolicy: true },
  });
  const latest = await tx.generatedDocumentVersion.findFirst({
    where: { documentId: generatedDocumentId },
    orderBy: { version: "desc" },
    select: { revisionId: true },
  });
  if (!latest || latest.revisionId !== revisionId) throw deny();
  await resolveEvidencePolicy(doc, tx);
}

function isStillApprovable(
  doc: {
    indexState: string;
    deletedAt?: Date | null;
  } | null,
): boolean {
  return Boolean(
    doc &&
    doc.deletedAt == null &&
    (doc.indexState === "quarantined" || doc.indexState === "pending"),
  );
}

async function cleanupAbortedApproval(
  documentId: string,
  projectId: string,
  deps: ApprovalDeps,
  chunkIds: string[],
): Promise<void> {
  const vectorStore = deps.vectorStore ?? getVectorStore();
  // A commit can succeed while its acknowledgement fails. SQL is the selected
  // attempt pointer; never compensate IDs that the commit made live.
  const live = await prisma.knowledgeChunk.findMany({
    where: { documentId },
    select: { id: true },
  });
  const selected = new Set(live.map((row) => row.id));
  const obsolete = chunkIds.filter((id) => !selected.has(id));
  await vectorStore.deleteByChunkIds(projectId, obsolete);
  await (deps.bm25 ?? getBM25Index()).removeChunkIds(projectId, documentId, obsolete);
}

async function reconcileApprovalAttempts(
  documentId: string,
  projectId: string,
  deps: ApprovalDeps,
): Promise<void> {
  const bm25 = deps.bm25 ?? getBM25Index();
  let winnerId: string | undefined;
  try {
    winnerId = await prisma.$transaction(async (tx) => {
      await fenceGeneratedApproval(tx, documentId, projectId);
      await tx.document.updateMany({ where: { id: documentId }, data: { id: documentId } });
      const [winner] = await tx.quarantineChunk.findMany({ where: { documentId, ord: -3 } });
      if (winner)
        await tx.document.updateMany({
          where: {
            id: documentId,
            deletedAt: null,
            indexState: { in: ["indexed", "reconciling"] },
          },
          data: { indexState: "reconciling", status: "processing", errorMessage: null },
        });
      return winner?.id;
    });
    // Capture sparse candidates BEFORE the SQL fence. Never delete by a stale
    // complement of SQL: later generations may add IDs while deletion awaits IO.
    const sparseIds = await bm25.documentChunkIds(projectId, documentId);
    const fenced = await prisma.$transaction(async (tx) => {
      await tx.document.updateMany({ where: { id: documentId }, data: { id: documentId } });
      // -2 active, -3 selected, -4 ingest generation, -1 revoked/obsolete.
      // Revocation and commit both
      // take the document lock FIRST; no revoked attempt can subsequently win.
      await tx.quarantineChunk.updateMany({ where: { documentId, ord: -2 }, data: { ord: -1 } });
      const journals = await tx.quarantineChunk.findMany({ where: { documentId, ord: { lt: 0 } } });
      const selected = new Set(
        (await tx.knowledgeChunk.findMany({ where: { documentId }, select: { id: true } })).map(
          (row) => row.id,
        ),
      );
      const candidates = new Set(sparseIds);
      for (const journal of journals) {
        const metadata = safeParseJson(journal.metadata) as { approvalChunkIds?: string[] } | null;
        for (const id of metadata?.approvalChunkIds ?? []) candidates.add(id);
      }
      return {
        winnerId: journals.find((row) => row.ord === -3)?.id,
        obsolete: [...candidates].filter((id) => !selected.has(id)),
      };
    });
    winnerId = fenced.winnerId;
    await (deps.vectorStore ?? getVectorStore()).deleteByChunkIds(projectId, fenced.obsolete);
    await bm25.removeChunkIds(projectId, documentId, fenced.obsolete);
    if (winnerId) await setReconciliationStatus(documentId, winnerId);
  } catch (error) {
    if (winnerId) await setReconciliationStatus(documentId, winnerId, error);
    throw error;
  }
}

async function setReconciliationStatus(
  documentId: string,
  winnerId: string,
  error?: unknown,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Failed cleanup must remain observable even after authorization/version
    // revocation; only the transition back to searchable success is fenced.
    if (error === undefined) await fenceGeneratedApproval(tx, documentId);
    await tx.document.updateMany({ where: { id: documentId }, data: { id: documentId } });
    const winner = await tx.quarantineChunk.updateMany({
      where: { id: winnerId, documentId, ord: -3 },
      data: { ord: -3 },
    });
    if (!winner.count) return; // A later ingest/deletion owns status now.
    await tx.document.updateMany({
      where: { id: documentId, deletedAt: null, indexState: { in: ["reconciling", "indexed"] } },
      data:
        error === undefined
          ? { indexState: "indexed", status: "ready", errorMessage: null }
          : {
              indexState: "reconciling",
              status: "failed",
              errorMessage: error instanceof Error ? error.message : String(error),
            },
    });
  });
}

function metaVectorMetadata(
  rows: Array<{ ord: number; metadata: string }>,
  position: number,
): Record<string, unknown> | null {
  const row = rows.find((candidate) => candidate.ord === position);
  const meta = safeParseJson(row?.metadata) as Record<string, unknown> | null;
  if (!meta) return null;
  const {
    md5: _md5,
    embeddingModel: _embeddingModel,
    chunkerIdentity: _chunkerIdentity,
    headings: _headings,
    aclSubjects: _aclSubjects,
    filename: _filename,
    ...rest
  } = meta;
  return rest;
}

/** Drop quarantined chunks and mark the document `rejected`. Audit-logged. */
export async function rejectDocument(
  documentId: string,
  actor: ApprovalActor,
  reason?: string,
): Promise<void> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, deletedAt: null },
  });
  if (!doc) throw new Error(`Document ${documentId} not found`);
  await prisma.$transaction(async (tx) => {
    await tx.document.update({
      where: { id: documentId },
      data: {
        indexState: "rejected",
        status: "failed",
        chunkCount: 0,
        errorMessage: reason ?? "rejected",
        processedAt: new Date(),
      },
    });
    await tx.quarantineChunk.updateMany({
      where: { documentId, ord: { in: [-2, -3, -4] } },
      data: { ord: -1 },
    });
    await tx.quarantineChunk.deleteMany({ where: { documentId, ord: { gte: 0 } } });
  });
  audit({
    actor: { id: actor.id },
    action: "document.reject",
    target: { type: "document", id: documentId },
    metadata: { projectId: doc.projectId, reason: reason ?? null },
  });
  log.info("rejected document", { documentId, projectId: doc.projectId });
}

/** List quarantine and approvals whose selected index still needs cleanup. */
export async function listQuarantine(projectId: string) {
  const docs = await prisma.document.findMany({
    where: {
      projectId,
      deletedAt: null,
      OR: [
        { indexState: "quarantined" },
        {
          indexState: "reconciling",
          quarantineChunks: { some: { ord: -3 } },
        },
      ],
    },
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      filename: true,
      uploadedAt: true,
      chunkCount: true,
      indexState: true,
      autoApproveTrusted: true,
      errorMessage: true,
    },
  });
  return docs.map((d) => ({
    documentId: d.id,
    filename: d.filename,
    uploadedAt: d.uploadedAt.toISOString(),
    chunkCount: d.chunkCount,
    indexState: d.indexState as "quarantined" | "reconciling",
    autoApproveTrusted: d.autoApproveTrusted,
    // #98 — a reconciling row holds the approval cleanup's raw exception text.
    errorMessage: publicIndexingErrorMessage(d.errorMessage, d.indexState),
  }));
}

function safeParseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
