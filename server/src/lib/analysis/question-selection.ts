/**
 * #2235 (Epic #2227) — which generated clarifying questions are asked, in
 * what order, and which are set aside. Deterministic: the model classifies
 * each question (`uncertainty`, `divergent`, `impact`); this module decides.
 *
 *   - `unanswerable` — no one available can settle it now: set aside as an
 *     open item, never asked (ConfuseBench's "abstain").
 *   - `divergent: false` — every plausible reading builds the same thing, so
 *     the answer would not change the outcome: set aside (ClarifyGPT: ask only
 *     when readings diverge).
 *   - everything else is ranked — the ticked items first (#1129), then by
 *     impact, then by the requirement's priority — and the first
 *     {@link MAX_QUESTIONS_PER_ROUND} are asked. The rest stay open for the
 *     next round and are counted on the round (`notAsked`).
 *
 * A question the model did not classify is asked, as before #2235: METIS is
 * recall-first (#1101), so a missing verdict never hides a question.
 */
import type {
  ClarifyingQuestion,
  QuestionCitation,
  QuestionImpact,
  RequirementEnhancementPriority,
  SetAsideQuestion,
  StructuredRequirement,
} from "./types/requirements.js";

/** The most ambiguity questions one round asks. Governing questions are not counted. */
export const MAX_QUESTIONS_PER_ROUND = 8;

/** A generated question, before selection: `divergent` is the model's call, not persisted. */
export type GeneratedQuestion = ClarifyingQuestion & { divergent?: boolean };

export interface QuestionSelection {
  ask: ClarifyingQuestion[];
  setAside: Array<Omit<SetAsideQuestion, "round">>;
  /** Worth asking, but over this round's cap. */
  notAsked: ClarifyingQuestion[];
}

const IMPACT_RANK: Record<QuestionImpact, number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_RANK: Record<RequirementEnhancementPriority, number> = {
  "must-have": 0,
  "should-have": 1,
  "nice-to-have": 2,
};

function withoutVerdict(q: GeneratedQuestion): ClarifyingQuestion {
  const { divergent: _divergent, ...question } = q;
  return question;
}

function setAsideOf(
  q: GeneratedQuestion,
  reason: SetAsideQuestion["reason"],
): Omit<SetAsideQuestion, "round"> {
  return {
    requirementId: q.requirementId,
    ambiguityField: q.ambiguityField,
    question: q.question,
    context: q.context,
    reason,
    ...(q.options && q.options.length > 0 ? { options: q.options } : {}),
    ...(q.citation ? { citation: q.citation } : {}),
  };
}

export function selectQuestionsToAsk(
  questions: readonly GeneratedQuestion[],
  opts: {
    cap?: number;
    askFirst?: ReadonlySet<string>;
    priorityOf?: (requirementId: string) => RequirementEnhancementPriority | undefined;
  } = {},
): QuestionSelection {
  const cap = opts.cap ?? MAX_QUESTIONS_PER_ROUND;
  const setAside: QuestionSelection["setAside"] = [];
  const worth: Array<{ q: GeneratedQuestion; at: number }> = [];
  const seen = new Set<string>();

  questions.forEach((q, at) => {
    // One question per ambiguity: a second about the same field is a repeat.
    const key = `${q.requirementId}:${q.ambiguityField}`;
    if (q.ambiguityField && seen.has(key)) return;
    seen.add(key);
    if (q.uncertainty === "unanswerable") setAside.push(setAsideOf(q, "unanswerable"));
    else if (q.divergent === false) setAside.push(setAsideOf(q, "same-outcome"));
    else worth.push({ q, at });
  });

  const first = (q: GeneratedQuestion) => (opts.askFirst?.has(q.requirementId) ? 0 : 1);
  const impact = (q: GeneratedQuestion) => IMPACT_RANK[q.impact ?? "medium"];
  const priority = (q: GeneratedQuestion) => {
    const p = opts.priorityOf?.(q.requirementId);
    return p ? PRIORITY_RANK[p] : PRIORITY_RANK["should-have"];
  };
  worth.sort(
    (a, b) =>
      first(a.q) - first(b.q) ||
      impact(a.q) - impact(b.q) ||
      priority(a.q) - priority(b.q) ||
      a.at - b.at,
  );

  const ranked = worth.map((w) => withoutVerdict(w.q));
  return { ask: ranked.slice(0, cap), setAside, notAsked: ranked.slice(cap) };
}

/** Whole-word match: "fast" is not in "breakfast". */
export function holdsWord(text: string, term: string): boolean {
  // A plain search with boundary checks, not a RegExp built from the term
  // (Semgrep: a pattern built from data risks ReDoS).
  if (term.length === 0) return false;
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    // Two code units either side cover a character outside the BMP.
    const before = text.slice(Math.max(0, at - 2), at);
    const after = text.slice(at + term.length, at + term.length + 2);
    if (!ENDS_IN_WORD_CHAR.test(before) && !STARTS_WITH_WORD_CHAR.test(after)) return true;
  }
  return false;
}

/** Text that ends with a letter or digit, in any script. */
const ENDS_IN_WORD_CHAR = /[\p{L}\p{N}]$/u;
/** Text that begins with a letter or digit, in any script. */
const STARTS_WITH_WORD_CHAR = /^[\p{L}\p{N}]/u;

/**
 * The paragraph a question about `ambiguityField` cites: for a GtWR hit, the
 * source paragraph that holds its term; otherwise the requirement's first.
 * Undefined when the requirement has no verified source.
 */
export function citationFor(
  requirement: Pick<StructuredRequirement, "sources" | "ambiguities"> | undefined,
  ambiguityField: string,
): QuestionCitation | undefined {
  const sources = requirement?.sources ?? [];
  if (sources.length === 0) return undefined;
  const term = requirement?.ambiguities
    ?.find((a) => a.field === ambiguityField)
    ?.term?.toLowerCase();
  const held = term
    ? sources.find((s) => holdsWord(s.quote.replace(/\s+/g, " ").toLowerCase(), term))
    : undefined;
  const { ref: _ref, ...citation } = held ?? sources[0]!;
  return citation;
}
