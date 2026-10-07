"use client";

/**
 * Issue #1104 (finding B) — the empty REQUIREMENTS list, told honestly.
 *
 * A run that synthesized 14 requirements and had every one of them withheld by
 * the approval gate used to render the same "No requirements yet." as a run
 * that genuinely produced nothing. That single line is what made a gated run
 * indistinguishable from a lost one. When the analysis metadata records a
 * blocked promotion, say what exists, what is blocking it, and where to go.
 *
 * Issue #723 — only PENDING approvals hold the gate; a rejection is resolved.
 * Once the gate is open (the live `ticketStatus`, or a record written before
 * rejections counted as resolved, with no pending approval) nothing is left to
 * review: point at the Promote action instead of at outstanding approvals.
 */
import { readEnhancementMetadata, type TicketStatus } from "@/lib/analysis-api";

export function RequirementsEmptyState({
  metadata,
  ticketStatus,
}: {
  metadata: Record<string, unknown> | null | undefined;
  /** #723 — the live approval gate, when known; it outranks the recorded counts. */
  ticketStatus?: TicketStatus | null;
}): React.ReactElement {
  const blocked = readEnhancementMetadata(metadata).promotionBlocked;

  if (!blocked?.blocked) {
    return <p className="text-sm text-muted-foreground">No requirements yet.</p>;
  }

  const awaiting = blocked.awaitingRequirementCount ?? 0;
  const pendingCount = ticketStatus ? ticketStatus.pendingCount : blocked.pendingCount;
  const gateOpen = ticketStatus ? ticketStatus.allowed : blocked.pendingCount === 0;

  if (gateOpen) {
    return (
      <div
        role="alert"
        data-testid="requirements-gated"
        className="space-y-1 rounded border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning"
      >
        <p>
          <span aria-hidden>⚠</span>{" "}
          {awaiting > 0
            ? `All approvals are resolved, but the ${awaiting} requirement(s) have not been promoted yet.`
            : "All approvals are resolved, but the requirements have not been promoted yet."}
        </p>
        <p className="text-xs text-warning">
          Promote the approved requirements from the approvals section.{" "}
          <a href="#approvals" className="font-medium underline">
            Go to approvals
          </a>
        </p>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="requirements-gated"
      className="space-y-1 rounded border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning"
    >
      <p>
        <span aria-hidden>⚠</span>{" "}
        {awaiting > 0
          ? `${awaiting} requirement(s) awaiting approval — they were generated but are not saved yet.`
          : "Requirements are awaiting approval before they are saved."}
      </p>
      <p className="text-xs text-warning">
        {pendingCount > 0
          ? `${pendingCount} pending approval(s) must be resolved.`
          : "Resolve the pending approvals to release them."}{" "}
        <a href="#approvals" className="font-medium underline">
          Go to approvals
        </a>
      </p>
    </div>
  );
}
