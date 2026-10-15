/**
 * Issue #1129 — on a run started from ticked imported items, which reviewed
 * requirements restate one of those items and which the analysis added.
 *
 * The approval checkpoint raises one approval per STRUCTURED requirement, and
 * the extractor that writes that list is seeded with the document agent's
 * requirements as well as the ticked items' titles. In #706 run 8 five ticked
 * items became 34 approvals, 29 of them README and API features nobody ticked,
 * and nothing on screen told the two apart.
 *
 * The join is deterministic and LLM-free: an imported title restated by a
 * requirement has most of its significant words in that requirement's title or
 * description. It is the same containment measure #1116 uses to place
 * clarification answers. It errs toward "ticked": leaving out an added
 * requirement is one click to reopen, while hiding a ticked one among the added
 * would make the user re-find the thing they asked for.
 */
import type { AnalysisSourceRequirement } from "@metis/shared";
import { containmentScore, significantTokens } from "./clarification-enrichment.js";

export type RequirementOrigin = "ticked" | "added";

/**
 * Share of an imported title's significant words a requirement must contain to
 * restate it. Matches `ATTRIBUTION_THRESHOLD`: a two-word title needs one hit,
 * a six-word title three.
 */
export const TICKED_MATCH_THRESHOLD = 0.5;

/**
 * Origin per requirement id. Empty when the run was not started from imported
 * items, so every caller can treat "no entry" as "no ticked/added split".
 */
export function classifyRequirementOrigins(
  requirements: ReadonlyArray<{ id: string; title: string; description?: string | null }>,
  sources: ReadonlyArray<Pick<AnalysisSourceRequirement, "title">>,
): Map<string, RequirementOrigin> {
  const origins = new Map<string, RequirementOrigin>();
  const needles = sources.map((s) => significantTokens(s.title)).filter((t) => t.size > 0);
  if (needles.length === 0) return origins;
  for (const r of requirements) {
    const haystack = significantTokens(`${r.title} ${r.description ?? ""}`);
    const restates = needles.some(
      (needle) => containmentScore(needle, haystack) >= TICKED_MATCH_THRESHOLD,
    );
    origins.set(r.id, restates ? "ticked" : "added");
  }
  return origins;
}

/** The ids classified as restating a ticked item. */
export function tickedFirst(origins: ReadonlyMap<string, RequirementOrigin>): Set<string> {
  return new Set([...origins].filter(([, o]) => o === "ticked").map(([id]) => id));
}

/**
 * Stable partition: items whose id is ticked first, then everything else, each
 * group in its original order.
 */
export function orderTickedFirst<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  origins: ReadonlyMap<string, RequirementOrigin>,
): T[] {
  const ticked = tickedFirst(origins);
  if (ticked.size === 0) return [...items];
  return [
    ...items.filter((i) => ticked.has(idOf(i))),
    ...items.filter((i) => !ticked.has(idOf(i))),
  ];
}
