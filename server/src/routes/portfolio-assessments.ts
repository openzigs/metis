/**
 * /api/portfolio-assessments — Epic #1608 (#1625).
 *
 * A requirement checked across the product portfolio (#1622's engine), then
 * walked downstream from the products that must change (#1623's engine: the
 * `partial` products and an optional `hostProductId`), as an async job:
 *
 *   POST /             start one; 202 `{ id }`. Progress on `job:{id}`.
 *   GET  /             the newest assessments naming `?productId=`, or else the
 *                      caller's own
 *   GET  /:id          one assessment, as the caller may see it
 *   GET  /:id/export   the same, as Markdown (`?format=md`)
 *
 * Security:
 * - Every route: a pre-auth limiter, `requireAuth`, a per-user limiter and a
 *   permission (`analysis.run` to start, `analysis.read` to read). CSRF is the
 *   app-wide `csrfProtection` (#913), which runs before every `/api` router.
 * - `requirementId` must name a requirement in a project the caller can read;
 *   anything else is 404 (no existence oracle). So must an `all-accessible`
 *   scope's `hostProductId` name a product they can read.
 * - Reads never trust what was stored: `viewPortfolioAssessment` re-filters
 *   every product and repo against the reader's access now.
 */
import { Router } from "express";
import {
  createPortfolioAssessmentSchema,
  parseAcceptanceCriteria,
  type ApiResponse,
  type AuthPayload,
} from "@metis/shared";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import {
  portfolioAssessmentPreAuthRateLimiter,
  portfolioAssessmentReadRateLimiter,
  portfolioAssessmentStartRateLimiter,
} from "../middleware/portfolio-assessments-rate-limit.js";
import { prisma } from "../lib/prisma.js";
import { createChildLogger } from "../lib/logger.js";
import { canAccessProjectDiscussions } from "../lib/discussions/access.js";
import { genericFailureMessage, jobEvents } from "../lib/socket/job-events.js";
import {
  completePortfolioAssessment,
  createPortfolioAssessment,
  listPortfolioAssessmentIds,
  setPortfolioAssessmentStatus,
} from "../lib/portfolio/assessment-store.js";
import {
  evaluatePortfolioGap,
  portfolioGapInputSchema,
  toAssessmentInput,
  type PortfolioGapDeps,
  type PortfolioGapInput,
} from "../lib/portfolio/gap-engine.js";
import {
  directChangeProductIds,
  evaluatePortfolioImpact,
  withImpact,
  type PortfolioImpactDeps,
} from "../lib/portfolio/impact-engine.js";
import { assertProductAccessible } from "../lib/products/product-access.js";
import {
  renderPortfolioAssessmentMarkdown,
  resolveReaderAccess,
  toListItem,
  viewPortfolioAssessment,
} from "../lib/portfolio/assessment-view.js";

const log = createChildLogger("portfolio-assessments");

const KIND = "portfolio-assessment" as const;
/** Assessments one list returns. */
export const PORTFOLIO_ASSESSMENT_LIST_LIMIT = 25;

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const notFound = () => new AppError(404, "NOT_FOUND", "Portfolio assessment not found");

const listQuerySchema = z.object({ productId: z.string().min(1).max(64).optional() });
const exportQuerySchema = z.object({ format: z.literal("md").default("md") });

export interface PortfolioAssessmentsRouterDeps {
  /** Engine collaborators (tests inject a scripted model and search). */
  gap?: PortfolioGapDeps;
  /** Impact collaborators (#1623). */
  impact?: PortfolioImpactDeps;
}

/** The engine's input for a start request, or 404 for a requirement the caller cannot read. */
async function gapInputFor(
  user: AuthPayload,
  body: ReturnType<typeof createPortfolioAssessmentSchema.parse>,
): Promise<ReturnType<typeof portfolioGapInputSchema.parse>> {
  const scoped = {
    scope: body.scope,
    productIds: body.scope === "product" ? (body.productIds ?? []) : [],
  };
  if (body.statement !== undefined) {
    return portfolioGapInputSchema.parse({ statement: body.statement, ...scoped });
  }
  const requirement = await prisma.requirement.findUnique({
    where: { id: body.requirementId! },
    select: { id: true, projectId: true, title: true, body: true, acceptanceCriteria: true },
  });
  if (
    !requirement ||
    !(await canAccessProjectDiscussions(
      { id: user.userId, role: user.role },
      requirement.projectId,
    ))
  ) {
    throw new AppError(404, "NOT_FOUND", "Requirement not found");
  }
  return portfolioGapInputSchema.parse({
    statement: `${requirement.title}\n\n${requirement.body}`.trim().slice(0, 8_000),
    criteria: parseAcceptanceCriteria(requirement.acceptanceCriteria)
      .map((c) => c.slice(0, 2_000))
      .slice(0, 50),
    sourceRequirementId: requirement.id,
    sourceProjectId: requirement.projectId,
    ...scoped,
  });
}

/** Run an assessment created `pending` to `completed` or `failed`. Never throws. */
async function runAssessment(
  id: string,
  user: AuthPayload,
  input: PortfolioGapInput & { sourceRequirementId: string | null; sourceProjectId: string | null },
  hostProductId: string | null,
  deps: PortfolioAssessmentsRouterDeps,
): Promise<void> {
  try {
    await setPortfolioAssessmentStatus(id, "running");
    jobEvents.started(KIND, id, null, "Portfolio assessment started");
    const result = await evaluatePortfolioGap(user, input, {
      ...deps.gap,
      onProgress: ({ done, total }) =>
        jobEvents.progress(
          KIND,
          id,
          null,
          Math.round((done / Math.max(total, 1)) * 100),
          `${done} of ${total} products checked`,
        ),
    });
    // #1623 — from the products that must change, the products downstream of them.
    const impact = await evaluatePortfolioImpact(
      user,
      {
        directChangeProductIds: directChangeProductIds(result, hostProductId),
        listedProductIds: result.productIds,
      },
      deps.impact,
    );
    await completePortfolioAssessment(
      id,
      withImpact(
        toAssessmentInput(result, {
          createdById: user.userId,
          sourceRequirementId: input.sourceRequirementId,
          sourceProjectId: input.sourceProjectId,
        }),
        impact,
      ),
    );
    jobEvents.completed(KIND, id, null, "Portfolio assessment completed");
  } catch (err) {
    log.error("Portfolio assessment failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    await setPortfolioAssessmentStatus(id, "failed").catch((e: unknown) =>
      log.error("Could not record a failed portfolio assessment", {
        id,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    jobEvents.failed(KIND, id, null, genericFailureMessage(KIND));
  }
}

export function portfolioAssessmentsRouter(deps: PortfolioAssessmentsRouterDeps = {}): Router {
  const r = Router();

  r.post(
    "/",
    portfolioAssessmentPreAuthRateLimiter,
    requireAuth,
    portfolioAssessmentStartRateLimiter,
    requirePermission("analysis.run"),
    async (req, res, next) => {
      try {
        const user = req.user!;
        const body = createPortfolioAssessmentSchema.parse(req.body);
        const input = await gapInputFor(user, body);
        const hostProductId = body.hostProductId ?? null;
        // A host the caller cannot read is answered like a missing one (no existence oracle).
        if (hostProductId && body.scope === "all-accessible") {
          await assertProductAccessible(user, hostProductId);
        }
        const id = await createPortfolioAssessment({
          statement: input.statement,
          sourceRequirementId: input.sourceRequirementId,
          sourceProjectId: input.sourceProjectId,
          scope: input.scope,
          productIds: input.productIds,
          status: "pending",
          createdById: user.userId,
        });
        res.status(202).json(ok({ id }));
        void runAssessment(id, user, input, hostProductId, deps);
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/",
    portfolioAssessmentPreAuthRateLimiter,
    requireAuth,
    portfolioAssessmentReadRateLimiter,
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        const user = req.user!;
        const { productId } = listQuerySchema.parse(req.query);
        const access = await resolveReaderAccess(user);
        // A product the caller cannot read lists nothing, like one with no assessments.
        if (productId && !access.admin && !access.products.has(productId)) {
          res.json(ok([]));
          return;
        }
        const ids = await listPortfolioAssessmentIds(
          productId
            ? { productId, take: PORTFOLIO_ASSESSMENT_LIST_LIMIT }
            : { createdById: user.userId, take: PORTFOLIO_ASSESSMENT_LIST_LIMIT },
        );
        const items = [];
        for (const id of ids) {
          const view = await viewPortfolioAssessment(access, id);
          if (view) items.push(toListItem(view));
        }
        res.json(ok(items));
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/:id",
    portfolioAssessmentPreAuthRateLimiter,
    requireAuth,
    portfolioAssessmentReadRateLimiter,
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        const access = await resolveReaderAccess(req.user!);
        const view = await viewPortfolioAssessment(access, String(req.params.id));
        if (!view) throw notFound();
        res.json(ok(view));
      } catch (err) {
        next(err);
      }
    },
  );

  r.get(
    "/:id/export",
    portfolioAssessmentPreAuthRateLimiter,
    requireAuth,
    portfolioAssessmentReadRateLimiter,
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        exportQuerySchema.parse(req.query);
        const access = await resolveReaderAccess(req.user!);
        const view = await viewPortfolioAssessment(access, String(req.params.id));
        if (!view) throw notFound();
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        // `view.id` is the stored id, never the raw path segment.
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="portfolio-assessment-${view.id}.md"`,
        );
        res.send(renderPortfolioAssessmentMarkdown(view));
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
