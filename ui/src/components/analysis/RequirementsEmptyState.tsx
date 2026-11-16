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
 *
 * Issue #2596 — the tab named a count and nothing else: "18 requirement(s)
 * awaiting approval", with the list on the Checkpoints tab and "Run impact
 * analysis" disabled until all 18 were approved there. Given the run's
 * approvals (`checkpoint`), it lists the pending requirements by title and
 * offers the Checkpoints tab's own Approve all.
 */
import {
  readEnhancementMetadata,
  type ApprovalRequestPayload,
  type TicketStatus,
} from "@/lib/analysis-api";
import {
  ApproveAllPending,
  approvalItemName,
  describeRestrictedPending,
  useHeldIfApproved,
} from "./ApprovalsPanel";
import { NFR_CATEGORY_LABEL } from "./RequirementKind";

/** #2596 — what the Requirements tab needs to list the pending requirements and approve them. */
export interface PendingCheckpoint {
  projectId: string;
  analysisId: string;
  /** The run's approvals, as the Checkpoints tab reads them. */
  approvals: readonly ApprovalRequestPayload[];
  /** A viewer without requirement.approve approves as drafts. */
  approvesAsDraft: boolean;
  viewerId?: string;
}

export function RequirementsEmptyState({
  metadata,
  ticketStatus,
  checkpoint,
}: {
  metadata: Record<string, unknown> | null | undefined;
  /** #723 — the live approval gate, when known; it outranks the recorded counts. */
  ticketStatus?: TicketStatus | null;
  /** #2596 — the run's approvals; omitted, the tab names only the count. */
  checkpoint?: PendingCheckpoint;
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
            Go to checkpoints
          </a>
        </p>
      </div>
    );
  }

  const notice = (
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
          Go to checkpoints
        </a>
      </p>
    </div>
  );
  const pendingRequirements = (checkpoint?.approvals ?? []).filter(
    (a) => a.status === "pending" && a.type === "requirement",
  );
  if (!checkpoint || pendingRequirements.length === 0) return notice;
  return (
    <div className="space-y-3">
      {notice}
      <PendingRequirements
        checkpoint={checkpoint}
        metadata={metadata}
        requirements={pendingRequirements}
      />
    </div>
  );
}

/**
 * #2596 — the pending requirements by title, with Approve all. Each is decided
 * one by one (or edited) on the Checkpoints tab; Approve all here is that
 * tab's, so it approves every pending approval, not only these.
 */
function PendingRequirements({
  checkpoint,
  metadata,
  requirements,
}: {
  checkpoint: PendingCheckpoint;
  metadata: Record<string, unknown> | null | undefined;
  requirements: readonly ApprovalRequestPayload[];
}): React.ReactElement {
  const { projectId, analysisId, approvals, approvesAsDraft, viewerId } = checkpoint;
  const heldIfApproved = useHeldIfApproved({ projectId, metadata, viewerId, approvesAsDraft });
  const byId = new Map(
    (readEnhancementMetadata(metadata).structuredRequirements?.requirements ?? []).map((r) => [
      r.id,
      r,
    ]),
  );
  const pending = approvals.filter((a) => a.status === "pending");
  const restricted = pending.filter((a) => a.restricted).length;
  return (
    <section
      aria-labelledby="requirements-pending-heading"
      data-testid="requirements-pending"
      className="space-y-2 rounded border border-border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 id="requirements-pending-heading" className="text-sm font-medium">
          Awaiting approval ({requirements.length})
        </h5>
        {restricted > 0 ? (
          <p
            data-testid="requirements-approve-all-restricted"
            className="text-xs text-muted-foreground"
          >
            {describeRestrictedPending(restricted)}
          </p>
        ) : (
          <ApproveAllPending
            projectId={projectId}
            analysisId={analysisId}
            pendingCount={pending.length}
            approvesAsDraft={approvesAsDraft}
            // An edit is opened on the Checkpoints tab, never here.
            openEdits={0}
            heldCount={pending.filter(heldIfApproved).length}
            onChange={() => undefined}
          />
        )}
      </div>
      <ul className="space-y-1">
        {requirements.map((approval, i) => {
          const requirement = byId.get(approval.itemId);
          return (
            <li key={approval.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-foreground">
                {approvalItemName(approval, i + 1, requirement)}
              </span>
              {requirement?.elicitedNfr && (
                <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                  Found by the analysis · Non-functional ·{" "}
                  {NFR_CATEGORY_LABEL[requirement.elicitedNfr.nfrCategory] ??
                    requirement.elicitedNfr.nfrCategory}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        Approving saves them here and makes the impact analysis available. To edit or reject one,
        review it on{" "}
        <a href="#approvals" className="font-medium underline">
          the Checkpoints tab
        </a>
        .
      </p>
    </section>
  );
}
