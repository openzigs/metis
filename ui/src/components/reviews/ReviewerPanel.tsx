/**
 * Epic #609 / Issue #618 — reviewer assignments + recorded decisions.
 */
import type { ReviewerAssignment, ReviewerDecision } from "@/lib/reviews-api";
import { cn } from "@/lib/utils";

const DECISION_CLASSES: Record<ReviewerDecision, string> = {
  pending: "bg-muted text-muted-foreground",
  approved: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400",
};

export function ReviewerPanel({
  assignments,
  currentUserId,
}: {
  assignments: ReviewerAssignment[];
  currentUserId: string | null;
}) {
  return (
    <section className="space-y-2" data-testid="reviewer-panel">
      <h2 className="text-sm font-semibold">Reviewers</h2>
      <ul className="space-y-2" aria-label="Reviewer assignments">
        {assignments.map((assignment) => (
          <li
            key={assignment.id}
            className="rounded border px-3 py-2"
            data-testid={`assignment-${assignment.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                {assignment.reviewer.displayName}
                {assignment.reviewerId === currentUserId ? (
                  <span className="ml-1 text-xs text-muted-foreground">(you)</span>
                ) : null}
              </span>
              <span
                data-testid={`assignment-decision-${assignment.id}`}
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                  DECISION_CLASSES[assignment.decision] ?? DECISION_CLASSES.pending,
                )}
              >
                {assignment.decision}
              </span>
            </div>
            {assignment.note ? (
              <p className="mt-1 text-xs italic text-muted-foreground">{assignment.note}</p>
            ) : null}
            {assignment.decidedAt ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Decided {new Date(assignment.decidedAt).toLocaleString()}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
