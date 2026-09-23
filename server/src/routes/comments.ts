/**
 * Epic #728 / Issue #730 — Comment REST API.
 *
 * Routes:
 *   POST   /api/requirements/:requirementId/comments
 *   GET    /api/requirements/:requirementId/comments
 *   POST   /api/projects/:projectId/spec-kit/:artifactName/comments
 *   GET    /api/projects/:projectId/spec-kit/:artifactName/comments
 *   POST   /api/comments/:threadId/replies
 *   PATCH  /api/comments/:commentId
 *   DELETE /api/comments/:commentId
 *
 * All routes require authentication. Editing / deleting is restricted to the
 * comment's author.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { dispatchMentions } from "../lib/collaboration/mentions.js";
import {
  isAdminActor,
  listAccessibleProjectIds,
  type SchedulerActor,
} from "../lib/scheduler/project-access.js";

// ---- IDOR guard ------------------------------------------------------------

/**
 * Assert the authenticated user has access to the given project.
 * Admins are always allowed. Non-admins must have created the project
 * (current access model — no ProjectMember table yet).
 * Throws 403 FORBIDDEN on denial.
 */
async function assertProjectAccess(
  user: { userId: string; role: string },
  projectId: string,
): Promise<void> {
  const actor: SchedulerActor = { id: user.userId, role: user.role as SchedulerActor["role"] };
  if (isAdminActor(actor)) return;
  const allowed = await listAccessibleProjectIds(actor);
  if (!allowed.includes(projectId)) {
    throw new AppError(403, "FORBIDDEN", "Insufficient project access");
  }
}

// ---- Zod schemas -----------------------------------------------------------

const createThreadSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(50_000),
});

const replySchema = z.object({
  body: z.string().min(1).max(50_000),
});

const editSchema = z.object({
  body: z.string().min(1).max(50_000),
});

// ---- Helpers ----------------------------------------------------------------

function commentView(comment: {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author?: { id: string; username: string; displayName: string };
}) {
  return {
    id: comment.id,
    threadId: comment.threadId,
    authorId: comment.authorId,
    author: comment.author ?? null,
    body: comment.deletedAt ? null : comment.body,
    deleted: !!comment.deletedAt,
    editedAt: comment.editedAt?.toISOString() ?? null,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}

const commentInclude = {
  author: { select: { id: true, username: true, displayName: true } },
} as const;

// ---- Requirement comment routes --------------------------------------------

export function requirementCommentsRouter(): Router {
  const r = Router({ mergeParams: true });

  /** POST /api/requirements/:requirementId/comments — create thread + first comment */
  r.post(
    "/",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const requirementId = String(req.params.requirementId);
      const parsed = createThreadSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid request body", {
          issues: parsed.error.flatten(),
        });
      }

      const req_ = await prisma.requirement.findUnique({
        where: { id: requirementId },
        select: { id: true, projectId: true },
      });
      if (!req_) throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");

      await assertProjectAccess(req.user, req_.projectId);

      const thread = await prisma.commentThread.create({
        data: {
          requirementId,
          title: parsed.data.title ?? null,
          comments: {
            create: {
              authorId: req.user.userId,
              body: parsed.data.body,
            },
          },
        },
        include: {
          comments: { include: commentInclude },
        },
      });

      const firstComment = thread.comments[0];
      if (firstComment) {
        dispatchMentions(firstComment.id, parsed.data.body, req.user.userId);
      }

      res.status(201).json({
        success: true,
        data: {
          id: thread.id,
          requirementId: thread.requirementId,
          title: thread.title,
          resolved: thread.resolved,
          comments: thread.comments.map(commentView),
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
        },
      });
    },
  );

  /** GET /api/requirements/:requirementId/comments — list threads with comments */
  r.get(
    "/",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const requirementId = String(req.params.requirementId);

      const req_ = await prisma.requirement.findUnique({
        where: { id: requirementId },
        select: { id: true, projectId: true },
      });
      if (!req_) throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");

      await assertProjectAccess(req.user, req_.projectId);

      const threads = await prisma.commentThread.findMany({
        where: { requirementId },
        orderBy: { createdAt: "asc" },
        include: {
          comments: {
            // Soft-deleted comments stay in the list as placeholders
            // (`commentView` blanks the body and sets `deleted: true`), which is
            // what the thread UI renders as "This comment was deleted." Dropping
            // them here made that branch — and the whole `deleted` field —
            // unreachable, and left a thread whose only comment was deleted
            // looking empty.
            orderBy: { createdAt: "asc" },
            include: commentInclude,
          },
        },
      });

      res.json({
        success: true,
        data: threads.map((t) => ({
          id: t.id,
          requirementId: t.requirementId,
          title: t.title,
          resolved: t.resolved,
          comments: t.comments.map(commentView),
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        })),
      });
    },
  );

  return r;
}

// ---- Spec Kit artifact comment routes --------------------------------------

export function specKitArtifactCommentsRouter(): Router {
  const r = Router({ mergeParams: true });

  /** POST /api/projects/:projectId/spec-kit/:artifactName/comments */
  r.post(
    "/",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const projectId = String(req.params.projectId);
      const artifactName = String(req.params.artifactName);
      const parsed = createThreadSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid request body", {
          issues: parsed.error.flatten(),
        });
      }

      await assertProjectAccess(req.user, projectId);

      const thread = await prisma.commentThread.create({
        data: {
          specKitProjectId: projectId,
          specKitArtifactName: artifactName,
          title: parsed.data.title ?? null,
          comments: {
            create: {
              authorId: req.user.userId,
              body: parsed.data.body,
            },
          },
        },
        include: {
          comments: { include: commentInclude },
        },
      });

      const firstComment = thread.comments[0];
      if (firstComment) {
        dispatchMentions(firstComment.id, parsed.data.body, req.user.userId);
      }

      res.status(201).json({
        success: true,
        data: {
          id: thread.id,
          specKitProjectId: thread.specKitProjectId,
          specKitArtifactName: thread.specKitArtifactName,
          title: thread.title,
          resolved: thread.resolved,
          comments: thread.comments.map(commentView),
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
        },
      });
    },
  );

  /** GET /api/projects/:projectId/spec-kit/:artifactName/comments */
  r.get(
    "/",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const projectId = String(req.params.projectId);
      const artifactName = String(req.params.artifactName);

      await assertProjectAccess(req.user, projectId);

      const threads = await prisma.commentThread.findMany({
        where: {
          specKitProjectId: projectId,
          specKitArtifactName: artifactName,
        },
        orderBy: { createdAt: "asc" },
        include: {
          comments: {
            // Soft-deleted comments stay in the list as placeholders
            // (`commentView` blanks the body and sets `deleted: true`), which is
            // what the thread UI renders as "This comment was deleted." Dropping
            // them here made that branch — and the whole `deleted` field —
            // unreachable, and left a thread whose only comment was deleted
            // looking empty.
            orderBy: { createdAt: "asc" },
            include: commentInclude,
          },
        },
      });

      res.json({
        success: true,
        data: threads.map((t) => ({
          id: t.id,
          specKitProjectId: t.specKitProjectId,
          specKitArtifactName: t.specKitArtifactName,
          title: t.title,
          resolved: t.resolved,
          comments: t.comments.map(commentView),
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        })),
      });
    },
  );

  return r;
}

// ---- Thread reply / edit / delete routes -----------------------------------

export function commentsRouter(): Router {
  const r = Router();

  /** POST /api/comments/:threadId/replies — reply in thread */
  r.post(
    "/:threadId/replies",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const threadId = String(req.params.threadId);
      const parsed = replySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid request body", {
          issues: parsed.error.flatten(),
        });
      }

      const thread = await prisma.commentThread.findUnique({
        where: { id: threadId },
        select: {
          id: true,
          requirementId: true,
          specKitProjectId: true,
          requirement: { select: { projectId: true } },
        },
      });
      if (!thread) throw new AppError(404, "THREAD_NOT_FOUND", "Comment thread not found");

      const threadProjectId = thread.requirement?.projectId ?? thread.specKitProjectId;
      if (!threadProjectId)
        throw new AppError(403, "FORBIDDEN", "Cannot determine project for thread");
      await assertProjectAccess(req.user, threadProjectId);

      const comment = await prisma.comment.create({
        data: {
          threadId,
          authorId: req.user.userId,
          body: parsed.data.body,
        },
        include: commentInclude,
      });

      dispatchMentions(comment.id, parsed.data.body, req.user.userId);

      res.status(201).json({ success: true, data: commentView(comment) });
    },
  );

  /** PATCH /api/comments/:commentId — edit own comment */
  r.patch(
    "/:commentId",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const commentId = String(req.params.commentId);
      const parsed = editSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid request body", {
          issues: parsed.error.flatten(),
        });
      }

      const existing = await prisma.comment.findUnique({
        where: { id: commentId },
        select: {
          id: true,
          authorId: true,
          deletedAt: true,
          thread: {
            select: {
              requirementId: true,
              specKitProjectId: true,
              requirement: { select: { projectId: true } },
            },
          },
        },
      });
      if (!existing || existing.deletedAt) {
        throw new AppError(404, "COMMENT_NOT_FOUND", "Comment not found");
      }
      const editProjectId =
        existing.thread.requirement?.projectId ?? existing.thread.specKitProjectId;
      if (!editProjectId)
        throw new AppError(403, "FORBIDDEN", "Cannot determine project for comment");
      await assertProjectAccess(req.user, editProjectId);
      if (existing.authorId !== req.user.userId) {
        throw new AppError(403, "FORBIDDEN", "You can only edit your own comments");
      }

      const updated = await prisma.comment.update({
        where: { id: commentId },
        data: { body: parsed.data.body, editedAt: new Date() },
        include: commentInclude,
      });

      res.json({ success: true, data: commentView(updated) });
    },
  );

  /** DELETE /api/comments/:commentId — soft delete own comment */
  r.delete(
    "/:commentId",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const commentId = String(req.params.commentId);

      const existing = await prisma.comment.findUnique({
        where: { id: commentId },
        select: {
          id: true,
          authorId: true,
          deletedAt: true,
          thread: {
            select: {
              requirementId: true,
              specKitProjectId: true,
              requirement: { select: { projectId: true } },
            },
          },
        },
      });
      if (!existing || existing.deletedAt) {
        throw new AppError(404, "COMMENT_NOT_FOUND", "Comment not found");
      }
      const deleteProjectId =
        existing.thread.requirement?.projectId ?? existing.thread.specKitProjectId;
      if (!deleteProjectId)
        throw new AppError(403, "FORBIDDEN", "Cannot determine project for comment");
      await assertProjectAccess(req.user, deleteProjectId);
      if (existing.authorId !== req.user.userId) {
        throw new AppError(403, "FORBIDDEN", "You can only delete your own comments");
      }

      await prisma.comment.update({
        where: { id: commentId },
        data: { deletedAt: new Date() },
      });

      res.json({ success: true, data: { id: commentId, deleted: true } });
    },
  );

  return r;
}
