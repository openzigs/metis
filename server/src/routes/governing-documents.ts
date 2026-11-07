/**
 * /api/workspaces/:workspaceId/governing-documents — Epic #1866 (#1869).
 *
 * A workspace's governing documents (its policies and control frameworks):
 * upload, new revision, list, read and soft delete. Uploaded once per workspace
 * and indexed into the workspace's own governing table
 * (`lib/governing/governing-index.ts`), never into a project's.
 *
 *   POST   /                          admin+  multipart file, title, revisionLabel, effectiveDate, framework?
 *   POST   /:documentId/revisions     admin+  multipart file, revisionLabel, effectiveDate
 *   GET    /                          member+ live documents, each with its current revision
 *   GET    /:documentId               member+ one document with every revision
 *   DELETE /:documentId               admin+  soft delete
 *
 * Every route answers 404 while `GOVERNING_DOCS_ENABLED` is off, before
 * authentication runs. Access is the workspace's own roles
 * (`requireWorkspaceRole`): a non-member, and every workspace that is soft-
 * deleted, gets 404 — no oracle — and a member gets 403 on a write. Every by-id
 * read filters on the path workspace, so another workspace's document id is a
 * 404 too.
 *
 * Uploads take the project route's limits: `MAX_DOCUMENT_BYTES`, the
 * `UPLOAD_MIME_ALLOWLIST` and the magic-byte check (`validateUpload`), with the
 * same error codes. The stored blob's key is content-addressed under
 * `governing-<workspaceId>` and never contains the client's filename.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { type ApiResponse, MAX_DOCUMENT_BYTES } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceRole } from "../middleware/require-workspace-role.js";
import { AppError } from "../middleware/error-handler.js";
import { uploadRateLimiter } from "../middleware/upload-rate-limit.js";
import { audit } from "../lib/audit/audit-service.js";
import { getDocumentStorage, type StorageBackend } from "../lib/documents/storage.js";
import { validateUpload } from "../lib/documents/upload.js";
import { parseDocument } from "../lib/documents/parsers.js";
import { isGoverningDocsEnabled } from "../lib/governing/flag.js";
import { getGoverningIndex, type GoverningIndex } from "../lib/governing/governing-index.js";
import {
  addRevision,
  createDocumentWithRevision,
  documentExists,
  revisionLabelExists,
  getDocument,
  isWorkspaceLive,
  listDocuments,
  type RevisionInput,
  setRevisionIndexState,
  softDeleteDocument,
} from "../lib/governing/governing-store.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("governing-documents-routes");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
});

/**
 * `upload.single("file")`, with Multer's own errors given the project upload
 * contract's codes: an over-size file is 413 `FILE_TOO_LARGE`, the code and
 * message `validateUpload` gives a buffer over the cap.
 */
function singleFile(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(new AppError(413, "FILE_TOO_LARGE", `File exceeds ${MAX_DOCUMENT_BYTES} byte limit`));
        return;
      }
      next(new AppError(400, "UPLOAD_ERROR", "Upload failed: one file in the 'file' field"));
      return;
    }
    next(err);
  });
}

/** `YYYY-MM-DD` or an ISO date-time. */
const effectiveDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const revisionLabel = z.string().trim().min(1).max(64);

const revisionFieldsSchema = z.object({ revisionLabel, effectiveDate });
const uploadFieldsSchema = revisionFieldsSchema.extend({
  title: z.string().trim().min(1).max(300),
  framework: z.string().trim().min(1).max(200).optional(),
});

function labelExists(): AppError {
  return new AppError(
    409,
    "REVISION_LABEL_EXISTS",
    "This document already has a revision with that label",
  );
}

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorOf(req: Request): { id: string; role: string } {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

function notFound(): AppError {
  return new AppError(404, "NOT_FOUND", "Governing document not found");
}

/** The governing blob namespace of a workspace: a valid storage key, never a project id (cuid). */
export function governingStorageKey(workspaceId: string): string {
  return `governing-${workspaceId}`;
}

function parseFields<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid governing document fields", {
      issues: z.flattenError(parsed.error),
    });
  }
  return parsed.data;
}

export interface GoverningDocumentsRouterDeps {
  storage?: StorageBackend;
  index?: GoverningIndex;
}

export function governingDocumentsRouter(deps: GoverningDocumentsRouterDeps = {}): Router {
  const r = Router({ mergeParams: true });

  // The flag first: off, the routes do not exist, for anyone.
  r.use((_req: Request, _res: Response, next: NextFunction) => {
    if (!isGoverningDocsEnabled()) {
      next(new AppError(404, "NOT_FOUND", "Not found"));
      return;
    }
    next();
  });
  r.use(requireAuth);

  // A deployment admin passes `requireWorkspaceRole` without a membership row,
  // so the workspace itself must still be live.
  async function liveWorkspace(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      if (!(await isWorkspaceLive(String(req.params.workspaceId)))) {
        throw new AppError(404, "NOT_FOUND", "Workspace not found");
      }
      next();
    } catch (err) {
      next(err);
    }
  }
  const member = [requireWorkspaceRole("member"), liveWorkspace];
  const admin = [requireWorkspaceRole("admin"), liveWorkspace];

  const storage = (): StorageBackend => deps.storage ?? getDocumentStorage();
  const index = (): GoverningIndex => deps.index ?? getGoverningIndex();

  /** Validate, parse and store the uploaded file; the revision row's fields. */
  async function storeFile(
    req: Request,
    workspaceId: string,
    fields: { revisionLabel: string; effectiveDate: string },
  ): Promise<{ revision: RevisionInput; filename: string }> {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) throw new AppError(400, "FILE_REQUIRED", "Multipart field 'file' is required");
    const validation = validateUpload({
      filename: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
    if (!validation.ok) {
      throw new AppError(validation.status, validation.code, validation.message);
    }
    const parsed = await parseDocument({
      buffer: file.buffer,
      mimeType: validation.mimeType,
      filename: validation.filename,
    });
    if (!parsed.ok) {
      log.warn("governing document parse failed", { workspaceId, reason: parsed.reason });
      throw new AppError(422, "PARSE_FAILED", "The file could not be read as text");
    }
    if (parsed.text.trim().length === 0) {
      throw new AppError(422, "NO_TEXT", "The file contains no text");
    }
    const stored = await storage().write({
      projectId: governingStorageKey(workspaceId),
      buffer: file.buffer,
    });
    return {
      filename: validation.filename,
      revision: {
        revisionLabel: fields.revisionLabel,
        effectiveDate: new Date(fields.effectiveDate),
        storagePath: stored.storagePath,
        contentHash: stored.checksum,
        mimeType: validation.mimeType,
        sizeBytes: stored.sizeBytes,
        extractedText: parsed.text,
        uploadedById: actorOf(req).id,
      },
    };
  }

  /** Embed the stored revision. A failure leaves it `pending` (not searchable) and is logged. */
  async function indexStored(
    workspaceId: string,
    revisionId: string,
    filename: string,
    text: string,
  ): Promise<{ indexState: "indexed" | "pending"; chunkCount: number }> {
    try {
      const chunkCount = await index().indexRevision({ workspaceId, revisionId, filename, text });
      await setRevisionIndexState(workspaceId, revisionId, "indexed");
      return { indexState: "indexed", chunkCount };
    } catch (err) {
      log.warn("governing revision indexing failed", {
        workspaceId,
        revisionId,
        error: String(err),
      });
      return { indexState: "pending", chunkCount: 0 };
    }
  }

  r.post("/", ...admin, uploadRateLimiter, singleFile, async (req: Request, res: Response) => {
    const workspaceId = String(req.params.workspaceId);
    const actor = actorOf(req);
    const fields = parseFields(uploadFieldsSchema, req.body);
    const { revision, filename } = await storeFile(req, workspaceId, fields);
    const created = await createDocumentWithRevision({
      workspaceId,
      title: fields.title,
      framework: fields.framework ?? null,
      createdById: actor.id,
      revision,
    });
    const indexed = await indexStored(
      workspaceId,
      created.revisionId,
      filename,
      revision.extractedText,
    );
    audit({
      actor: { id: actor.id },
      action: "governing_document.upload",
      target: { type: "governing_document", id: created.documentId },
      metadata: {
        workspaceId,
        revisionId: created.revisionId,
        sizeBytes: revision.sizeBytes,
        ...indexed,
      },
    });
    res.status(201).json(ok({ ...created, ...indexed }));
  });

  r.post(
    "/:documentId/revisions",
    ...admin,
    uploadRateLimiter,
    singleFile,
    async (req: Request, res: Response) => {
      const workspaceId = String(req.params.workspaceId);
      const documentId = String(req.params.documentId);
      const actor = actorOf(req);
      if (!(await documentExists(workspaceId, documentId))) throw notFound();
      const fields = parseFields(revisionFieldsSchema, req.body);
      // Refuse a taken label before the upload is parsed or its blob written. The
      // P2002 catch below still covers two concurrent uploads of one label.
      if (await revisionLabelExists(documentId, fields.revisionLabel)) throw labelExists();
      const { revision, filename } = await storeFile(req, workspaceId, fields);
      let created;
      try {
        created = await addRevision(workspaceId, documentId, revision);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw labelExists();
        }
        throw err;
      }
      if (!created) throw notFound();
      const indexed = await indexStored(
        workspaceId,
        created.revisionId,
        filename,
        revision.extractedText,
      );
      audit({
        actor: { id: actor.id },
        action: "governing_document.revision",
        target: { type: "governing_document", id: documentId },
        metadata: {
          workspaceId,
          revisionId: created.revisionId,
          sizeBytes: revision.sizeBytes,
          ...indexed,
        },
      });
      res.status(201).json(ok({ ...created, ...indexed }));
    },
  );

  r.get("/", ...member, async (req: Request, res: Response) => {
    const documents = await listDocuments(String(req.params.workspaceId));
    res.json(ok({ documents }));
  });

  r.get("/:documentId", ...member, async (req: Request, res: Response) => {
    const document = await getDocument(
      String(req.params.workspaceId),
      String(req.params.documentId),
    );
    if (!document) throw notFound();
    res.json(ok({ document }));
  });

  r.delete("/:documentId", ...admin, async (req: Request, res: Response) => {
    const workspaceId = String(req.params.workspaceId);
    const documentId = String(req.params.documentId);
    const actor = actorOf(req);
    if (!(await softDeleteDocument(workspaceId, documentId))) throw notFound();
    audit({
      actor: { id: actor.id },
      action: "governing_document.delete",
      target: { type: "governing_document", id: documentId },
      metadata: { workspaceId },
    });
    res.json(ok({ documentId, deleted: true }));
  });

  return r;
}
