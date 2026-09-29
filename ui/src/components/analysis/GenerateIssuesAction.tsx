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

export interface GenerateIssuesActionProps {
  projectId: string;
  analysisId: string;
  status: string;
  requirementCount: number;
  hasFindings: boolean;
  /** The approval gate for this run; absent while loading or unavailable. */
  ticketStatus?: TicketStatus | null;
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
  if (!gated && !hasFindings) return null;

  const outstanding: string[] = [];
  if (gated && ticketStatus.pendingCount > 0)
    outstanding.push(`${ticketStatus.pendingCount} pending`);
  if (gated && ticketStatus.rejectedCount > 0)
    outstanding.push(`${ticketStatus.rejectedCount} rejected`);

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
        {gated ? (
          <>
            {outstanding.length > 0
              ? `${outstanding.join(", ")} approval(s) must be resolved before requirements exist.`
              : "Approvals must be resolved before requirements exist."}{" "}
            <a href="#approvals" className="font-medium underline">
              Go to approvals
            </a>
          </>
        ) : (
          "No requirements to generate issues from."
        )}
      </span>
    </span>
  );
}
