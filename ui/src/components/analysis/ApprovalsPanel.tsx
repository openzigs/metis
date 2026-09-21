"use client";

/**
 * Approvals Panel (Epic #202 / Issue #217).
 *
 * Surfaces human-in-the-loop approval checkpoints for an analysis. Lists every
 * approval request (pending + resolved) with its type and item, lets an
 * authorized reviewer approve/reject with an optional review note, and shows a
 * clear "promotion blocked" banner derived from the server's `ticketStatus`
 * (Epic #202 #216) so the user always knows why artifacts have not promoted.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PromotionBlockedEvent } from "@metis/shared";
import {
  analysisApi,
  readEnhancementMetadata,
  type ApprovalRequestPayload,
  type StructuredRequirement,
  type TicketStatus,
} from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";
import { useSocket } from "@/lib/socket-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

interface ApprovalsPanelProps {
  projectId: string;
  analysisId: string;
  /**
   * Analysis `metadata` blob (Epic #922) — used to enrich `requirement`
   * approvals with the matching structured requirement's title + ambiguities
   * instead of rendering a bare UUID.
   */
  metadata?: Record<string, unknown> | null;
}

/**
 * #256 — subscribe to the distinct `analysis:promotion-blocked` socket event so
 * the panel reacts to a blocked promotion directly from the stream instead of
 * inferring it from polled metadata. Returns the latest blocked event (if any)
 * for the current analysis and refetches the approvals query on each event so
 * the counts/banner stay live without waiting for the poll interval.
 */
function usePromotionBlockedEvent(
  analysisId: string,
  onBlocked: () => void,
): PromotionBlockedEvent | null {
  const socket = useSocket();
  const [blocked, setBlocked] = useState<PromotionBlockedEvent | null>(null);

  useEffect(() => {
    if (!socket || !analysisId) return;
    socket.emit("subscribe:analysis", { analysisId });
    const handler = (event: PromotionBlockedEvent): void => {
      if (event.analysisId !== analysisId) return;
      setBlocked(event);
      onBlocked();
    };
    // The browser socket is loosely typed — same escape hatch the other
    // analysis/job-event consumers use.
    socket.on("analysis:promotion-blocked" as never, handler as never);
    return () => {
      socket.off("analysis:promotion-blocked" as never, handler as never);
      socket.emit("unsubscribe:analysis", { analysisId });
    };
  }, [socket, analysisId, onBlocked]);

  return blocked;
}

const TYPE_LABELS: Record<string, string> = {
  evidence: "Evidence",
  clarification: "Clarification",
  requirement: "Requirement",
};

/**
 * Issue #1117 (finding E) — the banner read "16 requirement(s) awaiting
 * approval — 31 pending approval(s) must be resolved." Both numbers were
 * correct and they count different things, but nothing on screen said which was
 * which, so the natural reading is that one of them is a bug.
 *
 * They differ because an approval request is raised per REVIEWABLE ITEM — the
 * run's evidence and clarifications as well as its requirements — while the
 * first number counts only the synthesized requirements the gate is withholding.
 * Naming the pending items by type is what makes the arithmetic legible.
 */
export function summarisePendingByType(pending: ReadonlyArray<{ type: string }>): string | null {
  const counts = new Map<string, number>();
  for (const item of pending) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  if (counts.size === 0) return null;
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${(TYPE_LABELS[type] ?? type).toLowerCase()}`);
  return parts.join(", ");
}

function PromotionBanner({
  status,
  awaitingRequirementCount,
  pendingByType,
}: {
  status: TicketStatus;
  /** #1104 — how many synthesized requirements the gate is holding back. */
  awaitingRequirementCount?: number;
  /** #1117 (finding E) — breakdown of the pending approvals, e.g. "16 requirement, 11 evidence". */
  pendingByType?: string | null;
}): React.ReactElement | null {
  if (status.allowed) {
    return (
      <div
        role="status"
        data-testid="promotion-banner"
        className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
      >
        All approvals resolved — artifact promotion is unblocked.
      </div>
    );
  }
  const parts: string[] = [];
  if (status.pendingCount > 0) parts.push(`${status.pendingCount} pending`);
  if (status.rejectedCount > 0) parts.push(`${status.rejectedCount} rejected`);
  return (
    <div
      role="alert"
      data-testid="promotion-banner"
      className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
    >
      {/* #1104 — name what is being withheld. "Promotion blocked" alone never
          told the user that 14 finished requirements were sitting behind it. */}
      {awaitingRequirementCount
        ? `${awaitingRequirementCount} requirement(s) awaiting approval — `
        : "Promotion blocked — "}
      {parts.join(", ")} approval(s) must be resolved before specs are promoted.
      {/* #1117 (finding E) — reconcile the two counts explicitly. */}
      {pendingByType && (
        <span className="mt-1 block text-xs text-amber-200/80" data-testid="pending-by-type">
          The counts differ because one approval is raised per reviewable item, not per requirement.
          Pending: {pendingByType}.
        </span>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  requirement,
  projectId,
  analysisId,
  onChange,
}: {
  approval: ApprovalRequestPayload;
  /** #922 — matched structured requirement for `requirement` approvals. */
  requirement?: StructuredRequirement;
  projectId: string;
  analysisId: string;
  onChange: () => void;
}): React.ReactElement {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const isResolved = approval.status !== "pending";

  const reviewMutation = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      analysisApi.reviewApproval(projectId, analysisId, approval.id, {
        status: decision,
        reviewNote: note.trim() ? note.trim() : undefined,
      }),
    onSuccess: () => {
      onChange();
      qc.invalidateQueries({ queryKey: ["approvals", analysisId] });
      // Issue #1135 — resolving the last approval promotes the requirements, and
      // the server applies the clarification answers to the freshly created rows
      // in the same request (routes/analysis.ts → promoteApprovedRequirements →
      // applyClarificationsToRequirements). That rewrites the analysis metadata,
      // so without this the impact note kept reading "could not be matched to a
      // saved requirement" until the user reloaded the page.
      qc.invalidateQueries({ queryKey: queryKeys.analyses.detail(analysisId) });
    },
  });

  return (
    <Card className="space-y-3 p-4" data-testid={`approval-${approval.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-xs text-zinc-300">
            {TYPE_LABELS[approval.type] ?? approval.type}
          </span>
          {requirement ? (
            <span className="text-sm font-medium text-zinc-200">{requirement.title}</span>
          ) : (
            <span className="font-mono text-xs text-zinc-400">{approval.itemId}</span>
          )}
        </div>
        <span
          className={
            approval.status === "approved"
              ? "text-xs text-emerald-400"
              : approval.status === "rejected"
                ? "text-xs text-red-400"
                : "text-xs text-amber-300"
          }
        >
          {approval.status}
        </span>
      </div>

      {requirement && (
        <div className="space-y-2 rounded border border-zinc-800 bg-zinc-900/40 p-2">
          {requirement.description && (
            <p className="text-xs text-zinc-400">{requirement.description}</p>
          )}
          {requirement.ambiguities.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Open questions ({requirement.ambiguities.length})
              </p>
              <ul className="space-y-1">
                {requirement.ambiguities.map((amb) => (
                  <li key={amb.field} className="text-xs text-amber-300/90">
                    {amb.suggestedQuestion || amb.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!isResolved && (
        <div className="space-y-2">
          <Textarea
            aria-label={`Review note for ${approval.itemId}`}
            placeholder="Optional review note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => reviewMutation.mutate("approved")}
              disabled={reviewMutation.isPending}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => reviewMutation.mutate("rejected")}
              disabled={reviewMutation.isPending}
            >
              Reject
            </Button>
          </div>
        </div>
      )}

      {isResolved && approval.reviewNote && (
        <p className="text-xs text-zinc-500">Note: {approval.reviewNote}</p>
      )}
    </Card>
  );
}

export function ApprovalsPanel({
  projectId,
  analysisId,
  metadata,
}: ApprovalsPanelProps): React.ReactElement | null {
  // #922 — index structured requirements by id so each `requirement` approval
  // can be enriched with its real title + open questions.
  const requirementsById = new Map<string, StructuredRequirement>();
  for (const req of readEnhancementMetadata(metadata).structuredRequirements?.requirements ?? []) {
    requirementsById.set(req.id, req);
  }
  const lookupRequirement = (
    approval: ApprovalRequestPayload,
  ): StructuredRequirement | undefined =>
    approval.type === "requirement" ? requirementsById.get(approval.itemId) : undefined;

  const query = useQuery({
    queryKey: ["approvals", analysisId],
    queryFn: () => analysisApi.listApprovals(projectId, analysisId),
  });

  // #256 — react to the distinct promotion-blocked event directly: refetch the
  // approvals so the banner + counts update immediately when the server gates
  // promotion, rather than inferring it from the next poll of metadata.
  const blockedEvent = usePromotionBlockedEvent(analysisId, () => {
    void query.refetch();
  });

  if (query.isLoading) {
    return (
      <Card className="p-4">
        <p className="text-sm text-zinc-400">Loading approvals…</p>
      </Card>
    );
  }

  // Issue #1104 (finding B) — a failed approvals fetch used to fall through to
  // `items.length === 0` and render NOTHING, which is indistinguishable from
  // "nothing to approve" and leaves a gated analysis with no way through.
  if (query.isError) {
    return (
      <Card id="approvals" className="space-y-2 p-4">
        <p role="alert" data-testid="approvals-error" className="text-sm text-red-400">
          Could not load the approvals for this analysis. Requirements stay withheld until every
          approval is resolved.
        </p>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </Card>
    );
  }

  const items = query.data?.items ?? [];
  const ticketStatus = query.data?.ticketStatus;

  // Nothing to gate on — render nothing so the panel stays out of the way until
  // the pipeline has created approval requests.
  if (items.length === 0) return null;

  const pending = items.filter((a) => a.status === "pending");
  const resolved = items.filter((a) => a.status !== "pending");

  return (
    // #1104 — a stable anchor so the gated REQUIREMENTS notice can link straight
    // to the controls that clear the gate.
    <div id="approvals" className="space-y-4" data-testid="approvals-panel">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Approvals</h3>
        <p className="text-sm text-zinc-400">
          Review and resolve the human-in-the-loop checkpoints below. Specs are not promoted until
          every approval is resolved.
        </p>
      </div>

      {/* #256 — when the socket has pushed a live blocked event, surface its
          reason directly; otherwise fall back to the polled ticketStatus. */}
      {blockedEvent && !ticketStatus?.allowed ? (
        <div
          role="alert"
          data-testid="promotion-blocked-live"
          className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
        >
          {blockedEvent.reason}
        </div>
      ) : (
        ticketStatus && (
          <PromotionBanner
            status={ticketStatus}
            awaitingRequirementCount={
              readEnhancementMetadata(metadata).promotionBlocked?.awaitingRequirementCount
            }
            pendingByType={summarisePendingByType(pending)}
          />
        )
      )}

      {pending.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Pending ({pending.length})
          </p>
          {pending.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requirement={lookupRequirement(approval)}
              projectId={projectId}
              analysisId={analysisId}
              onChange={() => query.refetch()}
            />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Resolved ({resolved.length})
          </p>
          {resolved.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requirement={lookupRequirement(approval)}
              projectId={projectId}
              analysisId={analysisId}
              onChange={() => query.refetch()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
