/**
 * /api/projects/:projectId/documents — upload + list + delete
 * /api/projects/:projectId/retrieve   — knowledge search
 *
 * Phase 5 / issues #39, #43.
 *
 * Uploads use Multer's memory storage capped at MAX_DOCUMENT_BYTES
 * (`documentFile`, shared with the governing route, #1921) so the
 * raw bytes are validated by `validateUpload` (size, MIME allowlist,
 * magic-byte sniff) before any filesystem write happens. Successful uploads
 * persist a `Document` row in `pending` state, then synchronously trigger the
 * RAG ingest pipeline. Realtime status is mirrored over Socket.IO via the
 * `KnowledgeService` `emit` hook.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  type AclSubject,
  aclSubjectsSchema,
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
import { documentFile } from "../middleware/document-file-upload.js";
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
import {
  AclEditForbiddenError,
  AclGroupUnsupportedError,
  newGroupSubjects,
  resolveAclActor,
  saveDocumentAcl,
  serializeAclSubjects,
  type AclActor,
} from "../lib/rag/acl.js";
import { aclSaveErrorAsHttp, inactiveCallerAsUnauthenticated } from "./acl-errors.js";
import { createChildLogger } from "../lib/logger.js";
import {
  aclUserNames,
  canSeeDocument,
  documentAccessOf,
  documentVisibilityFor,
  restrictedDocumentRow,
  type DocumentAccess,
} from "../lib/documents/document-visibility.js";
import {
  approvalFailureMessage,
  indexingFailureMessage,
  publicDocumentRow,
  publicIndexingErrorMessage,
} from "../lib/rag/indexing-failure-message.js";

const log = createChildLogger("documents-routes");

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorFromReq(req: Request) {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

/**
 * #2547 — the caller as the ACL sees them (durable role, live account), for a
 * route that says whether they can read each document. An inactive caller is
 * the 401 `TOKEN_INVALID` #2261 chose.
 */
function callerAclActor(req: Request): Promise<AclActor> {
  return resolveAclActor(actorFromReq(req).id).catch((err: unknown) => {
    throw inactiveCallerAsUnauthenticated(err);
  });
}

/**
 * #2547 — owner policy: a member who cannot read a document under its current
 * access list cannot manage it either (approve, reject, the auto-approve and
 * spec toggles; the access list itself is refused inside `saveDocumentAcl`).
 * The row is already listed to them as restricted, so a 403 names nothing the
 * list does not; the attempt is audited as `<action>.denied`.
 */
async function refuseUnlessReader(
  actorId: string,
  doc: { id: string; aclSubjects: string },
  projectId: string,
  action: string,
): Promise<void> {
  if (await canSeeDocument(actorId, doc)) return;
  auditManageDenied(actorId, doc.id, projectId, action);
  throw new AppError(
    403,
    "DOCUMENT_RESTRICTED",
    "This document is restricted and you are not one of its readers, so you cannot manage it. Ask one of its readers or an admin.",
  );
}

/** #2547 — the audit row of a refused change to a document the caller cannot read. */
function auditManageDenied(actorId: string, documentId: string, projectId: string, action: string) {
  audit({
    actor: { id: actorId },
    action: `${action}.denied`,
    target: { type: "document", id: documentId },
    metadata: { projectId, reason: "document_restricted" },
  });
}

/**
 * #2555 — the access list a file upload is restricted to from the start, so
 * the document is never open to the whole project while it is indexed and
 * reviewed: the row is created with it, and ingest and approval copy the
 * document's own list onto every chunk (#2435). It arrives as the multipart
 * field `aclSubjects`, a JSON array of subjects. Absent or empty: unrestricted,
 * as before. A `group` subject is refused as `PATCH /acl` refuses a new one
 * (#2261: METIS stores no group membership, so it would match no one).
 */
function uploadAclSubjects(raw: unknown): AclSubject[] {
  if (raw === undefined || raw === "") return [];
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new AppError(400, "VALIDATION_ERROR", "aclSubjects must be a JSON array of subjects");
    }
  }
  const parsed = aclSubjectsSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid ACL payload", {
      issues: parsed.error.flatten(),
    });
  }
  const groups = newGroupSubjects([], parsed.data);
  if (groups.length > 0) throw aclSaveErrorAsHttp(new AclGroupUnsupportedError(groups));
  return parsed.data;
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

  /**
   * `uploaderId` (#2343) is told when a queued ingest ends. A synchronous
   * ingest answers the request itself, so the uploader is already looking.
   */
  async function handleIngest(
    documentId: string,
    uploaderId: string,
  ): Promise<{
    documentId: string;
    status: string;
    chunkCount: number;
    queued: boolean;
    errorMessage?: string;
  }> {
    if (ingestQueue) {
      try {
        await ingestQueue.enqueue(documentId, { priority: "manual", notifyUserId: uploaderId });
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
    documentFile,
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
      // #2555 — checked before anything is stored, so a refused list writes nothing.
      const aclSubjects = uploadAclSubjects(
        (req.body as Record<string, unknown> | undefined)?.aclSubjects,
      );

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
          ...(aclSubjects.length > 0 ? { aclSubjects: serializeAclSubjects(aclSubjects) } : {}),
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
          ...(aclSubjects.length > 0 ? { aclSubjects } : {}),
        },
      });

      // Issue #133 — when a queue is wired (production), enqueue and return
      // 202 immediately so the HTTP latency stays bounded. Tests can opt out
      // by passing `ingestQueue: null` to documentsRouter for synchronous
      // behavior + a 201.
      const ingest = await handleIngest(document.id, actor.id);
      const refreshed = await prisma.document.findUnique({ where: { id: document.id } });
      const httpStatus = ingest.queued ? 202 : 201;
      // #2548 — the same file under the same name is accepted, and said.
      const duplicateOf = await readableDuplicate(actor.id, document);
      res.status(httpStatus).json(
        ok({
          document: publicDocumentRow(refreshed),
          ingest,
          ...(duplicateOf ? { duplicateOf } : {}),
        }),
      );
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
      const ingest = await handleIngest(document.id, actor.id);
      const refreshed = await prisma.document.findUnique({ where: { id: document.id } });
      const httpStatus = ingest.queued ? 202 : 201;
      const duplicateOf = await readableDuplicate(actor.id, document);
      res.status(httpStatus).json(
        ok({
          document: publicDocumentRow(refreshed),
          ingest,
          source: { url: fetched.finalUrl },
          ...(duplicateOf ? { duplicateOf } : {}),
        }),
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
      const ingest = await handleIngest(document.id, actor.id);
      const refreshed = await prisma.document.findUnique({ where: { id: document.id } });
      const httpStatus = ingest.queued ? 202 : 201;
      const duplicateOf = await readableDuplicate(actor.id, document);
      res.status(httpStatus).json(
        ok({
          document: publicDocumentRow(refreshed),
          ingest,
          ...(duplicateOf ? { duplicateOf } : {}),
        }),
      );
    },
  );

  // ── List ────────────────────────────────────────────────────────────────
  r.get("/", requireAuth, requirePermission("document.read"), async (req, res) => {
    const projectId = String(req.params.projectId);
    const project = await getProject(projectId);
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    const limit = clampInt(req.query.limit, 25, 1, 100);
    const where = { projectId, deletedAt: null };
    // #440 — newest first, with the id breaking a tie in `uploadedAt`, so the
    // order is total and a cursor names one exact position in it.
    const orderBy = [{ uploadedAt: "desc" as const }, { id: "desc" as const }];

    // Cursor paging: the next page starts strictly after the last row the
    // client saw, so a row inserted or deleted mid-read cannot shift a later
    // page (offset paging over a changing list skips a row). A cursor page does
    // not re-run `count(*)` — the first page already reported the total.
    if (req.query.cursor !== undefined) {
      const after = decodeDocumentCursor(req.query.cursor);
      const rows = await prisma.document.findMany({
        where: {
          ...where,
          OR: [
            { uploadedAt: { lt: after.uploadedAt } },
            { uploadedAt: after.uploadedAt, id: { lt: after.id } },
          ],
        },
        orderBy,
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      res.json(
        ok({
          items: await readableDocumentRows(actorFromReq(req).id, projectId, page),
          limit,
          nextCursor: rows.length > limit ? encodeDocumentCursor(page[page.length - 1]) : null,
        }),
      );
      return;
    }

    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
    const [rows, total] = await Promise.all([
      prisma.document.findMany({ where, orderBy, take: limit + 1, skip: offset }),
      prisma.document.count({ where }),
    ]);
    const items = rows.slice(0, limit);
    res.json(
      ok({
        items: await readableDocumentRows(actorFromReq(req).id, projectId, items),
        total,
        limit,
        offset,
        nextCursor: rows.length > limit ? encodeDocumentCursor(items[items.length - 1]) : null,
      }),
    );
  });

  // ── Get one ─────────────────────────────────────────────────────────────
  r.get("/:documentId", requireAuth, requirePermission("document.read"), async (req, res) => {
    const projectId = String(req.params.projectId);
    const documentId = String(req.params.documentId);
    const document = await prisma.document.findFirst({
      where: { id: documentId, projectId, deletedAt: null },
    });
    if (!document) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
    const [row] = await readableDocumentRows(actorFromReq(req).id, projectId, [document]);
    res.json(ok(row));
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
    // #2548 — deleting is managing it: a member it is restricted away from may
    // not, as #2547 refuses them its approval (an admin keeps the bypass).
    await refuseUnlessReader(actor.id, document, projectId, "document.delete");
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
      await refuseUnlessReader(actor.id, doc, projectId, "document.approve");
      try {
        const result = await approveDocument(documentId, { id: actor.id });
        const refreshed = await prisma.document.findUnique({ where: { id: documentId } });
        // #2546 — the row as the caller may see it, as the list shows it.
        res.json(
          ok({ document: await readableDocumentRow(actor.id, projectId, refreshed), ...result }),
        );
      } catch (err) {
        // #108 — the cleanup exception stays in the server log.
        log.warn("document approve failed", { documentId, error: String(err) });
        throw new AppError(409, "DOCUMENT_APPROVE_FAILED", approvalFailureMessage(err));
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
      await refuseUnlessReader(actor.id, doc, projectId, "document.reject");
      const reasonParse = z
        .object({ reason: z.string().max(500).optional() })
        .safeParse(req.body ?? {});
      const reason = reasonParse.success ? reasonParse.data.reason : undefined;
      try {
        await rejectDocument(documentId, { id: actor.id }, reason);
        const refreshed = await prisma.document.findUnique({ where: { id: documentId } });
        res.json(ok({ document: await readableDocumentRow(actor.id, projectId, refreshed) }));
      } catch (err) {
        // #108 — the cleanup exception stays in the server log.
        log.warn("document reject failed", { documentId, error: String(err) });
        throw new AppError(409, "DOCUMENT_REJECT_FAILED", approvalFailureMessage(err));
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
      // #2547 — an archived project's access lists are frozen like its
      // documents, on every surface that offers the editor.
      await ensureProjectActive(projectId);
      // #2261 — a NEW group subject is refused (400 ACL_GROUP_UNSUPPORTED).
      // #2356 — checked against the ACL the write replaces, not one read
      // earlier: a group another editor just removed is not "already held".
      // #2547 — so is the caller: one the document is restricted away from
      // may not rewrite its list (403 ACL_EDIT_FORBIDDEN, audited).
      const saved = await saveDocumentAcl({
        documentId,
        projectId,
        aclSubjects: parsed.data.aclSubjects,
        actor: await callerAclActor(req),
      }).catch((err: unknown) => {
        if (err instanceof AclEditForbiddenError) {
          auditManageDenied(actor.id, documentId, projectId, "document.acl.update");
        }
        throw aclSaveErrorAsHttp(err);
      });
      if (!saved) throw new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found");
      const { chunkCount } = saved;
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
      await refuseUnlessReader(actor.id, doc, projectId, "document.autoApprove.update");
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
      res.json(ok(await readableDocumentRow(actor.id, projectId, updated)));
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
      await refuseUnlessReader(actor.id, doc, projectId, "document.spec.update");
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
      res.json(ok(await readableDocumentRow(actor.id, projectId, updated)));
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
          // #2225 — the caller's chunk ACLs apply; `requireAuth` has no live
          // re-read here, so the role comes from durable state. #2261 — a
          // deprovisioned caller is a 401, not a 500.
          actor: await resolveAclActor(actor.id).catch((err: unknown) => {
            throw inactiveCallerAsUnauthenticated(err);
          }),
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

/**
 * #440 — an opaque list cursor: the last row's `uploadedAt` and `id`, the two
 * keys of the list's order. Base64url JSON, so a client never builds one.
 */
// Ids are not all cuids: a generated document's published row is
// `gendoc-<cuid>:gendoc:<projectId>:<cuid>:v<n>` (~94 chars), and a cursor the
// server issued for such a row must decode (PR #469 panel). 512 bounds it.
const MAX_CURSOR_ID_CHARS = 512;
const documentCursorSchema = z.object({
  t: z.string().datetime(),
  id: z.string().min(1).max(MAX_CURSOR_ID_CHARS),
});
/** base64url of the JSON above: ~4/3 of (id + timestamp + keys), rounded up. */
const MAX_CURSOR_CHARS = 1024;

function encodeDocumentCursor(row: { uploadedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.uploadedAt.toISOString(), id: row.id })).toString(
    "base64url",
  );
}

function decodeDocumentCursor(raw: unknown): { uploadedAt: Date; id: string } {
  let parsed: unknown;
  try {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_CHARS)
      throw new Error("shape");
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const cursor = documentCursorSchema.safeParse(parsed);
  if (!cursor.success) throw new AppError(400, "INVALID_CURSOR", "Invalid document list cursor");
  return { uploadedAt: new Date(cursor.data.t), id: cursor.data.id };
}

/**
 * #2546 — the rows as `userId` may see them: one whose access list does not
 * name them keeps its place (the list's length and paging are unchanged) but
 * is the allowlisted `restrictedDocumentRow`: marked `restricted`, named by the
 * placeholder, and without its access list, path, uploader or error text, so
 * the page offers nothing to do with it that reads its text.
 */
async function readableDocumentRows<
  T extends { aclSubjects: string; filename: string; errorMessage: string | null },
>(
  userId: string,
  projectId: string,
  rows: readonly T[],
): Promise<
  Array<
    | (T & { access: DocumentAccess })
    | (ReturnType<typeof restrictedDocumentRow<T>> & { access: DocumentAccess })
  >
> {
  const sees = await documentVisibilityFor(userId, rows);
  // #2555 — the people a list names, resolved only from the rows they may read.
  const names = await aclUserNames(projectId, rows.filter(sees));
  // #2547 — each row's `access`: who reads it, only to one who may read it.
  return rows.map((row) =>
    sees(row)
      ? { ...publicDocumentRow(row), access: documentAccessOf(row, true, names) }
      : { ...restrictedDocumentRow(publicDocumentRow(row)), access: documentAccessOf(row, false) },
  );
}

/**
 * #2548 — an earlier live document of the project with the same name and the
 * same content (checksum) as `doc`, which `userId` may read: the upload is kept
 * (a second copy may be meant) and the page warns. One the uploader cannot read
 * is never named, nor its existence confirmed: an upload is not a probe of a
 * restricted document's content.
 */
async function readableDuplicate(
  userId: string,
  doc: { id: string; projectId: string; filename: string; checksum: string },
): Promise<{ id: string; uploadedAt: Date } | null> {
  const same = await prisma.document.findMany({
    where: {
      projectId: doc.projectId,
      filename: doc.filename,
      checksum: doc.checksum,
      deletedAt: null,
      id: { not: doc.id },
    },
    orderBy: [{ uploadedAt: "asc" }, { id: "asc" }],
    select: { id: true, uploadedAt: true, aclSubjects: true },
  });
  if (same.length === 0) return null;
  const sees = await documentVisibilityFor(userId, same);
  const first = same.find(sees);
  return first ? { id: first.id, uploadedAt: first.uploadedAt } : null;
}

/** One row (or none) as `userId` may see it: see {@link readableDocumentRows}. */
async function readableDocumentRow<
  T extends { aclSubjects: string; filename: string; errorMessage: string | null },
>(userId: string, projectId: string, row: T | null) {
  return row ? (await readableDocumentRows(userId, projectId, [row]))[0]! : null;
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
