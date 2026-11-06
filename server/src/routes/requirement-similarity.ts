/**
 * Issue #1837 (epic #1828) — similar and duplicate requirements.
 *
 *   GET  /api/projects/:projectId/requirements/:requirementId/similar?limit=5
 *   POST /api/projects/:projectId/requirements/similar   { text, acceptanceCriteria?, limit? }
 *   200  { success, data: { items: SimilarRequirementItem[] } }
 *   POST /api/projects/:projectId/requirements/:requirementId/similar/:otherRequirementId/not-duplicate
 *        (#1838) remembers an analyst's "Not a duplicate" for the pair
 *   POST /api/projects/:projectId/requirements/:requirementId/borrow-citations
 *        { fromRequirementId, mappingIds? }  (#1839) copies the similar
 *        requirement's current code links as `similar-requirement` suggestions
 *   200  { success, data: { copied, skippedStale, skippedDuplicate } }
 *
 * Every route runs behind `requireProjectAccess()`: a caller who cannot reach the
 * project gets 404, and a requirement id of another project answers 404 from the
 * service (it is looked up on the project AND the id), never its neighbours.
 */
import { Router, type Request } from "express";
import {
  borrowCitationsSchema,
  similarRequirementsDraftSchema,
  similarRequirementsLimitSchema,
  type ApiResponse,
  type BorrowCitationsResult,
  type SimilarRequirementsResponse,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { requirementSimilarityPreAuthRateLimiter } from "../middleware/requirement-similarity-rate-limit.js";
import { AppError } from "../middleware/error-handler.js";
import {
  findSimilarRequirements,
  markNotDuplicate,
} from "../lib/requirements/similar-requirements.js";
import { resolveSimilarityVerifier } from "../lib/requirements/similarity-verifier-resolver.js";
import { borrowCitations } from "../lib/traceability/borrow-citations.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const projectIdOf = (req: Request): string => String(req.params.projectId);

function validationError(issues: unknown): AppError {
  return new AppError(400, "VALIDATION_ERROR", "invalid similar-requirements request", {
    issues,
  });
}

export function requirementSimilarityRouter(): Router {
  const r = Router({ mergeParams: true });
  // Per route, NOT `r.use()`: this router is mounted at `/projects/:projectId/requirements`
  // ahead of `stakeholdersRouter()`, and a router-level `use` would run the similarity
  // limiter (and its auth) on every `/requirements/:id/stakeholders*` request too.
  const guard = [requirementSimilarityPreAuthRateLimiter, requireAuth, requireProjectAccess()];

  r.post("/similar", ...guard, requirePermission("analysis.read"), async (req, res) => {
    const parsed = similarRequirementsDraftSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw validationError(parsed.error.flatten());
    const projectId = projectIdOf(req);
    const items = await findSimilarRequirements(
      projectId,
      { text: parsed.data.text, acceptanceCriteria: parsed.data.acceptanceCriteria ?? [] },
      { limit: parsed.data.limit, verifier: await resolveSimilarityVerifier(projectId) },
    );
    res.json(ok<SimilarRequirementsResponse>({ items }));
  });

  r.get(
    "/:requirementId/similar",
    ...guard,
    requirePermission("analysis.read"),
    async (req, res) => {
      const limit = similarRequirementsLimitSchema.safeParse(req.query.limit ?? undefined);
      if (!limit.success) throw validationError(limit.error.flatten());
      const projectId = projectIdOf(req);
      const items = await findSimilarRequirements(
        projectId,
        { requirementId: String(req.params.requirementId) },
        { limit: limit.data, verifier: await resolveSimilarityVerifier(projectId) },
      );
      res.json(ok<SimilarRequirementsResponse>({ items }));
    },
  );

  // #1838 — "Not a duplicate": remembered for the pair, so a reload does not
  // raise the duplicate warning again. Same write permission as adding a link.
  r.post(
    "/:requirementId/similar/:otherRequirementId/not-duplicate",
    ...guard,
    requirePermission("project.update"),
    async (req, res) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      await markNotDuplicate(
        projectIdOf(req),
        String(req.params.requirementId),
        String(req.params.otherRequirementId),
        req.user.userId,
      );
      res.json(ok({ notDuplicate: true }));
    },
  );

  // #1839 — start from a similar requirement's saved code links. A write, so
  // the same edit permission as "Not a duplicate" and adding a link; both
  // requirements are looked up on this project, so another project's id is 404.
  r.post(
    "/:requirementId/borrow-citations",
    ...guard,
    requirePermission("project.update"),
    async (req, res) => {
      const parsed = borrowCitationsSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw validationError(parsed.error.flatten());
      const result = await borrowCitations(
        projectIdOf(req),
        String(req.params.requirementId),
        parsed.data,
      );
      res.json(ok<BorrowCitationsResult>(result));
    },
  );

  return r;
}
