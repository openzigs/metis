"use client";

/**
 * Issue #723 — recover a run whose approval gate is open but which has no
 * requirement rows. Promotion used to run only when a review was recorded, so
 * a run stranded before rejections counted as resolved (32 approved, 1
 * rejected, 0 rows) had no review left to make and no way forward from the
 * Analysis page. This calls the same idempotent promotion the review route
 * does (`POST .../approvals/promote`), then refreshes the run.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { analysisApi, type PromotionOutcome } from "@/lib/analysis-api";
import { ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";

/** #723 — approved `requirement` approvals; the set promotion would create. */
export function countApprovedRequirements(
  items: ReadonlyArray<{ type: string; status: string }>,
): number {
  return items.filter((a) => a.type === "requirement" && a.status === "approved").length;
}

/** What a non-promoting outcome means to the reviewer; null when it promoted. */
export function describePromotionOutcome(outcome: PromotionOutcome): string | null {
  switch (outcome.status) {
    case "promoted":
      return null;
    case "already-promoted":
      return "These requirements were already promoted; any deleted since are not restored. Refresh to see the current set.";
    case "blocked":
    case "unavailable":
      return outcome.reason;
  }
}

export function PromoteApprovedRequirementsButton({
  projectId,
  analysisId,
}: {
  projectId: string;
  analysisId: string;
}): React.ReactElement {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => analysisApi.promoteApprovedRequirements(projectId, analysisId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approvals", analysisId] });
      qc.invalidateQueries({ queryKey: queryKeys.analyses.detail(analysisId) });
    },
  });
  const outcomeNote = mutation.data ? describePromotionOutcome(mutation.data.promotion) : null;
  const errorNote = mutation.isError
    ? mutation.error instanceof ApiError
      ? mutation.error.message
      : "Could not promote the requirements. Try again."
    : null;
  const promoted = mutation.data?.promotion.status === "promoted";

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending || promoted}
      >
        {mutation.isPending ? "Promoting…" : "Promote approved requirements"}
      </Button>
      {(outcomeNote ?? errorNote) && (
        <span role="alert" className="text-xs text-destructive">
          {outcomeNote ?? errorNote}
        </span>
      )}
    </span>
  );
}
