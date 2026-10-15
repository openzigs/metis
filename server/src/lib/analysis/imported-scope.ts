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
 * Provenance first. #1063 already records it: synthesis names the imported
 * ids each requirement came from (`sourceIds`, checked against the run's own
 * ids), `matchSynthesized` joins that onto the structured requirement, and
 * promotion persists it as `sourceCandidateIds` — the column behind the
 * "Added by the analysis" badge. So a requirement whose recorded ids include a
 * ticked item is "ticked", and one with recorded provenance and no ticked id is
 * "added", exactly as the badge will say. A second, word-based opinion would
 * disagree with that badge, and `reject-added` would act on the wrong one.
 *
 * Only a requirement with NO recorded provenance (degraded synthesis, no
 * synthesized match, a model that did not say) falls back to a deterministic,
 * LLM-free word join: an imported title restated by a requirement has most of
 * its significant words in that requirement's title or description — the
 * containment measure #1116 uses to place clarification answers. The fallback
 * errs toward "ticked": leaving out an added requirement is one click to
 * reopen, while hiding a ticked one among the added would make the user
 * re-find the thing they asked for.
 */
import type { AnalysisSourceRequirement, SynthesizedRequirement } from "@metis/shared";
import { matchSynthesized } from "./approved-requirement-set.js";
import { containmentScore, significantTokens } from "./clarification-enrichment.js";
import { cleanSourceIds } from "./source-items.js";

export type RequirementOrigin = "ticked" | "added";

/**
 * Fallback only. Share of an imported title's significant words a requirement
 * with no recorded provenance must contain to restate it. Matches
 * `ATTRIBUTION_THRESHOLD`: a two-word title needs one hit, a six-word title
 * three.
 */
export const TICKED_MATCH_THRESHOLD = 0.5;

/**
 * Origin per requirement id. Empty when the run was not started from imported
 * items, so every caller can treat "no entry" as "no ticked/added split".
 *
 * `synthesized` is the synthesis agent's output for the run; its `sourceIds`
 * are the recorded provenance. Omitted or empty, every requirement falls back
 * to the word join.
 *
 * `rejectedIds` are the requirements whose latest approval is rejected. They
 * are left out of the join, because promotion joins over the approved subset
 * only: a rejected requirement must not claim the synthesized entry that a
 * pending one would carry, and so its badge, once promoted.
 */
export function classifyRequirementOrigins(
  requirements: ReadonlyArray<{ id: string; title: string; description?: string | null }>,
  sources: ReadonlyArray<Pick<AnalysisSourceRequirement, "candidateId" | "title">>,
  synthesized: readonly SynthesizedRequirement[] = [],
  options: { rejectedIds?: ReadonlySet<string> } = {},
): Map<string, RequirementOrigin> {
  const origins = new Map<string, RequirementOrigin>();
  if (sources.length === 0) return origins;
  const knownIds = new Set(sources.map((s) => s.candidateId));
  // The same join promotion uses, so the recorded ids are the badge's ids.
  const rejected = options.rejectedIds ?? new Set<string>();
  const matches = matchSynthesized(
    requirements.filter((r) => !rejected.has(r.id)),
    synthesized,
  );
  const needles = sources.map((s) => significantTokens(s.title)).filter((t) => t.size > 0);
  for (const r of requirements) {
    const recorded = cleanSourceIds(matches.get(r.id)?.sourceIds, knownIds);
    if (recorded !== undefined) {
      origins.set(r.id, recorded.length > 0 ? "ticked" : "added");
      continue;
    }
    // Imported titles of stopwords only: the word join cannot say either way.
    if (needles.length === 0) continue;
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
