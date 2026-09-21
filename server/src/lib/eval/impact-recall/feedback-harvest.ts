/**
 * Issue #966 (Epic #960) — harvest accumulated BA relevance feedback into a
 * labeled fixture fragment, matching the shape `assembleFixture` (fixture.ts)
 * expects for a manifest's `requirements` entries (`FixtureRequirement`: id,
 * text, expectedTables).
 *
 * This module is PURE aggregation — no I/O, no Prisma. The CLI wrapper
 * (`server/scripts/harvest-feedback.ts`) reads `ImpactTableFeedback` rows and
 * hands them here; the output is written for a HUMAN to review and manually
 * merge into `eval-data/corpus/<name>/manifest.json` — this module never
 * writes into the corpus itself, and nothing downstream of it feeds the
 * engine/filter (v1 is capture + export only).
 */
import type { ImpactTableFeedbackVerdict } from "@metis/shared";

/** One persisted feedback row, joined to its requirement's display text. */
export interface HarvestFeedbackRow {
  impactItemId: string;
  /** The requirement's title, when the item has a linked requirement. */
  requirementTitle: string | null;
  tableName: string;
  verdict: ImpactTableFeedbackVerdict;
}

/**
 * One harvested requirement fragment. Shares `id`/`text`/`expectedTables` with
 * {@link FixtureRequirement} (fixture.ts) so it can be pasted directly into a
 * manifest's `requirements` array. `notRelevantTables`/`markCount` are extra
 * informational fields for the human reviewer — harmless to a consumer that
 * only reads the three core fields.
 */
export interface HarvestedRequirementFragment {
  id: string;
  text: string;
  expectedTables: string[];
  /** Tables marked not-relevant by at least one BA — a caution flag for review. */
  notRelevantTables: string[];
  /** Total feedback rows folded into this fragment (both verdicts). */
  markCount: number;
}

/** The full harvest output written to disk for human-reviewed corpus merge. */
export interface FeedbackHarvestReport {
  version: 1;
  source: "feedback-harvest";
  generatedAt: string;
  note: string;
  requirementCount: number;
  feedbackCount: number;
  requirements: HarvestedRequirementFragment[];
}

const HARVEST_NOTE =
  "Harvested from ImpactTableFeedback (Issue #966). This is CAPTURE-ONLY signal — " +
  "it has NOT been auto-merged into any eval corpus. A human must review these " +
  "labels (including any notRelevantTables disagreement) before copying entries " +
  "into eval-data/corpus/<name>/manifest.json.";

/** Fallback display text when a feedback item has no linked requirement. */
function fallbackText(impactItemId: string): string {
  return `Impact item ${impactItemId}`;
}

/**
 * Aggregate feedback rows into one fragment per impact item, sorted
 * deterministically by `impactItemId`. A table is listed in `expectedTables`
 * when AT LEAST ONE mark says `relevant`, and in `notRelevantTables` when at
 * least one mark says `not-relevant` — the two lists are independent (NOT
 * mutually exclusive) so disagreement between reviewers stays visible rather
 * than being silently resolved.
 */
export function buildFeedbackHarvest(
  rows: readonly HarvestFeedbackRow[],
  opts: { generatedAt?: string } = {},
): FeedbackHarvestReport {
  interface Group {
    requirementTitle: string | null;
    relevant: Set<string>;
    notRelevant: Set<string>;
    markCount: number;
  }
  const byItem = new Map<string, Group>();

  for (const row of rows) {
    const group = byItem.get(row.impactItemId) ?? {
      requirementTitle: null,
      relevant: new Set<string>(),
      notRelevant: new Set<string>(),
      markCount: 0,
    };
    if (!group.requirementTitle && row.requirementTitle) {
      group.requirementTitle = row.requirementTitle;
    }
    if (row.verdict === "relevant") group.relevant.add(row.tableName);
    else group.notRelevant.add(row.tableName);
    group.markCount += 1;
    byItem.set(row.impactItemId, group);
  }

  const requirements: HarvestedRequirementFragment[] = [...byItem.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([impactItemId, group]) => ({
      id: `feedback:${impactItemId}`,
      text: group.requirementTitle ?? fallbackText(impactItemId),
      expectedTables: [...group.relevant].sort((a, b) => a.localeCompare(b)),
      notRelevantTables: [...group.notRelevant].sort((a, b) => a.localeCompare(b)),
      markCount: group.markCount,
    }));

  return {
    version: 1,
    source: "feedback-harvest",
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    note: HARVEST_NOTE,
    requirementCount: requirements.length,
    feedbackCount: rows.length,
    requirements,
  };
}
