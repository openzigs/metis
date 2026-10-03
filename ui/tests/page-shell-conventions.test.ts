/**
 * #270 — page shell conventions, read from the source.
 *
 *  1. Every authed page renders its title through the ui-kit `PageHeader`
 *     (directly, or through the one component it delegates to), unless it only
 *     redirects. Research #263 found nine `<h1>` class combinations across the
 *     authed pages and no shared header.
 *  2. There is one `<h1>` style: outside `PageHeader`, a literal `<h1>` in
 *     `ui/src` must use `PAGE_TITLE_CLASS`.
 *  3. Route `loading.tsx` files render the Skeleton-based `PageHeaderSkeleton`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const AUTHED = path.join(SRC, "app", "(authed)");

function walk(dir: string, pick: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full, pick);
    return pick(name) ? [full] : [];
  });
}

const rel = (full: string) => path.relative(SRC, full).split(path.sep).join("/");
/** Source with comments removed, so prose that mentions `<h1>` is not code. */
const read = (full: string) =>
  readFileSync(full, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Pages whose header lives in the one component they render. The component
 * must itself render `<PageHeader`.
 */
const DELEGATES: Record<string, string> = {
  "app/(authed)/reviews/[id]/page.tsx": "components/reviews/ReviewHeader.tsx",
  "app/(authed)/settings/audit/page.tsx": "app/(authed)/settings/api-keys/page.tsx",
  "app/(authed)/workspaces/[id]/agents/new/page.tsx":
    "components/custom-agents/AgentAuthoringWizard.tsx",
};

/**
 * Pages that only redirect and render nothing of their own. Named explicitly
 * rather than inferred from `redirect(` in the source, so a page that
 * redirects only on some branch still has to render a `PageHeader`.
 */
const REDIRECT_ONLY = new Set([
  "app/(authed)/admin/[[...slug]]/page.tsx",
  "app/(authed)/agents/page.tsx",
  "app/(authed)/projects/[id]/usage/page.tsx",
  "app/(authed)/settings/agents/page.tsx",
  "app/(authed)/workspaces/[id]/finops/page.tsx",
  "app/(authed)/projects/[id]/repositories/page.tsx",
  "app/(authed)/skills/page.tsx",
]);

const PAGES = walk(AUTHED, (n) => n === "page.tsx");

describe("every authed page uses PageHeader (#270)", () => {
  it("finds the authed pages", () => {
    // #31 folded eight Admin pages into Settings and one catch-all redirect;
    // #803 removed the four bug-scanner pages.
    expect(PAGES.length).toBeGreaterThanOrEqual(77);
  });

  for (const page of PAGES) {
    const name = rel(page);
    it(`${name} renders PageHeader, delegates to it, or only redirects`, () => {
      const src = read(page);
      if (REDIRECT_ONLY.has(name)) {
        expect(src).toMatch(/\bredirect\(/);
        // Nothing to render: a page that returns anything is not redirect-only.
        expect(src).not.toMatch(/\breturn\b/);
        return;
      }
      const delegate = DELEGATES[name];
      const headerSource = delegate ? read(path.join(SRC, delegate)) : src;
      expect(headerSource).toMatch(/<PageHeader\b/);
      expect(src).not.toMatch(/<h1\b/);
    });
  }
});

describe("one page-title style (#270)", () => {
  const files = walk(SRC, (n) => /\.tsx$/.test(n) && !/\.(test|spec|bench)\./.test(n));
  it("every literal <h1> outside PageHeader uses PAGE_TITLE_CLASS", () => {
    const offenders = files.flatMap((f) =>
      [...read(f).matchAll(/<h1\b[^>]*>/g)]
        .filter((m) => !m[0].includes("className={PAGE_TITLE_CLASS}"))
        .map((m) => `${rel(f)}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("route loading UIs use the page skeleton (#270)", () => {
  const loaders = walk(path.join(SRC, "app"), (n) => n === "loading.tsx");
  it("finds the loading files", () => {
    expect(loaders.length).toBeGreaterThanOrEqual(2);
  });
  for (const file of loaders) {
    it(`${rel(file)} renders PageHeaderSkeleton`, () => {
      expect(read(file)).toMatch(/<PageHeaderSkeleton\b/);
    });
  }
});
