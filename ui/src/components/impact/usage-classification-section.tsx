/**
 * UsageClassificationSection — Epic #292 (#298).
 *
 * Surfaces the per-object used/unreferenced/uncertain classification produced by
 * reconciling the introspected full schema against the code→schema graph
 * (#296/#297). Each object shows a usage badge with an evidence tooltip; a
 * filter toggle lets the user view only `used` objects while the full schema
 * remains accessible (toggle off restores it).
 *
 * Safety contract (#292): `uncertain` is rendered visually distinct, and there
 * is NO "drop"/"remove" affordance anywhere — unreferenced objects are framed
 * as review candidates only. METIS never recommends a schema change here.
 *
 * Accessibility: the section is a labelled `region`; the filter is a native
 * checkbox with an associated label; evidence is exposed via the badge `title`.
 */
"use client";

import { useMemo, useState } from "react";
import type { SchemaUsageClassificationView, UsageClass, UsageEvidence } from "@metis/shared";
import { Badge } from "@/components/ui/badge";

const CLASS_LABEL: Record<UsageClass, string> = {
  used: "Used",
  unreferenced: "Unreferenced",
  uncertain: "Uncertain",
};

const CLASS_VARIANT: Record<UsageClass, "default" | "secondary" | "destructive" | "outline"> = {
  used: "default",
  unreferenced: "outline",
  // `uncertain` is deliberately distinct from both used and unreferenced.
  uncertain: "destructive",
};

function evidenceTitle(evidence: UsageEvidence[]): string {
  if (evidence.length === 0) return "No inbound code references";
  return evidence
    .slice(0, 8)
    .map((e) => {
      const from = e.fromQualifiedName ?? "?";
      const recon = e.reconciliation ? ` (${e.reconciliation})` : "";
      return `${e.edgeKind} ← ${from} [${e.source}]${recon}`;
    })
    .join("\n");
}

export interface UsageBadgeProps {
  usageClass: UsageClass;
  evidence?: UsageEvidence[];
}

/** A single usage-classification badge. `uncertain` is marked visually distinct. */
export function UsageBadge({ usageClass, evidence = [] }: UsageBadgeProps) {
  return (
    <Badge
      variant={CLASS_VARIANT[usageClass]}
      data-testid="usage-badge"
      data-usage-class={usageClass}
      data-distinct={usageClass === "uncertain" ? "true" : "false"}
      title={evidenceTitle(evidence)}
    >
      {CLASS_LABEL[usageClass]}
    </Badge>
  );
}

export interface UsageClassificationSectionProps {
  objects: SchemaUsageClassificationView[];
}

export function UsageClassificationSection({ objects }: UsageClassificationSectionProps) {
  const [onlyUsed, setOnlyUsed] = useState(false);

  const visible = useMemo(
    () => (onlyUsed ? objects.filter((o) => o.usageClass === "used") : objects),
    [objects, onlyUsed],
  );

  if (objects.length === 0) return null;

  return (
    <section
      aria-label="Used objects"
      data-testid="usage-classification-section"
      className="space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Used objects</p>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyUsed}
            onChange={(e) => setOnlyUsed(e.target.checked)}
            aria-label="Only show used objects"
            data-testid="usage-only-used-toggle"
          />
          Only show used
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Unreferenced objects are review candidates only — METIS does not recommend any schema
        change. Uncertain objects could not be statically resolved and must be investigated
        manually.
      </p>
      <ul className="space-y-1">
        {visible.map((o) => {
          const name =
            o.kind === "column" && o.columnName ? `${o.tableName}.${o.columnName}` : o.tableName;
          return (
            <li
              key={o.id}
              className="flex flex-wrap items-center gap-2 rounded border px-2 py-1"
              data-testid="usage-classification-row"
              data-usage-class={o.usageClass}
            >
              <span className="font-mono text-xs" title={name}>
                {name}
              </span>
              <span className="text-[10px] uppercase text-muted-foreground">{o.kind}</span>
              <UsageBadge usageClass={o.usageClass} evidence={o.evidence} />
              {o.usageClass === "uncertain" && o.uncertainReason ? (
                <span
                  className="text-[11px] text-muted-foreground"
                  data-testid="usage-uncertain-reason"
                >
                  {o.uncertainReason}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
