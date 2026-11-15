import { useState } from "react";

/**
 * #2180 — run `reset` in the render where a write hint appears.
 *
 * A control hidden by `open && !writeHint` keeps its `open` state, and Radix
 * does not call `onOpenChange` when a controlled dialog is closed by its
 * parent, so when the hint clears (the auth refetch restored the permission)
 * the dialog, form or popover came back with no user action. Resetting the
 * state when the hint is set closes it for good.
 *
 * The check runs during render, the pattern React documents for adjusting
 * state when a prop changes: React re-renders before committing, so the hidden
 * control is never painted, and no effect runs a frame late.
 */
export function useResetOnHint(writeHint: string | undefined, reset: () => void): void {
  const [seen, setSeen] = useState(writeHint);
  if (writeHint !== seen) {
    setSeen(writeHint);
    if (writeHint) reset();
  }
}
