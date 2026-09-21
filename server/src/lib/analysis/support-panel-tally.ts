/**
 * Epic #1107 (#1109) — the multi-lens support panel's PURE core: what makes a
 * lens's verdict countable, and how counted verdicts become one confidence label.
 *
 * ## Why this is its own module
 *
 * The epic's load-bearing constraint is that **the tally is computed in code,
 * outside any model**. Claude Security's scan-verifier is explicit about this and
 * it is the reason its panel means anything: a fourth model asked to "summarise
 * the panel" is just a fourth opinion wearing the costume of an aggregate.
 *
 * Keeping the tally in a module with no provider, no I/O and no clock makes that
 * property STRUCTURAL rather than a promise in a comment — every rule below is
 * exercised by unit tests with no model involved
 * (`support-panel-tally.test.ts`).
 *
 * ## Two rules, both recall-first
 *
 * **(1) A verdict without a decisive `file:line` is not counted.** #1109 requires
 * every counted verdict to cite the evidence that decided it, and the locator is
 * validated against the excerpts the lens was actually SHOWN — the same
 * principle as the #734 grounding gate, applied to the verifier's own output. A
 * lens that "just knows" contributes nothing. Crucially it contributes nothing
 * *in either direction*: an uncited `unsupported` is discarded exactly like an
 * uncited `supported`, so the citation rule cannot become a back door for
 * down-weighting.
 *
 * **(2) No signal is never a negative vote.** #1114's degraded branch carries no
 * verdict at all; here it becomes a `no-signal` DISCARD, and a panel where every
 * lens degraded aggregates to `"no-signal"`, not to `"low"`. The distinction
 * survives all the way to A2's presentation (#1110): "we could not judge this"
 * and "we judged this weak" are different facts about a finding, and collapsing
 * them is how a verifier's own failure gets read as evidence against a user's
 * requirement.
 *
 * ## The confidence rule (first match wins)
 *
 * ```
 *   counted === 0                  → "no-signal"   nothing was learned
 *   unsupported >  supported       → "low"         dissent outweighs the defence
 *   unsupported >  0               → "medium"      real dissent, outvoted
 *   uncertain   >  0               → "medium"      no dissent, but not everyone was sure
 *   otherwise                      → "high"        every counted lens backed the claim
 * ```
 *
 * `low` deliberately requires the not-supported voices to OUTNUMBER the
 * supporting ones rather than merely to exist. With the shipped three lenses that
 * is Claude Security's 2-of-3 shape; unlike Claude Security it does not default
 * to doubt, because here a wrongly-doubted finding still reaches the user in full
 * while a wrongly-deleted one is invisible (#1101).
 *
 * ## What this file CANNOT do
 *
 * Nothing here removes a finding, and nothing here can: the return type is a set
 * of counts and a label. That is the whole design — the panel is a grader, not a
 * gate.
 */
import {
  SUPPORT_PANEL_LENSES,
  type SupportPanelConfidence,
  type SupportPanelJudgement,
  type SupportPanelLens,
  type SupportPanelVote,
} from "@metis/shared";
import { normalizeFilePath } from "./code-citations.js";

/** Longest reasoning kept from a lens. Beyond this the model is padding, not reasoning. */
export const MAX_VOTE_REASONING_CHARS = 2_000;

/**
 * A `path:line` or `path:start-end` locator anywhere in a string.
 *
 * Static literal on purpose (never built from a variable): a dynamic `RegExp`
 * over model output is both a ReDoS surface and a SAST failure on touched lines.
 * The path class excludes whitespace, quotes and backticks so a locator embedded
 * in prose or a Markdown span terminates cleanly.
 */
const LOCATOR_RE = /([A-Za-z0-9_./\\-]+\.[A-Za-z0-9_]+):(\d+)(?:\s*-\s*(\d+))?/g;

/** A lens's raw reply, before the citation rule decides whether it counts. */
export interface RawLensVerdict {
  lens: SupportPanelLens;
  judgement: SupportPanelJudgement;
  /** Free text the model offered as its decisive locator (often embedded in prose). */
  citation?: string | null;
  reasoning?: string | null;
}

/**
 * Extract the first `file:line` locator whose FILE is in `evidenceFiles`.
 *
 * Searches `citation` first, then falls back to the reasoning — models routinely
 * put the locator in the sentence rather than the field, and discarding an
 * otherwise-good verdict over field placement would silence the panel for a
 * formatting reason. Returns `null` when no locator is present, or when every
 * locator names a file the lens was never shown (an ungrounded citation is not a
 * citation).
 */
export function extractGroundedLocator(
  citation: string | null | undefined,
  reasoning: string | null | undefined,
  evidenceFiles: readonly string[],
): string | null {
  const allowed = [...new Set(evidenceFiles.map(normalizeFilePath))];
  if (allowed.length === 0) return null;
  for (const raw of [citation, reasoning]) {
    if (!raw) continue;
    // Bound the scanned text before matching. The locator pattern has two
    // adjacent quantifiers over overlapping character classes, which is O(n²)
    // on a pathological body; the schema already caps model output, and this
    // caps it again at the one place a regex meets it.
    const text = raw.slice(0, MAX_VOTE_REASONING_CHARS);
    const verbatim = matchVerbatimEvidencePath(text, allowed);
    if (verbatim) return verbatim;
    // `matchAll` on a /g literal is safe to re-enter; lastIndex is per-iterator.
    for (const m of text.matchAll(LOCATOR_RE)) {
      const filePath = normalizeFilePath(m[1] ?? "");
      if (!allowed.includes(filePath)) continue;
      const start = m[2];
      const end = m[3];
      return end ? `${filePath}:${start}-${end}` : `${filePath}:${start}`;
    }
  }
  return null;
}

/**
 * Match `<one of the evidence paths>:<line>` by plain STRING comparison against
 * the known paths, before falling back to the generic pattern.
 *
 * Needed because not every evidence path is a filesystem path: a document chunk
 * arrives as `billing-brd.md#chunk-13`, whose `#` the generic locator pattern
 * (correctly, for source files) refuses. Without this, a lens that cited exactly
 * what it was shown had its verdict discarded for a punctuation reason, silencing
 * the panel on every document-grounded finding — the very overstatement case the
 * deterministic gate also cannot see.
 *
 * Deliberately NOT a `new RegExp(evidencePath)`: interpolating an arbitrary path
 * into a pattern is both a ReDoS surface and a SAST failure.
 */
function matchVerbatimEvidencePath(text: string, allowed: readonly string[]): string | null {
  const haystack = normalizeFilePath(text);
  for (const filePath of allowed) {
    const at = haystack.indexOf(`${filePath}:`);
    if (at < 0) continue;
    const tail = haystack.slice(at + filePath.length + 1);
    const range = /^(\d+)(?:\s*-\s*(\d+))?/.exec(tail);
    if (!range) continue;
    return range[2] ? `${filePath}:${range[1]}-${range[2]}` : `${filePath}:${range[1]}`;
  }
  return null;
}

/**
 * Apply the citation rule to one lens reply. A verdict whose decisive locator is
 * absent or ungrounded becomes a `missing-citation` discard — it keeps its
 * reasoning for audit but contributes no judgement in either direction.
 */
export function toVote(raw: RawLensVerdict, evidenceFiles: readonly string[]): SupportPanelVote {
  const reasoning = (raw.reasoning ?? "").slice(0, MAX_VOTE_REASONING_CHARS);
  const locator = extractGroundedLocator(raw.citation, raw.reasoning, evidenceFiles);
  if (!locator) {
    return {
      lens: raw.lens,
      judgement: null,
      discardReason: "missing-citation",
      citation: null,
      reasoning,
      counted: false,
    };
  }
  return {
    lens: raw.lens,
    judgement: raw.judgement,
    discardReason: null,
    citation: locator,
    reasoning,
    counted: true,
  };
}

/**
 * A lens that produced no verdict at all (#1114 degraded, or the provider call
 * failed). Recorded so the panel is auditable, and counted as NOTHING.
 */
export function noSignalVote(lens: SupportPanelLens, detail: string): SupportPanelVote {
  return {
    lens,
    judgement: null,
    discardReason: "no-signal",
    citation: null,
    reasoning: detail.slice(0, MAX_VOTE_REASONING_CHARS),
    counted: false,
  };
}

/** The pure tally's output: the counts, and the label derived from them. */
export interface SupportPanelTally {
  confidence: SupportPanelConfidence;
  countedVotes: number;
  supportedVotes: number;
  unsupportedVotes: number;
  uncertainVotes: number;
  noSignalVotes: number;
  uncitedVotes: number;
}

/**
 * Fold the panel's votes into one confidence label. PURE — no provider, no I/O,
 * no clock, no randomness. See the module doc for the rule and why `low` requires
 * the dissent to outweigh rather than merely to exist.
 */
export function aggregatePanelVotes(votes: readonly SupportPanelVote[]): SupportPanelTally {
  let supported = 0;
  let unsupported = 0;
  let uncertain = 0;
  let noSignal = 0;
  let uncited = 0;
  for (const v of votes) {
    if (!v.counted || v.judgement === null) {
      if (v.discardReason === "no-signal") noSignal += 1;
      else uncited += 1;
      continue;
    }
    if (v.judgement === "supported") supported += 1;
    else if (v.judgement === "unsupported") unsupported += 1;
    else uncertain += 1;
  }
  const counted = supported + unsupported + uncertain;
  const confidence: SupportPanelConfidence =
    counted === 0
      ? "no-signal"
      : unsupported > supported
        ? "low"
        : unsupported > 0 || uncertain > 0
          ? "medium"
          : "high";
  return {
    confidence,
    countedVotes: counted,
    supportedVotes: supported,
    unsupportedVotes: unsupported,
    uncertainVotes: uncertain,
    noSignalVotes: noSignal,
    uncitedVotes: uncited,
  };
}

/**
 * Order votes by the canonical lens order so the persisted array — and every
 * report built from it — reads the same way regardless of which lens's provider
 * call happened to settle first.
 */
export function orderVotesByLens(votes: readonly SupportPanelVote[]): SupportPanelVote[] {
  const rank = new Map(SUPPORT_PANEL_LENSES.map((l, i) => [l, i] as const));
  return [...votes].sort((a, b) => (rank.get(a.lens) ?? 99) - (rank.get(b.lens) ?? 99));
}
