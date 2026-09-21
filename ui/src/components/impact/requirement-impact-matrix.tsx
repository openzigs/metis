/**
 * RequirementImpactMatrix — #964.
 *
 * A ranked requirement×project pivot over an impact analysis. Rows are the
 * requirements extracted from the source document, ranked by aggregate impact;
 * columns are the run's projects; each cell shows the requirement's impact in
 * that project (score / severity + affected-table count) and drills down to the
 * EXISTING per-item detail rendering ({@link ChangedRequirementGroup}) — the
 * detail UI is reused, never duplicated.
 *
 * A single-project run degrades to a ranked list of requirements.
 */
"use client";

import { useMemo, useState } from "react";
import type { ImpactItemView } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChangedRequirementGroup } from "./changed-requirement-group";

const SEVERITY_VARIANT: Record<
  ImpactItemView["severity"],
  "destructive" | "default" | "secondary" | "outline"
> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
};

export interface MatrixProject {
  id: string;
  name: string;
}

/** One ranked requirement row: its per-project impact items keyed by project id. */
export interface RequirementMatrixRow {
  /** Stable identity: requirementId when present, else the title, else the item id. */
  key: string;
  title: string;
  changeType: ImpactItemView["changeType"];
  /** Sum of impactScore across the projects that have impact — the rank key. */
  aggregateScore: number;
  /** Number of projects with a non-null impact item for this requirement. */
  impactedProjectCount: number;
  itemsByProject: Record<string, ImpactItemView | null>;
}

/** Group `items` into ranked requirement rows aligned to `projects`. Pure. */
export function buildRequirementMatrix(
  items: ImpactItemView[],
  projects: MatrixProject[],
): RequirementMatrixRow[] {
  const rowsByKey = new Map<string, RequirementMatrixRow>();
  const order: string[] = [];

  for (const item of items) {
    const key = item.requirementId ?? item.requirementTitle ?? item.id;
    let row = rowsByKey.get(key);
    if (!row) {
      row = {
        key,
        title: item.requirementTitle ?? "Requirement change",
        changeType: item.changeType,
        aggregateScore: 0,
        impactedProjectCount: 0,
        itemsByProject: Object.fromEntries(projects.map((p) => [p.id, null])),
      };
      rowsByKey.set(key, row);
      order.push(key);
    }
    // One item per (requirement, project); keep the stronger if duplicated.
    const existing = row.itemsByProject[item.projectId] ?? null;
    if (!existing || item.impactScore > existing.impactScore) {
      if (!existing) row.impactedProjectCount += 1;
      else row.aggregateScore -= existing.impactScore;
      row.itemsByProject[item.projectId] = item;
      row.aggregateScore += item.impactScore;
    }
  }

  return order
    .map((k) => rowsByKey.get(k)!)
    .sort(
      (a, b) =>
        b.aggregateScore - a.aggregateScore ||
        b.impactedProjectCount - a.impactedProjectCount ||
        a.title.localeCompare(b.title),
    );
}

export interface RequirementImpactMatrixProps {
  items: ImpactItemView[];
  /** The run's projects, in column order. */
  projects: MatrixProject[];
}

/**
 * Issue #985 (#2) — `item.affectedTables` is one row PER (table, column?), so
 * its raw length counts table+column impact rows, not distinct tables (a table
 * with 55 impacted columns read as "56 table(s)"). Count distinct `tableName`s
 * for the headline figure, with the row count alongside as "objects" so the
 * fan-out signal isn't lost. Pure — no I/O.
 */
export function affectedTableCountLabel(tables: ImpactItemView["affectedTables"]): string {
  const distinctTableCount = new Set(tables.map((t) => t.tableName)).size;
  const objectCount = tables.length;
  const tableWord = distinctTableCount === 1 ? "table" : "tables";
  const objectWord = objectCount === 1 ? "object" : "objects";
  return `${distinctTableCount} ${tableWord} · ${objectCount} ${objectWord}`;
}

function CellSummary({ item }: { item: ImpactItemView }) {
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge variant={SEVERITY_VARIANT[item.severity]} data-testid="matrix-cell-severity">
        {item.severity}
      </Badge>
      <span className="text-xs text-muted-foreground" data-testid="matrix-cell-score">
        impact {Math.round(item.impactScore * 100)}%
      </span>
      <span className="text-[11px] text-muted-foreground" data-testid="matrix-cell-tables">
        {affectedTableCountLabel(item.affectedTables)}
      </span>
    </span>
  );
}

export function RequirementImpactMatrix({ items, projects }: RequirementImpactMatrixProps) {
  const rows = useMemo(() => buildRequirementMatrix(items, projects), [items, projects]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="requirement-matrix-empty">
        No ranked requirement impact to display.
      </p>
    );
  }

  const singleProject = projects.length <= 1;

  return (
    <section className="space-y-4" data-testid="requirement-impact-matrix">
      <div className="flex items-center justify-between border-b pb-1">
        <h2 className="text-base font-semibold">Requirement impact</h2>
        <span className="text-xs text-muted-foreground">
          {rows.length} requirement(s) · {projects.length} project(s)
        </span>
      </div>

      {singleProject ? (
        <ol className="space-y-2" data-testid="requirement-matrix-list">
          {rows.map((row, idx) => {
            const item = projects.length === 1 ? row.itemsByProject[projects[0].id] : null;
            return (
              <li key={row.key}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded border border-border/60 px-3 py-2 text-left hover:bg-muted/40 disabled:cursor-default disabled:opacity-60"
                  data-testid="requirement-matrix-list-row"
                  disabled={!item}
                  onClick={() => item && setSelectedId(item.id)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">#{idx + 1}</span>
                    <span className="truncate text-sm font-medium">{row.title}</span>
                    <Badge variant="outline" data-testid="matrix-row-change-type">
                      {row.changeType}
                    </Badge>
                  </span>
                  {item ? (
                    <CellSummary item={item} />
                  ) : (
                    <span className="text-xs text-muted-foreground">no impact</span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full border-collapse text-left"
            data-testid="requirement-matrix-table"
          >
            <thead>
              <tr className="border-b">
                <th className="p-2 text-xs font-medium text-muted-foreground">Requirement</th>
                {projects.map((p) => (
                  <th
                    key={p.id}
                    className="p-2 text-xs font-medium text-muted-foreground"
                    data-testid="matrix-project-header"
                  >
                    {p.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={row.key} className="border-b align-top" data-testid="matrix-row">
                  <th scope="row" className="p-2">
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{idx + 1}</span>
                      <span className="text-sm font-medium">{row.title}</span>
                      <Badge variant="outline" data-testid="matrix-row-change-type">
                        {row.changeType}
                      </Badge>
                    </span>
                  </th>
                  {projects.map((p) => {
                    const item = row.itemsByProject[p.id];
                    return (
                      <td key={p.id} className="p-2" data-testid="matrix-cell">
                        {item ? (
                          <button
                            type="button"
                            className="rounded px-1 py-0.5 text-left hover:bg-muted/40"
                            data-testid="matrix-cell-button"
                            onClick={() => setSelectedId(item.id)}
                          >
                            <CellSummary item={item} />
                          </button>
                        ) : (
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid="matrix-cell-empty"
                          >
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedItem ? (
        <Card className="space-y-3 p-4" data-testid="requirement-matrix-drilldown">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Requirement detail</p>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline"
              data-testid="requirement-matrix-drilldown-close"
              onClick={() => setSelectedId(null)}
            >
              Close
            </button>
          </div>
          <ChangedRequirementGroup item={selectedItem} />
        </Card>
      ) : null}
    </section>
  );
}
