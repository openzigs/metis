"use client";

/**
 * Shared job-progress bar — Issue #423 (Epic #406).
 *
 * Renders a live 0-100 progress bar + step label for a long-running async op,
 * replacing the old frozen "Reindexing…" / "Regenerating…" / "Running…" labels.
 * Two modes:
 *   - determinate: pass `progress` (0-100, from a `job:lifecycle` event) for a
 *     fire-and-forget op whose worker streams progress over the bus (embeddings
 *     reindex). The bar fills and exposes `aria-valuenow`.
 *   - indeterminate: pass `indeterminate` for an op the server runs in one
 *     awaited shot (overview regenerate / Spec Kit commands), where there is no
 *     intermediate percentage to report before the result returns — an animated
 *     bar communicates "working" without a misleading fake percentage.
 *
 * Markup mirrors the accessible `ScanProgress` bar from #422
 * (`role="progressbar"` + aria-valuemin/max, aria-valuenow only when known).
 */
export interface JobProgressProps {
  /** 0-100 completion from the bus; omit/undefined renders an empty/indeterminate bar. */
  progress?: number | null;
  /** Human step/phase text (e.g. "Re-embedded 40/120 chunks"). */
  message?: string | null;
  /** Animated bar with no `aria-valuenow` for awaited, one-shot ops. */
  indeterminate?: boolean;
  /** Accessible label for the progressbar. */
  label?: string;
  /** Test id root; children get `-message` / `-pct` / `-bar` suffixes. */
  testId?: string;
}

export function JobProgress({
  progress,
  message,
  indeterminate = false,
  label = "Progress",
  testId = "job-progress",
}: JobProgressProps): React.ReactElement {
  const pct =
    typeof progress === "number" ? Math.min(100, Math.max(0, Math.round(progress))) : undefined;
  const showValue = !indeterminate && typeof pct === "number";

  return (
    <div className="space-y-1" data-testid={testId}>
      {message ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span data-testid={`${testId}-message`}>{message}</span>
          {showValue ? <span data-testid={`${testId}-pct`}>{pct}%</span> : null}
        </div>
      ) : null}
      <div
        className="h-1.5 w-full overflow-hidden rounded bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(showValue ? { "aria-valuenow": pct } : {})}
      >
        <div
          className={
            indeterminate
              ? "h-full w-1/3 animate-pulse rounded bg-blue-500"
              : "h-full rounded bg-blue-500 transition-all"
          }
          style={indeterminate ? undefined : { width: `${pct ?? 0}%` }}
          data-testid={`${testId}-bar`}
        />
      </div>
    </div>
  );
}
