"use client";

import { useEffect, useRef } from "react";

/**
 * Issue #406 — scroll to an in-page anchor (`#approvals`) whose target mounts
 * late.
 *
 * The browser scrolls to a URL fragment once, at navigation, and a target that
 * renders only after its queries resolve is not there yet. This waits for the
 * element to appear, scrolls it into view, and calls `onArrived` so the caller
 * can clear the request. `null` (or anything that is not `#id`) does nothing.
 */
export function useScrollToAnchor(anchor: string | null, onArrived: () => void): void {
  const onArrivedRef = useRef(onArrived);
  useEffect(() => {
    onArrivedRef.current = onArrived;
  }, [onArrived]);

  useEffect(() => {
    if (!anchor?.startsWith("#") || anchor.length < 2) return;
    const id = anchor.slice(1);
    const tryScroll = (): boolean => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView({ block: "start" });
      onArrivedRef.current();
      return true;
    };
    if (tryScroll()) return;
    const observer = new MutationObserver(() => {
      if (tryScroll()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [anchor]);
}
