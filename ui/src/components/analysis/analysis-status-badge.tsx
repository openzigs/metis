/**
 * The analysis page's status badges: one for an agent row, and (#1143) one for
 * a run, which shows `completed with errors` and names the failed agents when
 * a completed run had any. A run whose agents failed used to read as a clean
 * `completed`, with the failure visible only in the API's
 * `agents[].errorMessage`.
 */
import { analysisStatusLabel, COMPLETED_WITH_ERRORS_LABEL } from "@metis/shared";

export function StatusBadge({ status }: { status: string }): React.ReactElement {
  const colour =
    status === "completed"
      ? "bg-success-muted text-success border-success/30"
      : status === "degraded" || status === COMPLETED_WITH_ERRORS_LABEL
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

/** A run's status; `failedAgents` turns a completed run into one completed with errors. */
export function RunStatusBadge({
  status,
  failedAgents,
}: {
  status: string;
  failedAgents?: readonly string[] | null;
}): React.ReactElement {
  const failed = failedAgents ?? [];
  const label = analysisStatusLabel(status, failed);
  if (label !== COMPLETED_WITH_ERRORS_LABEL) return <StatusBadge status={label} />;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge status={label} />
      <span className="text-xs font-normal text-warning" data-testid="analysis-failed-agents">
        {`Failed: ${failed.join(", ")}`}
      </span>
    </span>
  );
}
