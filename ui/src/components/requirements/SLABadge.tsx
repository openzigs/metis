"use client";

/**
 * Epic #728 / Issue #736 — SLABadge component.
 *
 * Displays an SLA deadline with color-coded urgency:
 *   - Green: > 48 h remaining
 *   - Yellow/amber: ≤ 48 h remaining
 *   - Red: overdue
 *   - Grey: no deadline
 */
import { cn } from "@/lib/utils";

interface SLABadgeProps {
  deadline: string | null | undefined;
  className?: string;
}

type Status = "ok" | "warning" | "overdue" | "none";

function getStatus(deadline: string | null | undefined): Status {
  if (!deadline) return "none";
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms < 0) return "overdue";
  if (ms <= 48 * 60 * 60 * 1000) return "warning";
  return "ok";
}

function formatDeadline(deadline: string): string {
  const d = new Date(deadline);
  const diff = d.getTime() - Date.now();
  if (diff < 0) {
    const absDiff = Math.abs(diff);
    const days = Math.floor(absDiff / 86_400_000);
    if (days > 0) return `${days}d overdue`;
    const hours = Math.floor(absDiff / 3_600_000);
    return `${hours}h overdue`;
  }
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `Due in ${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  return `Due in ${hours}h`;
}

const statusStyles: Record<Status, string> = {
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  overdue: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  none: "bg-muted text-muted-foreground",
};

export function SLABadge({ deadline, className }: SLABadgeProps) {
  const status = getStatus(deadline);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        statusStyles[status],
        className,
      )}
      aria-label={
        deadline ? `SLA deadline: ${new Date(deadline).toLocaleString()}` : "No SLA deadline"
      }
    >
      {deadline ? formatDeadline(deadline) : "No SLA"}
    </span>
  );
}
