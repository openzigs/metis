/**
 * Issue #965 (Epic #960) — impact drift view.
 *
 * Renders "what changed since the original run" for a re-run: per-requirement
 * chips for affected tables added/removed, tier changes, and code sites
 * added/removed, plus a roll-up header. Purely presentational — the drift report
 * is computed server-side by the deterministic differ.
 */
"use client";

import type { ImpactDriftReport, RequirementDrift } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const STATUS_VARIANT: Record<
  RequirementDrift["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  added: "default",
  removed: "destructive",
  changed: "secondary",
  unchanged: "outline",
};

/** A compact colored chip listing a set of changed identities. */
function ChangeChips({
  label,
  values,
  tone,
  testid,
}: {
  label: string;
  values: string[];
  tone: "added" | "removed";
  testid: string;
}) {
  if (values.length === 0) return null;
  const color =
    tone === "added"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : "border-destructive/40 bg-destructive/10 text-destructive";
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={testid}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {values.map((v) => (
        <span
          key={v}
          className={`rounded border px-1.5 py-0.5 text-xs ${color}`}
          data-testid={`${testid}-chip`}
        >
          {tone === "added" ? "+" : "−"} {v}
        </span>
      ))}
    </div>
  );
}

function RequirementDriftRow({ drift }: { drift: RequirementDrift }) {
  const label = drift.requirementTitle ?? drift.requirementId ?? "(untitled requirement)";
  return (
    <div className="space-y-2 border-t py-3 first:border-t-0" data-testid="impact-drift-req">
      <div className="flex items-center gap-2">
        <Badge variant={STATUS_VARIANT[drift.status]} data-testid="impact-drift-req-status">
          {drift.status}
        </Badge>
        <span className="text-sm font-medium" data-testid="impact-drift-req-label">
          {label}
        </span>
        {drift.confidenceDelta !== 0 ? (
          <span className="text-xs text-muted-foreground" data-testid="impact-drift-confidence">
            confidence {drift.confidenceDelta > 0 ? "+" : ""}
            {drift.confidenceDelta.toFixed(2)}
          </span>
        ) : null}
        {drift.severityChanged ? (
          <span className="text-xs text-muted-foreground" data-testid="impact-drift-severity">
            severity {drift.severityChanged.from} → {drift.severityChanged.to}
          </span>
        ) : null}
      </div>
      <ChangeChips
        label="Tables"
        values={drift.tablesAdded}
        tone="added"
        testid="impact-drift-tables-added"
      />
      <ChangeChips
        label="Tables"
        values={drift.tablesRemoved}
        tone="removed"
        testid="impact-drift-tables-removed"
      />
      {drift.tablesTierChanged.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1" data-testid="impact-drift-tier-changed">
          <span className="text-xs font-medium text-muted-foreground">Tier</span>
          {drift.tablesTierChanged.map((t) => (
            <span
              key={`${t.tableName}.${t.columnName ?? ""}`}
              className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300"
            >
              {t.columnName ? `${t.tableName}.${t.columnName}` : t.tableName}: {t.fromTier ?? "—"} →{" "}
              {t.toTier ?? "—"}
            </span>
          ))}
        </div>
      ) : null}
      <ChangeChips
        label="Code sites"
        values={drift.symbolsAdded}
        tone="added"
        testid="impact-drift-symbols-added"
      />
      <ChangeChips
        label="Code sites"
        values={drift.symbolsRemoved}
        tone="removed"
        testid="impact-drift-symbols-removed"
      />
    </div>
  );
}

export function ImpactDriftSection({ report }: { report: ImpactDriftReport | undefined }) {
  if (!report || report.baseAnalysisId === null) return null;

  const { summary } = report;
  const hasChanges = report.requirements.length > 0;

  return (
    <Card className="p-4" data-testid="impact-drift-section">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Drift since the original run</h2>
        <Badge variant="outline" data-testid="impact-drift-summary">
          +{summary.tablesAdded}/−{summary.tablesRemoved} tables · +{summary.symbolsAdded}/−
          {summary.symbolsRemoved} sites
        </Badge>
      </div>
      {hasChanges ? (
        <div data-testid="impact-drift-list">
          {report.requirements.map((d) => (
            <RequirementDriftRow key={d.key} drift={d} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="impact-drift-empty">
          No changes since the original run — the impact is identical.
        </p>
      )}
    </Card>
  );
}
