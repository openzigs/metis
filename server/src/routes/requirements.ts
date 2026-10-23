/**
 * Epic #728 / Issue #733 — Requirements collaboration REST surface.
 *
 * Routes:
 *   PUT    /api/requirements/:requirementId   — update with optimistic-lock
 *   POST   /api/requirements/:requirementId/assignments — assign to user
 *   DELETE /api/requirements/:requirementId/assignments/:assigneeId — un-assign
 *   GET    /api/requirements/:requirementId/assignments — list assignments
 *   POST   /api/requirements/:requirementId/source-divergence — #1220: "Take the
 *          source version" / "Keep mine" on an imported requirement diverged
 *          from its source
 *   POST   /api/requirements/:requirementId/criteria-proposal — #1389: accept or
 *          dismiss the acceptance criteria a re-synthesis suggested for an
 *          approved requirement
 *
 * Also exposes the comment sub-routes (delegated to the comments router).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { isoDatetime } from "../lib/validation/iso-datetime.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { optimisticLock, sendVersionConflict } from "../middleware/optimistic-lock.js";
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
import {
  resolveSourceDivergence,
  SourceDivergenceError,
} from "../lib/requirements/source-divergence.js";
import {
  sourceDivergencePreAuthRateLimiter,
  sourceDivergenceUserRateLimiter,
} from "../middleware/source-divergence-rate-limit.js";
import {
  criteriaProposalPreAuthRateLimiter,
  criteriaProposalUserRateLimiter,
} from "../middleware/criteria-proposal-rate-limit.js";
import {
  CriteriaProposalError,
  resolveCriteriaProposal,
} from "../lib/analysis/analysis-service.js";
// `Requirement.labels` is a JSON-encoded string[] in the database and a plain
// string[] on the wire; a malformed/legacy value reads as no labels rather than
// throwing inside the lock's pre-flight read.
import { visibleRequirementLabels } from "../lib/analysis/requirement-labels.js";
import { audit } from "../lib/audit/audit-service.js";
import {
  eligibleAssigneeIds,
  isEligibleAssignee,
} from "../lib/requirements/assignee-eligibility.js";
import {
  ACCEPTANCE_CRITERIA_CLEARED,
  ACCEPTANCE_CRITERIA_MAX_ITEMS,
  ACCEPTANCE_CRITERION_MAX_LENGTH,
  parseAcceptanceCriteria,
  resolveCriteriaProposalSchema,
} from "@metis/shared";

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
  /// #990 — the full criteria list from the Edit dialog (replaces the stored
  /// one). Same bounds as synthesis writes; `[]` clears it.
  acceptanceCriteria: z
    .array(z.string().trim().min(1).max(ACCEPTANCE_CRITERION_MAX_LENGTH))
    .max(ACCEPTANCE_CRITERIA_MAX_ITEMS)
    .optional(),
  /// Epic #770 — optional free-text reason recorded on the version row.
  reason: z.string().max(500).optional(),
});

/// Issue #1220 — the analyst's answer to a "diverged from source" requirement.
const resolveSourceDivergenceSchema = z
  .object({
    choice: z.enum(["source", "local"]),
    /// The source content the analyst compared against (from the snapshot).
    sourceFingerprint: z.string().min(1).max(200),
    /// The requirement version the analyst saw. Required when taking the
    /// source, so it never overwrites an edit the analyst had not seen.
    version: z.number().int().optional(),
  })
  .refine((b) => b.choice !== "source" || b.version !== undefined, {
    message: "`version` is required when taking the source version",
    path: ["version"],
  });

const assignSchema = z.object({
  assigneeId: z.string().min(1),
  slaDeadline: isoDatetime().nullable().optional(),
});

// ---- Router -----------------------------------------------------------------

/**
 * The optimistic-lock view of a requirement: tracked fields plus `version`, in
 * the shape the client speaks. Used by the lock middleware and again by the
 * handler when the write transaction itself detects a conflict (#871).
 */
async function loadLockedRequirement(req: Request) {
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
      acceptanceCriteria: true,
    },
  });
  if (!row) return null;
  // `labels` is stored as a JSON string but travels over the API as a
  // string[] (see `updateRequirementSchema`). The lock diffs the record
  // against the REQUEST BODY field by field, so handing it the raw column
  // reported `labels` as conflicting on every 409 — and the merge modal
  // then offered to "keep" a JSON string, which the same endpoint rejects
  // with a 400. Present the record in the shape the client speaks — and, like
  // the Edit dialog, without the hidden `finding:*` / `review:*` labels the
  // write keeps on its own (#940).
  // #990 — `acceptanceCriteria` is the same JSON-string-vs-array case.
  return {
    ...row,
    labels: visibleRequirementLabels(row.labels),
    acceptanceCriteria: parseAcceptanceCriteria(row.acceptanceCriteria),
  };
}

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
  // Issue #1220 — the pre-auth limiter must run before `requireAuth` (CodeQL
  // js/missing-rate-limiting), and the guard below is where auth first runs.
  r.use("/:requirementId/source-divergence", sourceDivergencePreAuthRateLimiter);
  // Issue #1389 — the same pre-auth placement, with limiters of its own.
  r.use("/:requirementId/criteria-proposal", criteriaProposalPreAuthRateLimiter);

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
      // #1432 — a row written before assignees were checked, or whose assignee
      // or assigner has since left, must not reveal who that user is: keep the
      // row (it can still be removed) but drop the name of anyone — assignee or
      // assignedBy — no longer eligible for the project. One check per distinct
      // user, run in parallel.
      const owner = await prisma.requirement.findUnique({
        where: { id: requirementId },
        select: { projectId: true },
      });
      const eligible = owner
        ? await eligibleAssigneeIds(
            assignments.flatMap((a) => [a.assigneeId, a.assignedById]),
            owner.projectId,
          )
        : new Set<string>();
      const anonymous = (id: string) => ({ id, username: null, displayName: null });
      const data = assignments.map((a) => ({
        ...a,
        assignee: eligible.has(a.assigneeId) ? a.assignee : anonymous(a.assigneeId),
        assignedBy: eligible.has(a.assignedById) ? a.assignedBy : anonymous(a.assignedById),
      }));
      res.json({ success: true, data });
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
        select: { id: true, projectId: true },
      });
      if (!reqRow) throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");

      // #1432 — only an active member who can open the requirement's project.
      // An unknown id and an ineligible one get the same 404, and nothing is
      // written, so this is not a cross-workspace user lookup.
      if (!(await isEligibleAssignee(parsed.data.assigneeId, reqRow.projectId))) {
        throw new AppError(404, "ASSIGNEE_NOT_FOUND", "Assignee not found");
      }

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
    optimisticLock("requirement", loadLockedRequirement),
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
      // #1162 — the review status is the verdict on a version, not part of it:
      // written in the same transaction, recorded in the audit log, not versioned.
      const untrackedData =
        parsed.data.reviewStatus !== undefined
          ? { reviewStatus: parsed.data.reviewStatus }
          : undefined;
      if (parsed.data.acceptanceCriteria !== undefined) {
        // #990 — `[]` is an explicit clear: store the marker so the issue draft
        // does not refill the list from the body or a Gherkin text.
        patch.acceptanceCriteria =
          parsed.data.acceptanceCriteria.length === 0
            ? ACCEPTANCE_CRITERIA_CLEARED
            : JSON.stringify(parsed.data.acceptanceCriteria);
      }

      // Epic #770 — the version-history service owns version bumping and appends
      // a compact, changed-fields-only audit row inside the same transaction.
      // The optimistic-lock middleware answers the common stale-version case
      // with a diff, but its read is outside the write transaction, so two
      // concurrent edits with the same version both pass it (#871). The service
      // re-checks `expectedVersion` inside the transaction; the middleware's
      // `res.locals.nextVersion` is intentionally ignored (no double increment).
      const expectedVersion = parsed.data.version;
      try {
        const result = await updateRequirementWithHistory(prisma, {
          requirementId,
          patch,
          untrackedData,
          actorId: req.user.userId,
          reason: parsed.data.reason,
          // Defence in depth: the scope lives in the service's own query, not
          // only in the router guard (undefined for system admins).
          projectId: requirementScopeWhere(req).projectId,
          expectedVersion,
          // Issue #940 — the Edit dialog only ever sees the visible labels;
          // keep the hidden `finding:<id>` traceability labels it cannot show.
          keepHiddenLabels: true,
        });
        auditReviewStatusChange(req.user.userId, requirementId, result.untrackedChanges);
        res.json({
          success: true,
          data: { id: result.id, version: result.version, updatedAt: result.updatedAt },
        });
      } catch (err) {
        if (err instanceof RequirementVersionError && err.code === "NOT_FOUND") {
          throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
        }
        if (
          err instanceof RequirementVersionError &&
          err.code === "VERSION_CONFLICT" &&
          expectedVersion !== undefined
        ) {
          const current = await loadLockedRequirement(req);
          if (!current) throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
          sendVersionConflict(
            res,
            "requirement",
            current,
            req.body as Record<string, unknown>,
            expectedVersion,
          );
          return;
        }
        throw err;
      }
    },
  );

  // POST /api/requirements/:requirementId/source-divergence — Issue #1220.
  // "Take the source version" writes the source's content through the version
  // history, with the analyst as actor (a pinned review goes stale). "Keep
  // mine" changes no content, writes no version, and records the analyst's
  // decision on the row (`sourceDecisionActorId`), which the #769 guard reads.
  r.post(
    "/:requirementId/source-divergence",
    requireAuth,
    sourceDivergenceUserRateLimiter,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const requirementId = String(req.params.requirementId);
      const parsed = resolveSourceDivergenceSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid source-divergence payload", {
          issues: parsed.error.flatten(),
        });
      }
      try {
        const result = await resolveSourceDivergence(prisma, {
          requirementId,
          choice: parsed.data.choice,
          sourceFingerprint: parsed.data.sourceFingerprint,
          actorId: req.user.userId,
          // Defence in depth alongside the router guard (#1118).
          projectId: requirementScopeWhere(req).projectId,
          expectedVersion: parsed.data.version,
        });
        audit({
          actor: req.user.userId,
          // A take-source whose divergence a newer re-sync superseded wrote
          // the content but resolved nothing; say exactly that.
          action: result.superseded
            ? "requirement.source_divergence.superseded"
            : "requirement.source_divergence.resolve",
          target: { type: "requirement", id: requirementId },
          metadata: {
            projectId: result.projectId,
            choice: result.choice,
            sourceFingerprint: parsed.data.sourceFingerprint,
            changed: result.changed,
            version: result.version,
          },
        });
        res.json({ success: true, data: result });
      } catch (err) {
        if (err instanceof SourceDivergenceError) {
          if (err.code === "NOT_FOUND") {
            throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
          }
          throw new AppError(409, err.code, err.message);
        }
        if (err instanceof RequirementVersionError) {
          if (err.code === "NOT_FOUND") {
            throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
          }
          throw new AppError(409, "VERSION_CONFLICT", err.message);
        }
        throw err;
      }
    },
  );

  // POST /api/requirements/:requirementId/criteria-proposal — Issue #1389.
  // A re-synthesis kept an approved requirement's criteria and suggested
  // others. "Accept" writes them through the version history with the analyst
  // as actor; "Dismiss" changes no content. Either clears the suggestion.
  r.post(
    "/:requirementId/criteria-proposal",
    requireAuth,
    criteriaProposalUserRateLimiter,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const requirementId = String(req.params.requirementId);
      const parsed = resolveCriteriaProposalSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid criteria-proposal payload", {
          issues: parsed.error.flatten(),
        });
      }
      try {
        const result = await resolveCriteriaProposal({
          requirementId,
          choice: parsed.data.choice,
          actorId: req.user.userId,
          // Defence in depth alongside the router guard (#1118).
          projectId: requirementScopeWhere(req).projectId,
          expectedVersion: parsed.data.version,
        });
        audit({
          actor: req.user.userId,
          action: "requirement.criteria_proposal.resolve",
          target: { type: "requirement", id: requirementId },
          metadata: {
            projectId: result.projectId,
            analysisId: result.analysisId,
            choice: result.choice,
            changed: result.changed,
            version: result.version,
          },
        });
        res.json({ success: true, data: result });
      } catch (err) {
        if (err instanceof CriteriaProposalError) {
          if (err.code === "NOT_FOUND") {
            throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
          }
          throw new AppError(409, err.code, err.message);
        }
        if (err instanceof RequirementVersionError) {
          if (err.code === "NOT_FOUND") {
            throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
          }
          throw new AppError(409, "VERSION_CONFLICT", err.message);
        }
        throw err;
      }
    },
  );

  // Epic #770 — version history, export, and restore sub-routes.
  r.use("/", requirementHistoryRouter());

  return r;
}

/**
 * #1162 — a manual review-status change is not versioned (see `TRACKED_FIELDS`),
 * so it is recorded here instead, like the review workflow's own transitions.
 */
function auditReviewStatusChange(
  actorId: string,
  requirementId: string,
  untrackedChanges: Record<string, { from: unknown; to: unknown }>,
): void {
  const change = untrackedChanges.reviewStatus;
  if (!change) return;
  audit({
    actor: { id: actorId },
    action: "requirement.review_status.set",
    target: { type: "requirement", id: requirementId },
    metadata: { from: change.from, to: change.to },
  });
}
