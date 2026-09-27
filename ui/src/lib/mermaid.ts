/**
 * #272 — mermaid is loaded on demand, the first time a view actually has a
 * diagram to draw, instead of being bundled into every page that can show
 * markdown. The chat, workbench, discussion, overview and documentation pages
 * all render markdown, and almost none of their messages contain a diagram.
 *
 * Import the TYPE from "mermaid" if you need it; a value import brings the whole
 * library back into the page bundle (`ui/tests/lazy-heavy-viewers.test.ts`
 * fails on one).
 */
import type { Mermaid } from "mermaid";

let pending: Promise<Mermaid> | null = null;

/** The mermaid singleton, fetched once and shared by every caller. */
export function loadMermaid(): Promise<Mermaid> {
  pending ??= import("mermaid").then(
    (mod) => mod.default,
    (error: unknown) => {
      // A failed chunk load (offline, a deploy mid-session) must not poison
      // every later attempt.
      pending = null;
      throw error;
    },
  );
  return pending;
}

/**
 * A theme token as a colour mermaid can parse. Mermaid derives its palette
 * from real colour values and cannot read `hsl(var(--x))`, so the token is
 * resolved from the live stylesheet. `undefined` when the token is not defined
 * (tests, SSR), which leaves mermaid on its own theme colours.
 */
export function themeTokenColor(name: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  const m = raw.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  return m ? `hsl(${m[1]}, ${m[2]}%, ${m[3]}%)` : undefined;
}
