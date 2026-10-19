/**
 * The analysis page's status badges: one for an agent row, and (#1143) one for
 * a run, which shows `completed with errors` and names the failed agents when
 * a completed run had any, or `completed with warnings` and names the agents
 * that lost malformed citations. Either used to read as a clean `completed`,
 * with the failure visible only in the API's `agents[].errorMessage` and the
 * dropped citations visible nowhere.
 */
import {
  analysisStatusLabel,
  COMPLETED_WITH_ERRORS_LABEL,
  COMPLETED_WITH_WARNINGS_LABEL,
  type AnalysisDroppedCitations,
} from "@metis/shared";

export function StatusBadge({ status }: { status: string }): React.ReactElement {
  const colour =
    status === "completed"
      ? "bg-success-muted text-success border-success/30"
      : status === "degraded" ||
          status === COMPLETED_WITH_ERRORS_LABEL ||
          status === COMPLETED_WITH_WARNINGS_LABEL
        ? "bg-warning-muted text-warning border-warning/30"
        : status === "failed"
          ? "bg-destructive/10 text-destructive border-destructive/30"
          : status === "cancelled"
            ? "bg-muted text-foreground border-border/30"
            : "bg-info-muted text-info border-info/30";
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${colour}`}>
      {status}
    </span>
  );
}

/**
 * #1155 — the status text a run picker shows for one run of the run list: the
 * same label the run header shows ({@link analysisStatusLabel}), so a run that
 * completed with errors or warnings never reads as a plain `completed` there.
 */
export function runStatusText(run: {
  status: string;
  failedAgents?: readonly string[] | null;
  droppedCitations?: readonly AnalysisDroppedCitations[] | null;
}): string {
  return analysisStatusLabel(run.status, run.failedAgents ?? [], run.droppedCitations ?? []);
}

/**
 * A run's status. `failedAgents` turns a completed run into one completed with
 * errors; failing that, `droppedCitations` into one completed with warnings.
 */
export function RunStatusBadge({
  status,
  failedAgents,
  droppedCitations,
}: {
  status: string;
  failedAgents?: readonly string[] | null;
  droppedCitations?: readonly AnalysisDroppedCitations[] | null;
}): React.ReactElement {
  const failed = failedAgents ?? [];
  const dropped = (droppedCitations ?? []).filter((d) => d.count > 0);
  const label = analysisStatusLabel(status, failed, dropped);
  let detail: React.ReactElement | null = null;
  if (label === COMPLETED_WITH_ERRORS_LABEL) {
    detail = (
      <span className="text-xs font-normal text-warning" data-testid="analysis-failed-agents">
        {`Failed: ${failed.join(", ")}`}
      </span>
    );
  } else if (label === COMPLETED_WITH_WARNINGS_LABEL) {
    detail = (
      <span className="text-xs font-normal text-warning" data-testid="analysis-dropped-citations">
        {`Citations dropped: ${dropped.map((d) => `${d.agentKey} (${d.count})`).join(", ")}`}
      </span>
    );
  }
  if (!detail) return <StatusBadge status={label} />;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge status={label} />
      {detail}
    </span>
  );
}
