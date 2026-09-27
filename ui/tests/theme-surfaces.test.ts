/**
 * #266 — no dark-only neutral surfaces on the Templates and Analysis screens.
 *
 * These files used to paint un-prefixed `text-zinc-100…300` text and
 * `bg-zinc-800/900` / `border-zinc-700/800` panels that only work on a dark
 * page: in the Light theme the Templates `<h1>` (`text-zinc-100`) sat at about
 * 1.1:1 on white. They now use theme tokens (`text-foreground`,
 * `text-muted-foreground`, `bg-muted`, `border-border`), whose contrast in both
 * themes is asserted in `contrast-tokens.test.ts`.
 *
 * Rule: a neutral-palette utility (zinc/slate/gray/neutral/stone) that is not
 * behind a `dark:` variant must not be
 *  - light text (`text-*-50` … `text-*-600`; 400–600 also fail 4.5:1 on one
 *    of the two themes), or
 *  - a dark fill or border (`bg-*`/`border-*` at 600 and darker).
 * Mid-grey 500 fills/borders (e.g. `bg-zinc-500/15`) read in both themes and
 * are allowed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(dirname, "../src");

const TARGETS = [
  "app/(authed)/projects/[id]/settings/templates/page.tsx",
  "app/(authed)/projects/[id]/analysis/page.tsx",
  ...readdirSync(path.join(SRC, "components/analysis"))
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .map((f) => `components/analysis/${f}`),
];

const NEUTRAL =
  /^(bg|border(?:-[trblxy])?|text|ring|divide|outline|from|via|to)-(zinc|slate|gray|neutral|stone)-(\d+)(?:\/\d+)?$/;

/** Every dark-only neutral class in `source`, with its variant prefix. */
function darkOnlyNeutralClasses(source: string): string[] {
  const hits: string[] = [];
  for (const token of source.split(/[\s"'`{}()]+/)) {
    const parts = token.split(":");
    const utility = parts.pop() ?? "";
    if (parts.includes("dark")) continue;
    const m = utility.match(NEUTRAL);
    if (!m) continue;
    const [, kind, , shadeText] = m;
    const shade = Number(shadeText);
    const lightText = kind === "text" && shade <= 600;
    const darkFill = kind !== "text" && shade >= 600;
    if (lightText || darkFill) hits.push(token);
  }
  return hits;
}

describe("dark-only neutral classes detector", () => {
  it("flags light text and dark fills/borders", () => {
    expect(
      darkOnlyNeutralClasses(
        `<h1 className="text-zinc-100">x</h1><div className={\`border-zinc-800 bg-zinc-900/30 hover:bg-zinc-700/60\`} />`,
      ),
    ).toEqual(["text-zinc-100", "border-zinc-800", "bg-zinc-900/30", "hover:bg-zinc-700/60"]);
  });

  it("ignores dark:-prefixed, mid-grey and token classes", () => {
    expect(
      darkOnlyNeutralClasses(
        `"bg-white dark:bg-zinc-900 dark:hover:text-zinc-300 bg-zinc-500/15 border-zinc-500/30 text-foreground bg-muted/40 border-border text-zinc-900"`,
      ),
    ).toEqual([]);
  });
});

describe("Templates and Analysis screens use theme tokens (#266)", () => {
  for (const rel of TARGETS) {
    it(`${rel} has no dark-only neutral surfaces`, () => {
      const source = readFileSync(path.join(SRC, rel), "utf8");
      expect(darkOnlyNeutralClasses(source)).toEqual([]);
    });
  }
});
