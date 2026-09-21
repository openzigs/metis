"use client";

/**
 * Global active-jobs indicator — Epic #406 (#420).
 *
 * A compact header button that shows "N jobs running" and opens a drawer listing
 * every currently-active long-running job (kind, project, live progress). It is
 * driven entirely by the unified job-events bus via {@link useActiveJobs}, so it
 * reflects ANY `JobKind` (analysis, doc-gen, scan, pr-review, …), not just
 * doc-generation — the single chokepoint Epic #406 mandates.
 *
 * Behaviour required by #420:
 *   - Hidden entirely when nothing is running (renders `null`).
 *   - Accessible: the live region carries `role="status"` + `aria-live="polite"`
 *     so screen readers announce when jobs start/finish.
 *   - Clears automatically when all jobs reach a terminal state (the store drops
 *     terminal jobs, so the count falls to 0 and the indicator unmounts).
 *
 * Composed into the header alongside the #415 connection-status indicator and the
 * #416 notifications bell without colliding in the layout (see header.tsx).
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useActiveJobs, jobKindLabel, type ActiveJob } from "@/hooks/use-active-jobs";
import { useGlobalJobToasts } from "@/hooks/use-global-job-toasts";

/** A single active-job row in the drawer. */
function ActiveJobRow({ job }: { job: ActiveJob }): React.ReactElement {
  const hasProgress = typeof job.progress === "number";
  return (
    <li
      className="rounded border border-border bg-muted/30 p-2 text-sm"
      data-testid={`active-job-${job.jobId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <strong className="text-xs uppercase tracking-wide">{jobKindLabel(job.kind)}</strong>
        {hasProgress ? (
          <span className="text-xs font-medium text-muted-foreground">
            {Math.round(job.progress!)}%
          </span>
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      {job.projectId ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">Project: {job.projectId}</p>
      ) : null}
      {job.message ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{job.message}</p>
      ) : null}
      {hasProgress ? (
        <Progress
          value={job.progress}
          className="mt-2 h-1.5"
          aria-label={`${jobKindLabel(job.kind)} progress`}
        />
      ) : null}
    </li>
  );
}

/**
 * The header indicator. Returns `null` (occupies no header space) when there are
 * no active jobs, so it never collides with the connection-status / notifications
 * controls when idle.
 */
export function ActiveJobsIndicator(): React.ReactElement | null {
  const jobs = useActiveJobs();
  // #425 — co-locate the global terminal-toast consumer with the global
  // active-jobs aggregator (both attach one `job:lifecycle` listener high in the
  // tree). This fires the canonical, deduped success/error toast for EVERY op —
  // closing the silent-failure gap for list-view watchers — even when the
  // indicator itself renders null because nothing is currently running.
  useGlobalJobToasts();
  const [open, setOpen] = useState(false);

  // Hide entirely when nothing is running. Closing the drawer too keeps state
  // tidy for the next burst of jobs.
  if (jobs.length === 0) {
    return null;
  }

  const count = jobs.length;
  const label = `${count} job${count === 1 ? "" : "s"} running`;

  return (
    <div role="status" aria-live="polite" data-testid="active-jobs-indicator">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
        aria-label={`${label}. Open active jobs.`}
        data-testid="active-jobs-button"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span className="text-xs font-medium" data-testid="active-jobs-count">
          {label}
        </span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-96 flex-col gap-3 p-4"
          data-testid="active-jobs-drawer"
        >
          <SheetTitle>Active jobs</SheetTitle>
          <SheetDescription>Long-running operations currently in progress.</SheetDescription>
          <ul className="flex-1 space-y-2 overflow-y-auto" data-testid="active-jobs-list">
            {jobs.map((job) => (
              <ActiveJobRow key={job.jobId} job={job} />
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </div>
  );
}
