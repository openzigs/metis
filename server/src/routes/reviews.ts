/**
 * Epic #609 / Issue #617 — formal review & approval workflow REST surface.
 *
 * Routes:
 *   POST /api/projects/:projectId/reviews      — create a draft review (review.create)
 *   GET  /api/projects/:projectId/reviews      — project-scoped list      (review.read)
 *   GET  /api/reviews                          — queue (assignee=me [&decision=pending], requester=me,
 *                                                status, projectId)       (review.read)
 *   GET  /api/reviews/:reviewId                — detail incl. audit history (review.read)
 *   POST /api/reviews/:reviewId/submit         — draft → in_review, pins versions
 *                                                (review.create; requester or review.admin)
 *   POST /api/reviews/:reviewId/decision       — reviewer approve/reject (review.decide;
 *                                                assigned reviewer only, never the requester
 *                                                unless the project allows self-approval
 *                                                and they hold requirement.approve, #2436)
 *   POST /api/reviews/:reviewId/withdraw       — in_review → draft (requester or review.admin)
 *   POST /api/reviews/:reviewId/close          — any non-closed → closed (requester or
 *                                                review.admin)
 *   POST /api/reviews/:reviewId/reopen         — #2219 "Request re-review": approved →
 *                                                in_review, re-pins current versions
 *                                                (review.create; requester or review.admin)
 *
 * All state changes go through `lib/reviews/state-machine.ts` and are audited
 * via the shared `audit()` service (see `lib/reviews/review-service.ts`).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { isoDatetime } from "../lib/validation/iso-datetime.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, hasPermission, type RoleKey } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { restrictedIds, userSourceReader } from "../lib/analysis/source-redaction.js";
import { InactiveAclActorError, resolveAclActor } from "../lib/rag/acl.js";
import { audit } from "../lib/audit/audit-service.js";
import { redactReviewFor, redactReviewsFor } from "../lib/reviews/review-redaction.js";
import { assertLiveProjectAccess } from "../lib/custom-agents/authz.js";
import { workspaceScopeWhere } from "../lib/auth/project-scope.js";
import {
  closeReview,
  createReviewRequest,
  getReviewDetail,
  listReviews,
  recordDecision,
  reopenReview,
  submitReview,
  withdrawReview,
  reviseReview,
} from "../lib/reviews/review-service.js";

// ---- Schemas ----------------------------------------------------------------

const reviewItemSchema = z
  .object({
    requirementId: z.string().min(1).optional(),
    generatedDocumentId: z.string().min(1).optional(),
  })
  .refine(
    (item) => (item.requirementId !== undefined) !== (item.generatedDocumentId !== undefined),
    { message: "Each item must reference exactly one requirement OR one generated document" },
  );

/**
 * Only whitelisted fields are read from the body — `requestedById`, `status`,
 * `decidedAt`, etc. are server-controlled (no mass assignment).
 */
const createReviewSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(4000).optional(),
  policy: z.enum(["all", "quorum"]).default("all"),
  quorum: z.number().int().min(1).optional(),
  dueAt: isoDatetime().nullable().optional(),
  reviewerIds: z.array(z.string().min(1)).min(1).max(50),
  items: z.array(reviewItemSchema).min(1).max(200),
});

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(2000).optional(),
});

// ---- Helpers ----------------------------------------------------------------

function requireUser(req: Request): { userId: string; role: RoleKey } {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { userId: req.user.userId, role: req.user.role as RoleKey };
}

/**
 * #305 — `/api/reviews` is mounted outside `/api/projects`, so the
 * `/projects/:id/:sub` chokepoint never reaches it. Every `/:reviewId` route
 * resolves the review's project and checks it through `assertProjectAccess`
 * (admins bypass). A review in a project the caller cannot reach answers the
 * same 404 as an unknown id, before any read or state change.
 */
async function assertReviewAccess(req: Request, reviewId: string): Promise<void> {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  const notFound = () => new AppError(404, "REVIEW_NOT_FOUND", "Review request not found");
  const row = await prisma.reviewRequest.findUnique({
    where: { id: reviewId },
    select: { projectId: true },
  });
  if (!row) throw notFound();
  try {
    await assertLiveProjectAccess(req.user, row.projectId);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) throw notFound();
    throw err;
  }
}

/**
 * #2554 — a review asks colleagues to sign off requirements, so its requester
 * must be able to see each one: a requirement of `projectId` resting on a
 * source they cannot see (#2447) is refused (403), as a checkpoint they cannot
 * see is. It is listed to them as "Restricted", so the refusal names nothing
 * new; audited as `review.create.denied`. An id of no requirement of the
 * project is left to the item resolution, which answers 404.
 */
async function refuseRestrictedReviewItems(
  userId: string,
  projectId: string,
  requirementIds: readonly string[],
): Promise<void> {
  if (requirementIds.length === 0) return;
  const rows = await prisma.requirement.findMany({
    where: { id: { in: [...new Set(requirementIds)] }, projectId, deletedAt: null },
    select: { id: true, analysisId: true, sourceIds: true },
  });
  const restricted = await restrictedIds(userSourceReader(userId), rows);
  if (restricted.size === 0) return;
  audit({
    actor: { id: userId },
    action: "review.create.denied",
    target: { type: "project", id: projectId },
    metadata: { reason: "source-restricted", requirementIds: [...restricted] },
  });
  throw new AppError(
    403,
    "REVIEW_ITEM_RESTRICTED",
    "Some of these requirements rest on a document you cannot read, so you cannot ask for a review of them. Leave them out, or ask one of its readers or an admin.",
  );
}

/**
 * #2554 — each reviewer of a review must be able to see every requirement in
 * it, or they would be asked to sign off text they are shown only as
 * "Restricted" (and their approval would set its `reviewStatus`). Checked after
 * the requester's own check, so the requester reads every item and is told
 * nothing a reader is not (a reader is shown who reads a document). Refused
 * (403 `REVIEWER_CANNOT_SEE_ITEMS`, the reviewers named in
 * `details.reviewerIds`) before anything is written, audited as
 * `review.create.denied`. An admin reviewer (durable role) is never refused, as
 * at the decision below. An inactive or unknown reviewer is left to the
 * reviewer validation, which answers 400.
 */
async function refuseReviewersWhoCannotSee(
  userId: string,
  projectId: string,
  reviewerIds: readonly string[],
  requirementIds: readonly string[],
): Promise<void> {
  if (requirementIds.length === 0) return;
  const rows = await prisma.requirement.findMany({
    where: { id: { in: [...new Set(requirementIds)] }, projectId, deletedAt: null },
    select: { id: true, analysisId: true, sourceIds: true },
  });
  if (rows.length === 0) return;
  const live = await prisma.user.findMany({
    where: { id: { in: [...new Set(reviewerIds)] }, status: "active", deletedAt: null },
    select: { id: true },
  });
  const blocked: string[] = [];
  for (const { id } of live) {
    const hidden = (await restrictedIds(userSourceReader(id), rows)).size > 0;
    if (hidden && !(await isDurableAdminUser(id))) blocked.push(id);
  }
  if (blocked.length === 0) return;
  audit({
    actor: { id: userId },
    action: "review.create.denied",
    target: { type: "project", id: projectId },
    metadata: { reason: "reviewer-source-restricted", reviewerIds: blocked },
  });
  throw new AppError(
    403,
    "REVIEWER_CANNOT_SEE_ITEMS",
    blocked.length === 1
      ? "One of the reviewers cannot read a document these requirements rest on, so they cannot review them. Choose another reviewer, or leave those requirements out."
      : "Some of the reviewers cannot read a document these requirements rest on, so they cannot review them. Choose other reviewers, or leave those requirements out.",
    { reviewerIds: blocked },
  );
}

/**
 * #2554 — an assigned reviewer cannot decide a review holding a requirement
 * they cannot see now (its document restricted after the review was asked
 * for, say): their approval would set the `reviewStatus` of text they are shown
 * only as "Restricted". Only an assigned reviewer is checked, so anyone else
 * still gets the decision's own uniform 403 `NOT_A_REVIEWER`. An admin (durable
 * role) is never refused, as for a checkpoint: a requirement whose source
 * document was deleted since is seen by no one (#2447), and the review would be
 * stranded. Refused with 403 `REVIEW_ITEM_RESTRICTED`, audited
 * `review.decision.denied`.
 */
async function refuseDecisionOnHiddenItems(userId: string, reviewId: string): Promise<void> {
  const review = await prisma.reviewRequest.findUnique({
    where: { id: reviewId },
    select: {
      projectId: true,
      assignments: { where: { reviewerId: userId }, select: { id: true } },
      items: { select: { requirementId: true } },
    },
  });
  if (!review || review.assignments.length === 0) return;
  const requirementIds = review.items.flatMap((i) => (i.requirementId ? [i.requirementId] : []));
  if (requirementIds.length === 0) return;
  const rows = await prisma.requirement.findMany({
    where: { id: { in: requirementIds } },
    select: { id: true, analysisId: true, sourceIds: true },
  });
  const hidden = await restrictedIds(userSourceReader(userId), rows);
  if (hidden.size === 0 || (await isDurableAdminUser(userId))) return;
  audit({
    actor: { id: userId },
    action: "review.decision.denied",
    target: { type: "review", id: reviewId },
    metadata: {
      projectId: review.projectId,
      reason: "source-restricted",
      requirementIds: [...hidden],
    },
  });
  throw new AppError(
    403,
    "REVIEW_ITEM_RESTRICTED",
    "This review covers a requirement resting on a document you cannot read, so you cannot decide it. Ask one of its readers or an admin.",
  );
}

/** #2554 — whether `userId` is an admin by durable role (an inactive user is not). */
async function isDurableAdminUser(userId: string): Promise<boolean> {
  try {
    return (await resolveAclActor(userId)).role === "admin";
  } catch (err) {
    if (err instanceof InactiveAclActorError) return false;
    throw err;
  }
}

function isReviewAdmin(role: RoleKey): boolean {
  return hasPermission(role, "review.admin");
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseListQuery(req: Request): {
  status?: string;
  assignee?: string;
  decision?: string;
  requester?: string;
  projectId?: string;
  page: number;
  pageSize: number;
} {
  return {
    status: req.query.status === undefined ? undefined : String(req.query.status),
    assignee: req.query.assignee === undefined ? undefined : String(req.query.assignee),
    decision: req.query.decision === undefined ? undefined : String(req.query.decision),
    requester: req.query.requester === undefined ? undefined : String(req.query.requester),
    projectId: req.query.projectId === undefined ? undefined : String(req.query.projectId),
    page: parsePositiveInt(req.query.page, 1),
    pageSize: Math.min(parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE),
  };
}

// ---- Routers ----------------------------------------------------------------

/** Mounted at `/api/projects/:projectId/reviews`. */
export function projectReviewsRouter(): Router {
  const r = Router({ mergeParams: true });

  // POST / — create a draft review request.
  r.post(
    "/",
    requireAuth,
    requirePermission("review.create"),
    async (req: Request, res: Response) => {
      const { userId, role } = requireUser(req);
      const projectId = String(req.params.projectId);
      const parsed = createReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid review payload", {
          issues: parsed.error.flatten(),
        });
      }
      const requirementIds = parsed.data.items.flatMap((i) =>
        i.requirementId ? [i.requirementId] : [],
      );
      await refuseRestrictedReviewItems(userId, projectId, requirementIds);
      await refuseReviewersWhoCannotSee(userId, projectId, parsed.data.reviewerIds, requirementIds);
      // #2436 — the requester may name themselves only where the project allows
      // self-approval and they could approve directly (`requirement.approve`).
      const review = await createReviewRequest(userId, projectId, parsed.data, {
        canApprove: hasPermission(role, "requirement.approve"),
      });
      res
        .status(201)
        .json({ success: true, data: await redactReviewFor(userSourceReader(userId), review) });
    },
  );

  // GET / — project-scoped review list.
  r.get("/", requireAuth, requirePermission("review.read"), async (req: Request, res: Response) => {
    const { userId } = requireUser(req);
    const query = parseListQuery(req);
    const data = await listReviews(userId, {
      ...query,
      projectId: String(req.params.projectId),
    });
    res.json({
      success: true,
      data: { ...data, reviews: await redactReviewsFor(userSourceReader(userId), data.reviews) },
    });
  });

  return r;
}

/** Mounted at `/api/reviews`. */
export function reviewsRouter(): Router {
  const r = Router();

  // GET / — reviewer/requester queues.
  // #305 — an explicit `?projectId=` must name a project the caller can reach
  // (404 otherwise); without it the queue is narrowed to the caller's projects
  // instead of listing every workspace's reviews.
  r.get("/", requireAuth, requirePermission("review.read"), async (req: Request, res: Response) => {
    const { userId } = requireUser(req);
    const query = parseListQuery(req);
    if (query.projectId) await assertLiveProjectAccess(req.user!, query.projectId);
    const data = await listReviews(userId, {
      ...query,
      projectScope: workspaceScopeWhere(req.user!),
    });
    res.json({
      success: true,
      data: { ...data, reviews: await redactReviewsFor(userSourceReader(userId), data.reviews) },
    });
  });

  // GET /:reviewId — detail incl. items, assignments, and audit history.
  r.get(
    "/:reviewId",
    requireAuth,
    requirePermission("review.read"),
    async (req: Request, res: Response) => {
      await assertReviewAccess(req, String(req.params.reviewId));
      const data = await getReviewDetail(String(req.params.reviewId));
      res.json({
        success: true,
        data: {
          ...data,
          review: await redactReviewFor(userSourceReader(req.user!.userId), data.review),
        },
      });
    },
  );

  // POST /:reviewId/submit — draft → in_review (pins item versions).
  r.post(
    "/:reviewId/submit",
    requireAuth,
    requirePermission("review.create"),
    async (req: Request, res: Response) => {
      const { userId, role } = requireUser(req);
      await assertReviewAccess(req, String(req.params.reviewId));
      const review = await submitReview(userId, String(req.params.reviewId), isReviewAdmin(role));
      res.json({ success: true, data: await redactReviewFor(userSourceReader(userId), review) });
    },
  );

  // POST /:reviewId/decision — reviewer approve/reject.
  r.post(
    "/:reviewId/decision",
    requireAuth,
    requirePermission("review.decide"),
    async (req: Request, res: Response) => {
      const { userId, role } = requireUser(req);
      await assertReviewAccess(req, String(req.params.reviewId));
      const parsed = decisionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid decision payload", {
          issues: parsed.error.flatten(),
        });
      }
      await refuseDecisionOnHiddenItems(userId, String(req.params.reviewId));
      const result = await recordDecision(
        userId,
        String(req.params.reviewId),
        parsed.data.decision,
        parsed.data.note,
        { canApprove: hasPermission(role, "requirement.approve") },
      );
      res.json({ success: true, data: result });
    },
  );

  // POST /:reviewId/withdraw — in_review → draft.
  r.post(
    "/:reviewId/withdraw",
    requireAuth,
    requirePermission("review.create"),
    async (req: Request, res: Response) => {
      const { userId, role } = requireUser(req);
      await assertReviewAccess(req, String(req.params.reviewId));
      const review = await withdrawReview(userId, String(req.params.reviewId), isReviewAdmin(role));
      res.json({ success: true, data: await redactReviewFor(userSourceReader(userId), review) });
    },
  );

  // POST /:reviewId/revise — #2347 rejected → draft ("Revise and resubmit").
  r.post(
    "/:reviewId/revise",
    requireAuth,
    requirePermission("review.create"),
    async (req: Request, res: Response) => {
      const { userId, role } = requireUser(req);
      await assertReviewAccess(req, String(req.params.reviewId));
      const review = await reviseReview(userId, String(req.params.reviewId), isReviewAdmin(role));
      res.json({ success: true, data: await redactReviewFor(userSourceReader(userId), review) });
    },
  );

  // POST /:reviewId/close — any non-closed → closed (terminal archive).
  r.post(
    "/:reviewId/close",
    requireAuth,
    requirePermission("review.create"),
    async (req: Request, res: Response) => {
      const { userId, role } = requireUser(req);
      await assertReviewAccess(req, String(req.params.reviewId));
      const review = await closeReview(userId, String(req.params.reviewId), isReviewAdmin(role));
      res.json({ success: true, data: await redactReviewFor(userSourceReader(userId), review) });
    },
  );

  // POST /:reviewId/reopen — #2219 approved → in_review (re-pins current versions).
  r.post(
    "/:reviewId/reopen",
    requireAuth,
    requirePermission("review.create"),
    async (req: Request, res: Response) => {
      const { userId, role } = requireUser(req);
      await assertReviewAccess(req, String(req.params.reviewId));
      const review = await reopenReview(userId, String(req.params.reviewId), isReviewAdmin(role));
      res.json({ success: true, data: await redactReviewFor(userSourceReader(userId), review) });
    },
  );

  return r;
}
