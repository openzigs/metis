import type { ImpactAffectedTableView } from "./schema-impact.js";

/**
 * #1014 — THE single source of truth for grouping impact-affected table rows
 * into one entry per physical table and ordering them. Both the UI
 * (`ui/src/components/impact/affected-tables-section.tsx`) and the Markdown
 * export (`server/src/lib/analysis/analysis-export.ts`) consume this, so the
 * screen and the exported artifact (#1004) can never drift: there is no second
 * copy of the algorithm to fall out of step.
 */
export interface GroupedImpactTable {
  tableName: string;
  /** The `columnName === null` row for this table, when the engine emitted one. */
  tableEntry: ImpactAffectedTableView | null;
  columns: ImpactAffectedTableView[];
}

/**
 * The row that carries the group relevance/confidence: the table-level row when
 * present, else the first column. Null only for an empty group.
 */
export function groupRepresentative(group: GroupedImpactTable): ImpactAffectedTableView | null {
  return group.tableEntry ?? group.columns[0] ?? null;
}

/**
 * #950 — primary sort rank for the #936 relevance tier: `likely` first, then
 * `possible`. Everything else (`unlikely`, or null when the relevance filter did
 * not run) collapses to a single trailing bucket that preserves the historical
 * alphabetical order, so a flag-off analysis renders exactly as before.
 */
export function tierRank(tier: ImpactAffectedTableView["relevanceTier"]): number {
  if (tier === "likely") return 0;
  if (tier === "possible") return 1;
  return 2;
}

/**
 * Group rows by physical table and order them exactly as the screen renders
 * them: `likely` → `possible` → rest; confidence descending within the ranked
 * buckets; table name as the stable tiebreak.
 *
 * #1014 — representative selection is FIRST-row-wins (`tableEntry ?? row`): once
 * a `columnName === null` row represents a table, a later table-level row for the
 * same table does NOT overwrite it. The UI historically used last-wins
 * (`tableEntry = row`) and the export first-wins; because `crossToSchema` dedupes
 * on `(tableQn, columnName)`, at most one table-level row exists per
 * `(item, table)`, so the two never diverged in practice. First-wins is the
 * canonical, documented behaviour and both callers now share this implementation.
 */
export function groupImpactTables(rows: ImpactAffectedTableView[]): GroupedImpactTable[] {
  const byName = new Map<string, GroupedImpactTable>();
  for (const row of rows) {
    const group = byName.get(row.tableName) ?? {
      tableName: row.tableName,
      tableEntry: null,
      columns: [],
    };
    if (row.columnName === null) group.tableEntry = group.tableEntry ?? row;
    else group.columns.push(row);
    byName.set(row.tableName, group);
  }
  return [...byName.values()].sort((a, b) => {
    const ra = tierRank(groupRepresentative(a)?.relevanceTier ?? null);
    const rb = tierRank(groupRepresentative(b)?.relevanceTier ?? null);
    if (ra !== rb) return ra - rb;
    if (ra !== 2) {
      const ca = groupRepresentative(a)?.confidence ?? 0;
      const cb = groupRepresentative(b)?.confidence ?? 0;
      if (cb !== ca) return cb - ca;
    }
    return a.tableName.localeCompare(b.tableName);
  });
}
