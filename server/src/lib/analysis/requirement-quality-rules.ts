/**
 * #2235 (Epic #2227) — the deterministic first pass over a requirement's
 * source text, run before any model is asked about it.
 *
 * Three lexical rules of the INCOSE Guide to Writing Requirements (GtWR) —
 * R7 vague terms, R8 escape clauses, R9 open-ended clauses — and one
 * placeholder check (TBD / TBC) for ISO/IEC/IEEE 29148 §5.2.5's "complete".
 * Each hit names the rule, the source's own words and their offsets, so the
 * question about it can quote the paragraph. A model then explains what was
 * flagged and decides whether asking would change the outcome
 * (`clarification-dialog.ts`); this pass only finds the words.
 *
 * The phrase lists follow the GtWR's published examples. "any", "all",
 * "about" and "common" are left out on purpose: the last two mostly mean
 * "concerning" and "shared" in a business document, and "any" and "all" are
 * usually universal quantifiers (GtWR treats them under a separate rule).
 * Flagging every "any user" would bury the real questions.
 *
 * Every pattern is built once from the fixed lists below — never from input —
 * and is an alternation of literals, so matching is linear in the text.
 */
import type { Ambiguity } from "./types/requirements.js";

export type QualityRuleId = "R7" | "R8" | "R9" | "TBD";

export interface QualityRule {
  id: QualityRuleId;
  /** What the rule calls the problem, in the analyst's words. */
  label: string;
  /** The ISO/IEC/IEEE 29148 §5.2.5 characteristics a hit puts at risk. */
  characteristics: readonly string[];
  /** Why it matters, appended to the ambiguity's description. */
  consequence: string;
  phrases: readonly string[];
}

export const QUALITY_RULES: Readonly<Record<QualityRuleId, QualityRule>> = {
  R7: {
    id: "R7",
    label: "Vague term",
    characteristics: ["unambiguous", "verifiable"],
    consequence: "no test can show whether the system meets it as written",
    phrases: [
      "some",
      "several",
      "many",
      "a lot of",
      "a few",
      "almost always",
      "very nearly",
      "nearly",
      "close to",
      "almost",
      "approximately",
      "approximate",
      "relevant",
      "routine",
      "generic",
      "significant",
      "flexible",
      "expandable",
      "typical",
      "typically",
      "sufficient",
      "adequate",
      "appropriate",
      "efficient",
      "effective",
      "reasonable",
      "user-friendly",
      "easy",
      "easily",
      "fast",
      "quickly",
      "quick",
      "robust",
      "timely",
      "intuitive",
      "seamless",
      "seamlessly",
      "minimal",
      "large",
      "small",
    ],
  },
  R8: {
    id: "R8",
    label: "Escape clause",
    characteristics: ["verifiable", "unambiguous"],
    consequence: "it lets the requirement be met by not meeting it",
    phrases: [
      "so far as is possible",
      "as far as possible",
      "as little as possible",
      "as much as possible",
      "where possible",
      "wherever possible",
      "if possible",
      "if it should prove necessary",
      "if necessary",
      "where necessary",
      "to the extent necessary",
      "as appropriate",
      "where appropriate",
      "as required",
      "to the extent practical",
      "if practicable",
      "if needed",
    ],
  },
  R9: {
    id: "R9",
    label: "Open-ended clause",
    characteristics: ["complete", "unambiguous"],
    consequence: "the list it opens has no end, so its scope cannot be known",
    phrases: ["including but not limited to", "but not limited to", "etc.", "and so on", "and/or"],
  },
  TBD: {
    id: "TBD",
    label: "Placeholder",
    characteristics: ["complete"],
    consequence: "the document has not decided it yet",
    phrases: ["TBD", "TBC", "TBA", "to be determined", "to be confirmed", "to be decided"],
  },
};

const RULE_ORDER: readonly QualityRuleId[] = ["R7", "R8", "R9", "TBD"];

/** One hit: the rule, and the source's own words with their offsets. */
export interface QualityFlag {
  rule: QualityRuleId;
  /** `text.slice(start, end)`: the source's words, not a normalised copy. */
  term: string;
  start: number;
  end: number;
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A phrase as a pattern: its words literal, any run of whitespace between them. */
function phrasePattern(phrase: string): string {
  return phrase.trim().split(/\s+/).map(escapeLiteral).join("\\s+");
}

/**
 * One pattern over every phrase of every rule, longest phrase first so "as
 * much as possible" wins over a shorter phrase at the same place. Each
 * alternative is a named-free group; the rule is looked up from the match.
 */
const PHRASES: ReadonlyArray<{ rule: QualityRuleId; phrase: string }> = RULE_ORDER.flatMap((rule) =>
  QUALITY_RULES[rule].phrases.map((phrase) => ({ rule, phrase })),
).sort((a, b) => b.phrase.length - a.phrase.length);

const MATCHER = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${PHRASES.map((p) => phrasePattern(p.phrase)).join("|")})(?![\\p{L}\\p{N}])`,
  "giu",
);

/** Collapse whitespace and fold case, so a matched term finds its phrase. */
function normalise(s: string): string {
  return s.replace(/\s+/g, " ").toLowerCase();
}

const RULE_BY_PHRASE = new Map(PHRASES.map((p) => [normalise(p.phrase), p.rule]));

/**
 * Every GtWR R7 / R8 / R9 and placeholder hit in `text`, in source order.
 * A term repeated under the same rule is reported once, at its first place.
 */
export function findQualityFlags(text: string): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MATCHER)) {
    const term = m[0];
    const rule = RULE_BY_PHRASE.get(normalise(term));
    if (!rule) continue;
    const key = qualityFlagField({ rule, term });
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push({ rule, term, start: m.index, end: m.index + term.length });
  }
  return flags;
}

/** The ambiguity field a flag is recorded under: `R7:fast`. Stable across rounds. */
export function qualityFlagField(flag: Pick<QualityFlag, "rule" | "term">): string {
  return `${flag.rule}:${normalise(flag.term)}`;
}

/**
 * Each flag as an ambiguity of its requirement, so the clarification dialog
 * asks about it, credits its answer and counts it like any other. The
 * description is the rule's own words; the question is the model's to write.
 */
export function qualityFlagAmbiguities(flags: readonly QualityFlag[]): Ambiguity[] {
  return flags.map((flag) => {
    const rule = QUALITY_RULES[flag.rule];
    const source = flag.rule === "TBD" ? "ISO/IEC/IEEE 29148" : `INCOSE GtWR ${flag.rule}`;
    return {
      field: qualityFlagField(flag),
      description:
        `${rule.label} "${flag.term.replace(/\s+/g, " ")}" (${source}): ${rule.consequence}. ` +
        `At risk under ISO/IEC/IEEE 29148 §5.2.5: ${rule.characteristics.join(", ")}.`,
      suggestedQuestion: "",
      rule: flag.rule,
      term: flag.term.replace(/\s+/g, " "),
    };
  });
}
