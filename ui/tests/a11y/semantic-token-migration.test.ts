/**
 * #267 — the ten files with the most raw Tailwind palette classes (measured
 * at 78d717b; the list is in the PR) now style status and neutral surfaces
 * through the semantic tokens (`text-success`, `bg-warning-muted`,
 * `text-muted-foreground`, …), which carry a contrast-checked value for BOTH
 * themes. A raw `text-amber-700` has no dark counterpart unless someone
 * remembers a `dark:` twin — the drift the tokens remove. This guard keeps
 * the migrated files from regressing; the rest of the tree is the follow-up.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const UI_ROOT = [process.cwd(), path.join(process.cwd(), "ui")].find((d) =>
  existsSync(path.join(d, "src", "app", "globals.css")),
);
if (!UI_ROOT) throw new Error(`ui/ not found from ${process.cwd()}`);

const MIGRATED_FILES = [
  "src/app/(authed)/projects/[id]/pulls/[prNumber]/page.tsx",
  "src/components/analysis/SupportPanelBadge.tsx",
  "src/app/(authed)/settings/mcp/page.tsx",
  "src/components/analysis/gap-report-schema-section.tsx",
  "src/app/(authed)/projects/[id]/documentation/page.tsx",
  "src/components/findings/derivation-badge.tsx",
  "src/app/(authed)/projects/[id]/analysis/page.tsx",
  "src/components/analysis/gap-report.tsx",
  "src/app/(authed)/projects/[id]/pulls/page.tsx",
  "src/components/sandbox/SandboxStatusBadge.tsx",
  // Tied for 10th with SandboxStatusBadge (36 classes each), so migrated too.
  "src/app/(authed)/projects/[id]/changes/page.tsx",
] as const;

const RAW_PALETTE =
  /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?(?![\w-])/g;
/** `bg-white` / `text-white` do not follow the theme either. */
const RAW_WHITE_BLACK = /(?<![\w-])(?:[a-z-]+:)*(?:bg|text)-(?:white|black)(?![\w-])/g;

describe("the ten worst raw-palette files use semantic tokens (#267)", () => {
  for (const rel of MIGRATED_FILES) {
    it(`${rel} has no raw palette colour classes`, () => {
      const src = readFileSync(path.join(UI_ROOT, rel), "utf8");
      expect(src.match(RAW_PALETTE) ?? []).toEqual([]);
      expect(src.match(RAW_WHITE_BLACK) ?? []).toEqual([]);
    });
  }
});
