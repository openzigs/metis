/**
 * Per-requirement gap report — PURE builder (Issue #742, Epic #728).
 *
 * Given the synthesized requirements and their linked findings (already loaded
 * from the persisted analysis by {@link getGapReport}), assemble one gap report
 * per requirement:
 *
 *   - `currentImplementation` — the deterministic, code-grounded view of what
 *     exists today: the deduped set of CODE citations across the requirement's
 *     linked findings (confirmed findings first, so the strongest #740 evidence
 *     leads). `hasEvidence`/`noEvidence` are false/true when NOTHING cites code,
 *     so the UI renders an explicit "nothing found in code" marker rather than a
 *     fabricated summary (no-fabrication rule).
 *   - `gapFindings` — the requirement's linked gap-path findings, surfaced
 *     verbatim. The `code` specialist prompt already makes each finding body
 *     state (1) what the requirement asks, (2) what current code does/lacks, and
 *     (3) the change needed — so the finding body IS the gap narrative; we do NOT
 *     re-derive or split it (and add NO LLM call).
 *   - `storyPoints` — the requirement's EXISTING effort field, passed through
 *     unchanged (null ⇒ the UI shows "unestimated").
 *   - `verificationStatus` — a roll-up of the linked findings' #740 verdicts.
 *
 * The builder is pure and total: every input requirement produces exactly one
 * report, and a requirement with no linked (or no code-cited) findings produces
 * an honest empty/no-evidence report — never an omission.
 */
import {
  isCodeCitation,
  formatCodeCitationLocator,
  type AnalysisDatabaseAware,
  type AnalysisRetrievalHealth,
  type Citation,
  type CodeCitation,
  type FindingSeverity,
  type FindingVerificationStatus,
  type GapReport,
  type GapReportCurrentImplementation,
  type GapReportDatabaseChange,
  type GapReportFindingRef,
  type GapReportRequirement,
  type GapReportSchemaConsumer,
  type RequirementCoverage,
  type RequirementPriority,
  type RequirementVerdict,
  type SqlLineageCoverage,
} from "@metis/shared";
import type { AffectedTableInput } from "../impact-analysis/schema-impact.js";
import { classifyDdlRisk } from "../impact-analysis/ddl-risk-classifier.js";
import type { AffectedSchemaConsumers, SchemaConsumer } from "./affected-schema-consumers.js";

/** Minimal requirement projection the builder needs (from the snapshot). */
export interface GapReportRequirementInput {
  id: string;
  title: string;
  body: string;
  priority: RequirementPriority;
  coverage: RequirementCoverage | null;
  /** Issue #773 — the persisted three-state verdict (null on pre-#773 rows). */
  verdict: RequirementVerdict | null;
  storyPoints: number | null;
  evidenceFindingIds: string[];
}

/** Minimal finding projection the builder needs (from the snapshot). */
export interface GapReportFindingInput {
  id: string;
  title: string;
  body: string;
  severity: FindingSeverity;
  verificationStatus: FindingVerificationStatus | null;
  /** Issue #773 — the finding's gated verdict (null when it makes no claim). */
  verdict: RequirementVerdict | null;
  citations: Citation[];
}

/**
 * Issue #825 — one requirement's affected-schema inputs: the deterministic
 * schema-impact rows (1c / #823's {@link AffectedSchemaContext.rows}) joined with
 * the cross-project consumer enumeration (1b / #822's
 * {@link enumerateSchemaConsumers}). Both are REUSED verbatim — the builder joins
 * them into the report's `databaseChanges`, inventing no new traversal.
 */
export interface GapReportSchemaImpactInput {
  /** Affected tables/columns from the impact engine (1c / #823). */
  rows: AffectedTableInput[];
  /** Cross-project consumers per affected object (1b / #822). */
  consumers: AffectedSchemaConsumers[];
}

export interface BuildGapReportInput {
  analysisId: string;
  projectId: string;
  requirements: GapReportRequirementInput[];
  /** Every finding referenced by any requirement, keyed by finding id. */
  findingsById: Map<string, GapReportFindingInput>;
  /**
   * Issue #773 — the run's retrieval health + searched-scope provenance. Attached
   * to the report so every `gap-confirmed` verdict is auditable against the
   * queries that actually ran. Null for runs with no agentic code pass.
   */
  retrieval?: AnalysisRetrievalHealth | null;
  /**
   * Issue #825 — the affected-schema inputs per requirement id (1c / #823 rows +
   * 1b / #822 consumers). Optional: a run with no schema-impact pass omits it and
   * the report carries no `databaseChanges` (byte-identical to the pre-#825
   * shape). A requirement absent from the map is simply left without a database
   * section — never faked.
   */
  schemaImpactByRequirementId?: ReadonlyMap<string, GapReportSchemaImpactInput>;
  /**
   * Issue #856 (Epic #852 Phase 2c) — the resolved database-aware-analysis
   * decision (#854) for this project/report, threaded through verbatim from
   * {@link resolveGapReportDeps} so the report can surface WHY `databaseChanges`
   * is present, empty, or entirely absent. Optional/undefined for callers that
   * predate #856 (e.g. `getGapReport(id)` with no deps) — the report then simply
   * omits the field, matching every other additive gap-report input.
   */
  databaseAware?: AnalysisDatabaseAware | null;
  /**
   * Issue #895 (Epic #882 Phase 3) — the project-wide resolved-vs-unresolved
   * schema-edge coverage (computed by {@link resolveGapReportDeps} via
   * {@link computeSqlLineageCoverage}). Optional/undefined for callers that
   * don't compute it (e.g. `getGapReport(id)` with no deps), so the report
   * omits the field — matching every other additive gap-report input.
   */
  sqlLineageCoverage?: SqlLineageCoverage | null;
}

/**
 * Rank a linked finding for evidence strength: confirmed (#740) first, then
 * findings that cite code, then the rest. Stable within a rank (input order is
 * preserved) so the report is deterministic.
 */
function evidenceRank(finding: GapReportFindingInput): number {
  const codeCitations = finding.citations.filter(isCodeCitation);
  if (finding.verificationStatus === "confirmed" && codeCitations.length > 0) return 0;
  if (codeCitations.length > 0) return 1;
  return 2;
}

/** Roll the linked findings' #740 verdicts up into one requirement-level status. */
function rollUpVerification(findings: GapReportFindingInput[]): FindingVerificationStatus | null {
  if (findings.some((f) => f.verificationStatus === "confirmed")) return "confirmed";
  if (findings.some((f) => f.verificationStatus === "unverified")) return "unverified";
  return null;
}

/**
 * Build the deterministic "current implementation" evidence: the deduped set of
 * CODE citations across the (already confirmed-first-ordered) linked findings.
 */
function buildCurrentImplementation(
  orderedFindings: GapReportFindingInput[],
): GapReportCurrentImplementation {
  const citations: CodeCitation[] = [];
  const seen = new Set<string>();
  let citedFindingCount = 0;

  for (const finding of orderedFindings) {
    const codeCitations = finding.citations.filter(isCodeCitation);
    if (codeCitations.length > 0) citedFindingCount += 1;
    for (const citation of codeCitations) {
      // Dedupe on the canonical locator + symbol so the same line range cited by
      // two findings appears once.
      const key = `${formatCodeCitationLocator(citation)}::${citation.symbolId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(citation);
    }
  }

  return {
    hasEvidence: citations.length > 0,
    citations,
    citedFindingCount,
  };
}

function toFindingRef(finding: GapReportFindingInput): GapReportFindingRef {
  return {
    id: finding.id,
    title: finding.title,
    body: finding.body,
    severity: finding.severity,
    verificationStatus: finding.verificationStatus ?? null,
    verdict: finding.verdict ?? null,
    citations: finding.citations.filter(isCodeCitation),
  };
}

/**
 * Issue #773 — is this finding's claim UNVERIFIABLE? Such a finding is not a gap
 * and must never be rendered (or exported) as one — the gap report surfaces
 * finding bodies VERBATIM as the gap narrative, which is precisely how "our
 * search failed" became "you must build this".
 */
function isUnverifiable(finding: GapReportFindingInput): boolean {
  return (
    finding.verdict === "could-not-verify" || finding.verificationStatus === "could-not-verify"
  );
}

/** The physical/mapped object label as it appears in the schema graph. */
function changeLabel(c: { tableName: string; columnName: string | null }): string {
  return c.columnName ? `${c.tableName}.${c.columnName}` : c.tableName;
}

/** Project one 1b (#822) consumer into the report's serialized consumer shape. */
function toReportConsumer(consumer: SchemaConsumer): GapReportSchemaConsumer {
  return {
    projectId: consumer.projectId,
    projectName: consumer.projectName,
    usage: consumer.usage,
    objectQualifiedName: consumer.objectQualifiedName,
  };
}

/**
 * Issue #825 — join one requirement's schema-impact rows (1c / #823) with its
 * cross-project consumers (1b / #822) into the report's `databaseChanges`. PURE
 * and total; invents no traversal:
 *
 *   - Dedupes affected rows by `(tableName, columnName)`, keeping the
 *     highest-confidence row — mirroring `crossToSchema`'s own dedupe so an
 *     object appears once.
 *   - Looks up each object's consumer entry by the SAME `(tableName, columnName)`
 *     key. `identityResolved` is carried through verbatim, and `consumers` is
 *     attached ONLY when identity resolved — so a resolved-with-zero-consumers
 *     object (empty list) stays structurally distinct from an identity-unresolved
 *     one (no list at all). The report never claims "no consumers" when the
 *     cross-project identity is unknown.
 *   - Classifies each row's `riskClass` via the deterministic 3a (#830)
 *     {@link classifyDdlRisk} (breaking / expanding / neutral) — advisory triage
 *     over the TEXT-ONLY suggested DDL; it never gates or executes anything.
 *   - Escalates to `crossProjectBreaking` (3b / #831) ONLY a `breaking` change on
 *     a shared object with a RESOLVED identity and at least one enumerated
 *     consumer — the grounded CRITICAL case. An identity-unresolved or
 *     consumer-less change is never escalated (the flag is set only when true).
 *   - Sorts by confidence (desc) then object label so the section is
 *     deterministic regardless of input order.
 *
 * Returns `[]` when there is no schema impact; the caller then omits the section
 * entirely rather than scaffolding an empty one.
 */
export function buildDatabaseChanges(
  input: GapReportSchemaImpactInput | undefined,
): GapReportDatabaseChange[] {
  if (!input || input.rows.length === 0) return [];

  // Dedupe rows by (table, column); highest confidence wins (mirrors crossToSchema).
  const distinct = new Map<string, AffectedTableInput>();
  for (const row of input.rows) {
    const key = `${row.tableName}\u0000${row.columnName ?? ""}`;
    const existing = distinct.get(key);
    if (!existing || row.confidence > existing.confidence) distinct.set(key, row);
  }

  // Consumer entries keyed by the SAME (table, column) identity as the rows.
  const consumersByKey = new Map<string, AffectedSchemaConsumers>();
  for (const entry of input.consumers) {
    consumersByKey.set(`${entry.tableName}\u0000${entry.columnName ?? ""}`, entry);
  }

  const changes: GapReportDatabaseChange[] = [];
  for (const [key, row] of distinct) {
    const entry = consumersByKey.get(key);
    const identityResolved = entry?.identityResolved ?? false;
    const change: GapReportDatabaseChange = {
      tableName: row.tableName,
      columnName: row.columnName,
      changeKind: row.changeKind,
      reconciliation: row.reconciliation,
      confidence: row.confidence,
      suggestedDdl: row.suggestedDdl,
      // 3a (#830) — deterministic expand/contract triage over the TEXT-ONLY
      // suggested DDL. The live `columnType` is the post-change column type for an
      // additive `add-column`; `alter-column`/`drop-column` (no before/after here)
      // classify conservatively.
      riskClass: classifyDdlRisk({
        changeKind: row.changeKind,
        reconciliation: row.reconciliation,
        suggestedDdl: row.suggestedDdl,
        columnTypeAfter: row.columnType,
      }),
      identityResolved,
    };
    // Attach consumers ONLY when identity is resolved. An unresolved object
    // carries no `consumers` field at all — "cross-project impact unknown", never
    // a spurious "0 consumers".
    if (identityResolved) {
      change.consumers = (entry?.consumers ?? []).map(toReportConsumer);
    }
    // 3b (#831) — escalate to CRITICAL a `breaking` change on a shared object
    // that OTHER projects demonstrably read/write. Grounded, never guessed: it
    // requires a resolved cross-project identity AND at least one enumerated
    // consumer. An identity-unresolved change (stays "could-not-verify" per #826)
    // or a resolved-but-consumer-less change is NEVER escalated. The flag is set
    // only when true, so an ordinary change stays byte-identical to pre-#831.
    if (
      change.riskClass === "breaking" &&
      identityResolved &&
      (change.consumers?.length ?? 0) > 0
    ) {
      change.crossProjectBreaking = true;
    }
    changes.push(change);
  }

  // Deterministic order: highest confidence first, then object label.
  changes.sort(
    (a, b) => b.confidence - a.confidence || changeLabel(a).localeCompare(changeLabel(b)),
  );
  return changes;
}

/** Assemble one requirement's gap report from its linked findings. */
function buildRequirementReport(
  requirement: GapReportRequirementInput,
  findingsById: Map<string, GapReportFindingInput>,
  schemaImpact?: GapReportSchemaImpactInput,
): GapReportRequirement {
  // Resolve linked findings in evidence-strength order (confirmed + code-cited
  // first). Missing ids (a stale evidence link) are simply skipped, never faked.
  const linked = requirement.evidenceFindingIds
    .map((id) => findingsById.get(id))
    .filter((f): f is GapReportFindingInput => f != null);
  const ordered = [...linked].sort((a, b) => evidenceRank(a) - evidenceRank(b));

  const currentImplementation = buildCurrentImplementation(ordered);

  // #773 — split the unverifiable findings OUT of the gap narrative. `gapFindings`
  // is what the UI/export renders as "the gap"; a finding whose retrieval failed
  // belongs in `unverifiedFindings`, under a heading that says we do not know.
  const gapFindings = ordered.filter((f) => !isUnverifiable(f));
  const unverifiedFindings = ordered.filter(isUnverifiable);

  // #825 — the DATABASE replay of the gap findings: affected objects joined with
  // their cross-project consumers. Omitted (undefined) when there is no schema
  // impact, so the section is never scaffolded empty and pre-#825 reports are
  // byte-identical.
  const databaseChanges = buildDatabaseChanges(schemaImpact);

  return {
    requirementId: requirement.id,
    title: requirement.title,
    body: requirement.body,
    priority: requirement.priority,
    coverage: requirement.coverage,
    verdict: requirement.verdict,
    storyPoints: requirement.storyPoints,
    verificationStatus: rollUpVerification(ordered),
    currentImplementation,
    gapFindings: gapFindings.map(toFindingRef),
    unverifiedFindings: unverifiedFindings.map(toFindingRef),
    noEvidence: !currentImplementation.hasEvidence,
    ...(databaseChanges.length > 0 ? { databaseChanges } : {}),
  };
}

export function buildGapReport(input: BuildGapReportInput): GapReport {
  return {
    analysisId: input.analysisId,
    projectId: input.projectId,
    requirements: input.requirements.map((r) =>
      buildRequirementReport(r, input.findingsById, input.schemaImpactByRequirementId?.get(r.id)),
    ),
    retrieval: input.retrieval ?? null,
    // #856 — echoed only when the caller resolved a decision; omitted (not even
    // `null`) otherwise so pre-#856 report shapes stay byte-identical.
    ...(input.databaseAware !== undefined ? { databaseAware: input.databaseAware } : {}),
    // #895 — echoed only when the caller computed coverage; omitted otherwise so
    // pre-#895 report shapes stay byte-identical.
    ...(input.sqlLineageCoverage !== undefined
      ? { sqlLineageCoverage: input.sqlLineageCoverage }
      : {}),
  };
}
