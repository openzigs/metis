/**
 * /api/impact-analyses — Epic #159 (#163).
 *
 * Top-level (NOT project-scoped) because a single impact analysis spans many
 * projects: upload one requirements-change document, pick TWO OR MORE
 * deep-ingested projects, and get a per-project code-impact report.
 *
 * Endpoints:
 *   POST /          trigger a multi-project impact analysis (202 Accepted)
 *   GET  /          list analyses visible to the caller
 *   GET  /:id       full per-project breakdown for one analysis
 *
 * Security (OWASP A01): every endpoint requires auth + the relevant analysis
 * permission, AND every `projectId` is intersected against the caller's
 * accessible-project set. A caller must be able to access EVERY project in the
 * request (POST) or in the stored analysis (GET /:id) — no cross-tenant leak.
 */
import { Router, type Request } from "express";
import { z, ZodError } from "zod";
import {
  createImpactAnalysisSchema,
  type ApiResponse,
  type CreateImpactAnalysisResponse,
} from "@metis/shared";
import type { RoleKey } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import {
  isAdminActor,
  listAccessibleProjectIds,
  type SchedulerActor,
} from "../lib/scheduler/project-access.js";
import {
  triggerImpactAnalysis,
  ImpactAnalysisError,
  type ImpactServiceDeps,
} from "../lib/impact-analysis/impact-analysis-engine.js";
import {
  impactLlmSeedingEnabled,
  mapRequirementToCode,
  selectCodeSymbolSearcher,
} from "../lib/traceability/requirement-code-mapping.js";
import {
  buildPrismaEntityVocabularyLoader,
  impactLlmEntitySeedsEnabled,
  withEntitySeedUnion,
} from "../lib/traceability/requirement-entity-seeds.js";
import {
  filterAffectedTablesByRelevance,
  impactLlmTableFilterEnabled,
} from "../lib/impact-analysis/table-relevance-filter.js";
import {
  impactLlmAdditiveDdlEnabled,
  proposeAdditiveColumns,
} from "../lib/impact-analysis/additive-column-proposer.js";
import {
  buildImpactSummarizer,
  impactLlmSummaryEnabled,
} from "../lib/impact-analysis/impact-summarizer.js";
import {
  impactLlmClauseReconcileEnabled,
  reconcileClauseCoverage,
} from "../lib/impact-analysis/clause-coverage-reconciler.js";
import {
  buildPrismaTableCatalogLoader,
  recoverAffectedTables,
} from "../lib/impact-analysis/table-relevance-judge-recovery.js";
import { impactLlmTableJudgeEnabled } from "../lib/impact-analysis/table-relevance-judge.js";
import {
  createImpactLlmRuntime,
  type ImpactLlmRuntime,
  type ImpactLlmStage,
  type ImpactStageUnavailableReason,
} from "../lib/impact-analysis/impact-llm-runtime.js";
import { buildProvider, loadAIConfig } from "../lib/ai/index.js";
import type { AIProvider } from "../lib/ai/types.js";
import { createChildLogger } from "../lib/logger.js";
import {
  getImpactAnalysisDetail,
  listImpactAnalyses,
} from "../lib/impact-analysis/impact-analysis-read.js";
import { diffImpactRuns } from "../lib/impact-analysis/impact-drift.js";
import type { ImpactDriftReport } from "@metis/shared";
import { serializeImpactAnalysisMarkdown } from "../lib/analysis/analysis-export.js";
import { publishImpactAnalysisToJira } from "../lib/scanner/prisma-adapter.js";
import { PublishError } from "../lib/scanner/finding-publisher.js";
import type { ImpactAnalysisDetail } from "@metis/shared";
import { manualUsageOverrideSchema, impactTableFeedbackInputSchema } from "@metis/shared";
import {
  deleteTableFeedback,
  findFeedbackTargetItem,
  upsertTableFeedback,
} from "../lib/impact-analysis/table-feedback.js";
import {
  computeUsageClassification,
  type ProjectRoutinesIntrospector,
  type ProjectSchemaIntrospector,
} from "../lib/impact-analysis/used-schema-service.js";
import { readUsageClassification } from "../lib/impact-analysis/used-schema-classifier.js";
import {
  applyOverrides,
  deleteManualOverride,
  listManualOverrides,
  upsertManualOverride,
} from "../lib/impact-analysis/schema-usage-override.js";
import { prisma } from "../lib/prisma.js";
import { listDbConnectors, inspectDbConnector } from "../lib/connectors/db/db-service.js";
import { loadLiveSchema, type LiveSchemaIndex } from "../lib/impact-analysis/live-schema-ingest.js";
import {
  crossProjectImpact,
  whichProjectsUseObject,
} from "../lib/cross-project/cross-project-impact.js";
import { USAGE_OBJECT_KINDS, type UsageObjectKind } from "@metis/shared";

const log = createChildLogger("impact-analysis-route");

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

/**
 * #1021/#1024 — build the ONE provider an impact run's LLM stages share, and say
 * plainly why it is unusable when it is. Returning a discriminated result (rather
 * than a bare `null`) is what lets each stage record its OWN unavailability
 * reason on the run's degradation ledger, so the end-of-run notice can name the
 * stages a BA did not get.
 */
type BuiltImpactProvider =
  | { provider: AIProvider }
  | { provider: null; reason: ImpactStageUnavailableReason };

function buildImpactStageProvider(): BuiltImpactProvider {
  let provider: AIProvider | null = null;
  try {
    provider = buildProvider({ config: loadAIConfig() });
  } catch (err) {
    log.warn("impact LLM provider build failed; stages degrade to deterministic", {
      error: String(err),
    });
    return { provider: null, reason: "provider-build-failed" };
  }
  if (!provider) return { provider: null, reason: "no-provider" };
  if (provider.offline) return { provider: null, reason: "provider-offline" };
  return { provider };
}

/**
 * Instrument `built` for `stage` (#1021 metering + #1024 deadline), or record the
 * stage as unavailable and return null so the caller keeps the deterministic path.
 */
function instrumentStage(
  runtime: ImpactLlmRuntime,
  stage: ImpactLlmStage,
  built: BuiltImpactProvider,
): AIProvider | null {
  if (!built.provider) {
    runtime.markUnavailable(stage, built.reason);
    return null;
  }
  return runtime.instrument(built.provider, stage);
}

/**
 * #931 — selection-only wiring for the LLM semantic seeder; #1002 — the entity-seed
 * RECALL UNION stacked on top of it.
 *
 * Two INDEPENDENT flags, deliberately kept independent because they are opposite
 * levers: `IMPACT_LLM_SEEDING` (#931) swaps the seed source for an LLM re-ranker and
 * regressed table precision, while `IMPACT_LLM_ENTITY_SEEDS` (#1002) only APPENDS
 * graph-grounded entity seeds below the deterministic ones. With both off this
 * returns `undefined` so the engine keeps its own deterministic BM25 default (no
 * behaviour change, and no provider is built at all). Never throws — a provider-
 * construction failure degrades to deterministic seeding.
 *
 * #1021 — the two stages share ONE built provider but get SEPARATE instrumented
 * wrappers, so their tokens land under distinct `agentStep`s.
 */
function llmSeedingMapRequirement(
  runtime: ImpactLlmRuntime,
): ImpactServiceDeps["mapRequirement"] | undefined {
  const seedingEnabled = impactLlmSeedingEnabled();
  const entitySeedsEnabled = impactLlmEntitySeedsEnabled();
  if (!seedingEnabled && !entitySeedsEnabled) return undefined;
  const built = buildImpactStageProvider();
  const seedProvider = seedingEnabled ? instrumentStage(runtime, "seeding", built) : null;
  const entityProvider = entitySeedsEnabled
    ? instrumentStage(runtime, "entity-seeds", built)
    : null;
  const base = selectCodeSymbolSearcher({
    prisma,
    provider: seedProvider,
    enabled: seedingEnabled,
  });
  const searcher = withEntitySeedUnion({
    base,
    provider: entityProvider,
    loadVocabulary: buildPrismaEntityVocabularyLoader(prisma),
    enabled: entitySeedsEnabled,
  });
  return (req, projectId) => mapRequirementToCode(req, projectId, {}, { searcher });
}

/**
 * #936 — flag-gated wiring for the LLM table-relevance OUTPUT filter. When
 * `IMPACT_LLM_TABLE_FILTER` is on AND a live (non-offline) provider builds, return
 * a filter that prunes tangential (`unlikely`) crossed tables into the secondary
 * bucket (precision). Off / provider-unavailable / offline ⇒ `undefined` so the
 * engine keeps the deterministic crossing unchanged. Never throws — a provider-
 * construction failure degrades to no filter (the filter itself also never throws).
 */
function tableRelevanceFilterDep(
  runtime: ImpactLlmRuntime,
): ImpactServiceDeps["tableRelevanceFilter"] | undefined {
  if (!impactLlmTableFilterEnabled()) return undefined;
  const liveProvider = instrumentStage(runtime, "table-filter", buildImpactStageProvider());
  if (!liveProvider) return undefined;
  return async (requirementText, tables) => {
    const result = await filterAffectedTablesByRelevance(requirementText, tables, liveProvider, {
      enabled: true,
    });
    return result;
  };
}

/**
 * #1001 — flag-gated wiring for the LLM ADDITIVE-COLUMN proposer. When
 * `IMPACT_LLM_ADDITIVE_DDL` is on AND a live (non-offline) provider builds, return
 * a proposer that appends TEXT-ONLY `ADD COLUMN` suggestions grounded in the
 * tables the crossing already surfaced — so a business-analyst phrasing ("a
 * cancelled order must record who cancelled it and when") yields real additive
 * DDL instead of only `-- Verify column …` comments. Off / provider-unavailable /
 * offline ⇒ `undefined` so the engine keeps the deterministic crossing unchanged.
 * Never throws — a provider-construction failure degrades to no proposals (the
 * proposer itself also never throws).
 */
function additiveColumnProposerDep(
  runtime: ImpactLlmRuntime,
): ImpactServiceDeps["additiveColumnProposer"] | undefined {
  if (!impactLlmAdditiveDdlEnabled()) return undefined;
  const liveProvider = instrumentStage(runtime, "additive-ddl", buildImpactStageProvider());
  if (!liveProvider) return undefined;
  return async (requirementText, tables) => {
    const result = await proposeAdditiveColumns(requirementText, tables, liveProvider, {
      enabled: true,
    });
    return result.rows;
  };
}

/**
 * #1005 — flag-gated wiring for the CLAUSE-vs-IMPACT reconciler. When
 * `IMPACT_LLM_CLAUSE_RECONCILE` is on AND a live (non-offline) provider builds,
 * return a reconciler that names requirement obligations the surfaced tables do
 * not cover, grounded in the project's OTHER real tables (the #1002 code-graph
 * vocabulary, reused here as the complement set). Off / provider-unavailable /
 * offline ⇒ `undefined` so nothing changes. Never throws — a provider-construction
 * failure degrades to no advisories (the reconciler itself also never throws).
 *
 * The vocabulary loader is built ONCE per run and memoizes per project, so a run
 * over many changed requirements queries the code graph once per project.
 */
function clauseCoverageReconcilerDep(
  runtime: ImpactLlmRuntime,
): ImpactServiceDeps["clauseCoverageReconciler"] | undefined {
  if (!impactLlmClauseReconcileEnabled()) return undefined;
  const liveProvider = instrumentStage(runtime, "clause-reconcile", buildImpactStageProvider());
  if (!liveProvider) return undefined;
  const loadVocabulary = buildPrismaEntityVocabularyLoader(prisma);
  return async (requirementText, projectId, surfacedTableNames) => {
    const vocabulary = await loadVocabulary(projectId);
    const result = await reconcileClauseCoverage(
      requirementText,
      surfacedTableNames,
      vocabulary.tables,
      liveProvider,
      { enabled: true },
    );
    return result.gaps;
  };
}

/**
 * #1029 — flag-gated wiring for the column-informed table-relevance RECOVERY judge.
 * When `IMPACT_LLM_TABLE_JUDGE` is on AND a live (non-offline) provider builds, return a
 * judge that — ONLY on a total-miss requirement (the engine gates it) — recovers the
 * genuinely-affected tables the crossing missed, each grounded in its OWN columns from
 * the project schema graph. Off / provider-unavailable / offline ⇒ `undefined` so
 * nothing changes. Never throws — a provider-construction failure degrades to no
 * recovery (the recovery itself also never throws).
 *
 * The catalog loader is built ONCE per run and memoizes per project, so a run over many
 * changed requirements reads each project table->columns once.
 */
function tableRecoveryJudgeDep(
  runtime: ImpactLlmRuntime,
): ImpactServiceDeps["tableRecoveryJudge"] | undefined {
  if (!impactLlmTableJudgeEnabled()) return undefined;
  const liveProvider = instrumentStage(runtime, "table-judge", buildImpactStageProvider());
  if (!liveProvider) return undefined;
  const loadCatalog = buildPrismaTableCatalogLoader(prisma);
  return async (requirementText, projectId, surfacedTableNames) => {
    const catalog = await loadCatalog(projectId);
    return recoverAffectedTables({
      requirementText,
      surfacedTableNames,
      catalog,
      provider: liveProvider,
      options: { enabled: true },
    });
  };
}

/**
 * #932 — flag-gated wiring for the LLM impact SUMMARIZER. When `IMPACT_LLM_SUMMARY`
 * is on AND a live (non-offline) provider builds, return a summarizer that
 * generates the BA-readable run overview + per-item narratives POST-HOC from the
 * deterministic facts. Off / provider-unavailable / offline ⇒ `undefined` so the
 * engine persists no LLM summary (deterministic result intact). Never throws — a
 * provider-construction failure degrades to no summarizer (the summarizer itself
 * also never throws).
 */
function impactSummarizerDep(
  runtime: ImpactLlmRuntime,
): ImpactServiceDeps["impactSummarizer"] | undefined {
  if (!impactLlmSummaryEnabled()) return undefined;
  // #1033 — the per-item and run-overview calls meter under DISTINCT agentSteps
  // (`impact.summary-item` / `impact.summary-run`), so instrument the SAME base
  // provider twice, once per stage. Both share one build (hence one liveness).
  const built = buildImpactStageProvider();
  const itemProvider = instrumentStage(runtime, "summary-item", built);
  const runProvider = instrumentStage(runtime, "summary-run", built);
  if (!itemProvider || !runProvider) return undefined;
  return buildImpactSummarizer({ itemProvider, runProvider });
}

/**
 * Issue #965 — assemble the flag-gated LLM run deps (seeder, table filter,
 * summarizer) + the per-project live-schema introspector for a run started by
 * `actorId`. Shared by the initial-run (`POST /`) and the drift re-run
 * (`POST /:id/rerun`) so both paths wire identical engine collaborators — a re-run
 * against the current graph goes through the SAME pipeline as the original.
 *
 * Issues #1021/#1024 — ONE {@link ImpactLlmRuntime} per run owns the metering
 * session, the per-call deadline and the degradation ledger for EVERY stage
 * assembled here. A stage added later that does not route through
 * `instrumentStage` is an unmetered stage, which is precisely the regression
 * `impact-llm-runtime.test.ts` and `impact-analysis-metering.test.ts` pin down.
 */
export function impactRunDeps(actorId: string, projectIds: readonly string[]): ImpactServiceDeps {
  const runtime = createImpactLlmRuntime({ actorId, projectIds });
  const mapRequirement = llmSeedingMapRequirement(runtime);
  const tableRelevanceFilter = tableRelevanceFilterDep(runtime);
  const additiveColumnProposer = additiveColumnProposerDep(runtime);
  const clauseCoverageReconciler = clauseCoverageReconcilerDep(runtime);
  const tableRecoveryJudge = tableRecoveryJudgeDep(runtime);
  const impactSummarizer = impactSummarizerDep(runtime);
  const liveIndexIntrospectorFor = defaultLiveIndexIntrospectorFor(actorId);
  return {
    ...(mapRequirement ? { mapRequirement } : {}),
    ...(tableRelevanceFilter ? { tableRelevanceFilter } : {}),
    ...(additiveColumnProposer ? { additiveColumnProposer } : {}),
    ...(clauseCoverageReconciler ? { clauseCoverageReconciler } : {}),
    ...(tableRecoveryJudge ? { tableRecoveryJudge } : {}),
    ...(impactSummarizer ? { impactSummarizer } : {}),
    llmDegradationNotice: () => runtime.degradationNotice(),
    liveIndexIntrospectorFor,
  };
}

function actorOf(req: Request): SchedulerActor {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role as RoleKey };
}

/**
 * Issue #966 — a human-readable label for "who marked it" on table feedback.
 * The JWT only carries `username` (no `displayName`), so that's what gets
 * snapshotted; a missing value degrades to a placeholder rather than throwing
 * (feedback is a low-stakes capture path — never block on a cosmetic label).
 */
function actorDisplayNameOf(req: Request): string {
  return req.user?.username ?? "unknown";
}

function asAppError(err: unknown): unknown {
  if (err instanceof ImpactAnalysisError) {
    return new AppError(err.status, err.code, err.message);
  }
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request payload", {
      issues: err.flatten(),
    });
  }
  return err;
}

/**
 * Ensure `actor` can access every requested project. Admins see all projects
 * (a missing id then means it doesn't exist → 404); non-admins get 403 for any
 * project outside their accessible set so existence is never leaked.
 */
async function assertProjectsAccessible(
  actor: SchedulerActor,
  projectIds: string[],
): Promise<void> {
  const accessible = new Set(await listAccessibleProjectIds(actor));
  const missing = projectIds.filter((id) => !accessible.has(id));
  if (missing.length === 0) return;
  if (isAdminActor(actor)) {
    throw new AppError(404, "PROJECT_NOT_FOUND", `Unknown project(s): ${missing.join(", ")}`);
  }
  throw new AppError(403, "FORBIDDEN", "You do not have access to one or more requested projects");
}

/**
 * Issue #963 — load an impact analysis for `actor`, enforcing the SAME tenant
 * isolation as `GET /:id`: the caller must be able to access EVERY project the
 * run touches. Missing run OR any inaccessible project ⇒ 404 (existence is never
 * leaked). Shared by the export + Jira-publish routes so their authorization is
 * identical to the read route (OWASP A01 / BOLA).
 */
async function loadAccessibleImpactDetail(
  actor: SchedulerActor,
  id: string,
): Promise<ImpactAnalysisDetail> {
  const detail = await getImpactAnalysisDetail(id);
  if (!detail) {
    throw new AppError(404, "NOT_FOUND", "Impact analysis not found");
  }
  if (!isAdminActor(actor) && detail.projectIds.length > 0) {
    const accessible = new Set(await listAccessibleProjectIds(actor));
    if (!detail.projectIds.every((pid) => accessible.has(pid))) {
      throw new AppError(404, "NOT_FOUND", "Impact analysis not found");
    }
  }
  return detail;
}

/** #963 — optional body for the Jira publish: an explicit run project to bill the issue to. */
const publishImpactToJiraSchema = z.object({
  projectId: z.string().min(1).max(200).optional(),
});

/**
 * Default per-project schema introspector for the usage-classification compute
 * path: resolve the project's first/primary DB connector and run the read-only
 * introspection. Never executes DDL. Injectable for tests.
 */
function defaultProjectIntrospector(actorId: string): ProjectSchemaIntrospector {
  return async (projectId: string) => {
    const connectors = await listDbConnectors(projectId);
    if (connectors.length === 0) {
      throw new AppError(404, "NO_DB_CONNECTOR", "Project has no database connector to introspect");
    }
    const primary = connectors[0];
    const snapshot = await inspectDbConnector(projectId, primary.id, actorId);
    return snapshot.tables;
  };
}

/**
 * Default per-project ROUTINES introspector — Epic #293 Phase 2 (#302). Resolves
 * the project's primary DB connector and returns the routines (procedures &
 * functions) from the SAME read-only introspection snapshot used for tables. A
 * project with no routines (or a driver without routine introspection) yields an
 * empty list. Never executes DDL or a routine body. Injectable for tests.
 */
function defaultProjectRoutinesIntrospector(actorId: string): ProjectRoutinesIntrospector {
  return async (projectId: string) => {
    const connectors = await listDbConnectors(projectId);
    if (connectors.length === 0) return [];
    const primary = connectors[0];
    const snapshot = await inspectDbConnector(projectId, primary.id, actorId);
    return snapshot.routines ?? [];
  };
}

/**
 * Issue #958 — default per-project LIVE-SCHEMA introspector for the impact
 * engine's reconciliation dimension: resolve the project's primary DB
 * connector (SAME resolution as {@link defaultProjectIntrospector} above) and
 * turn its read-only introspection snapshot into a {@link LiveSchemaIndex} via
 * `loadLiveSchema`. Strictly read-only — `inspectDbConnector` never issues DDL.
 *
 * No connector configured, or introspection failing for ANY reason (offline
 * DB, driver error, timeout), degrades to `null` so the impact engine falls
 * back to its pre-#958 inferred-DDL behaviour for that project — never blocks
 * or fails the run. The engine (`executeImpactAnalysis`) invokes this AT MOST
 * ONCE per project per run regardless of how many changed requirements are in
 * the run, so a connected project never pays for repeated introspection.
 * Exported for direct unit testing.
 */
export function defaultLiveIndexIntrospectorFor(
  actorId: string,
): (projectId: string) => Promise<LiveSchemaIndex | null> {
  return async (projectId: string) => {
    try {
      const connectors = await listDbConnectors(projectId);
      if (connectors.length === 0) return null;
      const primary = connectors[0];
      return await loadLiveSchema(
        (connectorId) => inspectDbConnector(projectId, connectorId, actorId),
        primary.id,
      );
    } catch (err) {
      log.warn("live schema index introspection failed; proceeding without reconciliation", {
        projectId,
        error: String(err),
      });
      return null;
    }
  };
}

export interface UsageClassificationRouterDeps {
  /** Override the introspector (tests inject a deterministic schema). */
  introspectorFor?: (actorId: string) => ProjectSchemaIntrospector;
  /** Override the routines introspector (tests inject deterministic routines). */
  routinesIntrospectorFor?: (actorId: string) => ProjectRoutinesIntrospector;
}

export function impactAnalysisRouter(deps: UsageClassificationRouterDeps = {}): Router {
  const r = Router();
  r.use(requireAuth);

  // GET /projects/:projectId/usage-classification — Epic #292 (#298).
  // Read the persisted used/unreferenced/uncertain classification for ONE
  // project. Tenant isolation: the caller must be able to access the project
  // (same guard as the multi-project endpoints).
  r.get(
    "/projects/:projectId/usage-classification",
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        const actor = actorOf(req);
        const projectId = String(req.params.projectId);
        await assertProjectsAccessible(actor, [projectId]);
        const rows = await readUsageClassification(prisma, projectId);
        // Epic #294 (#304) — fold manual overrides in (precedence: manual wins).
        const overrides = await listManualOverrides(prisma, projectId);
        res.json(ok(applyOverrides(rows, overrides)));
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  // POST /projects/:projectId/usage-classification — Epic #292 (#297/#298).
  // Recompute + persist the classification by reconciling the introspected full
  // schema against the code→schema graph. Requires `analysis.run`. Never
  // executes DDL — introspection is the read-only connector path.
  r.post(
    "/projects/:projectId/usage-classification",
    requirePermission("analysis.run"),
    async (req, res, next) => {
      try {
        const actor = actorOf(req);
        const projectId = String(req.params.projectId);
        await assertProjectsAccessible(actor, [projectId]);
        const introspect = (deps.introspectorFor ?? defaultProjectIntrospector)(actor.id);
        const routinesIntrospect = (
          deps.routinesIntrospectorFor ?? defaultProjectRoutinesIntrospector
        )(actor.id);
        const result = await computeUsageClassification(
          prisma,
          projectId,
          introspect,
          routinesIntrospect,
        );
        res.status(200).json(ok({ persisted: result.persisted, objects: result.classified }));
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  // ---- Manual-override path — Epic #294 (#304) ----------------------------
  // Lets an analyst assert/correct a usage edge the SQL parser cannot derive
  // from dynamic SQL. Overrides persist with source `manual` and take precedence
  // over derived classifications. Requires `analysis.run` (a mutating action).

  // GET /projects/:projectId/usage-overrides — list manual overrides.
  r.get(
    "/projects/:projectId/usage-overrides",
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        const actor = actorOf(req);
        const projectId = String(req.params.projectId);
        await assertProjectsAccessible(actor, [projectId]);
        const rows = await listManualOverrides(prisma, projectId);
        res.json(ok(rows));
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  // POST /projects/:projectId/usage-overrides — assert/correct a usage edge.
  r.post(
    "/projects/:projectId/usage-overrides",
    requirePermission("analysis.run"),
    async (req, res, next) => {
      try {
        const actor = actorOf(req);
        const projectId = String(req.params.projectId);
        await assertProjectsAccessible(actor, [projectId]);
        const input = manualUsageOverrideSchema.parse(req.body);
        const view = await upsertManualOverride(prisma, projectId, input, actor.id);
        res.status(201).json(ok(view));
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  // DELETE /projects/:projectId/usage-overrides/:overrideId — remove an override.
  r.delete(
    "/projects/:projectId/usage-overrides/:overrideId",
    requirePermission("analysis.run"),
    async (req, res, next) => {
      try {
        const actor = actorOf(req);
        const projectId = String(req.params.projectId);
        await assertProjectsAccessible(actor, [projectId]);
        const removed = await deleteManualOverride(
          prisma,
          projectId,
          String(req.params.overrideId),
        );
        if (!removed) {
          throw new AppError(404, "NOT_FOUND", "Override not found");
        }
        res.status(204).end();
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  // ---- Cross-project queries — Epic #295 Phase 4 (#309) -------------------
  // Read-only, text-only. Every read enforces workspace MEMBERSHIP and project
  // access (cross-project-access.ts); a caller never sees resources/objects/
  // projects outside workspaces they belong to. NEVER executes DDL.

  // GET /workspaces/:workspaceId/objects/usage — "which projects use object X".
  // Query params: objectName (required), schemaName?, objectType? (defaults
  // table). Returns the projects (within the caller's accessible set in the
  // workspace) that reference the canonical object, with usage class + evidence.
  r.get(
    "/workspaces/:workspaceId/objects/usage",
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        const actor = actorOf(req);
        const workspaceId = String(req.params.workspaceId);
        const objectName = typeof req.query.objectName === "string" ? req.query.objectName : "";
        if (!objectName) {
          throw new AppError(400, "VALIDATION_ERROR", "objectName query param is required");
        }
        const schemaName =
          typeof req.query.schemaName === "string" && req.query.schemaName.length > 0
            ? req.query.schemaName
            : null;
        const rawType = typeof req.query.objectType === "string" ? req.query.objectType : "table";
        if (!(USAGE_OBJECT_KINDS as readonly string[]).includes(rawType)) {
          throw new AppError(400, "VALIDATION_ERROR", "invalid objectType");
        }
        const result = await whichProjectsUseObject(actor, workspaceId, {
          objectName,
          schemaName,
          objectType: rawType as UsageObjectKind,
        });
        res.json(ok(result));
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  // GET /projects/:projectId/cross-project-impact — aggregate the OTHER projects
  // in the same workspace that use the source project's affected objects.
  r.get(
    "/projects/:projectId/cross-project-impact",
    requirePermission("analysis.read"),
    async (req, res, next) => {
      try {
        const actor = actorOf(req);
        const projectId = String(req.params.projectId);
        const result = await crossProjectImpact(actor, projectId);
        res.json(ok(result));
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  // POST / — trigger a multi-project impact analysis.
  r.post("/", requirePermission("analysis.run"), async (req, res, next) => {
    try {
      const actor = actorOf(req);
      const body = createImpactAnalysisSchema.parse(req.body);

      // Dedupe project ids before authz + persistence.
      const projectIds = [...new Set(body.projectIds)];
      await assertProjectsAccessible(actor, projectIds);

      // The flag-gated LLM collaborators (#931 seeder, #936 table filter, #1001
      // additive-DDL proposer, #932 summarizer) + the #958 live-schema
      // introspector are assembled in ONE place so an initial run and a #965
      // drift re-run always wire the identical pipeline.
      const result = await triggerImpactAnalysis(
        {
          projectIds,
          documentId: body.documentId ?? null,
          text: body.text ?? null,
          actorId: actor.id,
          includeSchemaImpact: body.includeSchemaImpact,
          includeDependencies: body.includeDependencies,
        },
        impactRunDeps(actor.id, projectIds),
      );

      const payload: CreateImpactAnalysisResponse = {
        id: result.id,
        status: result.status as CreateImpactAnalysisResponse["status"],
        projectIds,
      };
      res.status(202).json(ok(payload));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // GET / — list analyses visible to the caller.
  r.get("/", requirePermission("analysis.read"), async (req, res, next) => {
    try {
      const actor = actorOf(req);
      const accessibleProjectIds = isAdminActor(actor)
        ? null
        : await listAccessibleProjectIds(actor);
      const rows = await listImpactAnalyses({ accessibleProjectIds });
      res.json(ok(rows));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // GET /:id — full per-project breakdown.
  r.get("/:id", requirePermission("analysis.read"), async (req, res, next) => {
    try {
      const actor = actorOf(req);
      const detail = await loadAccessibleImpactDetail(actor, String(req.params.id));
      res.json(ok(detail));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // ---- Re-run + drift — Issue #965 (Epic #960) ----------------------------
  // Re-execute a completed run against the CURRENT code graph and diff the result
  // against the original so a BA sees "what changed since" (living traceability).

  // POST /:id/rerun — create a NEW run linked to `:id` via `rerunOfId`, reusing the
  // original's stored `sourceText`/`documentId` VERBATIM and its impacted projects.
  // The original run is IMMUTABLE — this never mutates its rows. Requires
  // `analysis.run`; authorized identically to GET /:id (must access every project
  // the original touched → 404 on any leak). 202 Accepted; poll the new run.
  r.post("/:id/rerun", requirePermission("analysis.run"), async (req, res, next) => {
    try {
      const actor = actorOf(req);
      const id = String(req.params.id);
      const original = await loadAccessibleImpactDetail(actor, id);

      if (original.status !== "completed") {
        throw new AppError(
          409,
          "RERUN_NOT_COMPLETED",
          "Only a completed impact analysis can be re-run.",
        );
      }
      // Reuse the ORIGINAL's impacted projects. `projectIds` is derived from the
      // original's persisted items, so a run that produced no impact has none to
      // re-run against.
      const projectIds = [...original.projectIds];
      if (projectIds.length === 0) {
        throw new AppError(
          409,
          "RERUN_NO_PROJECTS",
          "The original analysis impacted no projects — nothing to re-run.",
        );
      }
      // Belt-and-braces: re-assert access to every project (identical to POST /).
      await assertProjectsAccessible(actor, projectIds);

      if (!original.documentId && !(original.sourceText && original.sourceText.trim().length > 0)) {
        throw new AppError(
          409,
          "RERUN_NO_SOURCE",
          "The original analysis has no stored source text or document to re-run.",
        );
      }

      const result = await triggerImpactAnalysis(
        {
          projectIds,
          documentId: original.documentId,
          text: original.sourceText,
          actorId: actor.id,
          rerunOfId: id,
        },
        impactRunDeps(actor.id, projectIds),
      );

      res.status(202).json(
        ok({
          id: result.id,
          status: result.status as CreateImpactAnalysisResponse["status"],
          projectIds,
          rerunOfId: id,
        }),
      );
    } catch (err) {
      next(asAppError(err));
    }
  });

  // GET /:id/drift — the deterministic drift report for run `:id` (HEAD) vs the
  // original run it re-executes (its `rerunOfId` parent, the BASE). Computed as a
  // PURE diff over the two runs' PERSISTED rows (no re-analysis). A run with no
  // parent (an original) yields an empty report (baseAnalysisId null). Authorized
  // identically to GET /:id for BOTH runs — the caller must access every project
  // each run touches (404 on any leak).
  r.get("/:id/drift", requirePermission("analysis.read"), async (req, res, next) => {
    try {
      const actor = actorOf(req);
      const id = String(req.params.id);
      const head = await loadAccessibleImpactDetail(actor, id);

      if (!head.rerunOfId) {
        const empty: ImpactDriftReport = {
          headAnalysisId: head.id,
          baseAnalysisId: null,
          requirements: [],
          summary: {
            requirementsAdded: 0,
            requirementsRemoved: 0,
            requirementsChanged: 0,
            requirementsUnchanged: 0,
            tablesAdded: 0,
            tablesRemoved: 0,
            symbolsAdded: 0,
            symbolsRemoved: 0,
          },
        };
        res.json(ok(empty));
        return;
      }

      const base = await loadAccessibleImpactDetail(actor, head.rerunOfId);
      res.json(ok(diffImpactRuns(base, head)));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // ---- Table relevance feedback — Issue #966 (Epic #960) ------------------
  // A BA marks one affected-table row `relevant`/`not-relevant`. v1 is
  // CAPTURE + EXPORT ONLY: persisting a mark has ZERO effect on the engine or
  // the #936 LLM relevance filter — it is harvested (human-reviewed) into the
  // eval corpus by `pnpm eval:harvest-feedback`. Idempotent per
  // (item, table, column, user); scoped to the item's own project so a caller
  // must be able to access it (same tenant-isolation shape as the manual-
  // override routes above).

  // POST /:id/items/:itemId/feedback — mark (or re-mark) a row.
  r.post(
    "/:id/items/:itemId/feedback",
    requirePermission("analysis.run"),
    async (req, res, next) => {
      try {
        const actor = actorOf(req);
        const analysisId = String(req.params.id);
        const itemId = String(req.params.itemId);
        const item = await findFeedbackTargetItem(prisma, analysisId, itemId);
        if (!item) {
          throw new AppError(404, "NOT_FOUND", "Impact item not found");
        }
        await assertProjectsAccessible(actor, [item.projectId]);
        const input = impactTableFeedbackInputSchema.parse(req.body);
        const view = await upsertTableFeedback(prisma, analysisId, itemId, input, {
          id: actor.id,
          displayName: actorDisplayNameOf(req),
        });
        res.status(201).json(ok(view));
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  // DELETE /:id/items/:itemId/feedback/:feedbackId — remove a mark. Scoped to
  // the caller's OWN feedback row (IDOR-safe — see table-feedback.ts).
  r.delete(
    "/:id/items/:itemId/feedback/:feedbackId",
    requirePermission("analysis.run"),
    async (req, res, next) => {
      try {
        const actor = actorOf(req);
        const analysisId = String(req.params.id);
        const itemId = String(req.params.itemId);
        const item = await findFeedbackTargetItem(prisma, analysisId, itemId);
        if (!item) {
          throw new AppError(404, "NOT_FOUND", "Impact item not found");
        }
        await assertProjectsAccessible(actor, [item.projectId]);
        const removed = await deleteTableFeedback(
          prisma,
          analysisId,
          itemId,
          String(req.params.feedbackId),
          actor.id,
        );
        if (!removed) {
          throw new AppError(404, "NOT_FOUND", "Feedback not found");
        }
        res.status(204).end();
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  // GET /:id/export.md — Issue #963 (Epic #960). Download the impact run as a
  // markdown report (run summary + per-requirement narrative + likely/possibly-
  // related tables with tiers/rationale/DDL + affected code + cross-project
  // consumers), serialized from PERSISTED rows only (no LLM call). Streamed as a
  // downloadable attachment (NOT the `{ success, data }` envelope), mirroring the
  // analysis-report export (analysis.ts `/:id/export`). Authorized identically to
  // GET /:id (analysis.read + every-project access → 404 on any leak).
  r.get("/:id/export.md", requirePermission("analysis.read"), async (req, res, next) => {
    try {
      const actor = actorOf(req);
      const id = String(req.params.id);
      const detail = await loadAccessibleImpactDetail(actor, id);

      // Resolve display names for the run's projects (cosmetic; never changes
      // which rows are serialized). Failure to name a project falls back to its id.
      const projects = await prisma.project.findMany({
        where: { id: { in: detail.projectIds } },
        select: { id: true, name: true },
      });
      const projectNames: Record<string, string> = {};
      for (const p of projects) projectNames[p.id] = p.name;

      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="impact-analysis-${id}.md"`);
      res.send(serializeImpactAnalysisMarkdown(detail, { projectNames }));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // POST /:id/publish/jira — Issue #963 (Epic #960). Publish the run to Jira as
  // ONE issue, mirroring the finding-publisher pattern (marker dedup + idempotent
  // IssueLink keyed on impactAnalysisId). Idempotent re-publish returns the same
  // link (no duplicate Jira issue). The Jira target is a RUN project's configured
  // connection: an explicit `projectId` (body) must be one of the run's projects;
  // otherwise the first configured run project (sorted) is used. Clear 400 when no
  // run project has a Jira connection/project key (same semantics as analysis.ts).
  r.post("/:id/publish/jira", requirePermission("issue.publish"), async (req, res, next) => {
    try {
      const actor = actorOf(req);
      const id = String(req.params.id);
      const body = publishImpactToJiraSchema.parse(req.body ?? {});
      const detail = await loadAccessibleImpactDetail(actor, id);

      // Candidate run projects, optionally narrowed to an explicit (in-run) project.
      let candidateIds = [...detail.projectIds].sort((a, b) => a.localeCompare(b));
      if (body.projectId) {
        if (!candidateIds.includes(body.projectId)) {
          throw new AppError(
            400,
            "PROJECT_NOT_IN_RUN",
            "The requested project is not part of this impact analysis run.",
          );
        }
        candidateIds = [body.projectId];
      }

      // Pick the first candidate with a configured Jira connection + project key.
      const configured = await prisma.project.findMany({
        where: {
          id: { in: candidateIds },
          NOT: [{ jiraConnectionId: null }, { jiraProjectKey: null }],
        },
        select: { id: true },
      });
      const configuredIds = new Set(configured.map((p) => p.id));
      const jiraProjectId = candidateIds.find((pid) => configuredIds.has(pid));
      if (!jiraProjectId) {
        throw new AppError(
          400,
          "JIRA_NOT_CONFIGURED",
          "No project in this impact analysis run has a Jira connection or project key configured — set one in project settings before publishing to Jira.",
        );
      }

      const projects = await prisma.project.findMany({
        where: { id: { in: detail.projectIds } },
        select: { id: true, name: true },
      });
      const projectNames: Record<string, string> = {};
      for (const p of projects) projectNames[p.id] = p.name;

      const title = `Impact analysis: ${detail.summary?.slice(0, 200) ?? `run ${id}`}`;
      const markdown = serializeImpactAnalysisMarkdown(detail, { projectNames });

      try {
        const link = await publishImpactAnalysisToJira({
          analysisId: id,
          jiraProjectId,
          title,
          body: markdown,
        });
        res
          .status(200)
          .json(ok({ provider: "jira", issueKey: link.externalId, url: link.externalUrl }));
      } catch (err) {
        // Mirror analysis.ts:1091 — an unconfigured/failed Jira destination is a
        // 400 client error, not a downstream 5xx.
        if (err instanceof PublishError) {
          throw new AppError(400, "JIRA_PUBLISH_FAILED", err.message);
        }
        throw err;
      }
    } catch (err) {
      next(asAppError(err));
    }
  });

  return r;
}
