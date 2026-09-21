import { createHash } from "node:crypto";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getDocumentStorage, type StorageBackend } from "../documents/storage.js";
import { getEmbedder, type Embedder } from "../rag/embedder.js";
import { writeQuarantine, approveDocument, shouldAutoApprove } from "../rag/quarantine.js";
import { getSchedulerBootstrap } from "../scheduler/index.js";
import { getVectorStore } from "../rag/vector-store.js";
import { getBM25Index } from "../rag/bm25-index.js";
import {
  generatedDocRevisionId,
  slugifySectionLabel,
  type GeneratedDocRevisionKey,
} from "./generated-doc-provenance.js";
import { resolveEvidencePolicy } from "./evidence-policy.js";

const log = createChildLogger("docs-gen:publication");

const CHUNK_SIZE = 1500;

export const DOCSGEN_CHUNKER_IDENTITY = `docsgen:v1:${CHUNK_SIZE}`;
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

export interface GeneratedDocPublicationDeps {
  signal?: AbortSignal;
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
  const embeddings = chunks.length
    ? await embedder.embed(chunks.map((chunk) => chunk.text))
    : { model: "empty", identity: "empty", vectors: [] };
  if (embeddings.vectors.length !== chunks.length) {
    throw new Error(
      `embedder returned ${embeddings.vectors.length} vectors for ${chunks.length} generated-doc chunks`,
    );
  }

  deps.signal?.throwIfAborted();
  await writeQuarantine({
    onlyIfUnpublished: true,
    documentId: syntheticDocumentId,
    projectId: payload.projectId,
    filename,
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
      },
    })),
    embeddingModel: embeddings.identity ?? embeddings.model,
    chunkerIdentity: DOCSGEN_CHUNKER_IDENTITY,
    aclSubjects: [...policy.aclSubjects],
  });

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

async function readPublicationSnapshot(
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

async function reconcileSyntheticDocumentRemoval(
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

function chunkGeneratedMarkdown(
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
    if (section.length <= CHUNK_SIZE) {
      if (section.trim()) {
        chunks.push({ text: section.trim(), sectionSlug, sectionIndex, heading });
      }
      continue;
    }
    const paragraphs = section.split(/\n\n+/);
    let current = "";
    for (const para of paragraphs) {
      if (current.length + para.length + 2 > CHUNK_SIZE) {
        if (current.trim()) {
          chunks.push({ text: current.trim(), sectionSlug, sectionIndex, heading });
        }
        current = para;
      } else {
        current += (current ? "\n\n" : "") + para;
      }
    }
    if (current.trim()) {
      chunks.push({ text: current.trim(), sectionSlug, sectionIndex, heading });
    }
  }
  return chunks;
}

function sectionHeading(section: string): string | null {
  const match = /^#{2,3}\s+(.+)$/m.exec(section);
  return match?.[1]?.trim() ?? null;
}
