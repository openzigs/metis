/**
 * Issue #1058 (epic #1051) — RATCHET BASELINE for the project-scope guard test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE ADDING AN ENTRY
 * ─────────────────────────────────────────────────────────────────────────────
 * This list may only SHRINK. `project-access-guard.test.ts` fails when
 *   • a `:projectId`-mounted router NOT on this list omits `requireProjectAccess()`
 *     → you introduced a new instance; mount the guard (see connectors.ts:269);
 *   • a router ON this list now HAS the guard → delete its line, the debt is paid.
 *
 * Adding a new line is a deliberate act that needs a reviewer's sign-off and a
 * written justification. "The test went red" is not a justification.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THESE ENTRIES ARE — AND ARE NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * These are NOT live BOLA holes. Measured on the real `apiRouter()` (see
 * `project-access-effective.test.ts`), every `/projects/:projectId/**` request
 * is today intercepted by TWO independent upstream chokepoints, either of which
 * alone is sufficient:
 *
 *   1. `projects.ts:94`   — `r.use("/:id/:sub", requireAuth, requireProjectAccess("id"))`
 *                           on `projectsRouter()`, mounted at `/projects` FIRST,
 *                           so it prefix-matches every two-or-more-segment path
 *                           under `/projects/**` regardless of which router
 *                           ultimately serves it.
 *   2. `documents.ts:525` — `knowledgeRouter()`'s router-level
 *                           `r.use(requireAuth, requireProjectAccess())`, mounted
 *                           at `/projects/:projectId` early in the table, whose
 *                           path-less middleware therefore runs for every deeper
 *                           sibling path too.
 *
 * Removing ONE changes nothing; removing BOTH makes every router below start
 * serving another tenant's data (verified by temporarily deleting each, then
 * both, and replaying a cross-tenant request through the real router tree).
 *
 * So the entries below are DEFENCE-IN-DEPTH DEBT: each router's own safety is
 * currently a property of the mount ORDER of a 93-layer table, not of the
 * router. Re-order the table, or mount a new router ahead of `projectsRouter()`,
 * and the protection silently evaporates. That is precisely the fragility #1058
 * exists to retire — but it also means these are follow-up hardening tickets,
 * not an incident.
 */

/** One baselined router: the mount path, the factory expression, and why. */
export interface BaselineEntry {
  /** Mount path exactly as written in `index.ts`. */
  path: string;
  /** Handler expression exactly as written in `index.ts`. */
  expression: string;
  /** Why this router is still unguarded. Keep it to one line. */
  note: string;
}

/**
 * Routers mounted under `:projectId` that do not yet mount
 * `requireProjectAccess()` themselves. Ordered as they appear in `index.ts`.
 */
export const PROJECT_ACCESS_BASELINE: readonly BaselineEntry[] = [
  {
    path: "/projects/:projectId/publishing",
    expression: "publishingRouter()",
    note: "drafts/batches are now scoped to the PATH projectId (#1072) — but the path project itself is unchecked",
  },
  {
    path: "/projects/:projectId/model-preferences",
    expression: "initModelPreferenceRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/analyses/model-recommendation",
    expression: "initModelRecommendationRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/usage",
    expression: "projectUsageRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/token-budget",
    expression: "projectTokenBudgetRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/inference-profile",
    expression: "inferenceProfileRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/repositories/:repoId",
    expression: "astCacheRouter()",
    note: "repoId is confined to the path project (ast-cache.ts:39) but the path project itself is unchecked",
  },
  {
    path: "/projects/:projectId",
    expression: "projectAgentsMdRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId",
    expression: "skillDirectoriesRouter()",
    note: "role gate fixed in #1075 (project.read / project.update / skill.manage); still no requireProjectAccess of its own",
  },
  {
    path: "/projects/:projectId/spec-kit",
    expression: "specKitRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/pr-reviews",
    expression: "prReviewsRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/rule-sets",
    expression: "rulesRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId",
    expression: "scansRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId",
    expression: "triageRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/test-coverage",
    expression: "testCoverageRouter()",
    note: "test-coverage.ts:76 ensureProject checks existence + archived status, not access",
  },
  {
    path: "/projects/:projectId",
    expression: "dataMappingsRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId",
    expression: "traceabilityRouter()",
    note: "path-scoped, but the includeLinked=true cross-project branch (traceability.ts:69) needs a human look",
  },
  {
    path: "/projects/:projectId",
    expression: "stakeholdersRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/reviews",
    expression: "projectReviewsRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/baselines",
    expression: "projectBaselinesRouter()",
    note: "service layer filters on the PATH projectId only — it trusts the path, never the caller",
  },
  {
    path: "/projects/:projectId/spec-kit/artifacts/:artifactName/comments",
    expression: "specKitArtifactCommentsRouter()",
    note: "DOES check access per-handler via the local assertProjectAccess (comments.ts:37,226+) — just not the middleware",
  },
];

/** Stable identity for a baselined mount: `<path> → <expression>`. */
export function baselineKey(entry: { path: string; expression: string }): string {
  return `${entry.path} → ${entry.expression}`;
}
