/**
 * SharedTableImpactSection — Epic #954 (#956).
 *
 * The RUN-LEVEL "shared impact" rollup: physical tables impacted in TWO OR MORE
 * of the run's selected projects. Distinct from the per-table CONSUMER dimension
 * (sibling projects NOT selected in the run): this flags overlap WITHIN the
 * selected set. Renders nothing for single-project runs or when no table is
 * shared, so those views are unchanged. Read-only — informational only.
 */
"use client";

import type { SharedTableImpact } from "@metis/shared";
import { Badge } from "@/components/ui/badge";

export interface SharedTableImpactSectionProps {
  /** Project id → display name, for rendering the impacted projects. */
  projectName?: (projectId: string) => string;
  sharedTableImpacts: SharedTableImpact[];
}

export function SharedTableImpactSection({
  sharedTableImpacts,
  projectName,
}: SharedTableImpactSectionProps) {
  if (sharedTableImpacts.length === 0) return null;
  const nameOf = (id: string) => projectName?.(id) ?? id;

  return (
    <section
      aria-label="Shared-table impact"
      data-testid="shared-table-impact-section"
      className="space-y-2 rounded border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Shared-table impact</p>
        <Badge variant="secondary" data-testid="shared-table-impact-count">
          {sharedTableImpacts.length} shared table{sharedTableImpacts.length === 1 ? "" : "s"}
        </Badge>
      </div>
      <p className="text-[11px] text-muted-foreground">
        These tables are impacted in two or more of the selected projects — a change here ripples
        across all of them. Review is informational; METIS recommends no schema change.
      </p>
      <ul className="space-y-1">
        {sharedTableImpacts.map((s) => (
          <li
            key={s.tableName}
            className="flex flex-wrap items-center gap-2 rounded border px-2 py-1"
            data-testid="shared-table-impact-row"
            data-table-name={s.tableName}
          >
            <span className="font-mono text-xs font-semibold" title={s.tableName}>
              {s.tableName}
            </span>
            <span className="text-[11px] text-muted-foreground">
              impacted in {s.projectIds.length} projects: {s.projectIds.map(nameOf).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
