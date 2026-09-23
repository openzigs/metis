/**
 * Epic #739 / Issue #745 — Drift indicator badge.
 *
 * Displays the count of pending drift events for a project/requirement.
 * Renders within 50ms (no API call on mount — relies on prefetched data or
 * Socket.IO live-updates). Activating it navigates to the sync page.
 *
 * #90 — it is a real `<button>`. It used to be the ui-kit `Badge` (a `<div>`)
 * with an `onClick` and `role="status"`: unreachable by Tab, inert to Enter and
 * Space, and announced as a live region rather than as a control. Once #78
 * mounted it on the project Overview that was a mouse-only control on a
 * primary page. The badge LOOK is kept by applying the destructive badge
 * classes to the button itself — `Badge` renders a `<div>`, which is not valid
 * button content.
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { badgeVariantClasses } from "@metis/ui-kit";

/**
 * The ui-kit `Badge` destructive variant (its colours come FROM the ui-kit, so
 * they cannot drift — #113), applied to a focusable element. `h-6 min-w-6` is
 * the WCAG 2.2 SC 2.5.8 minimum target of 24×24 CSS px; it was 18×18.
 */
const BADGE_CLASSES =
  "inline-flex items-center justify-center rounded-full border border-transparent font-semibold " +
  `${badgeVariantClasses("destructive")} transition-colors ` +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "h-6 min-w-6";

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

  const noun = `pending drift event${localCount === 1 ? "" : "s"}`;

  return (
    <button
      type="button"
      className={`${BADGE_CLASSES} cursor-pointer text-xs px-1.5 py-0 ${className ?? ""}`}
      onClick={(e) => {
        e.stopPropagation();
        router.push(href);
      }}
      title={`${localCount} drift${localCount === 1 ? "" : "s"} detected`}
      aria-label={`View ${localCount} ${noun}`}
    >
      {localCount}
    </button>
  );
}
