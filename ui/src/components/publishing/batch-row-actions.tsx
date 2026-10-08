"use client";

/**
 * Per-batch row actions — #1104 (F).
 *
 * A batch stranded in `pending` (the reported one predates the #1092 fix)
 * rendered as permanently in-progress with "Watch" as its only affordance:
 * nothing to cancel, archive or dismiss, and the row never cleared.
 *
 * "Cancel" settles the local record. It deliberately does NOT close or delete
 * anything already created on GitHub — that is `archive` with `closeIssues`.
 * Because of that, offering it while a run may still be writing would be
 * actively harmful (a row marked cancelled whose `publishedCount` keeps
 * climbing), so eligibility comes from the shared `publishBatchCancelState`
 * verdict — the very same function the API enforces. A batch inside the
 * in-flight window shows the button disabled *with the reason*, rather than
 * hiding it, so the absence of the remedy is explained instead of mysterious.
 *
 * #863 — "Archive" is offered on a SETTLED batch (the API's archive existed but
 * nothing in the UI reached it). It is never offered while a batch may still be
 * running: that is what Cancel is for.
 */
import { publishBatchCancelState, type PublishBatch } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { touchTargetClass } from "@/components/tables/responsive-table";

export type BatchRowActionsBatch = Pick<PublishBatch, "id" | "status" | "archived" | "startedAt">;

export interface BatchRowActionsProps {
  batch: BatchRowActionsBatch;
  onWatch: (id: string) => void;
  onCancel: (id: string) => void;
  /** #863 — archive a settled batch. Omitted ⇒ no Archive button. */
  onArchive?: (id: string) => void;
  /** True while a cancel request for THIS batch is in flight. */
  cancelPending?: boolean;
  /** Injectable clock for tests. */
  now?: number;
}

/** The hint shown when cancel is offered but not yet permitted. */
export function cancelDisabledHint(waitMs: number): string {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return `This batch may still be running. Cancel becomes available ${minutes} minute${
    minutes === 1 ? "" : "s"
  } from now; it settles the local record only and cannot recall issues already created on GitHub.`;
}

export function BatchRowActions({
  batch,
  onWatch,
  onCancel,
  onArchive,
  cancelPending = false,
  now,
}: BatchRowActionsProps) {
  const state = publishBatchCancelState(batch, now ?? Date.now());
  const showCancel = state.reason !== "not_in_progress";
  const showArchive = Boolean(onArchive) && !showCancel && !batch.archived;

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        className={touchTargetClass}
        onClick={() => onWatch(batch.id)}
      >
        Watch
      </Button>
      {showCancel && (
        <Button
          size="sm"
          variant="ghost"
          className={touchTargetClass}
          data-testid={`cancel-batch-${batch.id}`}
          disabled={!state.cancellable || cancelPending}
          title={state.cancellable ? undefined : cancelDisabledHint(state.waitMs)}
          onClick={() => onCancel(batch.id)}
        >
          {cancelPending ? "Cancelling…" : "Cancel"}
        </Button>
      )}
      {showArchive && (
        <Button
          size="sm"
          variant="ghost"
          className={touchTargetClass}
          data-testid={`archive-batch-${batch.id}`}
          onClick={() => onArchive?.(batch.id)}
        >
          Archive
        </Button>
      )}
    </div>
  );
}
