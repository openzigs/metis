"use client";

/**
 * #1833 (epic #1827) — whether each saved code link still points at the code
 * it was read from, in words an analyst can act on.
 *
 * When METIS re-reads a repository it re-checks every saved link (#1831): a
 * link to code that moved is updated (`moved`, with where it was), and one to
 * code that changed or went is flagged (`stale`, with why). This shows that on
 * the requirement card's direct code links:
 *
 *   - each link's state as TEXT (a badge reading "Up to date", "Moved" or
 *     "Out of date"), never colour alone, and for a stale one the reason;
 *   - a summary, "2 of 6 code links may be out of date: the code changed since
 *     commit abc1234", counted from the links on screen;
 *   - "Re-run code evaluation" for someone who may run analyses. There is no
 *     per-requirement re-run, so it re-runs the code analysis of the whole
 *     analysis this requirement came from (the agent card's Regenerate) and
 *     says so, with the existing cost estimate shown before anything starts.
 *
 * A link never checked (`unverified`: saved before #1830, or not yet
 * re-checked) shows no state: "not checked" on every older link would be noise.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CodeCitationFreshness,
  CodeCitationStaleReason,
  TraceabilityCodeNode,
} from "@metis/shared";
import { apiFetch } from "@/lib/api-client";
import { analysisApi } from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";
import { useAppMutation } from "@/lib/use-app-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** The text each checked state reads as. `unverified` shows nothing. */
export const FRESHNESS_LABEL: Partial<Record<CodeCitationFreshness, string>> = {
  fresh: "Up to date",
  moved: "Moved",
  stale: "Out of date",
};

/** Why a link is out of date, in an analyst's words. */
export const STALE_REASON_TEXT: Record<CodeCitationStaleReason, string> = {
  "file-missing": "The file it pointed to was removed or renamed.",
  "symbol-missing": "The function it pointed to can no longer be found.",
  "content-changed": "The code it pointed to has changed.",
};

const isStale = (c: TraceabilityCodeNode) => c.freshness === "stale";

/** `path:start-end`, `path:line` or `path`. */
function location(
  filePath: string,
  start: number | null | undefined,
  end: number | null | undefined,
) {
  if (start == null) return filePath;
  return end != null && end !== start ? `${filePath}:${start}-${end}` : `${filePath}:${start}`;
}

/** A code link's checked state, as a badge that reads as text. */
export function FreshnessBadge({
  link,
}: {
  link: TraceabilityCodeNode;
}): React.ReactElement | null {
  const label = link.freshness ? FRESHNESS_LABEL[link.freshness] : undefined;
  if (!label) return null;
  return (
    <Badge
      variant={link.freshness === "stale" ? "destructive" : "outline"}
      data-testid="code-link-freshness"
      data-freshness={link.freshness}
    >
      {label}
    </Badge>
  );
}

/** The line under a moved or stale link: where it came from, or why it is out of date. */
export function FreshnessNote({ link }: { link: TraceabilityCodeNode }): React.ReactElement | null {
  if (link.freshness === "moved" && link.previousFilePath) {
    return (
      <p data-testid="code-link-moved-from" className="pl-4 text-xs text-muted-foreground">
        Moved from{" "}
        <code className="font-mono">
          {location(link.previousFilePath, link.previousStartLine, link.previousEndLine)}
        </code>
      </p>
    );
  }
  if (link.freshness === "stale") {
    return (
      <p data-testid="code-link-stale-reason" className="pl-4 text-xs text-muted-foreground">
        {link.staleReason
          ? STALE_REASON_TEXT[link.staleReason]
          : "The code it pointed to may have changed."}
      </p>
    );
  }
  return null;
}

/** "since commit abc1234" for one commit, else a phrase that names none. */
function sinceWhen(stale: TraceabilityCodeNode[]): string {
  const commits = [...new Set(stale.map((c) => c.commitSha).filter((s): s is string => !!s))];
  if (commits.length === 1 && stale.every((c) => c.commitSha)) {
    return `since commit ${commits[0].slice(0, 7)}`;
  }
  return "since they were saved";
}

interface RunEstimate {
  selection: { estimatedCost: number | null };
  estimate: { tokens: number | null; sampleSize: number };
}

/** The existing pre-run estimate (#1095), for a code-only run. */
function fetchCodeRunEstimate(projectId: string): Promise<RunEstimate> {
  return apiFetch<RunEstimate>(`/projects/${projectId}/analyses/model-recommendation`, {
    method: "POST",
    body: { override: "auto", agentKeys: ["code"], requirementText: "" },
  });
}

function estimateText(data: RunEstimate | undefined, loading: boolean): string {
  if (loading || !data) return "Estimating the cost…";
  const { estimatedCost } = data.selection;
  const { tokens, sampleSize } = data.estimate;
  if (tokens == null || estimatedCost == null) {
    return "No cost estimate yet: this project has no completed analysis to size it from.";
  }
  const runs = sampleSize === 1 ? "1 previous run" : `${sampleSize} previous runs`;
  return `Estimated cost: about $${estimatedCost.toFixed(2)} (${tokens.toLocaleString()} tokens, from ${runs}).`;
}

function RerunEvaluation({
  projectId,
  analysisId,
}: {
  projectId: string;
  analysisId: string;
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  const estimate = useQuery({
    queryKey: ["code-rerun-estimate", projectId],
    queryFn: () => fetchCodeRunEstimate(projectId),
    enabled: confirming,
    staleTime: 30_000,
  });
  const rerun = useAppMutation({
    mutationFn: () => analysisApi.regenerateAgent(analysisId, "code"),
    successMessage: "Code evaluation re-run started",
    invalidateKeys: [queryKeys.analyses.detail(analysisId)],
    onSuccess: () => setConfirming(false),
  });

  if (!confirming) {
    return (
      <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
        Re-run code evaluation
      </Button>
    );
  }
  return (
    <div data-testid="code-link-rerun-confirm" className="space-y-2 rounded-md border p-2 text-xs">
      <p>
        This re-runs the code analysis for the whole analysis this requirement came from, not only
        this requirement: METIS has no single-requirement re-run.
      </p>
      <p role="status" data-testid="code-link-rerun-estimate">
        {estimateText(estimate.data, estimate.isLoading)}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => rerun.mutate()}
          disabled={rerun.isPending || estimate.isLoading}
        >
          Start re-run
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export interface StaleCodeLinksSummaryProps {
  /** The links on screen: the count is read from these, never passed in. */
  links: TraceabilityCodeNode[];
  projectId: string;
  /** The analysis the requirement came from; no re-run is offered without one. */
  analysisId?: string | null;
  /** The viewer may run analyses (`analysis.run`, what the re-run requires). */
  canRerun?: boolean;
}

/** "N of M code links may be out of date …", and the re-run, when any link is stale. */
export function StaleCodeLinksSummary({
  links,
  projectId,
  analysisId,
  canRerun = false,
}: StaleCodeLinksSummaryProps): React.ReactElement | null {
  const stale = links.filter(isStale);
  if (stale.length === 0) return null;
  const counted = `${stale.length} of ${links.length} code link${links.length === 1 ? "" : "s"}`;
  return (
    <div data-testid="code-links-stale-summary" className="space-y-2 rounded-md border p-2">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge
          variant="destructive"
          aria-label={`${counted} may be out of date`}
          data-testid="code-links-stale-count"
        >
          {stale.length} out of date
        </Badge>
        <span>
          {counted} may be out of date: the code changed {sinceWhen(stale)}.
        </span>
      </p>
      {canRerun && analysisId ? (
        <RerunEvaluation projectId={projectId} analysisId={analysisId} />
      ) : null}
    </div>
  );
}
