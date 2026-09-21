/**
 * Epic #609 / Issue #617 — formal review & approval workflow REST surface.
 *
 * Routes:
 *   POST /api/projects/:projectId/reviews      — create a draft review (review.create)
 *   GET  /api/projects/:projectId/reviews      — project-scoped list      (review.read)
 *   GET  /api/reviews                          — queue (assignee=me, requester=me,
 *                                                status, projectId)       (review.read)
 *   GET  /api/reviews/:reviewId                — detail incl. audit history (review.read)
 *   POST /api/reviews/:reviewId/submit         — draft → in_review, pins versions
 *                                                (review.create; requester or review.admin)
 *   POST /api/reviews/:reviewId/decision       — reviewer approve/reject (review.decide;
 *                                                assigned reviewer only, never the requester)
 *   POST /api/reviews/:reviewId/withdraw       — in_review → draft (requester or review.admin)
 *   POST /api/reviews/:reviewId/close          — any non-closed → closed (requester or
 *                                                review.admin)
 *
 * All state changes go through `lib/reviews/state-machine.ts` and are audited
 * via the shared `audit()` service (see `lib/reviews/review-service.ts`).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, hasPermission, type RoleKey } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import {
  closeReview,
  createReviewRequest,
  getReviewDetail,
  listReviews,
  recordDecision,
  submitReview,
  withdrawReview,
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
  dueAt: z.string().datetime().nullable().optional(),
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
  requester?: string;
  projectId?: string;
  page: number;
  pageSize: number;
} {
  return {
    status: req.query.status === undefined ? undefined : String(req.query.status),
    assignee: req.query.assignee === undefined ? undefined : String(req.query.assignee),
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
      const { userId } = requireUser(req);
      const projectId = String(req.params.projectId);
      const parsed = createReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid review payload", {
          issues: parsed.error.flatten(),
        });
      }
      const review = await createReviewRequest(userId, projectId, parsed.data);
      res.status(201).json({ success: true, data: review });
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
    res.json({ success: true, data });
  });

  return r;
}

/** Mounted at `/api/reviews`. */
export function reviewsRouter(): Router {
  const r = Router();

  // GET / — reviewer/requester queues.
  r.get("/", requireAuth, requirePermission("review.read"), async (req: Request, res: Response) => {
    const { userId } = requireUser(req);
    const data = await listReviews(userId, parseListQuery(req));
    res.json({ success: true, data });
  });

  // GET /:reviewId — detail incl. items, assignments, and audit history.
  r.get(
    "/:reviewId",
    requireAuth,
    requirePermission("review.read"),
    async (req: Request, res: Response) => {
      const data = await getReviewDetail(String(req.params.reviewId));
      res.json({ success: true, data });
    },
  );

  // POST /:reviewId/submit — draft → in_review (pins item versions).
  r.post(
    "/:reviewId/submit",
    requireAuth,
    requirePermission("review.create"),
    async (req: Request, res: Response) => {
      const { userId, role } = requireUser(req);
      const review = await submitReview(userId, String(req.params.reviewId), isReviewAdmin(role));
      res.json({ success: true, data: review });
    },
  );

  // POST /:reviewId/decision — reviewer approve/reject.
  r.post(
    "/:reviewId/decision",
    requireAuth,
    requirePermission("review.decide"),
    async (req: Request, res: Response) => {
      const { userId } = requireUser(req);
      const parsed = decisionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid decision payload", {
          issues: parsed.error.flatten(),
        });
      }
      const result = await recordDecision(
        userId,
        String(req.params.reviewId),
        parsed.data.decision,
        parsed.data.note,
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
      const review = await withdrawReview(userId, String(req.params.reviewId), isReviewAdmin(role));
      res.json({ success: true, data: review });
    },
  );

  // POST /:reviewId/close — any non-closed → closed (terminal archive).
  r.post(
    "/:reviewId/close",
    requireAuth,
    requirePermission("review.create"),
    async (req: Request, res: Response) => {
      const { userId, role } = requireUser(req);
      const review = await closeReview(userId, String(req.params.reviewId), isReviewAdmin(role));
      res.json({ success: true, data: review });
    },
  );

  return r;
}
