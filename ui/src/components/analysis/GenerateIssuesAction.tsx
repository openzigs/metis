"use client";

/**
 * Issue #362 — the Analysis page's "Generate GitHub Issues" action.
 *
 * Draft generation reads an analysis's persisted requirements, and the approval
 * gate (#1104) withholds those until every approval checkpoint is resolved. The
 * link used to appear as soon as a completed run had findings, so a gated run
 * led straight into a Publish error. It is now a link only when requirements
 * exist; otherwise it is disabled and says why.
 */
import type { TicketStatus } from "@/lib/analysis-api";
import { PromoteApprovedRequirementsButton } from "./PromoteApprovedRequirementsButton";

export interface GenerateIssuesActionProps {
  projectId: string;
  analysisId: string;
  status: string;
  requirementCount: number;
  hasFindings: boolean;
  /** The approval gate for this run; absent while loading or unavailable. */
  ticketStatus?: TicketStatus | null;
  /**
   * Where the approvals query stands. Until it is `ready` the gate is unknown,
   * so the button must not claim "No requirements" — the very confusion #362
   * removes (PR #404 review).
   */
  approvalsState?: "loading" | "error" | "ready";
  /**
   * #723 — how many `requirement` approvals are APPROVED. With the gate open
   * and no requirement rows, these were never promoted (a run stranded before
   * rejections counted as resolved), so the action offers to promote them
   * instead of claiming there is nothing to generate from.
   */
  approvedRequirementCount?: number;
}

const LABEL = "Generate GitHub Issues";

function GitHubMark(): React.ReactElement {
  return (
    <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
    </svg>
  );
}

export function GenerateIssuesAction({
  projectId,
  analysisId,
  status,
  requirementCount,
  hasFindings,
  ticketStatus,
  approvalsState = "ready",
  approvedRequirementCount = 0,
}: GenerateIssuesActionProps): React.ReactElement | null {
  if (status !== "completed") return null;

  if (requirementCount > 0) {
    return (
      <a
        href={`/projects/${projectId}/publish?analysisId=${analysisId}`}
        className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-foreground/40 hover:bg-accent/60"
      >
        <GitHubMark />
        {LABEL}
      </a>
    );
  }

  const gated = ticketStatus != null && !ticketStatus.allowed;
  const gateUnknown = approvalsState !== "ready";
  const stranded = !gated && !gateUnknown && approvedRequirementCount > 0;
  if (!gated && !gateUnknown && !stranded && !hasFindings) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled
        aria-describedby="generate-issues-reason"
        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded border border-border bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground"
      >
        <GitHubMark />
        {LABEL}
      </button>
      <span
        id="generate-issues-reason"
        data-testid="generate-issues-reason"
        className="text-xs text-muted-foreground"
      >
        {gateUnknown ? (
          approvalsState === "error" ? (
            <>
              Couldn&apos;t check the approval gate for this run.{" "}
              <a href="#approvals" className="font-medium underline">
                Go to approvals
              </a>
            </>
          ) : (
            "Checking approvals…"
          )
        ) : gated ? (
          <>
            {ticketStatus.pendingCount > 0
              ? `${ticketStatus.pendingCount} pending approval(s) must be resolved before requirements exist.`
              : "Approvals must be resolved before requirements exist."}{" "}
            <a href="#approvals" className="font-medium underline">
              Go to approvals
            </a>
          </>
        ) : stranded ? (
          `${approvedRequirementCount} approved requirement(s) have not been promoted yet.`
        ) : (
          "No requirements to generate issues from."
        )}
      </span>
      {stranded && (
        <PromoteApprovedRequirementsButton projectId={projectId} analysisId={analysisId} />
      )}
    </span>
  );
}
