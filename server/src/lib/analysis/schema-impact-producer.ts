/**
 * Production `loadSchemaImpact` producer — Epic #820 wiring (#847).
 *
 * This is the missing production producer the gap-report route never supplied.
 * Before #847, {@link getGapReport} gated the `databaseChanges` section on an
 * OPTIONAL `loadSchemaImpact` dependency that no caller ever constructed — so the
 * entire per-requirement schema-impact + cross-project blast-radius feature of
 * epic #820 (#822/#823/#825/#826/#831) was unreachable in production (the epic's
 * own #750/#797 "reachability ≠ existence" trap). This module builds the real
 * producer and the route wires it in at both gap-report call sites.
 *
 * It invents NO new blast-radius or identity traversal — it composes the
 * ALREADY-MERGED machinery, keyed by requirement id:
 *   1. {@link computeProjectImpact} (#162/#168) maps each requirement to its code
 *      symbols + blast radius AND crosses them into the schema graph via
 *      {@link crossToSchema} (`includeSchemaImpact`) — the SAME crossing #823 uses
 *      — returning the affected `table`/`column`/routine rows with reconciliation
 *      (when a live index is supplied) and TEXT-ONLY suggested DDL.
 *   2. {@link enumerateSchemaConsumers} (#822) enumerates the cross-project
 *      (shared-database) consumers of those affected objects — read-only,
 *      workspace-scoped, reusing #821's identity resolver and #309's
 *      `whichProjectsUseObject`. No parallel consumer query is written here.
 *
 * Safety rails (epic #820, non-negotiable):
 *   - READ-ONLY against METIS's OWN Prisma tables. It NEVER introspects a customer
 *     database, executes DDL, or fetches routine bodies. At report time no live
 *     connection is opened: `liveIndexFor` defaults to `null`, so affected rows
 *     stay UNRECONCILED and therefore surface as speculative / could-not-verify
 *     (#826 discipline), never asserted. An operator/test that supplies a live
 *     index gets reconciliation for free through the same call.
 *   - Suggested DDL is TEXT ONLY ({@link crossToSchema} → `suggestDdl`).
 *   - Best-effort + total: one requirement's mapping/crossing failure is logged
 *     and skipped, never sinking the whole report; a requirement with no schema
 *     impact is simply absent from the map (no fabricated section).
 *
 * Cost guard: this runs synchronously inside the gap-report GET. It is gated by
 * the per-project resolver decision (#856) — since #849 the platform default
 * behind that decision is ON, so a project with schema data gets the section
 * without env config; a project with none still short-circuits, an explicit
 * per-project `off` still suppresses it, and an operator who explicitly sets
 * {@link SCHEMA_IMPACT_FLAG} false still disables it fleet-wide. Capped at
 * `ANALYSIS_SCHEMA_IMPACT_MAX_REQUIREMENTS` requirements per report.
 */
import type { PrismaClient } from "@prisma/client";
import {
  type AnalysisDatabaseAware,
  type DatabaseAwareAnalysisSetting,
  type SqlLineageCoverage,
  DATABASE_AWARE_ANALYSIS_SETTINGS,
  DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING,
} from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { getConfigService } from "../config/config-service.js";
import { prisma as defaultPrisma } from "../prisma.js";
import { getAnalysisSnapshot } from "./analysis-service.js";
import type { GapReportDeps } from "./gap-report-service.js";
import type { GapReportSchemaImpactInput } from "./gap-report.js";
import {
  computeProjectImpact,
  PrismaCodeGraphDataSource,
} from "../impact-analysis/impact-analysis-engine.js";
import {
  PrismaSchemaImpactDataSource,
  type SchemaImpactDataSource,
} from "../impact-analysis/schema-impact.js";
import type { LiveSchemaIndex } from "../impact-analysis/live-schema-ingest.js";
import type { ChangedRequirement } from "../impact-analysis/extract-changes.js";
import {
  mapRequirementToCode,
  MemoizingBm25CodeSymbolSearcher,
  type RequirementCodeMatch,
} from "../traceability/requirement-code-mapping.js";
import {
  CachingCodeGraphDataSource,
  type CodeGraphDataSource,
} from "../code-graph/query-service.js";
import { enumerateSchemaConsumers, type ConsumersPrisma } from "./affected-schema-consumers.js";
import {
  resolveDatabaseAwareAnalysis,
  readDbAwareEnvDefault,
  hasSchemaData as probeHasSchemaData,
  DB_AWARE_PLATFORM_DEFAULT,
  type DbAwareEnvDefault,
  type SchemaDataPrismaClient,
} from "./database-aware-resolver.js";
import {
  computeSqlLineageCoverage,
  type SqlLineageCoveragePrismaClient,
} from "./sql-lineage-coverage.js";

const log = createChildLogger("schema-impact-producer");

/**
 * Operator gate mirroring `ANALYSIS_SCHEMA_CONTEXT` (#732/#752) — read via
 * `cfg.getBool`. Default ON since #849 (see `DB_AWARE_PLATFORM_DEFAULT`): the
 * per-requirement crossing this producer runs is deterministic graph traversal
 * with no LLM calls, and #849's whole point is that the feature is reachable
 * without hidden env config. An operator who explicitly sets this key false
 * still disables it fleet-wide — that kill-switch is the resolver's
 * `auto->platform-disabled` branch, not this reader.
 */
export const SCHEMA_IMPACT_FLAG = "ANALYSIS_SCHEMA_IMPACT";
/** Upper bound on requirements crossed per report (cost cap). */
export const DEFAULT_SCHEMA_IMPACT_MAX_REQUIREMENTS = 50;

type MapRequirementFn = (
  req: { id: string; title: string; body: string },
  projectId: string,
) => Promise<RequirementCodeMatch[]>;

/** Prisma surface the producer needs: consumer reads + the impact/code reads. */
type ProducerPrisma = ConsumersPrisma & Pick<PrismaClient, "codeSymbol" | "codeEdge">;

/**
 * Injectable seam for {@link loadAnalysisSchemaImpact}. Every field is optional —
 * the defaults are the production snapshot read, BM25 requirement→code mapper,
 * and Prisma code + schema graph data sources — so a test can drive the whole
 * crossing in-memory WITHOUT injecting a hand-built `loadSchemaImpact` (that
 * false-green is precisely what #847 kills; tests drive THIS real producer).
 */
export interface SchemaImpactProducerDeps {
  /** Snapshot loader (requirements + projectId). Defaults to the shared read path. */
  loadSnapshot?: typeof getAnalysisSnapshot;
  /** Prisma client for consumer + code/schema reads. Defaults to the shared client. */
  prisma?: ProducerPrisma;
  /** Requirement→code mapper. Defaults to the BM25 `mapRequirementToCode`. */
  mapRequirement?: MapRequirementFn;
  /** Code-graph data source factory. Defaults to `PrismaCodeGraphDataSource`. */
  dataSourceFor?: (projectId: string) => CodeGraphDataSource;
  /** Schema-graph data source factory. Defaults to `PrismaSchemaImpactDataSource`. */
  schemaDataSourceFor?: (projectId: string) => SchemaImpactDataSource;
  /**
   * Live schema index factory for reconciliation. Defaults to `() => null` — no
   * live introspection at report time (read-only, cheap, safe): rows stay
   * unreconciled ⇒ speculative / could-not-verify (#826), never asserted. Inject
   * a real index to reconcile.
   */
  liveIndexFor?: (projectId: string) => LiveSchemaIndex | null;
  /** Cross-project consumer enumerator. Defaults to #822's `enumerateSchemaConsumers`. */
  enumerateConsumers?: typeof enumerateSchemaConsumers;
  /** Cost cap on requirements crossed. Defaults to the configured/50 max. */
  maxRequirements?: number;
}

/**
 * Compute the per-requirement affected-schema inputs (1c/#823 rows + 1b/#822
 * consumers) for an analysis, keyed by requirement id — the real producer that
 * feeds {@link getGapReport}'s `loadSchemaImpact`. Returns an EMPTY map when the
 * analysis has no visible requirements or none imply a schema change (the report
 * then carries no `databaseChanges`, byte-identical to today). Never throws.
 */
export async function loadAnalysisSchemaImpact(
  analysisId: string,
  deps: SchemaImpactProducerDeps = {},
): Promise<ReadonlyMap<string, GapReportSchemaImpactInput>> {
  const result = new Map<string, GapReportSchemaImpactInput>();

  const loadSnapshot = deps.loadSnapshot ?? getAnalysisSnapshot;
  const snapshot = await loadSnapshot(analysisId);
  if (!snapshot) return result;

  const projectId = snapshot.projectId;
  const prisma = (deps.prisma ?? (defaultPrisma as unknown as ProducerPrisma)) as ProducerPrisma;
  const sharedSearcher = new MemoizingBm25CodeSymbolSearcher(prisma as never);
  const mapRequirement: MapRequirementFn =
    deps.mapRequirement ??
    // Reuse ONE BM25 index across every requirement in this report (#849/#872
    // perf): the default mapper rebuilds the whole-project index per requirement,
    // which — with the synchronous SQLite dev driver — blocked the event loop for
    // ~8s on a large graph and starved concurrent gap-report/list requests.
    ((req, pid) =>
      mapRequirementToCode(req, pid, {}, { prisma: prisma as never, searcher: sharedSearcher }));
  // ONE cached code-graph source reused across every requirement's blast-radius
  // BFS (#849/#872 perf): the raw source issues a query per visited node, and the
  // requirements' depth-limited neighborhoods overlap heavily — recreating an
  // uncached source per requirement re-ran those queries and (on the synchronous
  // SQLite dev driver) blocked the event loop for ~8s. Caching collapses the
  // overlap to one query per distinct node for the whole report.
  const sharedGraph = new CachingCodeGraphDataSource(
    new PrismaCodeGraphDataSource(prisma as never, projectId),
  );
  const dataSourceFor = deps.dataSourceFor ?? (() => sharedGraph);
  const schemaDataSourceFor =
    deps.schemaDataSourceFor ??
    ((pid: string) => new PrismaSchemaImpactDataSource(prisma as never, pid));
  const liveIndexFor = deps.liveIndexFor ?? (() => null);
  const enumerateConsumers = deps.enumerateConsumers ?? enumerateSchemaConsumers;

  const cfg = getConfigService();
  const maxRequirements =
    deps.maxRequirements ??
    cfg.getNumber(
      "ANALYSIS_SCHEMA_IMPACT_MAX_REQUIREMENTS",
      DEFAULT_SCHEMA_IMPACT_MAX_REQUIREMENTS,
    );

  const requirements = snapshot.requirements.slice(0, Math.max(0, maxRequirements));

  for (const r of requirements) {
    try {
      // 1. Map requirement → code symbols + blast radius AND cross into the schema
      //    graph in one call (the SAME crossToSchema path #823 uses). No parallel
      //    blast-radius or crossing is reimplemented here.
      const change: ChangedRequirement = {
        requirementId: r.id,
        title: r.title,
        body: r.body,
        changeType: "added",
        bodyDelta: r.body.length,
      };
      const impact = await computeProjectImpact(change, projectId, {
        mapRequirement,
        dataSourceFor,
        schemaDataSourceFor,
        liveIndexFor,
        includeSchemaImpact: true,
      });
      const rows = impact.affectedTables;
      if (rows.length === 0) continue;

      // 2. Enumerate the cross-project (shared-DB) consumers of those objects —
      //    reused verbatim (#822 → #821 identity + #309 consumer queries).
      const consumers = await enumerateConsumers({ projectId, affected: rows }, prisma);

      result.set(r.id, { rows, consumers });
    } catch (err) {
      // One requirement's failure must never sink the whole report.
      log.warn("schema-impact crossing failed for requirement; skipping", {
        analysisId,
        requirementId: r.id,
        error: String(err),
      });
    }
  }

  return result;
}

/**
 * Platform flag reader — `ANALYSIS_SCHEMA_IMPACT`, default ON since #849. Kept
 * as a named export for tests/observability, but since #856 it is no longer the
 * direct gate for {@link resolveGapReportDeps}: it feeds
 * `envDefault.schemaImpact`, one of the resolver's (#854) inputs — see the
 * resolution order in `database-aware-resolver.ts`'s module docs for how an
 * explicitly-configured false value becomes the fleet-wide kill-switch.
 */
export function isSchemaImpactEnabled(): boolean {
  return getConfigService().getBool(SCHEMA_IMPACT_FLAG, DB_AWARE_PLATFORM_DEFAULT);
}

/**
 * Validate an untrusted `Project.databaseAwareAnalysis` value against the
 * shared whitelist, degrading to the documented default. Mirrors the identical
 * guard in `orchestrator.ts`'s `resolveDatabaseAware` (#855) so both callers of
 * #854's resolver apply the SAME untrusted-input discipline (OWASP: an
 * unrecognized/corrupted column value never throws, it degrades to `auto`).
 */
function coerceDatabaseAwareSetting(raw: unknown): DatabaseAwareAnalysisSetting {
  const settings: readonly string[] = DATABASE_AWARE_ANALYSIS_SETTINGS;
  return settings.includes(raw as string)
    ? (raw as DatabaseAwareAnalysisSetting)
    : DEFAULT_DATABASE_AWARE_ANALYSIS_SETTING;
}

/**
 * Shared core of {@link resolveProjectDatabaseAware} / {@link
 * resolveProjectDatabaseAwareState}: validate `Project.databaseAwareAnalysis`
 * (untrusted), probe schema-data presence via #854's `hasSchemaData`, and fold
 * both plus the two legacy env flags into ONE decision via #854's
 * `resolveDatabaseAwareAnalysis`. Both exported wrappers below call THIS one
 * function so every caller of the coupling invariant reads the identical
 * inputs — see the module-level coupling discussion on
 * {@link resolveProjectDatabaseAware}.
 *
 * Best-effort: a schema-data probe failure degrades to "no schema data" (fail
 * closed — never assumed present), matching the run path's posture. Never
 * throws into the caller.
 */
async function computeProjectDatabaseAwareDecision(
  projectId: string,
  prisma: ProducerPrisma,
): Promise<{
  setting: DatabaseAwareAnalysisSetting;
  resolved: ReturnType<typeof resolveDatabaseAwareAnalysis>;
  hasSchemaData: boolean;
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { databaseAwareAnalysis: true },
  });
  const setting = coerceDatabaseAwareSetting(
    (project as { databaseAwareAnalysis?: string } | null)?.databaseAwareAnalysis,
  );

  // #849 — same helper the run path uses, so both apply the identical default
  // (ON) and the identical explicitly-configured probe.
  const envDefault: DbAwareEnvDefault = readDbAwareEnvDefault(getConfigService());

  let dataPresent = false;
  try {
    dataPresent = await probeHasSchemaData(prisma as unknown as SchemaDataPrismaClient, projectId);
  } catch (err) {
    log.warn("Database-aware schema-data probe failed; degrading to no schema data", {
      projectId,
      error: (err as Error).message,
    });
  }

  const resolved = resolveDatabaseAwareAnalysis({
    setting,
    envDefault,
    hasSchemaData: dataPresent,
  });
  return { setting, resolved, hasSchemaData: dataPresent };
}

/**
 * Epic #852 Phase 2c (#856) — resolve the per-project database-aware-analysis
 * decision through the EXACT SAME primitives the run path (#855,
 * `orchestrator.ts`'s private `resolveDatabaseAware`) calls. This is the
 * coupling invariant epic #852 exists to enforce: no caller may read
 * different inputs into the resolver and diverge into a half-on state. Used
 * by {@link resolveGapReportDeps} below (gap-report path); the shape
 * (`{setting, enabled, ran, reason}`, no `hasSchemaData`) is unchanged from
 * #856 so the persisted `GapReport.databaseAware` field stays exactly as it
 * was.
 */
export async function resolveProjectDatabaseAware(
  projectId: string,
  prisma: ProducerPrisma,
): Promise<AnalysisDatabaseAware> {
  const { setting, resolved } = await computeProjectDatabaseAwareDecision(projectId, prisma);
  return { setting, ...resolved };
}

/**
 * Epic #852 Phase 3 (#857) — the project-settings "resolved state" read
 * (`GET /api/projects/:id/database-aware-analysis`, `project-service.ts`)
 * calls this THIRD caller of {@link computeProjectDatabaseAwareDecision}
 * rather than a hand-rolled fourth implementation of the same wiring. Adds
 * `hasSchemaData` on top of {@link resolveProjectDatabaseAware}'s shape
 * purely for the UI hint ("no schema data yet — connect a database or
 * re-ingest"); the gap-report/run-path shapes are untouched.
 */
export async function resolveProjectDatabaseAwareState(
  projectId: string,
  prisma: ProducerPrisma,
): Promise<AnalysisDatabaseAware & { hasSchemaData: boolean }> {
  const { setting, resolved, hasSchemaData } = await computeProjectDatabaseAwareDecision(
    projectId,
    prisma,
  );
  return { setting, ...resolved, hasSchemaData };
}

/**
 * The single production wiring point for the gap-report route (`analysis.ts`
 * L663/L695). Epic #852 Phase 2c (#856): the `databaseChanges` gate is now the
 * resolver's `enabled` decision (#854), NOT the bare {@link SCHEMA_IMPACT_FLAG}
 * directly — replacing the #847 gate this function used to apply alone. When
 * `enabled` is `false`, returns `{ databaseAware }` (no `loadSchemaImpact`) so
 * {@link getGapReport} takes its exact pre-#847 branch — no `databaseChanges`,
 * BYTE-IDENTICAL to today — while still surfacing WHY via `databaseAware.reason`.
 * When `enabled` is `true`, also wires the real `loadSchemaImpact` bound to
 * {@link loadAnalysisSchemaImpact}. The `ANALYSIS_SCHEMA_IMPACT_MAX_REQUIREMENTS`
 * cost cap is unaffected — it still applies inside the producer.
 *
 * Issue #895 (Epic #882 Phase 3): ALSO computes the project-wide SQL-lineage
 * unresolved/dynamic coverage (`computeSqlLineageCoverage`) and threads it
 * through on BOTH branches. Coverage is INDEPENDENT of the `databaseAware`
 * gate — the unresolved-edge markers (#886/#890/#892/#893) live in the schema
 * graph regardless of whether the per-requirement schema-impact crossing runs
 * — so it is surfaced whenever the project has schema lineage edges (a single
 * indexed `code_edges` read; `null` and cheap when there are none). Never
 * throws: a coverage-read failure degrades to `null` rather than sinking the
 * whole gap-report response.
 */
export async function resolveGapReportDeps(
  projectId: string,
  deps?: SchemaImpactProducerDeps,
): Promise<GapReportDeps> {
  const prisma = (deps?.prisma ?? (defaultPrisma as unknown as ProducerPrisma)) as ProducerPrisma;
  const databaseAware = await resolveProjectDatabaseAware(projectId, prisma);

  let sqlLineageCoverage: SqlLineageCoverage | null = null;
  try {
    sqlLineageCoverage = await computeSqlLineageCoverage(
      projectId,
      prisma as unknown as SqlLineageCoveragePrismaClient,
    );
  } catch (err) {
    log.warn("SQL-lineage coverage computation failed; omitting from gap report", {
      projectId,
      error: String(err),
    });
  }

  if (!databaseAware.enabled) return { databaseAware, sqlLineageCoverage };
  return {
    loadSchemaImpact: (analysisId) => loadAnalysisSchemaImpact(analysisId, deps),
    databaseAware,
    sqlLineageCoverage,
  };
}
