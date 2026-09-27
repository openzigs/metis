import * as React from "react";

/**
 * #268 — focus return for a modal opened WITHOUT a Radix `Trigger`.
 *
 * Radix Dialog / AlertDialog return focus on close to their `Trigger`. The
 * app opens most of its modals from state (a list row, a toolbar button that
 * is not a `DialogTrigger`), and then Radix has nothing to return to, so
 * focus falls to `<body>` (WCAG 2.4.3 Focus Order). This hook records the
 * element that had focus when the content opened — `onOpenAutoFocus` fires
 * before Radix moves focus in — and puts focus back there on close, unless a
 * caller handled `onCloseAutoFocus` itself.
 */
export function useReturnFocus<O extends Event, C extends Event>(
  onOpenAutoFocus: ((e: O) => void) | undefined,
  onCloseAutoFocus: ((e: C) => void) | undefined,
): { onOpenAutoFocus: (e: O) => void; onCloseAutoFocus: (e: C) => void } {
  const returnTo = React.useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (e: O) => {
      const active = typeof document === "undefined" ? null : document.activeElement;
      returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
      onOpenAutoFocus?.(e);
    },
    onCloseAutoFocus: (e: C) => {
      onCloseAutoFocus?.(e);
      const target = returnTo.current;
      returnTo.current = null;
      if (e.defaultPrevented || !target || !target.isConnected) return;
      e.preventDefault();
      target.focus();
    },
  };
}
