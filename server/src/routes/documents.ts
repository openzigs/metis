/**
 * /api/projects/:projectId/documents — upload + list + delete
 * /api/projects/:projectId/retrieve   — knowledge search
 *
 * Phase 5 / issues #39, #43.
 *
 * Uploads use Multer's memory storage capped at MAX_DOCUMENT_BYTES so the
 * raw bytes are validated by `validateUpload` (size, MIME allowlist,
 * magic-byte sniff) before any filesystem write happens. Successful uploads
 * persist a `Document` row in `pending` state, then synchronously trigger the
 * RAG ingest pipeline. Realtime status is mirrored over Socket.IO via the
 * `KnowledgeService` `emit` hook.
 */
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import {
  type ApiResponse,
  MAX_DOCUMENT_BYTES,
  retrieveQuerySchema,
  updateDocumentAclSchema,
  updateAutoApproveSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";
import { retrieveRateLimiter, uploadRateLimiter } from "../middleware/upload-rate-limit.js";
import { audit } from "../lib/audit/audit-service.js";
import { prisma } from "../lib/prisma.js";
import { getDocumentStorage, type StorageBackend } from "../lib/documents/storage.js";
import { validateUpload } from "../lib/documents/upload.js";
import { fetchUrlForIngest, UrlFetchError } from "../lib/documents/url-fetcher.js";
import { collapseUrlFetchRejection } from "../lib/documents/url-fetch-rejection.js";
import { getKnowledgeService, type KnowledgeService } from "../lib/rag/knowledge-service.js";
import { getIngestQueue, type IngestQueue } from "../lib/rag/ingest-queue.js";
import { getProject } from "../lib/projects/project-service.js";
import { approveDocument, rejectDocument } from "../lib/rag/quarantine.js";
import { propagateAcl } from "../lib/rag/acl.js";
import { createChildLogger } from "../lib/logger.js";
import {
  indexingFailureMessage,
  publicDocumentRow,
  publicIndexingErrorMessage,
} from "../lib/rag/indexing-failure-message.js";

const log = createChildLogger("documents-routes");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
});

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorFromReq(req: Request) {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

async function ensureProjectActive(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
  if (project.status === "archived") {
    throw new AppError(409, "PROJECT_ARCHIVED", "Cannot mutate an archived project");
  }
  return project;
}

export interface DocumentsRouterDeps {
  storage?: StorageBackend;
  knowledge?: KnowledgeService;
  /** Issue #133 — when present, ingest is enqueued instead of inline. */
  ingestQueue?: IngestQueue | null;
}

export function documentsRouter(deps: DocumentsRouterDeps = {}): Router {
  // mergeParams so :projectId from the parent mount is visible.
  const r = Router({ mergeParams: true });
  // Epic #671 / #674 — object-level project scope (OWASP A01 / BOLA). A
  // cross-tenant `documentId` under a foreign `projectId` must never disclose or
  // delete another tenant's documents. Gate the whole subtree on workspace
  // membership before any handler runs; non-members get a 404, admins bypass.
  r.use(requireAuth, requireProjectAccess());
  const storage = deps.storage ?? getDocumentStorage();
  const knowledge = deps.knowledge ?? getKnowledgeService();
  // `null` opts out of the queue (used by tests that want synchronous
  // behavior); `undefined` falls through to the singleton.
  const ingestQueue = deps.ingestQueue === null ? null : (deps.ingestQueue ?? getIngestQueue());

  async function handleIngest(documentId: string): Promise<{
    documentId: string;
    status: string;
    chunkCount: number;
    queued: boolean;
    errorMessage?: string;
  }> {
    if (ingestQueue) {
      try {
        await ingestQueue.enqueue(documentId, { priority: "manual" });
        return { documentId, status: "queued", chunkCount: 0, queued: true };
      } catch (err) {
        log.warn("document enqueue failed", { documentId, error: String(err) });
        return {
          documentId,
          status: "failed",
          chunkCount: 0,
          queued: false,
          // #98 — the ingest exception stays in the server log.
          errorMessage: indexingFailureMessage(err),
        };
      }
    }
    try {
      const result = await knowledge.ingestDocument(documentId);
      return {
        documentId,
        status: result.status,
        chunkCount: result.chunkCount,
        queued: false,
        errorMessage: publicIndexingErrorMessage(result.errorMessage) ?? undefined,
      };
    } catch (err) {
      log.warn("document ingest failed", { documentId, error: String(err) });
      return {
        documentId,
        status: "failed",
        chunkCount: 0,
        queued: false,
        // #98 — the ingest exception stays in the server log.
        errorMessage: indexingFailureMessage(err),
      };
    }
  }

  // ── Upload ──────────────────────────────────────────────────────────────
  r.post(
    "/",
    requireAuth,
    requirePermission("document.upload"),
    uploadRateLimiter,
    upload.single("file"),
    async (req: Request, res: Response) => {
      const actor = actorFromReq(req);
      const projectId = String(req.params.projectId);
      await ensureProjectActive(projectId);

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        throw new AppError(400, "FILE_REQUIRED", "Multipart field 'file' is required");
      }
      const validation = validateUpload({
        filename: file.originalname,
        mimeType: file.mimetype,
        buffer: file.buffer,
      });
      if (!validation.ok) {
        throw new AppError(validation.status, validation.code, validation.message);
      }

      const stored = await storage.write({ projectId, buffer: file.buffer });
      const document = await prisma.document.create({
        data: {
          projectId,
          filename: validation.filename,
          mimeType: validation.mimeType,
          sizeBytes: stored.sizeBytes,
          storagePath: stored.storagePath,
          checksum: stored.checksum,
          uploadedById: actor.id,
          status: "pending",
        },
      });
      audit({
        actor: { id: actor.id },
        action: "document.upload",
        target: { type: "document", id: document.id },
        metadata: {
          projectId,
          filename: validation.filename,
          sizeBytes: stored.sizeBytes,
          deduplicated: stored.deduplicated,
        },
      });

      // Issue #133 — when a queue is wired (production), enqueue and return
      // 202 immediately so the HTTP latency stays bounded. Tests can opt out
      // by passing `ingestQueue: null` to documentsRouter for synchronous
      // behavior + a 201.
      const ingest = await handleIngest(document.id);
      const refreshed = await prisma.document.findUnique({ where: { id: document.id } });
      const httpStatus = ingest.queued ? 202 : 201;
      res.status(httpStatus).json(ok({ document: publicDocumentRow(refreshed), ingest }));
    },
  );

  // ── Ingest from URL (issue #132) ───────────────────────────────────────
  // Hostname allow-list via INGEST_URL_ALLOWLIST (regex CSV). DNS-resolved
  // private/loopback/link-local IPs are always rejected. Same MIME allow-list
  // and size cap as multipart uploads.
  r.post(
    "/url",
    requireAuth,
    requirePermission("document.upload"),
    uploadRateLimiter,
    async (req: Request, res: Response) => {
      const actor = actorFromReq(req);
      const projectId = String(req.params.projectId);
      await ensureProjectActive(projectId);

      const parsed = urlIngestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid url ingest payload", {
          issues: parsed.error.flatten(),
        });
      }
      let fetched;
      try {
        fetched = await fetchUrlForIngest(parsed.data.url);
      } catch (err) {
        if (err instanceof UrlFetchError) {
          // #1084 — the URL is fully caller-supplied, so a rejection that
          // depends on how the host resolved is reconnaissance. Collapse it;
          // the reason is kept in the server-side log.
          throw collapseUrlFetchRejection(err, { url: parsed.data.url, projectId });
        }
        throw err;
      }
      const validation = validateUpload({
        filename: parsed.data.filename ?? fetched.filename,
        mimeType: fetched.contentType,
        buffer: fetched.buffer,
      });
      if (!validation.ok) {
        throw new AppError(validation.status, validation.code, validation.message);
      }
      const stored = await storage.write({ projectId, buffer: fetched.buffer });
      const document = await prisma.document.create({
        data: {
          projectId,
          filename: validation.filename,
          mimeType: validation.mimeType,
          sizeBytes: stored.sizeBytes,
          storagePath: stored.storagePath,
          checksum: stored.checksum,
          uploadedById: actor.id,
          status: "pending",
        },
      });
      audit({
        actor: { id: actor.id },
        action: "document.upload",
        target: { type: "document", id: document.id },
        metadata: {
          projectId,
          filename: validation.filename,
          sizeBytes: stored.sizeBytes,
          source: "url",
          url: fetched.finalUrl,
          deduplicated: stored.deduplicated,
        },
      });
      const ingest = await handleIngest(document.id);
      const refreshed = await prisma.document.findUnique({ where: { id: document.id } });
      const httpStatus = ingest.queued ? 202 : 201;
      res
        .status(httpStatus)
        .json(
          ok({ document: publicDocumentRow(refreshed), ingest, source: { url: fetched.finalUrl } }),
        );
    },
  );

  // ── Ingest raw text (issue #132) ───────────────────────────────────────
  // Skips the network entirely — useful for pasting agent transcripts or
  // notes into a project. Same size cap and pipeline as uploads.
  r.post(
    "/text",
    requireAuth,
    requirePermission("document.upload"),
    uploadRateLimiter,
    async (req: Request, res: Response) => {
      const actor = actorFromReq(req);
      const projectId = String(req.params.projectId);
      await ensureProjectActive(projectId);

      const parsed = textIngestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid text ingest payload", {
          issues: parsed.error.flatten(),
        });
      }
      const filename = parsed.data.filename;
      const buffer = Buffer.from(parsed.data.content, "utf8");
      const mimeType = parsed.data.mimeType ?? inferMimeFromFilename(filename);
      const validation = validateUpload({ filename, mimeType, buffer });
      if (!validation.ok) {
        throw new AppError(validation.status, validation.code, validation.message);
      }
      const stored = await storage.write({ projectId, buffer });
      const document = await prisma.document.create({
        data: {
          projectId,
          filename: validation.filename,
          mimeType: validation.mimeType,
          sizeBytes: stored.sizeBytes,
          storagePath: stored.storagePath,
          checksum: stored.checksum,
          uploadedById: actor.id,
          status: "pending",
        },
      });
      audit({
        actor: { id: actor.id },
        action: "document.upload",
        target: { type: "document", id: document.id },
        metadata: {
          projectId,
          filename: validation.filename,
          sizeBytes: stored.sizeBytes,
          source: "text",
          deduplicated: stored.deduplicated,
        },
      });
      const ingest = await handleIngest(document.id);
      const refreshed = await prisma.document.findUnique({ where: { id: document.id } });
      const httpStatus = ingest.queued ? 202 : 201;
      res.status(httpStatus).json(ok({ document: publicDocumentRow(refreshed), ingest }));
    },
  );

  // ── List ────────────────────────────────────────────────────────────────
  r.get("/", requireAuth, requirePermission("document.read"), async (req, res) => {
    const projectId = String(req.params.projectId);
    const project = await getProject(projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    const limit = clampInt(req.query.limit, 25, 1, 100);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
    const where = { projectId, deletedAt: null };
    const [items, total] = await Promise.all([
      prisma.document.findMany({
        where,
        orderBy: { uploadedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.document.count({ where }),
    ]);
    res.json(ok({ items: items.map((item) => publicDocumentRow(item)), total, limit, offset }));
  });

  // ── Get one ─────────────────────────────────────────────────────────────
  r.get("/:documentId", requireAuth, requirePermission("document.read"), async (req, res) => {
    const projectId = String(req.params.projectId);
    const documentId = String(req.params.documentId);
    const document = await prisma.document.findFirst({
      where: { id: documentId, projectId, deletedAt: null },
    });
    if (!document) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    res.json(ok(publicDocumentRow(document)));
  });

  // ── Delete ──────────────────────────────────────────────────────────────
  r.delete("/:documentId", requireAuth, requirePermission("document.delete"), async (req, res) => {
    const actor = actorFromReq(req);
    const projectId = String(req.params.projectId);
    const documentId = String(req.params.documentId);
    const document = await prisma.document.findFirst({
      where: { id: documentId, projectId, deletedAt: null },
    });
    if (!document) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    await knowledge.deleteDocument(documentId);
    audit({
      actor: { id: actor.id },
      action: "document.delete",
      target: { type: "document", id: documentId },
      metadata: { projectId },
    });
    res.status(204).end();
  });

  // ── Approve quarantined document (epic #157) ────────────────────────────
  r.post(
    "/:documentId/approve",
    requireAuth,
    requirePermission("document.upload"),
    async (req, res) => {
      const actor = actorFromReq(req);
      const projectId = String(req.params.projectId);
      const documentId = String(req.params.documentId);
      const doc = await prisma.document.findFirst({
        where: { id: documentId, projectId, deletedAt: null },
      });
      if (!doc) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
      try {
        const result = await approveDocument(documentId, { id: actor.id });
        const refreshed = await prisma.document.findUnique({ where: { id: documentId } });
        res.json(ok({ document: publicDocumentRow(refreshed), ...result }));
      } catch (err) {
        throw new AppError(409, "DOCUMENT_APPROVE_FAILED", (err as Error).message);
      }
    },
  );

  // ── Reject quarantined document (epic #157) ─────────────────────────────
  r.post(
    "/:documentId/reject",
    requireAuth,
    requirePermission("document.upload"),
    async (req, res) => {
      const actor = actorFromReq(req);
      const projectId = String(req.params.projectId);
      const documentId = String(req.params.documentId);
      const doc = await prisma.document.findFirst({
        where: { id: documentId, projectId, deletedAt: null },
      });
      if (!doc) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
      const reasonParse = z
        .object({ reason: z.string().max(500).optional() })
        .safeParse(req.body ?? {});
      const reason = reasonParse.success ? reasonParse.data.reason : undefined;
      try {
        await rejectDocument(documentId, { id: actor.id }, reason);
        const refreshed = await prisma.document.findUnique({ where: { id: documentId } });
        res.json(ok({ document: publicDocumentRow(refreshed) }));
      } catch (err) {
        throw new AppError(409, "DOCUMENT_REJECT_FAILED", (err as Error).message);
      }
    },
  );

  // ── Update document ACL (epic #157) ─────────────────────────────────────
  r.patch(
    "/:documentId/acl",
    requireAuth,
    requirePermission("document.upload"),
    async (req, res) => {
      const actor = actorFromReq(req);
      const projectId = String(req.params.projectId);
      const documentId = String(req.params.documentId);
      const parsed = updateDocumentAclSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid ACL payload", {
          issues: parsed.error.flatten(),
        });
      }
      const doc = await prisma.document.findFirst({
        where: { id: documentId, projectId, deletedAt: null },
      });
      if (!doc) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
      const chunkCount = await propagateAcl(documentId, parsed.data.aclSubjects);
      audit({
        actor: { id: actor.id },
        action: "document.acl.update",
        target: { type: "document", id: documentId },
        metadata: {
          projectId,
          subjects: parsed.data.aclSubjects,
          chunkCount,
        },
      });
      res.json(ok({ chunkCount, aclSubjects: parsed.data.aclSubjects }));
    },
  );

  // ── Toggle per-document auto-approve (epic #157) ────────────────────────
  r.patch(
    "/:documentId/auto-approve",
    requireAuth,
    requirePermission("document.upload"),
    async (req, res) => {
      const actor = actorFromReq(req);
      const projectId = String(req.params.projectId);
      const documentId = String(req.params.documentId);
      const parsed = updateAutoApproveSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const doc = await prisma.document.findFirst({
        where: { id: documentId, projectId, deletedAt: null },
      });
      if (!doc) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
      const updated = await prisma.document.update({
        where: { id: documentId },
        data: { autoApproveTrusted: parsed.data.autoApproveTrusted },
      });
      audit({
        actor: { id: actor.id },
        action: "document.autoApprove.update",
        target: { type: "document", id: documentId },
        metadata: { projectId, autoApproveTrusted: parsed.data.autoApproveTrusted },
      });
      res.json(ok(publicDocumentRow(updated)));
    },
  );

  // Epic #724 — toggle spec tag on a document (used by spec-checking scan mode).
  r.patch(
    "/:documentId/spec",
    requireAuth,
    requirePermission("document.upload"),
    async (req, res) => {
      const actor = actorFromReq(req);
      const projectId = String(req.params.projectId);
      const documentId = String(req.params.documentId);
      const { isSpec } = req.body ?? {};
      if (typeof isSpec !== "boolean") {
        throw new AppError(400, "VALIDATION_ERROR", "isSpec must be a boolean");
      }
      const doc = await prisma.document.findFirst({
        where: { id: documentId, projectId, deletedAt: null },
      });
      if (!doc) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
      const updated = await prisma.document.update({
        where: { id: documentId },
        data: { isSpec },
      });
      audit({
        actor: { id: actor.id },
        action: "document.spec.update",
        target: { type: "document", id: documentId },
        metadata: { projectId, isSpec },
      });
      res.json(ok(publicDocumentRow(updated)));
    },
  );

  return r;
}

export interface KnowledgeRouterDeps {
  knowledge?: KnowledgeService;
}

export function knowledgeRouter(deps: KnowledgeRouterDeps = {}): Router {
  const r = Router({ mergeParams: true });
  // Epic #671 / #674 — scope knowledge retrieval to the caller's workspace so a
  // foreign `projectId` cannot search another tenant's ingested knowledge.
  r.use(requireAuth, requireProjectAccess());
  const knowledge = deps.knowledge ?? getKnowledgeService();

  // ── Retrieval ───────────────────────────────────────────────────────────
  r.post(
    "/retrieve",
    requireAuth,
    requirePermission("document.read"),
    retrieveRateLimiter,
    async (req: Request, res: Response) => {
      const actor = actorFromReq(req);
      const projectId = String(req.params.projectId);
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
      const parsed = retrieveQuerySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid retrieve payload", {
          issues: parsed.error.flatten(),
        });
      }
      const { hits, coverageWarning, mode, reranked } = await knowledge.search(
        projectId,
        parsed.data.query,
        {
          k: parsed.data.k,
          documentIds: parsed.data.documentIds,
          mode: parsed.data.mode,
        },
      );
      audit({
        actor: { id: actor.id },
        action: "knowledge.search",
        target: { type: "project", id: projectId },
        metadata: {
          hitCount: hits.length,
          k: parsed.data.k ?? null,
          mode,
          reranked: reranked ?? false,
          coverageWarning: coverageWarning ?? null,
        },
      });
      res.json(ok({ hits, coverageWarning, mode, reranked: reranked ?? false }));
    },
  );

  return r;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const urlIngestSchema = z.object({
  url: z.string().url().min(1).max(4096),
  /** Optional override — defaults to the URL's last path segment. */
  filename: z.string().min(1).max(255).optional(),
});

const textIngestSchema = z.object({
  filename: z.string().min(1).max(255),
  content: z.string().min(1).max(MAX_DOCUMENT_BYTES),
  /** Defaults to inference from the filename extension. */
  mimeType: z.string().min(1).max(120).optional(),
});

function inferMimeFromFilename(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "html":
    case "htm":
      return "text/html";
    case "json":
      return "application/json";
    case "txt":
    default:
      return "text/plain";
  }
}
