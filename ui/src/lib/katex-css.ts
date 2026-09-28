/**
 * #272 — the KaTeX stylesheet (~23 kB of CSS plus its font faces) used to be
 * imported by `globals.css`, so every page downloaded it. Only markdown that
 * actually contains math needs it; `useKatexCss` fetches it the first time
 * such markdown renders.
 */
import { useEffect } from "react";

let requested = false;

/**
 * True when `markdown` has something remark-math turns into math: a `$$…$$`
 * block or an inline `$…$`. A false positive (two prices on one line) only
 * costs one stylesheet download.
 */
export function hasMath(markdown: string): boolean {
  return /\$\$[\s\S]*?\$\$|\$[^\s$][^$\n]*\$/.test(markdown);
}

/** Loads the KaTeX stylesheet once per page session. */
export function ensureKatexCss(): void {
  if (requested) return;
  requested = true;
  import("katex/dist/katex.min.css").catch(() => {
    // Let a later render retry after a failed chunk load.
    requested = false;
  });
}

export function useKatexCss(markdown: string): void {
  const needed = hasMath(markdown);
  useEffect(() => {
    if (needed) ensureKatexCss();
  }, [needed]);
}
