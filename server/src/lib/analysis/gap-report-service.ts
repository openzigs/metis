/**
 * Per-requirement gap report SERVICE (Issue #742, Epic #728).
 *
 * Assembles the gap report for one analysis from ALREADY-PERSISTED data and
 * hands it to the pure {@link buildGapReport} builder — no recomputation, no LLM
 * call. A single read: the analysis snapshot (requirements + their coverage +
 * evidence links, and every finding + its #734 code citations + #740
 * verification), via the existing `getAnalysisSnapshot` read path so the report
 * stays byte-consistent with the GET /analyses/:id contract.
 *
 * Mirrors the traceability matrix service (#737): the effort estimate reuses the
 * requirement's existing `storyPoints`, and requirements with no code-cited
 * evidence render an explicit no-evidence report rather than a fabricated one.
 */
import {
  type AnalysisDatabaseAware,
  type FindingSeverity,
  type GapReport,
  type SqlLineageCoverage,
  FINDING_SEVERITIES,
} from "@metis/shared";
import { getAnalysisSnapshot } from "./analysis-service.js";
import {
  buildGapReport,
  type GapReportFindingInput,
  type GapReportRequirementInput,
  type GapReportSchemaImpactInput,
} from "./gap-report.js";

export interface GapReportDeps {
  /** Injectable snapshot loader (tests). Defaults to the shared read path. */
  loadSnapshot?: typeof getAnalysisSnapshot;
  /**
   * Issue #825 — optional loader for the per-requirement affected-schema inputs
   * (1c / #823 rows + 1b / #822 consumers), keyed by requirement id. When
   * provided, the report carries a `databaseChanges` section per requirement with
   * schema impact; when omitted (the default) the report is byte-identical to the
   * pre-#825 shape. The heavy per-requirement schema crossing is produced by the
   * analysis pipeline — this service only threads it through, never recomputes it.
   */
  loadSchemaImpact?: (
    analysisId: string,
  ) => Promise<ReadonlyMap<string, GapReportSchemaImpactInput>>;
  /**
   * Issue #856 (Epic #852 Phase 2c) — the ALREADY-RESOLVED database-aware
   * decision for this project (`resolveDatabaseAwareAnalysis`, #854), computed
   * once by {@link resolveGapReportDeps} and threaded through verbatim so the
   * report can surface why `databaseChanges` is present, empty, or absent.
   * Undefined for callers that predate #856.
   */
  databaseAware?: AnalysisDatabaseAware | null;
  /**
   * Issue #895 (Epic #882 Phase 3) — the ALREADY-COMPUTED project-wide
   * SQL-lineage coverage (`computeSqlLineageCoverage`), resolved once by
   * {@link resolveGapReportDeps} and threaded through verbatim. `null` when the
   * project has no schema lineage edges; undefined for callers that don't
   * compute it (the report then omits the field). Project-scoped (NOT
   * per-analysis) — it reflects the whole schema graph, so it takes no
   * `analysisId`.
   */
  sqlLineageCoverage?: SqlLineageCoverage | null;
}

const SEVERITY_SET = new Set<string>(FINDING_SEVERITIES);

function coerceSeverity(value: string): FindingSeverity {
  return SEVERITY_SET.has(value) ? (value as FindingSeverity) : "info";
}

/**
 * Build the gap report for an analysis, or `null` when the analysis does not
 * exist / is not visible (the route maps that to 404 — no leak of existence).
 * Scope/ownership is enforced by the caller before this runs.
 */
export async function getGapReport(
  analysisId: string,
  deps: GapReportDeps = {},
): Promise<GapReport | null> {
  const loadSnapshot = deps.loadSnapshot ?? getAnalysisSnapshot;

  const snapshot = await loadSnapshot(analysisId);
  if (!snapshot) return null;
  const requirements: GapReportRequirementInput[] = snapshot.requirements.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    priority: r.priority,
    coverage: r.coverage ?? null,
    verdict: r.verdict ?? null,
    storyPoints: r.storyPoints,
    evidenceFindingIds: r.evidenceFindingIds,
  }));

  const findingsById = new Map<string, GapReportFindingInput>();
  for (const agent of snapshot.agents) {
    for (const finding of agent.findings) {
      findingsById.set(finding.id, {
        id: finding.id,
        title: finding.title,
        body: finding.body,
        severity: coerceSeverity(finding.severity),
        verificationStatus: finding.verificationStatus ?? null,
        verdict: finding.verdict ?? null,
        citations: finding.citations,
      });
    }
  }

  return buildGapReport({
    analysisId: snapshot.id,
    projectId: snapshot.projectId,
    requirements,
    findingsById,
    // Issue #773 — searched-scope provenance for every gap-confirmed verdict.
    retrieval: snapshot.retrieval ?? null,
    // Issue #825 — per-requirement affected-schema inputs, when a producer is
    // wired. Undefined by default ⇒ no `databaseChanges` section (backward compatible).
    schemaImpactByRequirementId: deps.loadSchemaImpact
      ? await deps.loadSchemaImpact(analysisId)
      : undefined,
    // #856 — threaded through verbatim; undefined when the caller never resolved
    // one (byte-identical to pre-#856).
    databaseAware: deps.databaseAware,
    // #895 — threaded through verbatim; undefined when the caller never computed
    // it (byte-identical to pre-#895).
    sqlLineageCoverage: deps.sqlLineageCoverage,
  });
}
