import * as React from "react";
import { cn } from "../utils";

/**
 * S2 (#144) — shared Skeleton placeholder. Animated by default; honors
 * `prefers-reduced-motion` via `motion-reduce:animate-none`. Size and shape are
 * controlled by passing Tailwind classes through `className`.
 *
 * Skeletons are decorative — mark the surrounding loading region with
 * `role="status"`, `aria-live="polite"`, and `aria-busy` (and include
 * visually-hidden text) so assistive tech announces the pending state. See
 * {@link SkeletonText} for a ready-made announced block.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

interface SkeletonTextProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of placeholder lines to render. */
  lines?: number;
  /** Accessible label announced while loading. */
  label?: string;
}

/**
 * Convenience announced loading block: a `role="status"` region with N skeleton
 * lines and visually-hidden status text. Mirrors the dashboard `WidgetShell`
 * loading pattern so all surfaces behave consistently.
 */
function SkeletonText({ lines = 3, label = "Loading…", className, ...props }: SkeletonTextProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("space-y-2", className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn("h-3", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export { Skeleton, SkeletonText };
