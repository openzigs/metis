/**
 * /api/projects/:projectId/publishing — Phase 9 routes (#65–#71).
 *
 *   GET    /drafts                      list drafts                (issue.draft)
 *   POST   /drafts/generate             generate from analysis     (issue.draft)
 *   POST   /drafts/:id/approve          approve a draft            (issue.draft)
 *   GET    /batches                     list batches               (issue.preview)
 *   GET    /batches/:id                 batch detail + issues      (issue.preview)
 *   POST   /batches                     create + immediately run   (issue.publish | issue.preview for dry-run)
 *   POST   /batches/preview             plan a batch, write nothing (issue.preview)
 *   POST   /batches/:id/cancel          settle a stranded batch    (issue.publish + admin OR batch owner)
 *   POST   /batches/:id/archive         rollback / archive batch   (issue.publish + admin OR batch owner)
 */
import { Router, type Request } from "express";
import { z, ZodError } from "zod";
import {
  archivePublishBatchSchema,
  createPublishBatchSchema,
  generateDraftsSchema,
  hasPermission,
  type ApiResponse,
  type RoleKey,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import {
  approveDraft,
  archiveBatch,
  cancelBatch,
  createBatch,
  executeBatch,
  generateDrafts,
  getBatch,
  listBatches,
  listDrafts,
  previewBatch,
  VAULT_REF_FORMAT_MESSAGE,
} from "../lib/publishing/publishing-service.js";
import { PublishError } from "../lib/publishing/types.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

function actorRole(req: Request): RoleKey {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.role;
}

function projectIdOf(req: Request): string {
  const id = String(req.params.projectId ?? "");
  if (!id) throw new AppError(400, "INVALID_PROJECT", "projectId required");
  return id;
}

/**
 * #1094 — curated, client-safe text for the vault-ref failures.
 *
 * `resolveVaultRef` throws a `ConnectorError`, which the central handler
 * deliberately never forwards the message of (#1065: connector messages can
 * embed resolved private addresses and driver text). The result was a 400
 * reading only "The request could not be processed." for a mistake the server
 * could describe precisely.
 *
 * The fix is not to relax the redaction rule but to supply our OWN message:
 * these strings are written here, at a site that knows exactly what went
 * wrong, and echo nothing from the request or the upstream error.
 */
const VAULT_ERROR_MESSAGES: Record<string, string> = {
  VAULT_REF_INVALID: VAULT_REF_FORMAT_MESSAGE,
  VAULT_REF_UNRESOLVED:
    "That vault secret ref is well-formed but no matching secret exists. " +
    "Check the label against the secrets registered for this workspace.",
};

function asAppError(err: unknown): unknown {
  if (err instanceof PublishError) {
    return new AppError(err.status, err.code, err.message);
  }
  // A ConnectorError raised while resolving the publish credential. Map the
  // code to our own vetted message; the original message is discarded.
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code in VAULT_ERROR_MESSAGES) {
      const status = (err as { status?: unknown }).status;
      return new AppError(
        typeof status === "number" && status >= 400 && status < 500 ? status : 400,
        code,
        VAULT_ERROR_MESSAGES[code],
      );
    }
  }
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request payload", {
      issues: err.flatten(),
    });
  }
  return err;
}

export function publishingRouter(): Router {
  const r = Router({ mergeParams: true });
  r.use(requireAuth);

  // ---- Drafts ----
  r.get("/drafts", requirePermission("issue.draft"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const drafts = await listDrafts(projectId);
      res.json(ok(drafts));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.post("/drafts/generate", requirePermission("issue.draft"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const body = generateDraftsSchema
        .extend({
          targetOwner: z.string().min(1).max(128),
          targetRepo: z.string().min(1).max(128),
        })
        .parse(req.body);
      const result = await generateDrafts({
        projectId,
        analysisId: body.analysisId,
        targetOwner: body.targetOwner,
        targetRepo: body.targetRepo,
        defaultLabels: body.defaultLabels,
        actorId: actor(req),
      });
      res.status(201).json(ok(result));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.post("/drafts/:id/approve", requirePermission("issue.draft"), async (req, res, next) => {
    try {
      // #1072: scope the draft to the PATH project. The upstream
      // `/projects/:projectId/**` guard only proves the caller may reach the
      // path project — without this, a legitimate member of project A could
      // approve project B's draft by putting B's id here.
      const updated = await approveDraft({
        draftId: String(req.params.id),
        projectId: projectIdOf(req),
        actorId: actor(req),
      });
      res.json(ok(updated));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // ---- Batches ----
  r.get("/batches", requirePermission("issue.preview"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const includeArchived = String(req.query.includeArchived ?? "false") === "true";
      const rows = await listBatches({ projectId, includeArchived });
      res.json(ok(rows));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.get("/batches/:id", requirePermission("issue.preview"), async (req, res, next) => {
    try {
      // #1072: see the approve route — the batch must belong to the path project.
      const detail = await getBatch(String(req.params.id), projectIdOf(req));
      res.json(ok(detail));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // #1104 (D) — what WOULD this batch write, and where? Backs the pre-publish
  // confirmation. Takes the same body as POST /batches and creates nothing:
  // `issue.preview` is the right permission precisely because it is inert.
  r.post("/batches/preview", requirePermission("issue.preview"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const parsed = createPublishBatchSchema.parse({ ...req.body, projectId });
      const plan = await previewBatch({ input: parsed, actorId: actor(req) });
      res.json(ok(plan));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.post("/batches", async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const parsed = createPublishBatchSchema.parse({ ...req.body, projectId });
      const requiredPerm = parsed.dryRun ? "issue.preview" : "issue.publish";
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      if (!hasPermission(req.user.role, requiredPerm)) {
        throw new AppError(403, "FORBIDDEN", `permission ${requiredPerm} required`);
      }
      // F6: route-layer hint only; the service layer is the authoritative
      // enforcer of the cross-project guard.
      const meta = parsed.metadata as Record<string, unknown> | undefined;
      const confirmCrossProject = meta?.confirmCrossProject === true;
      const batch = await createBatch({
        input: parsed,
        actorId: actor(req),
        confirmCrossProject,
      });
      const result = await executeBatch({ batchId: batch.id, actorId: actor(req) });
      const detail = await getBatch(batch.id, projectId);
      res.status(201).json(ok({ batch: detail, run: result }));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // #1104 (F) — settle a stranded batch. Same permission and ownership rules
  // as archive; the service refuses anything that may still be in flight.
  r.post("/batches/:id/cancel", requirePermission("issue.publish"), async (req, res, next) => {
    try {
      const updated = await cancelBatch({
        batchId: String(req.params.id),
        projectId: projectIdOf(req),
        actorId: actor(req),
        actorRole: actorRole(req),
      });
      res.json(ok(updated));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.post("/batches/:id/archive", requirePermission("issue.publish"), async (req, res, next) => {
    try {
      const input = archivePublishBatchSchema.parse(req.body);
      // #1072: see the approve route — the batch must belong to the path project.
      const updated = await archiveBatch({
        batchId: String(req.params.id),
        projectId: projectIdOf(req),
        input,
        actorId: actor(req),
        actorRole: actorRole(req),
      });
      res.json(ok(updated));
    } catch (err) {
      next(asAppError(err));
    }
  });

  return r;
}
