/**
 * Issue #1389 — one analysis-level notice for every approved requirement a
 * re-synthesis suggested different acceptance criteria for, instead of a
 * notice on each card. "Review" filters the list to those requirements (each
 * then shows its own Accept / Dismiss); "Keep approved criteria for all"
 * dismisses every suggestion in one request.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { useAppMutation } from "@/lib/use-app-mutation";
import { analysisApi } from "@/lib/analysis-api";
import type { QueryKey } from "@tanstack/react-query";
import { HoverHint } from "@/components/spec-kit/hover-hint";

export interface CriteriaProposalsSummaryProps {
  projectId: string;
  analysisId: string;
  /** How many approved requirements have a pending suggestion. */
  count: number;
  /** Whether the list is filtered to them. */
  reviewing: boolean;
  onReviewChange: (reviewing: boolean) => void;
  invalidateKeys?: QueryKey[];
  /**
   * #1587 — why the viewer cannot make this write (they lack `project.update`,
   * which the server requires). Set: the write controls are disabled and carry
   * this hint. Omitted: they are enabled.
   */
  writeHint?: string;
}

export function CriteriaProposalsSummary({
  projectId,
  analysisId,
  count,
  reviewing,
  onReviewChange,
  invalidateKeys = [],
  writeHint,
}: CriteriaProposalsSummaryProps): React.ReactElement | null {
  const keepAll = useAppMutation({
    mutationFn: () => analysisApi.dismissAllCriteriaProposals(projectId, analysisId),
    successMessage: (d) =>
      `Kept the approved acceptance criteria for ${d.dismissedCount} requirement${
        d.dismissedCount === 1 ? "" : "s"
      }`,
    invalidateKeys,
    onSuccess: () => onReviewChange(false),
  });

  if (count === 0) return null;
  const noun = count === 1 ? "requirement" : "requirements";

  return (
    <div
      className="rounded border border-info/40 bg-info-muted p-2 text-xs"
      data-testid="criteria-proposals-summary"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className="font-medium text-info">
          Re-synthesis suggested different acceptance criteria for {count} approved {noun}
        </span>
        <span className="text-muted-foreground">They keep the criteria you approved.</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={reviewing ? "default" : "outline"}
          aria-pressed={reviewing}
          onClick={() => onReviewChange(!reviewing)}
        >
          {reviewing ? "Show all requirements" : "Review"}
        </Button>
        <HoverHint hint={writeHint}>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(writeHint) || keepAll.isPending}
            onClick={() => keepAll.mutate()}
          >
            Keep approved criteria for all
          </Button>
        </HoverHint>
      </div>
    </div>
  );
}
