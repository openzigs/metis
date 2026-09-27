// @vitest-environment node
/**
 * #265 / #269 — compile the REAL `ui/src/app/globals.css` through the same
 * Tailwind 4 PostCSS plugin the Next build uses (`ui/postcss.config.mjs`) and
 * assert on the generated CSS, not on the source text.
 *
 *  - #265: Tailwind 4's `dark:` variant defaults to
 *    `@media (prefers-color-scheme: dark)`, but next-themes toggles a `.dark`
 *    class on <html> (`components/providers.tsx`, `attribute="class"`). Unless
 *    globals.css overrides the variant, every `dark:` utility follows the OS
 *    and ignores the Light/Dark/System toggle.
 *  - #269: the ui-kit's overlay components use `animate-in` / `fade-in-0` /
 *    `zoom-in-95` (dialog, sheet, tooltip, dropdown-menu). Those utilities come
 *    from `tw-animate-css`; without it they compile to nothing and the
 *    animations are dead.
 *
 * Content scanning is disabled (the `@source` lines are stripped and the
 * plugin's base is an empty temp dir) and candidates are supplied with
 * `@source inline(...)`, so the test is hermetic and fast.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Container, type Document, type Root } from "postcss";
import tailwind from "@tailwindcss/postcss";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const GLOBALS = path.resolve(dirname, "../src/app/globals.css");

const CANDIDATES = [
  "dark:bg-zinc-900",
  "animate-in",
  "animate-out",
  "fade-in-0",
  "zoom-in-95",
  "data-[state=open]:animate-in",
];

let css = "";
let root: Root | null = null;
let emptyBase = "";

/**
 * Every top-level rule whose selector IS `selector` or extends it with a
 * variant suffix, rendered with its enclosing at-rules (`@media`, `@layer`...)
 * and any nested blocks.
 *
 * Walks the PostCSS AST rather than searching the text, because Tailwind is
 * free to change its output SHAPE: 4.3.1 emitted `.x { &:where(.dark, .dark *)
 * { ... } }` and 4.3.3 flattens that to `.x:where(.dark, .dark *) { ... }`,
 * which a `${selector} {` text search no longer finds. Including the
 * enclosing at-rules keeps the "not tied to prefers-color-scheme" check honest
 * in the flattened shape, where the media query wraps the rule instead of
 * nesting inside it.
 */
function ruleFor(selector: string): string {
  const out: string[] = [];
  root?.walkRules((rule) => {
    if (rule.parent?.type === "rule") return; // included in its parent's text
    const matches = rule.selectors.some(
      (s) =>
        s === selector || (s.startsWith(selector) && !/[\w\\-]/.test(s.charAt(selector.length))),
    );
    if (!matches) return;
    const context: string[] = [];
    for (let p: Container | Document | undefined = rule.parent; p && p.type !== "root";) {
      if (p.type === "atrule") context.unshift(`@${(p as AtRule).name} ${(p as AtRule).params}`);
      p = (p as Container).parent as Container | Document | undefined;
    }
    out.push([...context, rule.toString()].join("\n"));
  });
  return out.join("\n");
}

beforeAll(async () => {
  emptyBase = mkdtempSync(path.join(tmpdir(), "metis-tw-"));
  const source =
    readFileSync(GLOBALS, "utf8").replace(/^@source\s[^;]*;$/gm, "") +
    `\n@source inline("${CANDIDATES.join(" ")}");\n`;
  const result = await postcss([tailwind({ base: emptyBase })]).process(source, {
    from: GLOBALS,
  });
  css = result.css;
  root = result.root;
}, 30_000);

afterAll(() => {
  if (emptyBase) rmSync(emptyBase, { recursive: true, force: true });
});

describe("dark: variant follows the next-themes class toggle (#265)", () => {
  it("scopes dark: utilities to a .dark ancestor/self", () => {
    const rule = ruleFor(".dark\\:bg-zinc-900");
    expect(rule).not.toBe("");
    expect(rule).toMatch(/:where\(\.dark, \.dark \*\)/);
  });

  it("does not tie dark: utilities to the OS colour scheme", () => {
    const rule = ruleFor(".dark\\:bg-zinc-900");
    // Guard against passing on nothing: an absent rule never mentions the media query.
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/prefers-color-scheme/);
  });
});

describe("ui-kit enter/exit animation utilities resolve (#269)", () => {
  it("animate-in produces a real animation declaration", () => {
    expect(ruleFor(".animate-in")).toMatch(/animation:\s*enter\b/);
    expect(css).toMatch(/@keyframes enter\b/);
  });

  it("animate-out produces a real animation declaration", () => {
    expect(ruleFor(".animate-out")).toMatch(/animation:\s*exit\b/);
    expect(css).toMatch(/@keyframes exit\b/);
  });

  it("fade-in-0 and zoom-in-95 set the enter keyframe parameters", () => {
    expect(ruleFor(".fade-in-0")).toMatch(/--tw-enter-opacity/);
    expect(ruleFor(".zoom-in-95")).toMatch(/--tw-enter-scale/);
  });

  it("the Radix data-state variant used by the ui-kit overlays resolves too", () => {
    expect(ruleFor(".data-\\[state\\=open\\]\\:animate-in")).toMatch(/animation:\s*enter\b/);
  });
});
