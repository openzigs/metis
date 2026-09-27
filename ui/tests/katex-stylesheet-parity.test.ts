// @vitest-environment node
/**
 * #310 — the math the chat and the markdown previewer render is produced by
 * the katex copy NESTED inside `rehype-katex`, but the stylesheet that styles
 * it is loaded from the UI's OWN direct `katex` dependency — by a dynamic
 * `import()` in `src/lib/katex-css.ts` since #272 moved it out of
 * `globals.css`. Those are two installs, and nothing ties them together.
 *
 * KaTeX 0.18.0 prefixed its CSS classes with `katex-` (`.sizing` became
 * `.katex-sizing`). Bumping only the UI's direct katex to 0.18 while
 * rehype-katex still ships 0.16 leaves every `base` / `strut` / `sizing`
 * element unstyled: superscripts and fraction parts render full-size. jsdom
 * never applies CSS, so no rendering test sees it. This test does, by
 * rendering with the producer copy and checking each emitted class against
 * the imported stylesheet.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(dirname, "..");
/** #272 — the lazy loader that imports the katex stylesheet (was globals.css). */
const LOADER = path.join(UI_ROOT, "src/lib/katex-css.ts");

type KatexLike = {
  version: string;
  renderToString: (tex: string, opts?: { throwOnError?: boolean }) => string;
};

/** The katex copy rehype-katex itself resolves — the one that makes the markup. */
function producerKatex(): KatexLike {
  const rehypeDir = realpathSync(path.join(UI_ROOT, "node_modules/rehype-katex"));
  const req = createRequire(path.join(rehypeDir, "package.json"));
  return req("katex") as KatexLike;
}

/** The stylesheet the lazy loader imports, resolved the way the bundler does (from ui/). */
function importedStylesheet(): { css: string; version: string } {
  const source = readFileSync(LOADER, "utf8");
  const match = source.match(/import\(\s*["'](katex\/[^"']+\.css)["']\s*\)/);
  if (!match) throw new Error("lib/katex-css.ts no longer imports a katex stylesheet");
  const katexDir = realpathSync(path.join(UI_ROOT, "node_modules/katex"));
  const cssPath = path.join(katexDir, match[1].slice("katex/".length));
  const pkg = JSON.parse(readFileSync(path.join(katexDir, "package.json"), "utf8")) as {
    version: string;
  };
  return { css: readFileSync(cssPath, "utf8"), version: pkg.version };
}

const majorMinor = (v: string) => v.split(".").slice(0, 2).join(".");

describe("katex stylesheet matches the katex that renders the markup (#310)", () => {
  it("the stylesheet copy and rehype-katex's copy share a major.minor", () => {
    const producer = producerKatex();
    const { version } = importedStylesheet();
    expect(majorMinor(version)).toBe(majorMinor(producer.version));
  });

  it("every class rehype-katex's katex emits for a layout-heavy formula is styled", () => {
    const html = producerKatex().renderToString(String.raw`x^{2} + \frac{a}{b_{i}} = \sqrt{y}`, {
      throwOnError: true,
    });
    const classes = new Set<string>();
    for (const [, attr] of html.matchAll(/class="([^"]*)"/g)) {
      for (const cls of attr.split(/\s+/)) if (cls) classes.add(cls);
    }
    // The layout-critical classes named in the #310 review must be in play,
    // otherwise this test would be checking nothing that matters.
    const layoutCritical = ["base", "strut", "sizing"];
    for (const cls of layoutCritical) expect(classes.has(cls)).toBe(true);

    // Math-atom classes (`mord`, `mbin`, ...) are semantic hooks KaTeX styles
    // only in compound selectors, if at all — unstyled at every version.
    const atomClasses = new Set([
      "mord",
      "mbin",
      "mrel",
      "mopen",
      "mclose",
      "mpunct",
      "minner",
      "mop",
      "mtight",
    ]);
    const { css } = importedStylesheet();
    const selectorFor = (cls: string) =>
      new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
    const unstyled = [...classes].filter(
      (cls) => !atomClasses.has(cls) && !selectorFor(cls).test(css),
    );
    expect(unstyled).toEqual([]);
  });
});
