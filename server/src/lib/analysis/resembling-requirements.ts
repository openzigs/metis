/**
 * Issue #2596 — the requirements the analysis added at the checkpoint that look
 * like one read from the documents, so the Checkpoints tab can show the two
 * side by side instead of as unrelated rows.
 *
 * The reviewed list holds the requirements extracted from the documents and
 * the ones the analysis added to it: an NFR the elicitor found (#2449) or an
 * item synthesis wrote up that named no listed requirement (#1569). Those are
 * kept apart from the extracted ones only by an exact restatement
 * (`statesSameNfr`), on purpose: a false match there drops a requirement the
 * analyst never sees. So a paraphrase is listed twice. In the 2026-11-16
 * walkthrough 6 of the 10 NFRs restated one of the 8 extracted requirements
 * ("Expired API keys refused identically to unknown keys" beside "Expired keys
 * are refused like unknown keys").
 *
 * This only groups; it removes nothing. An added requirement resembles the
 * extracted one whose title shares at least {@link MIN_SHARED_WORDS} of its
 * significant words, making up at least {@link RESEMBLANCE_THRESHOLD} of the
 * shorter title. The closest one wins, by that share and then by the words
 * shared; two equally close leave it ungrouped, never a guess. Two added
 * requirements are never grouped, and neither are two extracted ones.
 *
 * Pure.
 */
import { significantTokens } from "./clarification-enrichment.js";
import type { StructuredRequirement } from "./types/requirements.js";

/** Fewer shared words than this is chance: "API keys" is in every key requirement. */
export const MIN_SHARED_WORDS = 3;
/** The share of the shorter title's significant words the two titles must share. */
export const RESEMBLANCE_THRESHOLD = 0.6;

type Comparable = Pick<StructuredRequirement, "id" | "title" | "elicitedNfr" | "synthesisItemKey">;

/** Added to the list by the analysis, not read from the documents. */
function isAdded(r: Comparable): boolean {
  return r.elicitedNfr !== undefined || r.synthesisItemKey !== undefined;
}

/** Added requirement id → the id of the extracted requirement it resembles. */
export function resembledRequirements(structured: readonly Comparable[]): Map<string, string> {
  const extracted = structured
    .filter((r) => !isAdded(r))
    .map((r) => ({ id: r.id, words: significantTokens(r.title) }));
  const out = new Map<string, string>();
  for (const added of structured.filter(isAdded)) {
    const words = significantTokens(added.title);
    let best: { id: string; share: number; shared: number } | null = null;
    let tied = false;
    for (const candidate of extracted) {
      let shared = 0;
      for (const w of words) if (candidate.words.has(w)) shared++;
      if (shared < MIN_SHARED_WORDS) continue;
      const share = shared / Math.min(words.size, candidate.words.size);
      if (share < RESEMBLANCE_THRESHOLD) continue;
      const order = best ? share - best.share || shared - best.shared : 1;
      if (order > 0) {
        best = { id: candidate.id, share, shared };
        tied = false;
      } else if (order === 0) {
        tied = true;
      }
    }
    if (best && !tied) out.set(added.id, best.id);
  }
  return out;
}
