/**
 * Epic #609 / Issue #618 — review status + due-date badges shared by the
 * queue and detail views.
 */
import type { ReviewStatus } from "@/lib/reviews-api";
import { cn } from "@/lib/utils";

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
  closed: "Closed",
};

const STATUS_CLASSES: Record<ReviewStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  in_review: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  approved: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  rejected: "bg-red-500/15 text-red-600 dark:text-red-400",
  closed: "bg-zinc-500/15 text-zinc-500",
};

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return (
    <span
      data-testid="review-status-badge"
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_CLASSES[status] ?? STATUS_CLASSES.draft,
      )}
    >
      {REVIEW_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** True while the review can still receive decisions (due dates matter). */
const OPEN_STATUSES: ReadonlySet<ReviewStatus> = new Set(["draft", "in_review"]);

/**
 * Due-date presentation logic. Exported for unit testing. Returns `null` when
 * there is no (parseable) due date; `overdue` only flags OPEN reviews whose
 * due date has passed.
 */
export function dueDateInfo(
  dueAt: string | null,
  status: ReviewStatus,
  now: Date = new Date(),
): { label: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const overdue = OPEN_STATUSES.has(status) && due.getTime() < now.getTime();
  return {
    label: `${overdue ? "Overdue" : "Due"} ${due.toLocaleDateString()}`,
    overdue,
  };
}

export function DueDateBadge({ dueAt, status }: { dueAt: string | null; status: ReviewStatus }) {
  const info = dueDateInfo(dueAt, status);
  if (!info) return null;
  return (
    <span
      data-testid="review-due-badge"
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        info.overdue
          ? "bg-red-500/15 text-red-600 dark:text-red-400"
          : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      )}
    >
      {info.label}
    </span>
  );
}
