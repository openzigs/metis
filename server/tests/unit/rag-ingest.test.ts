import { describe, it, expect, vi, beforeEach } from "vitest";

const storageWrite = vi.fn();
const resolveEvidencePolicy = vi.fn();
const schedulerEnqueue = vi.fn();
const embed = vi.fn();
const writeQuarantine = vi.fn();
const approveDocument = vi.fn();
const shouldAutoApprove = vi.fn();
const vectorDeleteByDocument = vi.fn();
const bm25RemoveDocument = vi.fn();
const documentUpdateMany = vi.fn();
const versionFindMany = vi.fn();
const revisionDocumentId = expect.stringMatching(/^gendoc-doc-1:.+/);

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    generatedDocument: {
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
    },
    generatedDocumentVersion: {
      findFirst: vi.fn(),
      findMany: versionFindMany,
    },
    document: {
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: documentUpdateMany,
    },
    quarantineChunk: {
      deleteMany: vi.fn(),
    },
    knowledgeChunk: {
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({ write: storageWrite }),
}));

vi.mock("../../src/lib/docs-gen/evidence-policy.js", () => ({
  resolveEvidencePolicy,
}));

vi.mock("../../src/lib/scheduler/index.js", () => ({
  getSchedulerBootstrap: () => ({
    queue: {
      enqueue: schedulerEnqueue,
    },
  }),
}));

vi.mock("../../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({ embed }),
}));

vi.mock("../../src/lib/rag/vector-store.js", () => ({
  getVectorStore: () => ({
    deleteByDocument: vectorDeleteByDocument,
  }),
}));

vi.mock("../../src/lib/rag/bm25-index.js", () => ({
  getBM25Index: () => ({
    removeDocument: bm25RemoveDocument,
  }),
}));

vi.mock("../../src/lib/rag/quarantine.js", () => ({
  writeQuarantine,
  approveDocument,
  shouldAutoApprove,
}));

describe("generated-doc publication compatibility", () => {
  beforeEach(() => {
    // Clear queued rejections as well as history, then seed a fresh happy path.
    vi.resetAllMocks();
    documentUpdateMany.mockResolvedValue({ count: 1 });
    versionFindMany.mockResolvedValue([]);
    storageWrite.mockResolvedValue({
      storagePath: "generated/doc-1.md",
      checksum: "checksum-1",
      sizeBytes: 42,
    });
    resolveEvidencePolicy.mockResolvedValue({
      actor: { userId: "user-1", role: "admin" },
      aclSubjects: [{ kind: "user", value: "user-1" }],
    });
    schedulerEnqueue.mockResolvedValue(undefined);
    embed.mockResolvedValue({
      model: "test-embed-model",
      identity: "test-embed-model@1",
      vectors: [[0.1, 0.2]],
    });
    writeQuarantine.mockResolvedValue(undefined);
    approveDocument.mockResolvedValue({ chunkCount: 1 });
    shouldAutoApprove.mockResolvedValue(true);
    vectorDeleteByDocument.mockResolvedValue(0);
    bm25RemoveDocument.mockResolvedValue(undefined);
  });

  it("ingestDocumentToRag defaults the legacy version to 1", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { ingestDocumentToRag } = await import("../../src/lib/docs-gen/rag-ingest.js");

    (prisma.generatedDocument.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      scope: "full",
      scopeFilter: "{}",
      evidencePolicy: "{}",
    });

    const result = await ingestDocumentToRag("doc-1", "proj-1", "## Overview\n\nAlpha");

    expect(schedulerEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          version: 1,
          revisionId: result.revisionId,
        }),
      }),
    );
  });

  it("ingestDocumentToRag preserves the legacy call signature and queues publication", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { ingestDocumentToRag, GENERATED_DOC_PUBLICATION_TASK_TYPE } =
      await import("../../src/lib/docs-gen/rag-ingest.js");

    (prisma.generatedDocument.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      scope: "full",
      scopeFilter: "{}",
      evidencePolicy: "{}",
    });

    const result = await ingestDocumentToRag("doc-1", "proj-1", "## Overview\n\nAlpha", {
      version: 3,
    });

    expect(prisma.document.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: revisionDocumentId },
        update: {},
        create: expect.objectContaining({ status: "pending", indexState: "pending" }),
      }),
    );
    expect(schedulerEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: GENERATED_DOC_PUBLICATION_TASK_TYPE,
        projectId: "proj-1",
        payload: expect.objectContaining({
          projectId: "proj-1",
          generatedDocumentId: "doc-1",
          version: 3,
          revisionId: result.revisionId,
        }),
        maxAttempts: 3,
        createdById: "user-1",
      }),
    );
    expect(result.syntheticDocumentId).toBe(`gendoc-doc-1:${result.revisionId}`);
  });

  it("enqueueGeneratedDocPublication honors injected storage and enqueueTask deps", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { enqueueGeneratedDocPublication, GENERATED_DOC_PUBLICATION_TASK_TYPE } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const injectedStorageWrite = vi.fn().mockResolvedValue({
      storagePath: "generated/doc-1-custom.md",
      checksum: "checksum-custom",
      sizeBytes: 64,
    });
    const injectedEnqueueTask = vi.fn().mockResolvedValue(undefined);
    (prisma.generatedDocument.findFirstOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      scope: "full",
      scopeFilter: "{}",
      evidencePolicy: "{}",
    });

    const result = await enqueueGeneratedDocPublication(
      {
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        markdown: "plain section without heading",
        version: 2,
      },
      {
        storage: { write: injectedStorageWrite } as never,
        enqueueTask: injectedEnqueueTask,
      },
    );

    expect(injectedStorageWrite).toHaveBeenCalledWith({
      projectId: "proj-1",
      buffer: Buffer.from("plain section without heading", "utf8"),
    });
    expect(injectedEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: GENERATED_DOC_PUBLICATION_TASK_TYPE,
        projectId: "proj-1",
        payload: expect.objectContaining({
          generatedDocumentId: "doc-1",
          version: 2,
          revisionId: result.revisionId,
        }),
      }),
    );
    expect(schedulerEnqueue).not.toHaveBeenCalled();
  });

  it.each(["default", "injected"] as const)(
    "queues deletion through the %s scheduler without recreating the artifact",
    async (scheduler) => {
      const { prisma } = await import("../../src/lib/prisma.js");
      const { enqueueGeneratedDocDeletion, GENERATED_DOC_PUBLICATION_TASK_TYPE } =
        await import("../../src/lib/docs-gen/generated-doc-publication.js");
      vi.mocked(prisma.generatedDocument.findFirstOrThrow).mockResolvedValue({
        id: "doc-1",
        projectId: "proj-1",
        scope: "full",
        scopeFilter: "{}",
        evidencePolicy: "{}",
      } as never);
      const enqueueTask = vi.fn().mockResolvedValue(undefined);
      const payload = {
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId: "persisted-revision-3",
      };

      await expect(
        enqueueGeneratedDocDeletion(payload, scheduler === "injected" ? { enqueueTask } : {}),
      ).resolves.toEqual({
        revisionId: payload.revisionId,
        syntheticDocumentId: "gendoc-doc-1:persisted-revision-3",
      });

      expect(prisma.generatedDocument.findFirstOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "doc-1", projectId: "proj-1" } }),
      );
      const selected = scheduler === "injected" ? enqueueTask : schedulerEnqueue;
      const unused = scheduler === "injected" ? schedulerEnqueue : enqueueTask;
      expect(selected).toHaveBeenCalledExactlyOnceWith({
        type: GENERATED_DOC_PUBLICATION_TASK_TYPE,
        projectId: "proj-1",
        payload,
        maxAttempts: 3,
        createdById: "user-1",
      });
      expect(unused).not.toHaveBeenCalled();
      expect(storageWrite).not.toHaveBeenCalled();
      expect(prisma.document.upsert).not.toHaveBeenCalled();
      expect(writeQuarantine).not.toHaveBeenCalled();
    },
  );

  it("does not enqueue deletion when the persisted evidence policy denies access", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { enqueueGeneratedDocDeletion } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");
    const doc = {
      id: "doc-1",
      projectId: "proj-1",
      scope: "repository",
      scopeFilter: '{"repoConnectorId":"repo-1"}',
      evidencePolicy: "{}",
    };
    vi.mocked(prisma.generatedDocument.findFirstOrThrow).mockResolvedValue(doc as never);
    resolveEvidencePolicy.mockRejectedValueOnce(new Error("Actor no longer has project access"));
    const enqueueTask = vi.fn();

    await expect(
      enqueueGeneratedDocDeletion(
        {
          generatedDocumentId: "doc-1",
          projectId: "proj-1",
          version: 3,
          revisionId: "persisted-revision-3",
        },
        { enqueueTask },
      ),
    ).rejects.toThrow("Actor no longer has project access");

    expect(resolveEvidencePolicy).toHaveBeenCalledExactlyOnceWith(doc);
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(schedulerEnqueue).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(prisma.document.upsert).not.toHaveBeenCalled();
  });

  it("retries cleanup for a missing artifact when BM25 fails and no placeholder exists", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");
    vi.mocked(prisma.generatedDocument.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.document.update).mockRejectedValueOnce(new Error("Record not found"));
    bm25RemoveDocument.mockRejectedValueOnce(new Error("BM25 unavailable"));

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId: "persisted-revision-3",
      }),
    ).rejects.toThrow("BM25 unavailable");

    expect(prisma.quarantineChunk.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { documentId: "gendoc-doc-1:persisted-revision-3", ord: { gte: 0 } },
    });
    expect(prisma.knowledgeChunk.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { documentId: "gendoc-doc-1:persisted-revision-3" },
    });
    expect(vectorDeleteByDocument).toHaveBeenCalledExactlyOnceWith(
      "proj-1",
      "gendoc-doc-1:persisted-revision-3",
    );
    expect(bm25RemoveDocument).toHaveBeenCalledExactlyOnceWith(
      "proj-1",
      "gendoc-doc-1:persisted-revision-3",
    );
    expect(documentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "gendoc-doc-1:persisted-revision-3", projectId: "proj-1" },
        data: expect.objectContaining({ indexState: "rejected", chunkCount: 0 }),
      }),
    );
    expect(prisma.generatedDocumentVersion.findFirst).not.toHaveBeenCalled();
    expect(resolveEvidencePolicy).not.toHaveBeenCalled();
    expect(writeQuarantine).not.toHaveBeenCalled();
    expect(approveDocument).not.toHaveBeenCalled();
  });

  it("publishGeneratedDocRevision skips superseded revisions", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 4,
      revisionId: "newer-revision",
      content: "## New\n\nContent",
    });

    const result = await publishGeneratedDocRevision({
      generatedDocumentId: "doc-1",
      projectId: "proj-1",
      version: 4,
      revisionId: "older-revision",
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "superseded",
      syntheticDocumentId: "gendoc-doc-1:older-revision",
    });
    expect(writeQuarantine).not.toHaveBeenCalled();
    expect(approveDocument).not.toHaveBeenCalled();
  });

  it("publishGeneratedDocRevision skips deleted generated documents", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId: "rev-3",
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "deleted",
      syntheticDocumentId: "gendoc-doc-1:rev-3",
    });

    expect(prisma.generatedDocumentVersion.findFirst).not.toHaveBeenCalled();
    expect(prisma.quarantineChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: "gendoc-doc-1", ord: { gte: 0 } },
    });
    expect(prisma.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: "gendoc-doc-1" },
    });
    expect(vectorDeleteByDocument).toHaveBeenCalledWith("proj-1", "gendoc-doc-1");
    expect(bm25RemoveDocument).toHaveBeenCalledWith("proj-1", "gendoc-doc-1");
    expect(documentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "gendoc-doc-1", projectId: "proj-1" },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          indexState: "rejected",
          chunkCount: 0,
        }),
      }),
    );
    expect(writeQuarantine).not.toHaveBeenCalled();
  });

  it("retries deleted generated-doc cleanup until vector and BM25 removal converge", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });
    vectorDeleteByDocument.mockRejectedValueOnce(new Error("vector store offline"));

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId: "rev-3",
      }),
    ).rejects.toThrow(/vector store offline/);

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId: "rev-3",
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "deleted",
      syntheticDocumentId: "gendoc-doc-1:rev-3",
    });

    expect(prisma.quarantineChunk.deleteMany).toHaveBeenCalledTimes(3);
    expect(prisma.knowledgeChunk.deleteMany).toHaveBeenCalledTimes(3);
    expect(vectorDeleteByDocument).toHaveBeenCalledTimes(3);
    expect(bm25RemoveDocument).toHaveBeenCalledTimes(2);
  });

  it("publishGeneratedDocRevision skips missing versions", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId: "rev-3",
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "missing-version",
      syntheticDocumentId: "gendoc-doc-1:rev-3",
    });

    expect(writeQuarantine).not.toHaveBeenCalled();
    expect(approveDocument).not.toHaveBeenCalled();
  });

  it("publishGeneratedDocRevision writes version provenance into quarantine metadata before approval", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { generatedDocRevisionId } =
      await import("../../src/lib/docs-gen/generated-doc-provenance.js");
    const { publishGeneratedDocRevision, DOCSGEN_CHUNKER_IDENTITY } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const revisionId = generatedDocRevisionId({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      version: 3,
    });
    const liveDoc = {
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    };
    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(liveDoc);
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 3,
      revisionId,
      content: "## Overview\n\nAlpha",
    });

    const result = await publishGeneratedDocRevision({
      generatedDocumentId: "doc-1",
      projectId: "proj-1",
      version: 3,
      revisionId,
    });

    expect(storageWrite).toHaveBeenCalled();
    expect(embed).toHaveBeenCalledWith(["## Overview\n\nAlpha"]);
    expect(writeQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: `gendoc-doc-1:${revisionId}`,
        projectId: "proj-1",
        embeddingModel: "test-embed-model@1",
        chunkerIdentity: DOCSGEN_CHUNKER_IDENTITY,
        chunks: [
          expect.objectContaining({
            ord: 0,
            headings: ["Overview"],
            metadata: expect.objectContaining({
              source: "generated-doc",
              generatedDocumentId: "doc-1",
              generatedDocumentVersion: 3,
              generatedRevisionId: revisionId,
              historyProvenance: "versioned",
              sectionSlug: "overview",
              sectionIndex: 0,
            }),
          }),
        ],
      }),
    );
    expect(approveDocument).toHaveBeenCalledWith(
      `gendoc-doc-1:${revisionId}`,
      { id: "user-1" },
      { signal: undefined },
    );
    expect(result).toEqual({
      status: "published",
      chunkCount: 1,
      syntheticDocumentId: `gendoc-doc-1:${revisionId}`,
    });
  });

  it("publishGeneratedDocRevision propagates trusted derived ACLs into quarantine metadata", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { generatedDocRevisionId } =
      await import("../../src/lib/docs-gen/generated-doc-provenance.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const revisionId = generatedDocRevisionId({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      version: 3,
    });
    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 3,
      revisionId,
      content: "## Overview\n\nAlpha",
    });
    resolveEvidencePolicy.mockResolvedValueOnce({
      actor: { userId: "user-1", role: "admin" },
      aclSubjects: [
        { kind: "user", value: "user-1" },
        { kind: "group", value: "sso-admins" },
      ],
    });

    await publishGeneratedDocRevision({
      generatedDocumentId: "doc-1",
      projectId: "proj-1",
      version: 3,
      revisionId,
    });

    expect(writeQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({
        aclSubjects: [
          { kind: "user", value: "user-1" },
          { kind: "group", value: "sso-admins" },
        ],
      }),
    );
  });

  it("publishGeneratedDocRevision respects normal approval policy instead of force auto-approving", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { generatedDocRevisionId } =
      await import("../../src/lib/docs-gen/generated-doc-provenance.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const revisionId = generatedDocRevisionId({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      version: 3,
    });
    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 3,
      revisionId,
      content: "## Overview\n\nAlpha",
    });
    (prisma.document.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    shouldAutoApprove.mockResolvedValueOnce(false);
    approveDocument.mockRejectedValueOnce(new Error("should not auto-approve"));

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId,
      }),
    ).resolves.toEqual({
      status: "published",
      chunkCount: 1,
      syntheticDocumentId: `gendoc-doc-1:${revisionId}`,
    });
    expect(approveDocument).not.toHaveBeenCalled();
  });

  it("publishGeneratedDocRevision does not report indexed success when BM25 approval fails", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { generatedDocRevisionId } =
      await import("../../src/lib/docs-gen/generated-doc-provenance.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const revisionId = generatedDocRevisionId({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      version: 3,
    });
    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 3,
      revisionId,
      content: "## Overview\n\nAlpha",
    });
    approveDocument.mockRejectedValueOnce(new Error("bm25 refresh failed"));

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId,
      }),
    ).rejects.toThrow(/bm25 refresh failed/);
  });

  it("publishGeneratedDocRevision indexes empty markdown without embeddings", async () => {
    approveDocument.mockResolvedValue({ chunkCount: 0 });
    const { prisma } = await import("../../src/lib/prisma.js");
    const { generatedDocRevisionId } =
      await import("../../src/lib/docs-gen/generated-doc-provenance.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const revisionId = generatedDocRevisionId({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      version: 3,
    });
    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 3,
      revisionId,
      content: "   \n\n  ",
    });

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId,
      }),
    ).resolves.toEqual({
      status: "published",
      chunkCount: 0,
      syntheticDocumentId: `gendoc-doc-1:${revisionId}`,
    });

    expect(embed).not.toHaveBeenCalled();
    expect(writeQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({ chunks: [], onlyIfUnpublished: true }),
    );
    expect(approveDocument).toHaveBeenCalledWith(
      `gendoc-doc-1:${revisionId}`,
      { id: "user-1" },
      { signal: undefined },
    );
    expect(prisma.quarantineChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: "gendoc-doc-1", ord: { gte: 0 } },
    });
    expect(prisma.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: "gendoc-doc-1" },
    });
    expect(vectorDeleteByDocument).toHaveBeenCalledWith("proj-1", "gendoc-doc-1");
    expect(bm25RemoveDocument).toHaveBeenCalledWith("proj-1", "gendoc-doc-1");
  });

  it("publishGeneratedDocRevision rejects embedder vector-count mismatches", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { generatedDocRevisionId } =
      await import("../../src/lib/docs-gen/generated-doc-provenance.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const revisionId = generatedDocRevisionId({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      version: 3,
    });
    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 3,
      revisionId,
      content: "## First\n\nAlpha\n\n## Second\n\nBeta",
    });
    embed.mockResolvedValueOnce({
      model: "test-embed-model",
      identity: "test-embed-model@1",
      vectors: [[0.1, 0.2]],
    });

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId,
      }),
    ).rejects.toThrow(/embedder returned 1 vectors for a batch of 2 texts/);

    expect(writeQuarantine).not.toHaveBeenCalled();
    expect(approveDocument).not.toHaveBeenCalled();
  });

  it("reconciles a delayed deletion before writing quarantine chunks", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { generatedDocRevisionId } =
      await import("../../src/lib/docs-gen/generated-doc-provenance.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const revisionId = generatedDocRevisionId({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      version: 3,
    });
    const liveDoc = {
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    };
    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(liveDoc)
      .mockResolvedValueOnce({ ...liveDoc, deletedAt: new Date("2026-01-01T00:00:00.000Z") });
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: 3,
      revisionId,
      content: "## Overview\n\nAlpha",
    });

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId,
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "deleted",
      syntheticDocumentId: `gendoc-doc-1:${revisionId}`,
    });

    expect(storageWrite).toHaveBeenCalledTimes(1);
    expect(writeQuarantine).not.toHaveBeenCalled();
    expect(approveDocument).not.toHaveBeenCalled();
    expect(prisma.quarantineChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: `gendoc-doc-1:${revisionId}`, ord: { gte: 0 } },
    });
    expect(prisma.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: `gendoc-doc-1:${revisionId}` },
    });
    expect(vectorDeleteByDocument).toHaveBeenCalledWith("proj-1", `gendoc-doc-1:${revisionId}`);
  });

  it("reconciles a superseded revision after quarantine write and before approval", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { generatedDocRevisionId } =
      await import("../../src/lib/docs-gen/generated-doc-provenance.js");
    const { publishGeneratedDocRevision } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const revisionId = generatedDocRevisionId({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      version: 3,
    });
    const liveDoc = {
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    };
    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(liveDoc)
      .mockResolvedValueOnce(liveDoc)
      .mockResolvedValueOnce(liveDoc);
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ version: 3, revisionId, content: "## Overview\n\nAlpha" })
      .mockResolvedValueOnce({ version: 3, revisionId, content: "## Overview\n\nAlpha" })
      .mockResolvedValueOnce({
        version: 3,
        revisionId: "gendoc:proj-1:doc-1:v4",
        content: "## Overview\n\nNewer",
      });

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId,
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "superseded",
      syntheticDocumentId: `gendoc-doc-1:${revisionId}`,
    });

    expect(writeQuarantine).toHaveBeenCalledTimes(1);
    expect(approveDocument).not.toHaveBeenCalled();
    expect(prisma.quarantineChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: `gendoc-doc-1:${revisionId}`, ord: { gte: 0 } },
    });
    expect(prisma.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: `gendoc-doc-1:${revisionId}` },
    });
    expect(vectorDeleteByDocument).toHaveBeenCalledWith("proj-1", `gendoc-doc-1:${revisionId}`);
    expect(bm25RemoveDocument).toHaveBeenCalledWith("proj-1", `gendoc-doc-1:${revisionId}`);
    expect(documentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: `gendoc-doc-1:${revisionId}`, projectId: "proj-1" },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          indexState: "rejected",
          chunkCount: 0,
        }),
      }),
    );
  });

  it("publishGeneratedDocRevision falls back to embedder.model and splits oversized sections", async () => {
    const { prisma } = await import("../../src/lib/prisma.js");
    const { generatedDocRevisionId } =
      await import("../../src/lib/docs-gen/generated-doc-provenance.js");
    const { publishGeneratedDocRevision, DOCSGEN_CHUNKER_IDENTITY } =
      await import("../../src/lib/docs-gen/generated-doc-publication.js");

    const revisionId = generatedDocRevisionId({
      projectId: "proj-1",
      generatedDocumentId: "doc-1",
      version: 3,
    });
    const longParagraph = "A".repeat(800);
    const content = `## Overview\n\n${longParagraph}\n\n${longParagraph}\n\n${longParagraph}`;
    (prisma.generatedDocument.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "doc-1",
      projectId: "proj-1",
      title: "Doc",
      deletedAt: null,
      evidencePolicy: "{}",
      scope: "full",
      scopeFilter: "{}",
    });
    (prisma.generatedDocumentVersion.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 3,
      revisionId,
      content,
    });
    embed.mockResolvedValueOnce({
      model: "embed-model-no-identity",
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
        [0.5, 0.6],
      ],
    });
    approveDocument.mockResolvedValueOnce({ chunkCount: 3 });

    await expect(
      publishGeneratedDocRevision({
        generatedDocumentId: "doc-1",
        projectId: "proj-1",
        version: 3,
        revisionId,
      }),
    ).resolves.toEqual({
      status: "published",
      chunkCount: 3,
      syntheticDocumentId: `gendoc-doc-1:${revisionId}`,
    });

    expect(writeQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingModel: "embed-model-no-identity",
        chunkerIdentity: DOCSGEN_CHUNKER_IDENTITY,
        chunks: [
          expect.objectContaining({ headings: ["Overview"] }),
          expect.objectContaining({ headings: ["Overview"] }),
          expect.objectContaining({ headings: ["Overview"] }),
        ],
      }),
    );
  });
});
