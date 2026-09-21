/**
 * Analysis export serializers — PURE (Issue #744, Epic #728).
 *
 * The terminal D3 deliverable: export the analyst-facing artifacts as markdown
 * and GitHub-issue drafts. This module assembles NOTHING new — it serializes
 * data that already exists:
 *
 *   - A finding's deep-dive draft (`FindingIssueDraft`, an already-generated,
 *     LLM-produced issue draft) → a paste-ready GitHub issue draft (title +
 *     markdown body with an acceptance-criteria checklist + affected files +
 *     suggested labels) and its full markdown blob. This is where the
 *     ACCEPTANCE CRITERIA are exported. The export makes NO LLM call: it takes a
 *     draft the caller already holds and only serializes it.
 *   - The per-requirement gap report (#742) + the traceability matrix (#737)
 *     → one combined "analysis report" markdown, stitching the coverage summary,
 *     the per-requirement gap sections (code citations preserved as
 *     `filePath:startLine-endLine` text), and the #737 matrix table into a single
 *     downloadable document. The matrix table reuses #737's
 *     `serializeTraceabilityMarkdown` verbatim — no duplicated matrix serializer.
 *
 * Security (OWASP output handling): every model-/user-controlled string is run
 * through {@link mdInline}/{@link mdBlock} before it lands in markdown, so raw
 * HTML (`<script>`, `<img onerror=…>`) is neutralized and no value can break the
 * intended list/heading structure. CSV is out of scope here — #737 already owns
 * the injection-safe CSV path (`toCsv`, formula-neutralized); this module is
 * markdown / issue-draft only.
 */
import {
  formatCodeCitationLocator,
  DDL_RISK_LABEL,
  groupImpactTables,
  groupRepresentative,
  type DdlRiskClass,
  type GroupedImpactTable,
  type FindingIssueDraft,
  type FindingIssueDraftExport,
  type GapReport,
  type GapReportDatabaseChange,
  type GapReportRequirement,
  type ImpactAffectedSymbolView,
  type ImpactAffectedTableView,
  type ImpactAnalysisDetail,
  type ImpactItemView,
  type ImpactTableConsumerView,
  type RequirementCoverage,
  type RequirementVerdict,
  type SharedTableImpact,
  type SqlLineageCoverage,
  type TraceabilityMatrix,
  type WritePathCoverageGap,
} from "@metis/shared";
import { serializeTraceabilityMarkdown } from "./traceability-matrix.js";

// ── Markdown sanitization ───────────────────────────────────────────────────

/**
 * Neutralize HTML so a model-generated string cannot inject markup (OWASP output
 * handling). Angle brackets and ampersands are entity-escaped; GitHub renders
 * the entities back as literal characters, so legit text like `List<T>` stays
 * readable while `<script>` can never execute.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Sanitize a value destined for a SINGLE-LINE markdown context (a heading, a
 * checklist item, a list entry, a label). Collapses every newline/tab/CR into a
 * single space so the value can never break out of its line and inject a new
 * list item or heading, then HTML-escapes and trims.
 */
export function mdInline(value: string): string {
  return escapeHtml(value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ")).trim();
}

/**
 * Sanitize a value destined for a MULTI-LINE markdown block (a problem
 * statement, a finding narrative). Line breaks are preserved (normalized to
 * `\n`) but each line is HTML-escaped and trailing whitespace trimmed.
 */
export function mdBlock(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => escapeHtml(line).replace(/\s+$/g, ""))
    .join("\n")
    .trim();
}

/**
 * Sanitize a value destined for a markdown BLOCKQUOTE (#1004). Every line is
 * HTML-escaped exactly like {@link mdBlock} and then prefixed with `> `, which
 * is the ONLY structural containment markdown offers: a quoted line starting
 * with `#`, `-`, `|` or ``` cannot open a heading, list, table or fenced block
 * at document level, so verbatim user-supplied requirement text can be exported
 * without letting it restructure (or, in a downstream HTML renderer, escape)
 * the document it is embedded in.
 */
export function mdQuote(value: string): string {
  return mdBlock(value)
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/** Render a code path/token inline as inert `` `code` ``, backticks stripped. */
function codeSpan(value: string): string {
  return `\`${mdInline(value).replace(/`/g, "")}\``;
}

// ── Finding deep-dive → GitHub issue draft ──────────────────────────────────

const NONE = "_None._";

/** One markdown section: a `## heading` followed by its body (or an empty marker). */
function section(heading: string, body: string): string {
  const content = body.trim().length > 0 ? body.trim() : NONE;
  return `## ${heading}\n\n${content}`;
}

/**
 * Serialize a finding's deep-dive draft into a GitHub-ready issue draft — the
 * `{ title, body, labels }` a user pastes into `gh issue create` or the GitHub
 * "new issue" form. `body` is sanitized markdown; `labels` is the raw suggested
 * label list (label text is inert in the GitHub label field). Never mutates the
 * input and makes no network/LLM call.
 */
export function buildFindingIssueDraft(draft: FindingIssueDraft): FindingIssueDraftExport {
  const acceptance =
    draft.acceptanceCriteria.length > 0
      ? draft.acceptanceCriteria.map((c) => `- [ ] ${mdInline(c)}`).join("\n")
      : "";
  const files =
    draft.affected.files.length > 0
      ? draft.affected.files.map((f) => `- ${codeSpan(f)}`).join("\n")
      : "";
  const requirements =
    draft.affected.requirementIds.length > 0
      ? draft.affected.requirementIds.map((r) => `- ${codeSpan(r)}`).join("\n")
      : "";
  const labels =
    draft.suggestedLabels.length > 0
      ? draft.suggestedLabels.map((l) => codeSpan(l)).join(", ")
      : "";

  const body = [
    section("Problem statement", mdBlock(draft.problemStatement)),
    section("Acceptance criteria", acceptance),
    section("Affected files", files),
    section("Related requirements", requirements),
    section("Suggested labels", labels),
  ].join("\n\n");

  return {
    // The GitHub issue TITLE is a plain-text field (not rendered as HTML), so it
    // is only whitespace-collapsed — but still escaped for defense in depth.
    title: mdInline(draft.title),
    body,
    labels: [...draft.suggestedLabels],
  };
}

/**
 * The full paste-ready markdown document for a finding's issue draft: the title
 * as an `# H1` above the {@link buildFindingIssueDraft} body. This is what the
 * "Export markdown" button downloads / copies.
 */
export function serializeFindingIssueDraftMarkdown(draft: FindingIssueDraft): string {
  const { title, body } = buildFindingIssueDraft(draft);
  return `# ${title}\n\n${body}\n`;
}

// ── Combined analysis report (gap report + traceability matrix) ──────────────

const COVERAGE_LABEL: Record<RequirementCoverage, string> = {
  grounded_in_code: "Grounded in code",
  grounded_in_docs_only: "Grounded in docs only",
  no_evidence: "No evidence",
};

function coverageLabel(coverage: RequirementCoverage | null): string {
  return coverage ? COVERAGE_LABEL[coverage] : "Unclassified";
}

/**
 * Issue #773 — the verdict label. This is the line a BA acts on, so
 * `could-not-verify` says out loud that it is NOT a gap: the exported report was
 * one of the surfaces that flattened "we could not check" into "build this".
 */
const VERDICT_LABEL: Record<RequirementVerdict, string> = {
  implemented: "Implemented (code evidence cited)",
  "gap-confirmed": "Gap confirmed (code was searched and does not satisfy this)",
  "could-not-verify": "Could not verify — NOT a confirmed gap (retrieval did not back a verdict)",
};

function verdictLabel(verdict: RequirementVerdict | null): string {
  return verdict ? VERDICT_LABEL[verdict] : "No verdict (code was not analyzed)";
}

/** A `- **key:** value` metadata bullet line. */
function meta(key: string, value: string): string {
  return `- **${key}:** ${value}`;
}

/** Max searched-scope entries listed in the export (the record itself is bounded at 40). */
const MAX_EXPORTED_SCOPE = 25;

/**
 * Issue #773 — THE SEARCHED SCOPE, in the artifact a BA actually circulates.
 *
 * An absence claim is only meaningful relative to what was searched. The run
 * persists that provenance and the UI renders it, but the exported markdown — the
 * document that gets mailed around and planned from — did not carry it, which put
 * every `gap-confirmed` in it back to being judgement-by-vibes. It is exported
 * here: the counts, and the queries that actually ran with what each one hit.
 */
function searchedScopeSection(retrieval: GapReport["retrieval"]): string[] {
  if (!retrieval) return [];
  const { successfulSearches, erroredCalls, totalCalls, requirementCount, searchedScope } =
    retrieval;
  if (totalCalls === 0 && searchedScope.length === 0) {
    return [
      "# Searched scope",
      "_The code agent ran no retrieval calls on this run, so nothing in this report was confirmed absent by a search._",
    ];
  }
  const counts = meta(
    "Retrieval",
    `${totalCalls} call(s) across ${requirementCount} requirement(s) — ${successfulSearches} returned results, ${erroredCalls} errored`,
  );
  const shown = searchedScope.slice(0, MAX_EXPORTED_SCOPE);
  const lines = shown.map((entry) => {
    const outcome = entry.errored ? "errored" : entry.hit ? "hit" : "no results";
    const what = entry.query ? ` ${codeSpan(entry.query)}` : "";
    return `- ${mdInline(entry.tool)}${what} — ${outcome}`;
  });
  const more =
    searchedScope.length > shown.length
      ? [`- _…and ${searchedScope.length - shown.length} more._`]
      : [];
  return [
    "# Searched scope",
    "_What the code agent actually searched for. A gap is only ever a gap relative to this list: a requirement nobody searched for is reported as “could not verify”, never as a confirmed gap._",
    counts,
    [...lines, ...more].join("\n"),
  ];
}

/** Render one gap-report finding as a sanitized markdown bullet with its citations. */
function findingBullet(f: GapReportRequirement["gapFindings"][number]): string {
  const cites =
    f.citations.length > 0
      ? "\n" + f.citations.map((c) => `  - ${codeSpan(formatCodeCitationLocator(c))}`).join("\n")
      : "";
  return `- **${mdInline(f.title)}** (${mdInline(f.severity)})\n\n  ${mdBlock(f.body).replace(
    /\n/g,
    "\n  ",
  )}${cites}`;
}

/** #825 — reconciliation status label for an affected database object. */
function reconciliationLabel(reconciliation: GapReportDatabaseChange["reconciliation"]): string {
  switch (reconciliation) {
    case "matched":
      return "matched against live schema";
    case "table-not-found":
      return "table absent from live schema";
    case "column-not-found":
      return "column absent from live schema";
    default:
      return "not reconciled against live schema";
  }
}

/**
 * #825 / #991 — risk-class label. Renders the shared human vocabulary
 * (`DDL_RISK_LABEL`, `@metis/shared`) instead of the raw `breaking` /
 * `expanding` / `neutral` enum value; absent ⇒ "unclassified" (never a
 * fabricated "neutral").
 */
function riskClassLabel(riskClass: GapReportDatabaseChange["riskClass"]): string {
  return riskClass ? DDL_RISK_LABEL[riskClass] : "unclassified";
}

/** #825 — how a sibling project touches the object (1b / #822 usage → verb). */
function consumerUsageLabel(usage: "readBy" | "writtenBy"): string {
  return usage === "writtenBy" ? "writes" : "reads";
}

/** Render one affected database object as a sanitized markdown bullet. */
function databaseChangeBullet(change: GapReportDatabaseChange): string {
  const label = change.columnName ? `${change.tableName}.${change.columnName}` : change.tableName;
  // 3b (#831) — a breaking change on a shared object with confirmed cross-project
  // consumers is escalated to CRITICAL. Surfaced inline on the header; the grounding
  // consumer list follows below. Absent flag ⇒ no marker (byte-identical to pre-#831).
  const criticalMarker = change.crossProjectBreaking
    ? " · **⚠ CRITICAL — breaking change to a shared object with cross-project consumers**"
    : "";
  const header = `- **${mdInline(label)}** — ${mdInline(change.changeKind)} · ${mdInline(
    reconciliationLabel(change.reconciliation),
  )} · confidence ${change.confidence.toFixed(2)} · risk: ${mdInline(
    riskClassLabel(change.riskClass),
  )}${criticalMarker}`;
  const lines: string[] = [header];

  // Suggested DDL — always behind the section's "review only, never executed"
  // label. Rendered inert (inline code, backticks stripped) since it is text only.
  if (change.suggestedDdl) {
    lines.push(`  - Suggested DDL: ${codeSpan(change.suggestedDdl)}`);
  }

  // Cross-project consumers — the three states render DISTINCTLY. Identity
  // unresolved is NEVER flattened into "no consumers".
  if (!change.identityResolved) {
    lines.push("  - _Cross-project impact unknown (database identity unresolved)._");
  } else if (!change.consumers || change.consumers.length === 0) {
    lines.push("  - _No other project in this workspace reads or writes this object._");
  } else {
    const consumers = change.consumers
      .map((c) => `${mdInline(c.projectName)} (${consumerUsageLabel(c.usage)})`)
      .join(", ");
    lines.push(`  - Consumers: ${consumers}`);
  }

  return lines.join("\n");
}

/**
 * #825 — the DATABASE replay of the gap section. Renders affected tables/columns,
 * each with its suggested DDL (behind a mandatory "review only, never executed"
 * label), risk class, and cross-project consumers. Rows the impact engine could
 * NOT reconcile against the live schema (`table-not-found`/`column-not-found`)
 * are separated under an explicit "unverified" subheading so a speculative object
 * is never presented as a confirmed schema fact (#773 discipline).
 */
function databaseChangesSection(changes: GapReportDatabaseChange[]): string {
  const isUnverified = (c: GapReportDatabaseChange): boolean =>
    c.reconciliation === "table-not-found" || c.reconciliation === "column-not-found";
  const verified = changes.filter((c) => !isUnverified(c));
  const unverified = changes.filter(isUnverified);

  const parts: string[] = ["### Database changes (suggested DDL — review only, never executed)"];

  if (verified.length > 0) {
    parts.push(verified.map(databaseChangeBullet).join("\n"));
  }

  if (unverified.length > 0) {
    parts.push("#### Unverified against live schema");
    parts.push(
      "_The objects below were referenced by impacted code but could NOT be reconciled against the live schema — treat them as speculative, not confirmed schema facts._",
    );
    parts.push(unverified.map(databaseChangeBullet).join("\n"));
  }

  return parts.join("\n\n");
}

/** Render one requirement's gap section: metadata → current impl → gap findings. */
function gapRequirementSection(req: GapReportRequirement): string {
  const parts: string[] = [`## ${mdInline(req.title)}`];

  parts.push(mdBlock(req.body));

  parts.push(
    [
      meta("Verdict", verdictLabel(req.verdict)),
      meta("Priority", mdInline(req.priority)),
      meta("Coverage", coverageLabel(req.coverage)),
      meta("Effort", req.storyPoints == null ? "Unestimated" : `${req.storyPoints} story points`),
      meta("Verification", req.verificationStatus ? mdInline(req.verificationStatus) : "—"),
    ].join("\n"),
  );

  // Current implementation — cited code, or an explicit no-evidence marker.
  parts.push("### Current implementation");
  if (req.currentImplementation.hasEvidence) {
    parts.push(
      req.currentImplementation.citations
        .map((c) => `- ${codeSpan(formatCodeCitationLocator(c))}`)
        .join("\n"),
    );
  } else {
    parts.push("_No source evidence was linked — review this requirement manually._");
  }

  // Gap — the linked gap-path findings surfaced verbatim (sanitized). #773: only
  // findings whose verdict SURVIVED the evidence threshold appear here.
  parts.push("### Gap");
  if (req.gapFindings.length === 0) {
    parts.push("_No gap findings were linked to this requirement._");
  } else {
    parts.push(req.gapFindings.map(findingBullet).join("\n"));
  }

  // #773 — the findings we could NOT verify, in their own clearly-labelled block.
  // Never merged into "Gap": the whole point of this issue is that "we could not
  // retrieve it" must not be exported as "it does not exist".
  if (req.unverifiedFindings.length > 0) {
    parts.push("### Could not verify (NOT confirmed gaps)");
    parts.push(
      "_Code retrieval did not return usable evidence for the claims below. They are shown for review — do NOT treat them as confirmed gaps or plan work from them without re-running the analysis._",
    );
    parts.push(req.unverifiedFindings.map(findingBullet).join("\n"));
  }

  // #825 — the database replay: affected objects + suggested DDL + consumers.
  // Absent entirely when the requirement has no schema impact (no empty section).
  if (req.databaseChanges && req.databaseChanges.length > 0) {
    parts.push(databaseChangesSection(req.databaseChanges));
  }

  return parts.join("\n\n");
}

/**
 * Issue #895 — the SQL-lineage unresolved/dynamic coverage section. Surfaces
 * "N% of table edges are dynamically resolved / need manual confirmation" as
 * the ACTIONABLE inverse of the resolved percentage, plus a per-source
 * breakdown and a bounded sample of the unresolved edges (each as a copyable
 * `filePath` locator + reason — dynamic `${}`/`EXECUTE IMMEDIATE` vs coarse
 * Tier-1 catalog). Returns `[]` (no section) when coverage is absent/null so
 * the export stays byte-identical for projects with no schema lineage edges.
 */
function sqlLineageCoverageSection(coverage: SqlLineageCoverage | null | undefined): string[] {
  if (!coverage || coverage.totalEdges === 0) return [];
  const resolvedPct = coverage.coveragePercent ?? 0;
  const unresolvedPct = Math.round((100 - resolvedPct) * 10) / 10;

  const reasonLabel = (reason: "dynamic" | "coarse-catalog"): string =>
    reason === "dynamic"
      ? "dynamic (runtime-built SQL — e.g. MyBatis `${}` / EXECUTE IMMEDIATE)"
      : "coarse Tier-1 catalog dependency (object-level only, direction unknown)";

  const parts: string[] = [
    "# SQL-lineage coverage",
    `_${unresolvedPct}% of table edges are dynamically resolved and need manual confirmation (${coverage.unresolvedEdges} of ${coverage.totalEdges} edges; ${resolvedPct}% resolved precisely)._`,
  ];

  const sources = Object.entries(coverage.bySource)
    .filter(([, v]) => v.unresolved > 0)
    .map(([source, v]) => `- ${codeSpan(source)}: ${v.unresolved} of ${v.total} unresolved`);
  if (sources.length > 0) {
    parts.push("## Unresolved by source");
    parts.push(sources.join("\n"));
  }

  if (coverage.unresolvedRefs.length > 0) {
    parts.push("## Edges needing manual confirmation");
    parts.push(
      coverage.unresolvedRefs
        .map((ref) => {
          const target = ref.toQualifiedName ? ` → ${codeSpan(ref.toQualifiedName)}` : "";
          const where = ref.placeholder ? ` · placeholder ${codeSpan(ref.placeholder)}` : "";
          return `- ${codeSpan(ref.filePath)}${target} — ${mdInline(reasonLabel(ref.reason))}${where}`;
        })
        .join("\n"),
    );
    if (coverage.unresolvedEdges > coverage.unresolvedRefs.length) {
      parts.push(
        `_…and ${coverage.unresolvedEdges - coverage.unresolvedRefs.length} more unresolved edge(s) not listed._`,
      );
    }
  }

  return parts;
}

/** Tally requirements by coverage classification for the report summary line. */
function coverageSummary(report: GapReport): string {
  const counts = new Map<string, number>();
  for (const req of report.requirements) {
    const label = coverageLabel(req.coverage);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const total = report.requirements.length;
  const breakdown = [...counts.entries()].map(([label, n]) => `${label}: ${n}`).join(", ");
  return `${total} ${total === 1 ? "requirement" : "requirements"}${
    breakdown ? ` (${breakdown})` : ""
  }`;
}

export interface AnalysisReportInput {
  gapReport: GapReport;
  matrix: TraceabilityMatrix;
}

/**
 * Stitch the gap report (#742) and the traceability matrix (#737) into one
 * downloadable "analysis report" markdown document. Uses ONLY already-persisted
 * data (no LLM call): the coverage summary, one gap section per requirement with
 * its code citations, and — reusing #737's serializer verbatim — the full
 * requirement→findings→code→tests matrix table.
 *
 * Acceptance criteria are NOT part of this report: they live in a finding's
 * deep-dive draft (ephemeral, LLM-produced) and are exported through
 * {@link serializeFindingIssueDraftMarkdown} / {@link buildFindingIssueDraft}.
 */
export function serializeAnalysisReportMarkdown(input: AnalysisReportInput): string {
  const { gapReport, matrix } = input;

  const gapBody =
    gapReport.requirements.length > 0
      ? gapReport.requirements.map(gapRequirementSection).join("\n\n")
      : "_No requirements to report on._";

  // #773 — when the run's retrieval failed the evidence threshold, say so at the
  // TOP of the exported document: every "not found" in it is unreliable.
  const degradedWarning = gapReport.retrieval?.degraded
    ? [
        "> **Code search returned little usable evidence on this run — 'not found' results are unreliable.**",
        `> ${gapReport.retrieval.successfulSearches} of ${gapReport.retrieval.totalCalls} retrieval calls returned usable results across ${gapReport.retrieval.requirementCount} requirement(s)${
          // #1236 — "cut short by its budget" describes EXHAUSTION, not starvation.
          gapReport.retrieval.exhausted ? ", and the investigation was cut short by its budget" : ""
        }. No gap in this report was confirmed by that search; re-run the analysis before planning work.`,
      ].join("\n")
    : "";

  return (
    [
      "# Analysis report",
      `_${coverageSummary(gapReport)}._`,
      ...(degradedWarning ? [degradedWarning] : []),
      "# Gap report",
      gapBody,
      ...searchedScopeSection(gapReport.retrieval),
      ...sqlLineageCoverageSection(gapReport.sqlLineageCoverage),
      "# Traceability matrix",
      serializeTraceabilityMarkdown(matrix),
    ].join("\n\n") + "\n"
  );
}

// ── Impact analysis → markdown export (Issue #963 / Epic #960) ───────────────

/** Options for {@link serializeImpactAnalysisMarkdown}. */
export interface ImpactAnalysisMarkdownOptions {
  /**
   * Optional projectId→display-name map. A run spans many projects; when a name
   * is known it heads that project's section, else the raw id is used. Purely
   * cosmetic — never affects which rows are serialized.
   */
  projectNames?: Record<string, string>;
}

/** #963 — human label for a relevance tier (#936/#950); null ⇒ untiered. */
function relevanceTierLabel(tier: ImpactAffectedTableView["relevanceTier"]): string | null {
  switch (tier) {
    case "likely":
      return "likely related";
    case "possible":
      return "possibly related";
    case "unlikely":
      return "unlikely related";
    default:
      return null;
  }
}

/** #963 — render one affected symbol as a sanitized bullet (persisted row only). */
function impactSymbolBullet(sym: ImpactAffectedSymbolView): string {
  const loc =
    sym.startLine != null
      ? `${sym.filePath}:${sym.startLine}${sym.endLine != null ? `-${sym.endLine}` : ""}`
      : sym.filePath;
  return `- ${codeSpan(loc)} · ${codeSpan(sym.qualifiedName)} — ${mdInline(
    sym.relation,
  )}, depth ${sym.depth} · confidence ${sym.confidence.toFixed(2)}`;
}

/** #963/#956 — render the cross-project consumer state for an affected table. */
function impactConsumerLines(table: ImpactAffectedTableView): string[] {
  // `consumerResolution === undefined` ⇒ consumers were not computed for this
  // run (single-project / no-workspace). Render nothing so the row is unchanged.
  if (table.consumerResolution === undefined || table.consumerResolution === null) return [];
  if (table.consumerResolution === "unverifiable") {
    return ["  - _Cross-project consumers could not be verified._"];
  }
  const consumers: ImpactTableConsumerView[] = table.consumers ?? [];
  if (consumers.length === 0) {
    return ["  - _No other project in this workspace reads or writes this table._"];
  }
  const rendered = consumers
    .map((c) => `${mdInline(c.projectName)} (${consumerUsageLabel(c.usage)})`)
    .join(", ");
  return [`  - Consumers: ${rendered}`];
}

// #1004/#1014 — GroupedImpactTable + the grouping/ordering helpers now live in
// @metis/shared (impact-table-grouping), imported above, so this serializer and
// the UI share ONE implementation and cannot drift. isRoutineRow, RISK_SEVERITY
// and groupRiskClass below stay export-local (serializer-only concerns).

/** A routine row (#302) — grouped separately from tables/columns, as in the UI. */
function isRoutineRow(row: ImpactAffectedTableView): boolean {
  return row.objectKind === "procedure" || row.objectKind === "function";
}

/** Severity order so a group's badge reflects its WORST proposed change (#957). */
const RISK_SEVERITY: Record<DdlRiskClass, number> = { breaking: 2, expanding: 1, neutral: 0 };

/** The most severe DDL risk across a group's rows; null when no row is classified. */
function groupRiskClass(group: GroupedImpactTable): DdlRiskClass | null {
  let worst: DdlRiskClass | null = null;
  for (const row of [group.tableEntry, ...group.columns]) {
    const rc = row?.riskClass ?? null;
    if (!rc) continue;
    if (worst === null || RISK_SEVERITY[rc] > RISK_SEVERITY[worst]) worst = rc;
  }
  return worst;
}

/** Suggested DDL bullet — TEXT ONLY, never executed, rendered inert. */
function suggestedDdlLine(row: ImpactAffectedTableView, indent: string): string[] {
  // Verify-only `reference` rows carry a `-- Verify column …` comment rather than
  // a real change. Repeating one per row was the bulk of the exported noise
  // (27 of them under `orders` alone), and it is not a proposed change — so only
  // rows that actually propose DDL export it.
  if (row.changeKind === "reference") return [];
  if (!row.suggestedDdl || row.suggestedDdl.trim().length === 0) return [];
  return [`${indent}- Suggested DDL (review only, never executed): ${codeSpan(row.suggestedDdl)}`];
}

/** One nested column row that PROPOSES a change (schema-qualified + its DDL). */
function proposedColumnLines(row: ImpactAffectedTableView, indent: string): string[] {
  const label = row.columnName ? `${row.tableName}.${row.columnName}` : row.tableName;
  const facts = [
    mdInline(row.changeKind),
    `source ${mdInline(row.source)}`,
    `confidence ${row.confidence.toFixed(2)}`,
  ];
  if (row.riskClass) facts.push(`risk: ${DDL_RISK_LABEL[row.riskClass]}`);
  return [
    `${indent}- **${mdInline(label)}** — ${facts.join(" · ")}`,
    ...suggestedDdlLine(row, `${indent}  `),
  ];
}

/** Cap on the inline referenced-column list (the rest are counted, not listed). */
const MAX_REFERENCED_COLUMNS = 40;

/**
 * #1004 — render ONE table group: the table stated once with its rationale
 * stated once, then its columns nested underneath (proposed changes as their own
 * rows with DDL; verify-only references collapsed into a single counted list).
 */
function impactTableGroupBullet(group: GroupedImpactTable): string {
  const rep = groupRepresentative(group);
  const entry = group.tableEntry;
  const facts: string[] = [];
  if (entry) {
    facts.push(mdInline(entry.changeKind), `source ${mdInline(entry.source)}`);
  }
  if (rep) facts.push(`confidence ${rep.confidence.toFixed(2)}`);
  // #982/#991 — risk before relevance, mirroring the UI's badge order; the
  // shared `DDL_RISK_LABEL` is the single source of truth for the vocabulary.
  const risk = groupRiskClass(group);
  if (risk) facts.push(`risk: ${DDL_RISK_LABEL[risk]}`);
  const tier = relevanceTierLabel(rep?.relevanceTier ?? null);
  if (tier) facts.push(`relevance: ${tier}`);

  const lines: string[] = [
    `- **${mdInline(group.tableName)}**${facts.length > 0 ? ` — ${facts.join(" · ")}` : ""}`,
  ];

  // Relevance rationale (#936/#950) — stated ONCE for the table, not once per row.
  const rationale = rep?.relevanceRationale;
  if (rationale && rationale.trim().length > 0) {
    lines.push(`  - Rationale: ${mdInline(rationale)}`);
  }
  if (entry) lines.push(...suggestedDdlLine(entry, "  "));
  if (rep) lines.push(...impactConsumerLines(rep));

  const proposed = group.columns.filter((c) => c.changeKind !== "reference");
  const referenced = group.columns.filter((c) => c.changeKind === "reference");
  if (proposed.length > 0) {
    lines.push(`  - Proposed column changes (${proposed.length}):`);
    for (const col of proposed) lines.push(...proposedColumnLines(col, "    "));
  }
  if (referenced.length > 0) {
    const shown = referenced.slice(0, MAX_REFERENCED_COLUMNS);
    const names = shown.map((c) => codeSpan(c.columnName ?? c.tableName)).join(", ");
    const more =
      referenced.length > shown.length ? ` …and ${referenced.length - shown.length} more` : "";
    lines.push(
      `  - Referenced by impacted code (${referenced.length} column${
        referenced.length === 1 ? "" : "s"
      }): ${names}${more}`,
    );
  }
  return lines.join("\n");
}

/** #302 — one affected procedure/function (never grouped as a table). */
function impactRoutineBullet(routine: ImpactAffectedTableView): string {
  const facts = [
    mdInline(routine.objectKind),
    mdInline(routine.changeKind),
    `source ${mdInline(routine.source)}`,
    `confidence ${routine.confidence.toFixed(2)}`,
  ];
  const lines = [`- **${mdInline(routine.tableName)}** — ${facts.join(" · ")}`];
  if (routine.relevanceRationale && routine.relevanceRationale.trim().length > 0) {
    lines.push(`  - Rationale: ${mdInline(routine.relevanceRationale)}`);
  }
  return lines.join("\n");
}

/** #1004 — the body of a table bucket: grouped tables, then routines. */
function impactTablesBlock(rows: ImpactAffectedTableView[]): string {
  const routines = rows.filter(isRoutineRow);
  const relational = rows.filter((r) => !isRoutineRow(r));
  const parts: string[] = [];
  if (relational.length > 0) {
    parts.push(groupImpactTables(relational).map(impactTableGroupBullet).join("\n"));
  }
  if (routines.length > 0) {
    parts.push("_Affected procedures & functions:_");
    parts.push(routines.map(impactRoutineBullet).join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * #1004 — the #962 untested-write-path callout, in the exported artifact. The
 * screen rated this the most decision-relevant block on the page, and the export
 * dropped it entirely. Absent when every written table has a covering test.
 */
function writePathGapSection(gaps: WritePathCoverageGap[]): string[] {
  if (gaps.length === 0) return [];
  const headline =
    gaps.length === 1
      ? "_1 impacted table has an untested write path — verify this mutation before shipping._"
      : `_${gaps.length} impacted tables have untested write paths — verify these mutations before shipping._`;
  // #1012 — gaps are per WRITER. A table with some covered writers is reported as
  // PARTIALLY covered, naming both sides, so the reader can tell "this mutation is
  // entirely untested" from "one of these two mutations is untested".
  const bullets = gaps.map((gap) => {
    const untested = gap.writingSymbols.map((s) => codeSpan(s)).join(", ");
    const table = `**${mdInline(gap.tableName)}**`;
    if (gap.coveredWritingSymbols.length === 0) {
      const writers = untested ? ` · written by ${untested}` : "";
      return `- ${table} — no test covers this write path${writers}`;
    }
    const total = gap.writingSymbols.length + gap.coveredWritingSymbols.length;
    const covered = gap.coveredWritingSymbols.map((s) => codeSpan(s)).join(", ");
    return (
      `- ${table} — ${gap.writingSymbols.length} of ${total} write paths untested` +
      ` · untested: ${untested} · covered: ${covered}`
    );
  });
  return ["#### Untested write paths (QA handoff)", headline, bullets.join("\n")];
}

/**
 * #1004 — the #962 "tests covering the impacted code" panel, in the exported
 * artifact (it was on screen but absent from the download). Empty ⇒ no section.
 */
function affectedTestsSection(tests: ImpactAffectedSymbolView[]): string[] {
  if (tests.length === 0) return [];
  const fileCount = new Set(tests.map((t) => t.filePath)).size;
  return [
    `#### Tests covering the impacted code (${tests.length} across ${fileCount} ${
      fileCount === 1 ? "file" : "files"
    })`,
    tests.map(impactSymbolBullet).join("\n"),
  ];
}

/**
 * #1004/#1013 — how an item's heading is titled.
 *
 * #1004 shipped a workaround: an `ImpactItem` had no title column, so a run
 * started from pasted text (`requirementId === null`) left `requirementTitle`
 * null and every heading read "Unlabelled requirement change". The export
 * RE-DERIVED a heading by re-splitting the run's source text — sound only under
 * a three-condition gate (exactly one extracted change AND one item AND one
 * project), because two mis-attribution modes were reproduced against real runs:
 * the engine DROPS zero-hit changes so item ordinals do not match paste ordinals,
 * and the derived label was run-scoped while the gate was project-scoped.
 *
 * #1013 removes the inference entirely: the engine now SNAPSHOTS each change's
 * own title onto the row that change produced (`impact_items.requirementTitle`),
 * so the label travels with the item and cannot be attributed to another one.
 * The only remaining context is the neutral numbered fallback for rows that
 * genuinely carry no title — pre-#1013 rows, and titleless changes.
 */
interface ImpactItemLabelContext {
  /** Whether the run has source text at all (drives the numbered fallback). */
  hasSourceText: boolean;
  /**
   * 1-based position of this item within the RUN (not within its project) and
   * the run's item total, so a multi-project run's neutral headings stay
   * distinguishable rather than all reading "change 1 of 1".
   */
  index: number;
  total: number;
}

/** Heading text for one impact item — never an opaque "Unlabelled" when we know better. */
function impactItemLabel(item: ImpactItemView, ctx: ImpactItemLabelContext): string {
  // #1013 — the item's OWN persisted title (the tracked requirement's live title
  // when there is one, else the snapshot the engine took for this very change).
  const title = item.requirementTitle?.trim();
  if (title) return title;
  if (item.requirementId) return item.requirementId;
  // No title on this row (it predates #1013, or the change had none). The run
  // has source text, but nothing in it can be attributed to THIS item, so number
  // it and point the reader at the verbatim "Requirement analysed" block above.
  // A confidently wrong heading is worse than a neutral one.
  if (ctx.hasSourceText) return `Requirement change ${ctx.index} of ${ctx.total}`;
  return "Unlabelled requirement change";
}

/** #963 — render one impact item (a changed requirement) for a project. */
function impactItemSection(item: ImpactItemView, ctx: ImpactItemLabelContext): string {
  const parts: string[] = [
    `### ${mdInline(impactItemLabel(item, ctx))} — ${mdInline(
      item.changeType,
    )} · severity ${mdInline(item.severity)}`,
  ];

  // #932/#941 — the BA-readable per-item narrative, when the summarizer ran.
  if (item.summary && item.summary.trim().length > 0) {
    parts.push(mdBlock(item.summary));
  }

  parts.push(
    [
      meta("Impact score", item.impactScore.toFixed(2)),
      meta("Confidence", item.confidence.toFixed(2)),
      meta("Affected files", String(item.affectedFileCount)),
      meta("Affected symbols", String(item.affectedSymbolCount)),
    ].join("\n"),
  );

  // #962/#1004 — the untested write paths, high in the section (as on screen).
  parts.push(...writePathGapSection(item.writePathGaps));

  // Likely / possibly-related tables (primary set) + suggested DDL + consumers,
  // ONE section per table (#1004).
  if (item.affectedTables.length > 0) {
    parts.push("#### Likely / possibly-related tables");
    parts.push(impactTablesBlock(item.affectedTables));
  }

  // #936 — the low-confidence SECONDARY bucket, clearly labelled (recall safety).
  if (item.affectedTablesSecondary.length > 0) {
    parts.push("#### Low-confidence tables (judged possibly unrelated)");
    parts.push(
      "_Retained for recall — the relevance filter judged these tangential to the change._",
    );
    parts.push(impactTablesBlock(item.affectedTablesSecondary));
  }

  // Affected code symbols (direct matches + transitive blast-radius).
  if (item.affectedSymbols.length > 0) {
    parts.push("#### Affected code");
    parts.push(item.affectedSymbols.map(impactSymbolBullet).join("\n"));
  }

  // #962/#1004 — the tests that already cover the impacted code.
  parts.push(...affectedTestsSection(item.affectedTests));

  return parts.join("\n\n");
}

/** #956 — the run-level shared-table rollup (tables impacted in ≥2 projects). */
function sharedTableImpactSection(
  shared: SharedTableImpact[],
  projectLabel: (projectId: string) => string,
): string[] {
  if (shared.length === 0) return [];
  const bullets = shared.map((s) => {
    const projects = s.projectIds.map((pid) => mdInline(projectLabel(pid))).join(", ");
    return `- **${mdInline(s.tableName)}** — impacted in ${s.projectIds.length} projects: ${projects}`;
  });
  return ["## Shared-table impact (across projects)", bullets.join("\n")];
}

// ── #1004 — the analysed requirement, in the exported artifact ──────────────

/**
 * Upper bound on the exported source text. The run's `sourceText` is a
 * user-supplied field bounded at 500k chars; a report that gets emailed around
 * (and POSTed into a Jira description, which has its own far smaller limit) must
 * not carry a half-megabyte payload, so the block is clipped with an explicit,
 * honest truncation marker rather than silently dropped.
 */
const MAX_EXPORTED_SOURCE_TEXT = 4000;

/**
 * #1004 — THE REQUIREMENT, verbatim, at the top of the report.
 *
 * The exported markdown previously stated no requirement text at all, so a
 * downloaded (or Jira-published) impact report could not be circulated, attached
 * to a ticket or reviewed later: nothing in it said what was analysed. The text
 * is rendered as a blockquote via {@link mdQuote} — HTML-escaped and structurally
 * contained, so verbatim user input cannot restructure the document.
 */
function requirementTextSection(sourceText: string | null): string[] {
  const text = (sourceText ?? "").trim();
  if (text.length === 0) return [];
  const clipped =
    text.length > MAX_EXPORTED_SOURCE_TEXT
      ? `${text.slice(0, MAX_EXPORTED_SOURCE_TEXT)}\n…(truncated — ${
          text.length - MAX_EXPORTED_SOURCE_TEXT
        } more characters in the source text)`
      : text;
  return ["## Requirement analysed", mdQuote(clipped)];
}

/**
 * Issue #963 (Epic #960) — serialize a persisted {@link ImpactAnalysisDetail}
 * into a downloadable markdown report. Consumes ONLY already-persisted rows (the
 * read-side projection assembled by `getImpactAnalysisDetail`) — no LLM call, no
 * fabrication: run summary, per-requirement narrative (#932/#941), likely /
 * possibly-related tables with relevance tiers + rationale (#936/#950), the DDL
 * risk class (#957/#982) + suggested DDL, the low-confidence secondary bucket,
 * affected code symbols, and the cross-project consumers (#956). Output is
 * DETERMINISTIC (the read projection
 * fixes ordering) so it is snapshot-testable, and every model-supplied string is
 * routed through {@link mdInline}/{@link mdBlock}/{@link mdQuote}/{@link codeSpan}
 * (OWASP output handling — no HTML/DDL injection, no structural breakout).
 *
 * Issue #1004 brings the artifact back in line with the screen it came from: the
 * ANALYSED REQUIREMENT is stated verbatim, tables are grouped one section each
 * (rationale stated once, columns nested) instead of one bullet per row, and the
 * two most decision-relevant panels — the untested write paths and the covering
 * tests — are exported instead of dropped. The same function backs the
 * "Publish to Jira" action (`POST /:id/publish/jira`), so that path is fixed by
 * construction.
 */
export function serializeImpactAnalysisMarkdown(
  detail: ImpactAnalysisDetail,
  options: ImpactAnalysisMarkdownOptions = {},
): string {
  const names = options.projectNames ?? {};
  const projectLabel = (projectId: string): string => names[projectId] ?? projectId;

  const projectIds = [...detail.projectIds].sort((a, b) => a.localeCompare(b));
  const itemsByProject = new Map<string, ImpactItemView[]>();
  for (const pid of projectIds) itemsByProject.set(pid, []);
  for (const item of detail.items) {
    const list = itemsByProject.get(item.projectId);
    if (list) list.push(item);
    else itemsByProject.set(item.projectId, [item]);
  }

  const blocks: string[] = [
    "# Impact analysis",
    `_Status: ${mdInline(detail.status)} · ${projectIds.length} project(s) · ${
      detail.totalImpactedSymbols
    } impacted symbol(s)._`,
  ];

  // #1004 — the requirement this run analysed, verbatim, ABOVE the narrative.
  blocks.push(...requirementTextSection(detail.sourceText));

  // Run-level BA-readable overview (#932), when present.
  if (detail.summary && detail.summary.trim().length > 0) {
    blocks.push(mdBlock(detail.summary));
  }

  // Failed runs surface their error at the top; no impact rows follow.
  if (detail.status === "failed" && detail.errorMessage) {
    blocks.push(`> **This run failed:** ${mdInline(detail.errorMessage)}`);
  }

  blocks.push(...sharedTableImpactSection(detail.sharedTableImpacts, projectLabel));

  // #1013 — each item carries its OWN persisted requirement title, so no label
  // is inferred from run-level state any more (#1004's three-condition gate is
  // gone). The only run-level input left is whether there is source text to
  // point a titleless legacy row at.
  const hasSourceText = (detail.sourceText ?? "").trim().length > 0;

  if (detail.items.length === 0) {
    blocks.push("_No code impact was detected for the supplied requirement change._");
  } else {
    let itemNumber = 0;
    for (const projectId of [...itemsByProject.keys()].sort((a, b) => a.localeCompare(b))) {
      const items = itemsByProject.get(projectId) ?? [];
      if (items.length === 0) continue;
      blocks.push(`## Project: ${mdInline(projectLabel(projectId))}`);
      for (const item of items) {
        itemNumber += 1;
        blocks.push(
          impactItemSection(item, {
            hasSourceText,
            index: itemNumber,
            total: detail.items.length,
          }),
        );
      }
    }
  }

  return blocks.join("\n\n") + "\n";
}
