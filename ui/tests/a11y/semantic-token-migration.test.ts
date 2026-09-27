/**
 * #267 migrated the ten files with the most raw Tailwind palette classes to
 * the semantic tokens (`text-success`, `bg-warning-muted`,
 * `text-muted-foreground`, …); #301 migrated the rest. The tokens carry a
 * contrast-checked value for BOTH themes (`ui/tests/contrast-tokens.test.ts`).
 * A raw `text-amber-700` has no dark counterpart unless someone remembers a
 * `dark:` twin, and the pair's contrast is never checked — the drift the tokens
 * remove.
 *
 * This guard is now a lint rule over the whole of `ui/src` and
 * `packages/ui-kit/src`: a NEW raw palette class anywhere fails it. Categorical
 * colours that carry no status meaning use the `--chart-1..7` series tokens.
 * The only exceptions are listed in ALLOWED, each with its reason.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const UI_ROOT = [process.cwd(), path.join(process.cwd(), "ui")].find((d) =>
  existsSync(path.join(d, "src", "app", "globals.css")),
);
if (!UI_ROOT) throw new Error(`ui/ not found from ${process.cwd()}`);
const REPO_ROOT = path.resolve(UI_ROOT, "..");

const ROOTS = [path.join(UI_ROOT, "src"), path.join(REPO_ROOT, "packages", "ui-kit", "src")];

/**
 * Raw classes a file may keep, keyed by path from the repo root. Every entry
 * needs a reason a token cannot do the job.
 */
const ALLOWED: Record<string, { classes: string[]; reason: string }> = {
  "packages/ui-kit/src/components/dialog.tsx": {
    classes: ["bg-black/80"],
    reason: "Modal scrim: it darkens the page in BOTH themes, so it must not follow the theme.",
  },
  "packages/ui-kit/src/components/alert-dialog.tsx": {
    classes: ["bg-black/80"],
    reason: "Modal scrim: it darkens the page in BOTH themes, so it must not follow the theme.",
  },
  "packages/ui-kit/src/components/sheet.tsx": {
    classes: ["bg-black/50"],
    reason: "Sheet scrim: it darkens the page in BOTH themes, so it must not follow the theme.",
  },
};

const HUES =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTILITIES =
  "bg|text|border(?:-[trblxy])?|ring|ring-offset|from|to|via|fill|stroke|outline|divide|decoration|accent|caret|placeholder|shadow";

const RAW_PALETTE = new RegExp(
  `(?<![\\w-])(?:[a-z-]+:)*(?:${UTILITIES})-(?:${HUES})-\\d{2,3}(?:\\/\\d+)?(?![\\w-])`,
  "g",
);
/** `bg-white` / `text-black` do not follow the theme either. */
const RAW_WHITE_BLACK = new RegExp(
  `(?<![\\w-])(?:[a-z-]+:)*(?:${UTILITIES})-(?:white|black)(?:\\/\\d+)?(?![\\w-])`,
  "g",
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.(test|spec|bench)\./.test(name) ? [full] : [];
  });
}

/** Comments may name the classes they replaced; only code counts. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function rawClasses(src: string): string[] {
  const code = stripComments(src);
  return [...(code.match(RAW_PALETTE) ?? []), ...(code.match(RAW_WHITE_BLACK) ?? [])];
}

const FILES = ROOTS.flatMap(sourceFiles).map((full) => ({
  rel: path.relative(REPO_ROOT, full).split(path.sep).join("/"),
  src: readFileSync(full, "utf8"),
}));

describe("no raw Tailwind palette classes in the UI (#267, #301)", () => {
  it("scans the whole UI source tree", () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES.some((f) => f.rel.startsWith("packages/ui-kit/src/"))).toBe(true);
  });

  it("every class in ui/src and packages/ui-kit/src is a theme token", () => {
    const offenders = FILES.flatMap(({ rel, src }) =>
      rawClasses(src)
        .filter((cls) => !ALLOWED[rel]?.classes.includes(cls))
        .map((cls) => `${rel}: ${cls}`),
    );
    expect(offenders).toEqual([]);
  });

  it("every allowlisted class is still there (no stale exceptions)", () => {
    for (const [rel, { classes }] of Object.entries(ALLOWED)) {
      const file = FILES.find((f) => f.rel === rel);
      expect(file, rel).toBeDefined();
      for (const cls of classes) expect(rawClasses(file!.src), rel).toContain(cls);
    }
  });

  it("the rule catches the shapes it is meant to", () => {
    expect(rawClasses('className="text-amber-700 dark:bg-zinc-900/40"')).toEqual([
      "text-amber-700",
      "dark:bg-zinc-900/40",
    ]);
    expect(rawClasses('cn("border-l-purple-500", "hover:bg-red-50")')).toEqual([
      "border-l-purple-500",
      "hover:bg-red-50",
    ]);
    expect(rawClasses('"bg-white text-white"')).toEqual(["bg-white", "text-white"]);
    expect(rawClasses('"text-destructive bg-success-muted border-chart-4"')).toEqual([]);
    expect(rawClasses("// was `text-zinc-400`\nconst x = 1;")).toEqual([]);
  });
});
