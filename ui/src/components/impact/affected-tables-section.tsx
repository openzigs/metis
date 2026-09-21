/**
 * AffectedTablesSection — Epic #168 (#174).
 *
 * Renders the database schema dimension of an impacted requirement: the
 * affected tables/columns, their provenance (live DB vs inferred mapper/ORM),
 * any reconciliation mismatch against the live schema, and the suggested DDL.
 *
 * The suggested DDL is **text only** — it is rendered inside a read-only
 * `<pre>` and is never executed. We deliberately avoid `dangerouslySetInnerHTML`.
 */
"use client";

import type {
  DdlRiskClass,
  GroupedImpactTable,
  ImpactAffectedTableView,
  ImpactConsumerResolution,
  ImpactTableConsumerView,
  ImpactTableFeedbackVerdict,
  ImpactTableFeedbackView,
  ProjectObjectUsage,
  SchemaSource,
} from "@metis/shared";
import {
  DDL_RISK_LABEL,
  groupImpactTables,
  groupRepresentative,
  isLiveSchemaSource,
} from "@metis/shared";
import { Badge } from "@/components/ui/badge";
import { renderInlineCode } from "@/lib/inline-code-text";

const SOURCE_LABEL: Record<SchemaSource, string> = {
  "live-db": "Live DB",
  mybatis: "MyBatis",
  orm: "ORM",
  "ddl-file": "DDL file",
  // Epic #294 (#304/#305/#306) — SQL parsed by the metis-sql-lineage sidecar,
  // and human manual-override assertions.
  sqlglot: "SQL parser",
  manual: "Manual override",
  // Epic #881 Phase 1 (#890) — coarse Tier-1 lineage read from a dialect's
  // dependency catalog (e.g. Oracle ALL_DEPENDENCIES/DBA_DEPENDENCIES).
  "catalog-deps": "Catalog dependency (coarse)",
  // Epic #883 (#897) — jOOQ generated table-class symbol resolution.
  jooq: "jOOQ",
  // #1029 — column-informed table-relevance RECOVERY judge (opt-in): a table the
  // deterministic crossing missed, recovered because the requirement data maps
  // to its own columns.
  "llm-recovery": "Column-informed recovery",
};

const RECONCILIATION_LABEL: Record<string, string> = {
  "table-not-found": "Table not in live schema",
  "column-not-found": "Column not in live schema",
  // Issue #958 — a live-DB reconciliation match: the referenced column ALREADY
  // EXISTS in the connected schema, so an add-a-field requirement may already
  // be implemented. Not a mismatch — rendered in a neutral (non-destructive)
  // badge, distinct from the two flags above.
  matched: "Already exists in live schema",
};

/** Issue #958 — badge variant per reconciliation outcome: mismatches read as a
 * destructive/needs-attention flag, a live match reads as neutral information. */
const RECONCILIATION_VARIANT: Record<string, "destructive" | "secondary"> = {
  "table-not-found": "destructive",
  "column-not-found": "destructive",
  matched: "secondary",
};

// #1014 — GroupedImpactTable, groupRepresentative, tierRank, and groupImpactTables
// now live in @metis/shared (impact-table-grouping) so this component and the
// Markdown export share ONE grouping/ordering implementation and cannot drift.

function ProvenanceBadge({ source }: { source: SchemaSource }) {
  const live = isLiveSchemaSource(source);
  return (
    <Badge
      variant={live ? "default" : "outline"}
      data-testid="schema-provenance-badge"
      data-source={source}
    >
      {live ? "Live DB" : `Inferred · ${SOURCE_LABEL[source]}`}
    </Badge>
  );
}

/**
 * Epic #295 Phase 4 (#310) — "used by N projects" indicator for a canonical
 * object. Read-only: it links the affected object to the OTHER projects in the
 * workspace that use it. Renders nothing when no cross-project usage is known.
 */
function CrossProjectUsageBadge({ projects }: { projects: ProjectObjectUsage[] | undefined }) {
  if (!projects || projects.length === 0) return null;
  const names = projects.map((p) => p.projectName).join(", ");
  return (
    <Badge
      variant="secondary"
      data-testid="cross-project-used-by"
      data-project-count={projects.length}
      title={`Also used by: ${names}`}
    >
      used by {projects.length} other project{projects.length === 1 ? "" : "s"}
    </Badge>
  );
}

const RELEVANCE_TIER_LABEL: Record<"likely" | "possible" | "unlikely", string> = {
  likely: "Likely",
  possible: "Possibly related",
  unlikely: "Unlikely related",
};

/**
 * #950 — surface the #936 LLM relevance judgment on an affected table.
 * Renders for every judged tier (`likely`/`possible`/`unlikely`); only null
 * (the filter did not run) renders nothing. #1022 — `unlikely` previously
 * rendered nothing, silently withholding the demotion tier from the collapsed
 * secondary bucket even though the Markdown export shows it; it now renders so
 * the two surfaces agree. `unlikely` only ever appears inside that collapsed
 * "Possibly-tangential" section, so the primary view is visually unchanged.
 *
 * Issue #985 review follow-up — this badge no longer carries the rationale as a
 * `title` attribute. {@link RelevanceRationale} now renders that same text
 * visibly right below the badge, so a `title` duplicate would make assistive
 * tech (and any other hover-reader) announce the identical sentence twice.
 */
function RelevanceTierBadge({ tier }: { tier: ImpactAffectedTableView["relevanceTier"] }) {
  if (tier !== "likely" && tier !== "possible" && tier !== "unlikely") return null;
  return (
    <Badge
      variant={tier === "likely" ? "default" : "outline"}
      data-testid="schema-relevance-tier"
      data-relevance-tier={tier}
    >
      {RELEVANCE_TIER_LABEL[tier]}
    </Badge>
  );
}

/**
 * Issue #985 (#1) — the LLM's one-line rationale for {@link RelevanceTierBadge},
 * rendered VISIBLY (this component previously only carried the rationale as
 * the badge's hover `title`, which is invisible without a mouse: no keyboard/
 * touch path, absent from screenshots/exports, and never announced to screen
 * readers — see the badge's own doc comment for why the `title` was removed
 * once this visible block took over). The rationale is arguably the single
 * most useful thing the LLM produces, so it now renders as plain
 * (always-visible) muted text under the table name, reachable by every input
 * modality and by assistive tech with zero interaction. Same gating as the
 * badge (every judged tier — `likely`/`possible`/`unlikely`, #1022) so it appears exactly
 * alongside the tier it explains. Inline `` `code` `` spans in the rationale
 * are tokenized (never parsed as HTML — untrusted LLM text).
 */
function RelevanceRationale({
  tier,
  rationale,
}: {
  tier: ImpactAffectedTableView["relevanceTier"];
  rationale: string | null | undefined;
}) {
  if (tier !== "likely" && tier !== "possible" && tier !== "unlikely") return null;
  if (!rationale || rationale.trim().length === 0) return null;
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="schema-relevance-rationale">
      {renderInlineCode(rationale)}
    </p>
  );
}

const RISK_VARIANT: Record<DdlRiskClass, "destructive" | "default" | "outline"> = {
  breaking: "destructive",
  expanding: "default",
  neutral: "outline",
};

const RISK_DESCRIPTION: Record<DdlRiskClass, string> = {
  breaking: "Destructive or backward-incompatible change — review before applying.",
  expanding: "Additive change — safe for existing consumers.",
  neutral: "No structural change — verify-only reference.",
};

/** Severity order so a table's badge reflects its WORST proposed change. */
const RISK_SEVERITY: Record<DdlRiskClass, number> = { breaking: 2, expanding: 1, neutral: 0 };

/**
 * #957 — the most severe DDL risk across a grouped table's rows (table-level +
 * columns), or null when no row carries a risk class (legacy rows ⇒ no badge, so
 * the view is visually unchanged).
 */
function groupRiskClass(group: GroupedImpactTable): DdlRiskClass | null {
  const entries = [group.tableEntry, ...group.columns].filter(
    (e): e is ImpactAffectedTableView => e !== null,
  );
  let worst: DdlRiskClass | null = null;
  for (const e of entries) {
    const rc = e.riskClass ?? null;
    if (!rc) continue;
    if (worst === null || RISK_SEVERITY[rc] > RISK_SEVERITY[worst]) worst = rc;
  }
  return worst;
}

/**
 * #957 — decision-ready risk badge on an affected table. Renders nothing when the
 * risk class is null (legacy row) so pre-#957 views are unchanged. The verbose
 * rationale rides along as the badge `title` (hover tooltip).
 */
function RiskBadge({ riskClass }: { riskClass: DdlRiskClass | null }) {
  if (!riskClass) return null;
  return (
    <Badge
      variant={RISK_VARIANT[riskClass]}
      data-testid="schema-risk-class"
      data-risk-class={riskClass}
      title={RISK_DESCRIPTION[riskClass]}
    >
      {DDL_RISK_LABEL[riskClass]}
    </Badge>
  );
}

/** Epic #954 (#956) — confidence label per consumer-resolution tier. */
const CONSUMER_TIER_LABEL: Record<ImpactConsumerResolution, string> = {
  identity: "verified identity",
  "string-match": "name match (lower confidence)",
  unverifiable: "could not verify",
};

/** How a consumer touches the shared table, in plain words. */
function usageVerb(usage: ImpactTableConsumerView["usage"]): string {
  return usage === "writtenBy" ? "writes" : "reads";
}

/**
 * Epic #954 (#956) — the cross-project CONSUMER block for one affected shared
 * table. Renders THREE visually-distinct states so "no consumers" is never
 * confused with "could not verify":
 *   - has consumers ⇒ "Also used by <project> (reads/writes via <qualifiedName>)"
 *     with the resolution tier's confidence label.
 *   - identity/string-match with ZERO consumers ⇒ "No other projects use this
 *     table" (verified, or heuristic for string-match).
 *   - unverifiable ⇒ "Cross-project impact could not be verified".
 * Renders NOTHING when consumers were not computed (single-project / no
 * workspace) so those views are unchanged. Read-only — no drop/alter affordance.
 */
function TableConsumersBlock({ entry }: { entry: ImpactAffectedTableView | null }) {
  const resolution = entry?.consumerResolution ?? null;
  if (!resolution) return null; // not computed ⇒ render unchanged
  const consumers = entry?.consumers ?? [];

  if (resolution === "unverifiable") {
    return (
      <div
        className="space-y-1 rounded border border-dashed px-2 py-1"
        data-testid="cross-project-consumers"
        data-consumer-resolution="unverifiable"
        data-consumer-state="could-not-verify"
      >
        <p className="text-[11px] text-muted-foreground">
          Cross-project impact could not be verified for this table (no shared-database identity).
          Other applications may or may not use it.
        </p>
      </div>
    );
  }

  const label = CONSUMER_TIER_LABEL[resolution];
  if (consumers.length === 0) {
    return (
      <div
        className="space-y-1 rounded border px-2 py-1"
        data-testid="cross-project-consumers"
        data-consumer-resolution={resolution}
        data-consumer-state="none"
      >
        <p className="text-[11px] text-muted-foreground">
          No other projects in this workspace read or write this table
          <span className="ml-1 text-[10px] uppercase">({label})</span>.
        </p>
      </div>
    );
  }

  return (
    <div
      className="space-y-1 rounded border px-2 py-1"
      data-testid="cross-project-consumers"
      data-consumer-resolution={resolution}
      data-consumer-state="has-consumers"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          Also used by {consumers.length} other project{consumers.length === 1 ? "" : "s"}
        </span>
        <Badge
          variant={resolution === "identity" ? "secondary" : "outline"}
          data-testid="consumer-tier-badge"
          data-consumer-resolution={resolution}
        >
          {label}
        </Badge>
      </div>
      <ul className="space-y-1">
        {consumers.map((c) => (
          <li
            key={`${c.projectId} ${c.objectQualifiedName}`}
            className="text-[11px]"
            data-testid="cross-project-consumer-row"
            data-consumer-project-id={c.projectId}
            data-consumer-usage={c.usage}
          >
            <span className="font-medium" title={c.projectId}>
              {c.projectName}
            </span>{" "}
            <span className="text-muted-foreground">
              ({usageVerb(c.usage)} via <span className="font-mono">{c.objectQualifiedName}</span>)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReconciliationFlag({ value }: { value: string }) {
  return (
    <Badge
      variant={RECONCILIATION_VARIANT[value] ?? "destructive"}
      data-testid="schema-reconciliation-flag"
      data-reconciliation={value}
      title={
        value === "matched" ? "Verify whether this requirement is already implemented." : undefined
      }
    >
      {RECONCILIATION_LABEL[value] ?? value}
    </Badge>
  );
}

function EntryDetail({ entry }: { entry: ImpactAffectedTableView }) {
  const mismatch =
    entry.reconciliation === "table-not-found" || entry.reconciliation === "column-not-found";
  // Issue #958 — a live-DB match on a COLUMN row: the field already exists, so
  // surface "already exists" (non-destructive) so a BA can verify whether the
  // requirement is already implemented, distinct from the mismatch flags above.
  // Table-level matches carry no such signal (a matched table says nothing
  // about whether a specific requirement is already implemented).
  const alreadyExists = entry.reconciliation === "matched" && entry.columnName !== null;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge source={entry.source} />
        <Badge variant="secondary" data-testid="schema-change-kind">
          {entry.changeKind}
        </Badge>
        {mismatch && entry.reconciliation ? (
          <ReconciliationFlag value={entry.reconciliation} />
        ) : null}
        {alreadyExists ? <ReconciliationFlag value="matched" /> : null}
        {entry.columnType ? (
          <span className="text-xs text-muted-foreground" data-testid="schema-column-type">
            {entry.columnType}
          </span>
        ) : null}
      </div>
      {entry.suggestedDdl ? (
        <pre
          className="overflow-x-auto rounded bg-muted px-3 py-2 text-xs"
          data-testid="schema-suggested-ddl"
        >
          {entry.suggestedDdl}
        </pre>
      ) : null}
    </div>
  );
}

/** One column-level affected entry (its name + detail). Used inside both the
 * "Proposed change" and "Referenced by impacted code" blocks (#957). */
function ColumnRow({ col }: { col: ImpactAffectedTableView }) {
  return (
    <li
      className="space-y-1"
      data-testid="schema-impact-column"
      data-column-name={col.columnName ?? ""}
    >
      <p className="font-mono text-xs" title={col.columnName ?? ""}>
        {col.columnName}
      </p>
      <EntryDetail entry={col} />
    </li>
  );
}

/**
 * #957 — one bucket of a table's rows: either the "Proposed change" block
 * (add-table/add-column/alter rows + their DDL) or the "Referenced by impacted
 * code" block (verify-only reference rows). A table-level entry renders its
 * detail inline; column entries render in a nested list. When `collapsible` and
 * the bucket has more than {@link COLLAPSE_THRESHOLD} rows, the block is wrapped
 * in a `<details>` so a long referenced-column list does not bury the change.
 */
const COLLAPSE_THRESHOLD = 5;

function AffectedRowsBlock({
  label,
  testId,
  tableEntry,
  columns,
  collapsible = false,
}: {
  label: string;
  testId: string;
  tableEntry: ImpactAffectedTableView | null;
  columns: ImpactAffectedTableView[];
  collapsible?: boolean;
}) {
  if (!tableEntry && columns.length === 0) return null;
  const rowCount = (tableEntry ? 1 : 0) + columns.length;
  const body = (
    <>
      {tableEntry ? <EntryDetail entry={tableEntry} /> : null}
      {columns.length > 0 ? (
        <ul className="space-y-2 border-l pl-3">
          {columns.map((col) => (
            <ColumnRow key={col.id} col={col} />
          ))}
        </ul>
      ) : null}
    </>
  );

  if (collapsible && rowCount > COLLAPSE_THRESHOLD) {
    return (
      <details className="space-y-2" data-testid={testId} data-collapsed="true">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          {label} ({rowCount})
        </summary>
        <div className="space-y-2 pt-1">{body}</div>
      </details>
    );
  }

  return (
    <div className="space-y-2" data-testid={testId}>
      <p className="text-xs font-medium text-muted-foreground">
        {label} ({rowCount})
      </p>
      {body}
    </div>
  );
}

/**
 * A routine (procedure/function) affected by the change — Epic #293 Phase 2
 * (#302). Rendered in its own list, distinct from tables/columns. METIS NEVER
 * suggests dropping/altering a routine (its body is not analyzed until Phase 3),
 * so only a verify-only note is shown — there is no drop/alter affordance.
 */
function RoutineRow({ routine }: { routine: ImpactAffectedTableView }) {
  return (
    <li
      className="space-y-1 rounded border px-3 py-2"
      data-testid="schema-impact-routine"
      data-object-kind={routine.objectKind}
      data-routine-name={routine.tableName}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold" title={routine.tableName}>
          {routine.tableName}
        </span>
        <Badge variant="secondary" data-testid="schema-routine-kind">
          {routine.objectKind}
        </Badge>
        <ProvenanceBadge source={routine.source} />
      </div>
      {routine.suggestedDdl ? (
        <pre
          className="overflow-x-auto rounded bg-muted px-3 py-2 text-xs"
          data-testid="schema-routine-note"
        >
          {routine.suggestedDdl}
        </pre>
      ) : null}
    </li>
  );
}

/**
 * Issue #966 (Epic #960) — a small thumbs-up/down affordance letting a BA mark
 * an affected TABLE relevant/not-relevant. Applied at the table-group level
 * (not per-column) to keep the affordance small, per the acceptance criteria.
 * State is always visible: every mark renders inline as "<name> 👍/👎", never
 * hidden behind a hover tooltip. Clicking the ALREADY-active verdict un-marks
 * (toggle); clicking the other verdict re-marks (idempotent update). CAPTURE
 * ONLY — this has no effect on the engine/filter, it just persists a signal
 * later harvested (human-reviewed) into eval-corpus labels.
 */
function TableFeedbackControls({
  tableName,
  feedback,
  currentUserId,
  onMark,
  onDelete,
}: {
  tableName: string;
  feedback: ImpactTableFeedbackView[];
  currentUserId: string | null | undefined;
  onMark: (verdict: ImpactTableFeedbackVerdict) => void;
  onDelete: (feedbackId: string) => void;
}) {
  const mine = currentUserId ? (feedback.find((f) => f.userId === currentUserId) ?? null) : null;

  function toggle(verdict: ImpactTableFeedbackVerdict) {
    if (mine && mine.verdict === verdict) onDelete(mine.id);
    else onMark(verdict);
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="table-feedback-controls"
      data-table-name={tableName}
    >
      <button
        type="button"
        aria-label={`Mark ${tableName} relevant`}
        aria-pressed={mine?.verdict === "relevant"}
        data-testid="table-feedback-relevant"
        data-active={mine?.verdict === "relevant"}
        className="rounded px-1 text-xs leading-none hover:bg-muted"
        onClick={() => toggle("relevant")}
      >
        👍
      </button>
      <button
        type="button"
        aria-label={`Mark ${tableName} not relevant`}
        aria-pressed={mine?.verdict === "not-relevant"}
        data-testid="table-feedback-not-relevant"
        data-active={mine?.verdict === "not-relevant"}
        className="rounded px-1 text-xs leading-none hover:bg-muted"
        onClick={() => toggle("not-relevant")}
      >
        👎
      </button>
      {feedback.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" data-testid="table-feedback-marks">
          {feedback.map((f) => (
            <li
              key={f.id}
              className="text-[10px] text-muted-foreground"
              data-testid="table-feedback-mark"
              data-verdict={f.verdict}
              data-user-id={f.userId}
            >
              {f.userDisplayName} {f.verdict === "relevant" ? "👍" : "👎"}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface AffectedTablesSectionProps {
  tables: ImpactAffectedTableView[];
  /**
   * Epic #295 Phase 4 (#310) — optional map of canonical object name
   * (`<schema>.<table>` or bare `<table>`/routine qualified name) -> the OTHER
   * projects in the workspace that use it. When provided, each affected object
   * shows a "used by N other projects" badge. Omitted in single-project views.
   */
  crossProjectUsage?: Record<string, ProjectObjectUsage[]>;
  /**
   * Issue #966 (Epic #960) — accumulated feedback for the parent item (both the
   * primary and secondary buckets share this one list; rows are matched to a
   * table by `tableName`). Omitted / empty ⇒ no marks rendered.
   */
  feedback?: ImpactTableFeedbackView[];
  /** Issue #966 — the signed-in caller's user id, to identify "my" mark. */
  currentUserId?: string | null;
  /**
   * Issue #966 — mark (or re-mark) a table relevant/not-relevant. The thumbs
   * affordance renders ONLY when this is provided, so every existing caller
   * that doesn't pass it renders unchanged.
   */
  onMarkFeedback?: (input: { tableName: string; verdict: ImpactTableFeedbackVerdict }) => void;
  /** Issue #966 — remove a feedback mark (toggle off). */
  onDeleteFeedback?: (feedbackId: string) => void;
}

export function AffectedTablesSection({
  tables,
  crossProjectUsage,
  feedback,
  currentUserId,
  onMarkFeedback,
  onDeleteFeedback,
}: AffectedTablesSectionProps) {
  if (tables.length === 0) return null;
  // Split routines (procedure/function) out of the table/column grouping (#302).
  const routines = tables.filter(
    (t) => t.objectKind === "procedure" || t.objectKind === "function",
  );
  const relational = tables.filter(
    (t) => t.objectKind !== "procedure" && t.objectKind !== "function",
  );
  const groups = groupImpactTables(relational);

  return (
    <div data-testid="schema-impact-section">
      <p className="mb-1 text-xs font-medium text-muted-foreground">Database schema impact</p>
      <ul className="space-y-2">
        {groups.map((group) => {
          // #957 — split this table's rows into the actual PROPOSED change
          // (add-table/add-column/alter/drop) vs verify-only REFERENCE rows, so a
          // BA sees the change at a glance instead of a flat column list. The
          // data already carries `changeKind` (#923); `reference` ⇒ referenced.
          const isProposed = (e: ImpactAffectedTableView) => e.changeKind !== "reference";
          const proposedTableEntry =
            group.tableEntry && isProposed(group.tableEntry) ? group.tableEntry : null;
          const referencedTableEntry =
            group.tableEntry && !isProposed(group.tableEntry) ? group.tableEntry : null;
          const proposedColumns = group.columns.filter(isProposed);
          const referencedColumns = group.columns.filter((c) => !isProposed(c));
          return (
            <li
              key={group.tableName}
              className="space-y-2 rounded border px-3 py-2"
              data-testid="schema-impact-table"
              data-table-name={group.tableName}
            >
              <div className="flex flex-wrap items-center gap-2 font-mono text-xs font-semibold">
                <span title={group.tableName}>{group.tableName}</span>
                <RiskBadge riskClass={groupRiskClass(group)} />
                <RelevanceTierBadge tier={groupRepresentative(group)?.relevanceTier ?? null} />
                <CrossProjectUsageBadge projects={crossProjectUsage?.[group.tableName]} />
                {onMarkFeedback ? (
                  <TableFeedbackControls
                    tableName={group.tableName}
                    feedback={(feedback ?? []).filter(
                      (f) => f.tableName === group.tableName && f.columnName === null,
                    )}
                    currentUserId={currentUserId}
                    onMark={(verdict) => onMarkFeedback({ tableName: group.tableName, verdict })}
                    onDelete={(feedbackId) => onDeleteFeedback?.(feedbackId)}
                  />
                ) : null}
              </div>
              <RelevanceRationale
                tier={groupRepresentative(group)?.relevanceTier ?? null}
                rationale={groupRepresentative(group)?.relevanceRationale ?? null}
              />
              <TableConsumersBlock entry={groupRepresentative(group)} />
              <AffectedRowsBlock
                label="Proposed change"
                testId="proposed-change-block"
                tableEntry={proposedTableEntry}
                columns={proposedColumns}
              />
              <AffectedRowsBlock
                label="Referenced by impacted code"
                testId="referenced-by-block"
                tableEntry={referencedTableEntry}
                columns={referencedColumns}
                collapsible
              />
            </li>
          );
        })}
      </ul>
      {routines.length > 0 ? (
        <div className="mt-3" data-testid="schema-impact-routines-section">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Affected procedures &amp; functions
          </p>
          <ul className="space-y-2">
            {routines.map((r) => (
              <RoutineRow key={r.id} routine={r} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
