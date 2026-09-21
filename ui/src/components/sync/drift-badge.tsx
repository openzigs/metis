/**
 * Epic #739 / Issue #745 — Drift indicator badge.
 *
 * Displays the count of pending drift events for a project/requirement.
 * Renders within 50ms (no API call on mount — relies on prefetched data or
 * Socket.IO live-updates). Clicking navigates to the sync page.
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";

export interface DriftBadgeProps {
  /** Project ID for navigation. */
  projectId: string;
  /** Initial count (passed from parent to avoid API call). */
  count: number;
  /** Optional requirement ID to scope the filter on the sync page. */
  requirementId?: string;
  /** Optional: className override. */
  className?: string;
}

/**
 * Small badge showing the number of pending drift events.
 * Clicking navigates to the sync dashboard filtered appropriately.
 */
export function DriftBadge({ projectId, count, requirementId, className }: DriftBadgeProps) {
  const router = useRouter();
  const [localCount, setLocalCount] = useState(count);

  useEffect(() => {
    setLocalCount(count);
  }, [count]);

  if (localCount === 0) return null;

  const href = requirementId
    ? `/projects/${projectId}/sync?requirementId=${requirementId}`
    : `/projects/${projectId}/sync`;

  return (
    <Badge
      variant="destructive"
      className={`cursor-pointer text-[10px] px-1.5 py-0 min-w-[18px] h-[18px] flex items-center justify-center ${className ?? ""}`}
      onClick={(e) => {
        e.stopPropagation();
        router.push(href);
      }}
      title={`${localCount} drift${localCount === 1 ? "" : "s"} detected`}
      role="status"
      aria-label={`${localCount} pending drift events`}
    >
      {localCount}
    </Badge>
  );
}
