"use client";

import { useRef, useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@metis/ui-kit";

export interface PausableLiveRegionProps {
  /** Auto-updating content (message list, progress rows, streamed log lines). */
  children: ReactNode;
  /**
   * Accessible name for the live region AND the pause control context, e.g.
   * "Chat transcript". The control announces as "Pause {label} auto-updates".
   */
  label: string;
  /** Applied to the region element so each call site keeps its own styling. */
  className?: string;
  /** ARIA role for the region (e.g. "log" for a streaming transcript). */
  role?: "log" | "status";
  /** aria-atomic on the region (default false — announce only new additions). */
  atomic?: boolean;
  /**
   * Whether the region is actively auto-updating. SC 2.2.2 only applies to
   * content that auto-updates, so the control is rendered only when true. When
   * a region is always a live transcript, leave this at its `true` default.
   */
  active?: boolean;
  /** data-testid for the region; the control gets `${testId}-pause-toggle`. */
  testId?: string;
  /** Extra classes for the toolbar wrapper around the pause control. */
  toolbarClassName?: string;
}

/**
 * WCAG 2.2 SC 2.2.2 Pause, Stop, Hide (Level A) — Issue #662.
 *
 * Wraps an auto-updating `aria-live` region with a keyboard-operable
 * pause/resume control that GENUINELY halts updates: while paused the region's
 * content is frozen to the last snapshot (so new data cannot mutate the DOM)
 * and `aria-live` flips to "off" so assistive tech stops announcing. Resuming
 * re-attaches to the live children and restores polite announcements.
 *
 * The control is only rendered while the region is auto-updating (`active`), so
 * it never strands a paused region: if the stream ends while paused, the region
 * force-resumes to show the final content.
 */
export function PausableLiveRegion({
  children,
  label,
  className,
  role,
  atomic = false,
  active = true,
  testId,
  toolbarClassName,
}: PausableLiveRegionProps): React.ReactElement {
  const [paused, setPaused] = useState(false);

  // A paused region is only meaningful while it is still auto-updating. If the
  // stream ends (active=false) we ignore a stale paused flag so the user always
  // sees the final content and no dead control lingers.
  const effectivelyPaused = paused && active;

  // Snapshot the latest live children on every non-frozen render so a pause
  // freezes exactly what was on screen. Writing a ref during render is a safe
  // caching pattern — it triggers no state update and no effect, and React
  // re-runs render whenever `children` changes, keeping the snapshot current
  // until the user actually pauses.
  const frozen = useRef<ReactNode>(children);
  if (!effectivelyPaused) {
    frozen.current = children;
  }
  const content = effectivelyPaused ? frozen.current : children;

  return (
    <>
      {active && (
        <div className={cn("mb-2 flex justify-end", toolbarClassName)}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={effectivelyPaused}
            onClick={() => setPaused((p) => !p)}
            data-testid={testId ? `${testId}-pause-toggle` : undefined}
          >
            {effectivelyPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            {effectivelyPaused ? `Resume ${label} auto-updates` : `Pause ${label} auto-updates`}
          </Button>
        </div>
      )}
      <div
        className={className}
        role={role}
        aria-live={effectivelyPaused ? "off" : "polite"}
        aria-atomic={atomic}
        aria-label={label}
        data-testid={testId}
        data-paused={effectivelyPaused ? "true" : "false"}
      >
        {content}
      </div>
    </>
  );
}
