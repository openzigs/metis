/**
 * Epic #728 / Issue #733 — Requirements collaboration REST surface.
 *
 * Routes:
 *   PUT    /api/requirements/:requirementId   — update with optimistic-lock
 *   POST   /api/requirements/:requirementId/assignments — assign to user
 *   DELETE /api/requirements/:requirementId/assignments/:assigneeId — un-assign
 *   GET    /api/requirements/:requirementId/assignments — list assignments
 *
 * Also exposes the comment sub-routes (delegated to the comments router).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { optimisticLock } from "../middleware/optimistic-lock.js";
import { prisma } from "../lib/prisma.js";
import { requirementCommentsRouter } from "./comments.js";
import { requirementHistoryRouter } from "./requirement-history.js";
import { requirementLinksRouter } from "./requirement-links.js";
import {
  requireRequirementAccess,
  requirementScopeWhere,
} from "../lib/requirements/requirement-authz.js";
import {
  updateRequirementWithHistory,
  RequirementVersionError,
} from "../lib/requirements/requirement-version-service.js";

/**
 * `Requirement.labels` is a JSON-encoded string[] in the database and a plain
 * string[] on the wire. Tolerates a malformed/legacy value by reporting no
 * labels rather than throwing inside the lock's pre-flight read.
 */
function parseLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((l) => String(l)) : [];
  } catch {
    return [];
  }
}

// ---- Schemas ----------------------------------------------------------------

const updateRequirementSchema = z.object({
  version: z.number().int().optional(),
  title: z.string().min(1).max(255).optional(),
  body: z.string().min(1).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  type: z.enum(["feature", "bug", "chore", "epic", "task"]).optional(),
  labels: z.array(z.string()).optional(),
  storyPoints: z.number().int().nullable().optional(),
  reviewStatus: z.enum(["draft", "approved", "rejected", "deferred"]).nullable().optional(),
  /// Epic #770 — optional free-text reason recorded on the version row.
  reason: z.string().max(500).optional(),
});

const assignSchema = z.object({
  assigneeId: z.string().min(1),
  slaDeadline: z.string().datetime().nullable().optional(),
});

// ---- Router -----------------------------------------------------------------

export function requirementsCollaborationRouter(): Router {
  const r = Router({ mergeParams: true });

  // Issue #1118 (epic #1051) — object-level tenant scope (OWASP A01 / BOLA).
  // This mount carries NO `:projectId` segment, so `requireProjectAccess()`
  // cannot be used: the owning project is resolved from the requirement row and
  // authorized through the same `assertProjectAccess` seam. Mounted ahead of
  // every route on the router — including the sub-routers, which keep their own
  // resolve-then-authorize as defence in depth — so a route added below is
  // covered by construction rather than by remembering. It also runs before the
  // optimistic-lock loader, which would otherwise read a foreign row and leak
  // its field values through the 409 conflict diff.
  r.use("/:requirementId", requireAuth, requireRequirementAccess);

  // Delegate comment sub-routes.
  r.use("/:requirementId/comments", requirementCommentsRouter());

  // Epic #610 (#624) — typed cross-project requirement links.
  r.use("/:requirementId/links", requirementLinksRouter());

  // GET /api/requirements/:requirementId/assignments
  r.get(
    "/:requirementId/assignments",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const requirementId = String(req.params.requirementId);
      const assignments = await prisma.assignment.findMany({
        where: { requirementId },
        include: {
          assignee: { select: { id: true, username: true, displayName: true } },
          assignedBy: { select: { id: true, username: true, displayName: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      res.json({ success: true, data: assignments });
    },
  );

  // POST /api/requirements/:requirementId/assignments
  r.post(
    "/:requirementId/assignments",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const requirementId = String(req.params.requirementId);
      const parsed = assignSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid assignment payload", {
          issues: parsed.error.flatten(),
        });
      }

      const reqRow = await prisma.requirement.findUnique({
        where: { id: requirementId, ...requirementScopeWhere(req) },
        select: { id: true },
      });
      if (!reqRow) throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");

      const assignment = await prisma.assignment.upsert({
        where: {
          requirementId_assigneeId: {
            requirementId,
            assigneeId: parsed.data.assigneeId,
          },
        },
        update: {
          assignedById: req.user.userId,
          slaDeadline: parsed.data.slaDeadline ? new Date(parsed.data.slaDeadline) : null,
          resolvedAt: null,
        },
        create: {
          requirementId,
          assigneeId: parsed.data.assigneeId,
          assignedById: req.user.userId,
          slaDeadline: parsed.data.slaDeadline ? new Date(parsed.data.slaDeadline) : null,
        },
        include: {
          assignee: { select: { id: true, username: true, displayName: true } },
          assignedBy: { select: { id: true, username: true, displayName: true } },
        },
      });

      res.status(201).json({ success: true, data: assignment });
    },
  );

  // DELETE /api/requirements/:requirementId/assignments/:assigneeId
  r.delete(
    "/:requirementId/assignments/:assigneeId",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const requirementId = String(req.params.requirementId);
      const assigneeId = String(req.params.assigneeId);

      const existing = await prisma.assignment.findUnique({
        where: { requirementId_assigneeId: { requirementId, assigneeId } },
        select: { id: true },
      });
      if (!existing) throw new AppError(404, "ASSIGNMENT_NOT_FOUND", "Assignment not found");

      await prisma.assignment.delete({
        where: { requirementId_assigneeId: { requirementId, assigneeId } },
      });

      res.json({ success: true, data: { removed: true } });
    },
  );

  // PUT /api/requirements/:requirementId — update with optimistic lock
  r.put(
    "/:requirementId",
    requireAuth,
    requirePermission("project.update"),
    optimisticLock("requirement", async (req) => {
      const id = String(req.params.requirementId);
      const row = await prisma.requirement.findUnique({
        // The scope resolved by `requireRequirementAccess` narrows the loader
        // too, so the lock's 409 diff can only ever describe an in-tenant row.
        where: { id, deletedAt: null, ...requirementScopeWhere(req) },
        select: {
          id: true,
          version: true,
          title: true,
          body: true,
          priority: true,
          type: true,
          labels: true,
          storyPoints: true,
          reviewStatus: true,
        },
      });
      if (!row) return null;
      // `labels` is stored as a JSON string but travels over the API as a
      // string[] (see `updateRequirementSchema`). The lock diffs the record
      // against the REQUEST BODY field by field, so handing it the raw column
      // reported `labels` as conflicting on every 409 — and the merge modal
      // then offered to "keep" a JSON string, which the same endpoint rejects
      // with a 400. Present the record in the shape the client speaks.
      return { ...row, labels: parseLabels(row.labels) };
    }),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const requirementId = String(req.params.requirementId);
      const parsed = updateRequirementSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid requirement patch", {
          issues: parsed.error.flatten(),
        });
      }

      const patch: Record<string, unknown> = {};
      if (parsed.data.title !== undefined) patch.title = parsed.data.title;
      if (parsed.data.body !== undefined) patch.body = parsed.data.body;
      if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
      if (parsed.data.type !== undefined) patch.type = parsed.data.type;
      if (parsed.data.labels !== undefined) patch.labels = JSON.stringify(parsed.data.labels);
      if (parsed.data.storyPoints !== undefined) patch.storyPoints = parsed.data.storyPoints;
      if (parsed.data.reviewStatus !== undefined) patch.reviewStatus = parsed.data.reviewStatus;

      // Epic #770 — the version-history service owns version bumping and appends
      // a compact, changed-fields-only audit row inside the same transaction.
      // The optimistic-lock middleware still guards against concurrent writes
      // (409) but its `res.locals.nextVersion` is intentionally ignored here to
      // avoid double-incrementing.
      try {
        const result = await updateRequirementWithHistory(prisma, {
          requirementId,
          patch,
          actorId: req.user.userId,
          reason: parsed.data.reason,
          // Defence in depth: the scope lives in the service's own query, not
          // only in the router guard (undefined for system admins).
          projectId: requirementScopeWhere(req).projectId,
        });
        res.json({
          success: true,
          data: { id: result.id, version: result.version, updatedAt: result.updatedAt },
        });
      } catch (err) {
        if (err instanceof RequirementVersionError && err.code === "NOT_FOUND") {
          throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
        }
        throw err;
      }
    },
  );

  // Epic #770 — version history, export, and restore sub-routes.
  r.use("/", requirementHistoryRouter());

  return r;
}
