import { createHash } from "node:crypto";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getDocumentStorage, type StorageBackend } from "../documents/storage.js";
import { getEmbedder, type Embedder } from "../rag/embedder.js";
import type { AclSubject } from "@metis/shared";
import { writeQuarantine, approveDocument, shouldAutoApprove } from "../rag/quarantine.js";
import { getSchedulerBootstrap } from "../scheduler/index.js";
import { getVectorStore } from "../rag/vector-store.js";
import { getBM25Index } from "../rag/bm25-index.js";
import { embedInBoundedBatches } from "../rag/embed-batched.js";
import {
  generatedDocRevisionId,
  slugifySectionLabel,
  type GeneratedDocRevisionKey,
} from "./generated-doc-provenance.js";
import { resolveEvidencePolicy } from "./evidence-policy.js";

const log = createChildLogger("docs-gen:publication");

/** Hard upper bound, in characters, on every generated-doc chunk (#189). */
export const CHUNK_SIZE = 1500;

/**
 * v2 (#189): v1 bounded a chunk only at paragraph boundaries, so one paragraph
 * longer than CHUNK_SIZE (a large table, a fenced block) became one chunk of any
 * size — 51,081 characters in the document that hung the server. v2 splits such a
 * paragraph on lines, then on characters, so no chunk exceeds CHUNK_SIZE.
 */
export const DOCSGEN_CHUNKER_IDENTITY = `docsgen:v2:${CHUNK_SIZE}`;

/**
 * Chunk-metadata label carried by every generated-doc chunk (#189). A generated
 * document is DERIVED output — possibly degraded, possibly scoped to part of the
 * project — never a primary source. Docs-gen grounding already refuses it
 * (`evidence-filter.ts`); the label makes the same fact readable to any other
 * consumer of the chunk.
 */
export const GENERATED_DOC_EVIDENCE_CLASS = "derived-generated-doc";

/** Texts per embed call during publication (#189): bounded, never the whole document. */
export const PUBLICATION_EMBED_BATCH_SIZE = 32;
export const GENERATED_DOC_PUBLICATION_TASK_TYPE = "publish-generated-document";

export interface GeneratedDocPublicationRequest extends GeneratedDocRevisionKey {
  markdown: string;
}

export interface GeneratedDocPublicationTaskPayload extends GeneratedDocRevisionKey {
  revisionId: string;
}

export type GeneratedDocDeletionRequest = GeneratedDocPublicationTaskPayload & {
  createdById?: string | null;
};

export interface GeneratedDocPublicationProgress {
  step: "embed";
  current: number;
  total: number;
}

export interface GeneratedDocPublicationDeps {
  signal?: AbortSignal;
  /** #189 — progress after each bounded embed batch. */
  onProgress?: (progress: GeneratedDocPublicationProgress) => void;
  /**
   * #189 — this is the task's last attempt. A failure then marks the synthetic
   * document `failed` instead of leaving it `processing` forever.
   */
  finalAttempt?: boolean;
  storage?: StorageBackend;
  embedder?: Embedder;
  enqueueTask?: (input: {
    type: string;
    projectId: string;
    payload: Record<string, unknown>;
    maxAttempts?: number;
    createdById?: string | null;
  }) => Promise<unknown>;
}

export function generatedDocSyntheticDocumentId(
  generatedDocumentId: string,
  revisionId?: string | null,
): string {
  // The legacy identity is read/cleanup-only. Every new writer owns a revision
  // namespace in ALL stores, so even a paused external mutation cannot touch v2.
  return `gendoc-${generatedDocumentId}${revisionId ? `:${revisionId}` : ""}`;
}

export async function enqueueGeneratedDocPublication(
  input: GeneratedDocPublicationRequest,
  deps: GeneratedDocPublicationDeps = {},
): Promise<{ revisionId: string; syntheticDocumentId: string }> {
  const revisionId = generatedDocRevisionId(input);
  const syntheticDocumentId = generatedDocSyntheticDocumentId(
    input.generatedDocumentId,
    revisionId,
  );
  await upsertSyntheticDocumentPlaceholder(input, revisionId, syntheticDocumentId, deps.storage);
  const enqueueTask =
    deps.enqueueTask ??
    (async (task) =>
      getSchedulerBootstrap().queue.enqueue({
        type: task.type,
        projectId: task.projectId,
        payload: task.payload,
        maxAttempts: task.maxAttempts,
        createdById: task.createdById,
      }));
  const policy = await resolveEvidencePolicyForPublication(
    input.generatedDocumentId,
    input.projectId,
  );
  await enqueueTask({
    type: GENERATED_DOC_PUBLICATION_TASK_TYPE,
    projectId: input.projectId,
    payload: {
      projectId: input.projectId,
      generatedDocumentId: input.generatedDocumentId,
      version: input.version,
      revisionId,
    },
    maxAttempts: 3,
    createdById: policy.actor.userId,
  });
  return { revisionId, syntheticDocumentId };
}

export async function enqueueGeneratedDocDeletion(
  input: GeneratedDocDeletionRequest,
  deps: GeneratedDocPublicationDeps = {},
): Promise<{ revisionId: string; syntheticDocumentId: string }> {
  const syntheticDocumentId = generatedDocSyntheticDocumentId(
    input.generatedDocumentId,
    input.revisionId,
  );
  const createdById =
    input.createdById !== undefined
      ? input.createdById
      : (await resolveEvidencePolicyForPublication(input.generatedDocumentId, input.projectId))
          .actor.userId;
  const enqueueTask =
    deps.enqueueTask ??
    (async (task) =>
      getSchedulerBootstrap().queue.enqueue({
        type: task.type,
        projectId: task.projectId,
        payload: task.payload,
        maxAttempts: task.maxAttempts,
        createdById: task.createdById,
      }));
  await enqueueTask({
    type: GENERATED_DOC_PUBLICATION_TASK_TYPE,
    projectId: input.projectId,
    payload: {
      projectId: input.projectId,
      generatedDocumentId: input.generatedDocumentId,
      version: input.version,
      revisionId: input.revisionId,
    },
    maxAttempts: 3,
    createdById,
  });
  return { revisionId: input.revisionId, syntheticDocumentId };
}

export async function publishGeneratedDocRevision(
  payload: GeneratedDocPublicationTaskPayload,
  deps: GeneratedDocPublicationDeps = {},
): Promise<
  | { status: "published"; chunkCount: number; syntheticDocumentId: string }
  | {
      status: "skipped";
      reason: "deleted" | "superseded" | "missing-version";
      syntheticDocumentId: string;
    }
> {
  const syntheticDocumentId = generatedDocSyntheticDocumentId(
    payload.generatedDocumentId,
    payload.revisionId,
  );
  deps.signal?.throwIfAborted();
  const snapshot = await readPublicationSnapshot(payload);
  if (snapshot.status !== "publishable") {
    await reconcileSyntheticDocumentRemoval(syntheticDocumentId, payload.projectId);
    await reconcileSyntheticDocumentRemoval(
      generatedDocSyntheticDocumentId(payload.generatedDocumentId),
      payload.projectId,
    );
    return handleUnpublishableSnapshot(payload, syntheticDocumentId, snapshot);
  }

  const { doc, version } = snapshot;

  const policy = await resolveEvidencePolicy(doc);
  const storage = deps.storage ?? getDocumentStorage();
  const embedder = deps.embedder ?? getEmbedder();
  const stored = await storage.write({
    projectId: payload.projectId,
    buffer: Buffer.from(version.content, "utf8"),
  });
  const filename = generatedDocFilename(payload.generatedDocumentId);
  deps.signal?.throwIfAborted();
  await prisma.document.upsert({
    where: { id: syntheticDocumentId },
    update: {},
    create: {
      id: syntheticDocumentId,
      projectId: payload.projectId,
      filename,
      mimeType: "text/markdown",
      sizeBytes: stored.sizeBytes,
      storagePath: stored.storagePath,
      checksum: stored.checksum,
      status: "processing",
      indexState: "pending",
      autoApproveTrusted: false,
      uploadedById: policy.actor.userId,
    },
  });

  const fencedBeforeChunkWrite = await readPublicationSnapshot(payload);
  if (fencedBeforeChunkWrite.status !== "publishable") {
    await reconcileSyntheticDocumentRemoval(syntheticDocumentId, payload.projectId);
    return handleUnpublishableSnapshot(payload, syntheticDocumentId, fencedBeforeChunkWrite);
  }

  const chunks = chunkGeneratedMarkdown(version.content);
  try {
    await embedAndQuarantine({
      payload,
      syntheticDocumentId,
      filename,
      chunks,
      embedder,
      aclSubjects: [...policy.aclSubjects],
      doc,
      deps,
    });
  } catch (err) {
    if (!deps.signal?.aborted) {
      await recordPublicationFailure(
        syntheticDocumentId,
        payload.projectId,
        err,
        deps.finalAttempt ?? false,
      );
    }
    throw err;
  }

  const fencedBeforeApprove = await readPublicationSnapshot(payload);
  if (fencedBeforeApprove.status !== "publishable") {
    await reconcileSyntheticDocumentRemoval(syntheticDocumentId, payload.projectId);
    return handleUnpublishableSnapshot(payload, syntheticDocumentId, fencedBeforeApprove);
  }

  const autoApprove = chunks.length === 0 || (await shouldAutoApprove(syntheticDocumentId));
  if (!autoApprove) {
    const finalSnapshot = await readPublicationSnapshot(payload);
    if (finalSnapshot.status !== "publishable") {
      await reconcileSyntheticDocumentRemoval(syntheticDocumentId, payload.projectId);
      return handleUnpublishableSnapshot(payload, syntheticDocumentId, finalSnapshot);
    }
    await markAwaitingReview(syntheticDocumentId, payload.projectId);
    await removeOlderPublications(payload);
    return { status: "published", chunkCount: chunks.length, syntheticDocumentId };
  }

  const result = await approveDocument(
    syntheticDocumentId,
    { id: policy.actor.userId },
    { signal: deps.signal },
  );
  const finalSnapshot = await readPublicationSnapshot(payload);
  if (finalSnapshot.status !== "publishable") {
    await reconcileSyntheticDocumentRemoval(syntheticDocumentId, payload.projectId);
    return handleUnpublishableSnapshot(payload, syntheticDocumentId, finalSnapshot);
  }
  await removeOlderPublications(payload);
  return { status: "published", chunkCount: result.chunkCount, syntheticDocumentId };
}

type GeneratedDocChunk = ReturnType<typeof chunkGeneratedMarkdown>[number];

/**
 * #189 — embed in bounded batches (progress + a cancellation point between them;
 * never the whole document in one call), then park the chunks in quarantine.
 */
async function embedAndQuarantine(input: {
  payload: GeneratedDocPublicationTaskPayload;
  syntheticDocumentId: string;
  filename: string;
  chunks: GeneratedDocChunk[];
  embedder: Pick<Embedder, "embed">;
  aclSubjects: AclSubject[];
  doc: { status: string; scope: string };
  deps: GeneratedDocPublicationDeps;
}): Promise<void> {
  const { payload, chunks, deps } = input;
  const embeddings = chunks.length
    ? await embedInBoundedBatches(
        input.embedder,
        chunks.map((chunk) => chunk.text),
        {
          batchSize: PUBLICATION_EMBED_BATCH_SIZE,
          signal: deps.signal,
          onProgress: (current, total) => deps.onProgress?.({ step: "embed", current, total }),
        },
      )
    : { model: "empty", identity: "empty", vectors: [] };
  if (embeddings.vectors.length !== chunks.length) {
    throw new Error(
      `embedder returned ${embeddings.vectors.length} vectors for ${chunks.length} generated-doc chunks`,
    );
  }

  deps.signal?.throwIfAborted();
  await writeQuarantine({
    onlyIfUnpublished: true,
    documentId: input.syntheticDocumentId,
    projectId: payload.projectId,
    filename: input.filename,
    chunks: chunks.map((chunk, index) => ({
      ord: index,
      text: chunk.text,
      md5: createHash("md5").update(chunk.text).digest("hex"),
      embedding: embeddings.vectors[index] as number[],
      headings: chunk.heading ? [chunk.heading] : [],
      metadata: {
        source: "generated-doc",
        generatedDocumentId: payload.generatedDocumentId,
        generatedDocumentVersion: payload.version,
        generatedRevisionId: payload.revisionId,
        historyProvenance: "versioned",
        chunkIndex: index,
        sectionSlug: chunk.sectionSlug,
        sectionIndex: chunk.sectionIndex,
        evidenceClass: GENERATED_DOC_EVIDENCE_CLASS,
        generatedDocumentStatus: input.doc.status,
        generatedDocumentScope: input.doc.scope,
      },
    })),
    embeddingModel: embeddings.identity ?? embeddings.model,
    chunkerIdentity: DOCSGEN_CHUNKER_IDENTITY,
    aclSubjects: input.aclSubjects,
  });
}

/**
 * #189 — chunks parked for operator review are a FINISHED ingest, exactly as for
 * an uploaded document (`knowledge-service.ingestDocument` marks it `ready` with a
 * pending-review badge). Before this, the synthetic row stayed `processing`
 * forever, so every non-auto-approved generated document looked stuck.
 */
export async function markAwaitingReview(
  syntheticDocumentId: string,
  projectId: string,
): Promise<void> {
  await prisma.document.updateMany({
    where: { id: syntheticDocumentId, projectId, deletedAt: null, indexState: "quarantined" },
    data: { status: "ready", errorMessage: null, processedAt: new Date() },
  });
}

/**
 * #189 — record a failed attempt on the synthetic document. A retry is still
 * coming unless this was the last attempt, so only then is the row `failed`;
 * either way the reason is visible instead of a silent `processing`.
 */
async function recordPublicationFailure(
  syntheticDocumentId: string,
  projectId: string,
  err: unknown,
  terminal: boolean,
): Promise<void> {
  const message = `generated-doc publication failed: ${(err as Error)?.message ?? String(err)}`;
  try {
    await prisma.document.updateMany({
      where: {
        id: syntheticDocumentId,
        projectId,
        deletedAt: null,
        indexState: { in: ["pending", "quarantined"] },
      },
      data: {
        errorMessage: message,
        ...(terminal ? { status: "failed", processedAt: new Date() } : {}),
      },
    });
  } catch (recordErr) {
    log.warn("Could not record generated-doc publication failure", {
      syntheticDocumentId,
      error: (recordErr as Error).message,
    });
  }
}

async function removeOlderPublications(payload: GeneratedDocPublicationTaskPayload): Promise<void> {
  // Enumerate immutable older identities, NEVER "all except me": a newer
  // revision can appear between this SQL read and an external-store mutation.
  const versions = await prisma.generatedDocumentVersion.findMany({
    where: { documentId: payload.generatedDocumentId, version: { lt: payload.version } },
    select: { version: true, revisionId: true },
  });
  for (const version of versions) {
    const revisionId =
      version.revisionId ?? generatedDocRevisionId({ ...payload, version: version.version });
    await reconcileSyntheticDocumentRemoval(
      generatedDocSyntheticDocumentId(payload.generatedDocumentId, revisionId),
      payload.projectId,
    );
  }
  await reconcileSyntheticDocumentRemoval(
    generatedDocSyntheticDocumentId(payload.generatedDocumentId),
    payload.projectId,
  );
}

type PublicationSnapshot =
  | {
      status: "publishable";
      doc: {
        id: string;
        projectId: string;
        title: string;
        status: string;
        deletedAt: Date | null;
        evidencePolicy: string | null;
        scope: string;
        scopeFilter: string;
      };
      version: {
        version: number;
        revisionId: string | null;
        content: string;
      };
    }
  | { status: "deleted" }
  | { status: "missing-version"; latestVersion: number | null }
  | { status: "superseded"; latestRevisionId: string | null };

export async function readPublicationSnapshot(
  payload: GeneratedDocPublicationTaskPayload,
): Promise<PublicationSnapshot> {
  const doc = await prisma.generatedDocument.findFirst({
    where: {
      id: payload.generatedDocumentId,
      projectId: payload.projectId,
    },
    select: {
      id: true,
      projectId: true,
      title: true,
      status: true,
      deletedAt: true,
      evidencePolicy: true,
      scope: true,
      scopeFilter: true,
    },
  });
  if (!doc || doc.deletedAt) {
    return { status: "deleted" };
  }

  const version = await prisma.generatedDocumentVersion.findFirst({
    where: { documentId: payload.generatedDocumentId },
    orderBy: { version: "desc" },
    select: { version: true, revisionId: true, content: true },
  });
  if (!version || version.version !== payload.version) {
    return {
      status: "missing-version",
      latestVersion: version?.version ?? null,
    };
  }
  if (version.revisionId !== payload.revisionId) {
    return {
      status: "superseded",
      latestRevisionId: version.revisionId,
    };
  }
  return { status: "publishable", doc, version };
}

function handleUnpublishableSnapshot(
  payload: GeneratedDocPublicationTaskPayload,
  syntheticDocumentId: string,
  snapshot: Exclude<PublicationSnapshot, { status: "publishable" }>,
): {
  status: "skipped";
  reason: "deleted" | "superseded" | "missing-version";
  syntheticDocumentId: string;
} {
  if (snapshot.status === "deleted") {
    log.info("Skip generated-doc publication for deleted artifact", payload);
    return { status: "skipped", reason: "deleted", syntheticDocumentId };
  }
  if (snapshot.status === "missing-version") {
    log.info("Skip generated-doc publication for missing version", {
      ...payload,
      latestVersion: snapshot.latestVersion,
    });
    return { status: "skipped", reason: "missing-version", syntheticDocumentId };
  }
  log.info("Skip generated-doc publication for superseded revision", {
    ...payload,
    latestRevisionId: snapshot.latestRevisionId,
  });
  return { status: "skipped", reason: "superseded", syntheticDocumentId };
}

export async function reconcileSyntheticDocumentRemoval(
  syntheticDocumentId: string,
  projectId: string,
): Promise<void> {
  // Tombstone FIRST. Approval's SQL compare-and-set cannot resurrect this row;
  // a writer already inside an external call compensates only its own revision.
  await prisma.document.updateMany({
    where: { id: syntheticDocumentId, projectId },
    data: {
      deletedAt: new Date(),
      status: "failed",
      indexState: "rejected",
      chunkCount: 0,
      errorMessage: "deleted",
      processedAt: new Date(),
    },
  });
  // Retain attempt tombstones: an old worker can still complete an external
  // write after this removal, then die before compensation. Replay needs its IDs.
  await prisma.quarantineChunk.deleteMany({
    where: { documentId: syntheticDocumentId, ord: { gte: 0 } },
  });
  await prisma.knowledgeChunk.deleteMany({ where: { documentId: syntheticDocumentId } });
  await removeSyntheticDocumentFromIndexes(projectId, syntheticDocumentId);
}

async function removeSyntheticDocumentFromIndexes(
  projectId: string,
  syntheticDocumentId: string,
): Promise<void> {
  const vectorStore = getVectorStore();
  const bm25 = getBM25Index();
  await vectorStore.deleteByDocument(projectId, syntheticDocumentId);
  await bm25.removeDocument(projectId, syntheticDocumentId);
}

async function resolveEvidencePolicyForPublication(generatedDocumentId: string, projectId: string) {
  const doc = await prisma.generatedDocument.findFirstOrThrow({
    where: { id: generatedDocumentId, projectId },
    select: {
      id: true,
      projectId: true,
      scope: true,
      scopeFilter: true,
      evidencePolicy: true,
    },
  });
  return resolveEvidencePolicy(doc);
}

async function upsertSyntheticDocumentPlaceholder(
  input: GeneratedDocPublicationRequest,
  revisionId: string,
  syntheticDocumentId: string,
  storageOverride?: StorageBackend,
): Promise<void> {
  const policy = await resolveEvidencePolicyForPublication(
    input.generatedDocumentId,
    input.projectId,
  );
  const storage = storageOverride ?? getDocumentStorage();
  const stored = await storage.write({
    projectId: input.projectId,
    buffer: Buffer.from(input.markdown, "utf8"),
  });
  const filename = generatedDocFilename(input.generatedDocumentId);
  await prisma.document.upsert({
    where: { id: syntheticDocumentId },
    update: {},
    create: {
      id: syntheticDocumentId,
      projectId: input.projectId,
      filename,
      mimeType: "text/markdown",
      sizeBytes: stored.sizeBytes,
      storagePath: stored.storagePath,
      checksum: stored.checksum,
      status: "pending",
      indexState: "pending",
      autoApproveTrusted: false,
      uploadedById: policy.actor.userId,
    },
  });
  log.info("Queued generated-doc publication", {
    generatedDocumentId: input.generatedDocumentId,
    syntheticDocumentId,
    revisionId,
  });
}

function generatedDocFilename(generatedDocumentId: string): string {
  return `generated-doc-${generatedDocumentId}.md`;
}

/** Exported for tests (#189): every returned chunk is at most {@link CHUNK_SIZE} characters. */
export function chunkGeneratedMarkdown(
  markdown: string,
): Array<{ text: string; sectionSlug: string; sectionIndex: number; heading: string | null }> {
  if (!markdown.trim()) return [];
  const sections = markdown.split(/(?=^#{2,3}\s)/m);
  const chunks: Array<{
    text: string;
    sectionSlug: string;
    sectionIndex: number;
    heading: string | null;
  }> = [];
  for (const [sectionIndex, section] of sections.entries()) {
    const heading = sectionHeading(section);
    const sectionSlug = slugifySectionLabel(heading ?? `section-${sectionIndex + 1}`);
    const push = (text: string) => {
      for (const piece of splitOversized(text.trim(), CHUNK_SIZE)) {
        const trimmed = piece.trim();
        if (trimmed) chunks.push({ text: trimmed, sectionSlug, sectionIndex, heading });
      }
    };
    if (section.length <= CHUNK_SIZE) {
      push(section);
      continue;
    }
    const paragraphs = section.split(/\n\n+/);
    let current = "";
    for (const para of paragraphs) {
      if (current.length + para.length + 2 > CHUNK_SIZE) {
        push(current);
        current = para;
      } else {
        current += (current ? "\n\n" : "") + para;
      }
    }
    push(current);
  }
  return chunks;
}

/**
 * #189 — split `text` so no piece exceeds `max` characters: on line breaks first
 * (a table or a code block stays row-aligned), then, for a single line longer than
 * `max`, at `max` — never inside a UTF-16 surrogate pair.
 */
export function splitOversized(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current) pieces.push(current);
    current = "";
  };
  for (const line of text.split("\n")) {
    if (line.length > max) {
      flush();
      let start = 0;
      while (start < line.length) {
        let end = Math.min(start + max, line.length);
        const code = line.charCodeAt(end - 1);
        if (end < line.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
        pieces.push(line.slice(start, end));
        start = end;
      }
      continue;
    }
    if (current && current.length + 1 + line.length > max) flush();
    current = current ? `${current}\n${line}` : line;
  }
  flush();
  return pieces;
}

function sectionHeading(section: string): string | null {
  const match = /^#{2,3}\s+(.+)$/m.exec(section);
  return match?.[1]?.trim() ?? null;
}
