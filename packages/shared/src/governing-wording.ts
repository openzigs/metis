/**
 * Issue #1875 (epic #1866) — the wording guard for governing-document findings.
 *
 * METIS checks requirements against a company's governing documents (policies, a
 * customer's own copy of SOC 2 criteria, regulatory obligations). An LLM rule
 * check is not an audit, and SOC 2 is an attestation report, not a certification,
 * so METIS must never say a requirement, feature or system is "SOC 2 compliant",
 * "GDPR certified" or similar — not in the findings summary (#1876), not in model
 * prose stored on a finding (#1874), not in the BRD section (#1877).
 *
 *   - `governingSummarySentence` is the one sentence the UI shows.
 *   - `findForbiddenComplianceClaims` locates claims in free text.
 *   - `neutraliseComplianceClaims` rewrites them to neutral wording.
 *
 * Neutral phrasing that merely NAMES a framework is left alone ("SOC 2 control
 * CC6.1", "a gap against the GDPR retention rule", "must comply with GDPR"), and
 * so is a negation ("not SOC 2 compliant", "non-compliant with GDPR"): neither
 * claims compliance.
 */

/** The disclaimer every governing summary ends with. */
export const GOVERNING_AUDIT_DISCLAIMER = "Not an audit opinion.";

/** SOC 1/2/3 (also `SOC-2`, `soc2`, `SOC II`), with an optional `Type I/II`. */
const SOC = String.raw`\bsoc[\s-]?(?:[123]|i{1,3})\b(?:[\s-]+type[\s-]+(?:ii?|[12])\b)?`;
const ISO = String.raw`\biso(?:\s*\/\s*iec)?[\s-]?27001(?::\d{4})?\b`;
const PCI = String.raw`\bpci(?:[\s-]?dss)?\b`;
/** A framework that can precede the claim word ("SOC 2 compliant"). */
const FRAMEWORK = String.raw`(?:${SOC}|${ISO}|\bgdpr\b|\bhipaa\b|${PCI})`;
/**
 * FRAMEWORK matched atomically (a lookahead capture plus a backreference), so a
 * following negative lookahead cannot make it backtrack to a shorter name:
 * "SOC 2 Type II" must not shrink to "SOC 2" (#1919). `name` is unique per use.
 */
const ATOMIC_FRAMEWORK = (name: string): string =>
  String.raw`(?=(?<${name}>${FRAMEWORK}))\k<${name}>`;
/** A framework, or "the policy", after a preposition ("compliant with the policy"). */
const TARGET = String.raw`(?:(?:the\s+)?${FRAMEWORK}|\bthe\s+(?:[\w-]+\s+){0,4}policy\b)`;
const SEP = String.raw`[\s-]+`;
/**
 * A negation just before the phrase makes it something other than a claim of
 * compliance, also across a few adverbs ("hasn't successfully passed SOC 2",
 * "not currently SOC 2 compliant"; #1919). Only an allowlist of adverbs that
 * carry the negation counts: an open "any -ly word" pattern would let "not
 * solely SOC 2 compliant", "not exclusively compliant with GDPR" and verbs such
 * as "do not apply SOC 2 compliant controls" pass as negations. Variable-length
 * lookbehind (ES2018).
 */
const NOT_NEGATED = String.raw`(?<!\b(?:not|non|never|isn['’]t|aren['’]t|wasn['’]t|hasn['’]t|haven['’]t|hadn['’]t)[\s-]+(?:(?:yet|already|ever|still|fully|currently|successfully|formally|officially|actually|really|necessarily|entirely|completely)[\s-]+){0,3})`;
/**
 * Where a phrase ends: the end of the text, punctuation other than a hyphen or a
 * possessive `'s` (both join on to the next word: "policy-mandated", "policy's
 * limit"; #1919), a spaced dash, or a word that starts a new clause.
 */
const PHRASE_ENDS = String.raw`(?=\s*$|\s*(?!['’]s\b)[^\w\s-]|\s+-|\s+(?:and|or|but|so|as|with|in|on|at|for|since|today|now|already|without)\b)`;
/** Pronouns whose `'s` can only be "has" ("it's passed SOC 2"), never a possessive. */
const PRONOUN_S = String.raw`(?<=\b(?:it|that|this|he|she|who|what|which|there|one|everyone|everything|someone|something|nothing))['’]s\s+`;
/**
 * #1901 — a perfect-tense auxiliary right before "passed" / "complied with"
 * ("has passed SOC 2"), with up to three adverbs ("has only partly complied";
 * #1919). The rewrite keeps it and uses the participle: "has been checked
 * against SOC 2". After a noun, `'s` followed by "passed <framework> <noun>" is
 * a possessive ("the vendor's passed SOC 2 report"), not "has" (#1919).
 */
const PERFECT_AUX = String.raw`(?<aux>\b(?:has|have|had)\s+|['’](?:ve|d)\s+|${PRONOUN_S}|['’]s\s+(?!passed\s+(?:the\s+)?${ATOMIC_FRAMEWORK("auxFw")}(?!${PHRASE_ENDS})))(?:(?:[a-z]+ly|already|now|also|since|just|still|ever|once)\s+){0,3}`;
/**
 * #1901 — "the … policy" after "passes" is a claim only when the phrase ends
 * there ("passes the policy.", "passes the policy and ships"). Followed by
 * another noun it is a modifier, and "passes" means "goes beyond": "the value
 * passes the policy limit" claims nothing. #1919 — "requirements" / "controls"
 * stay in the target ("passes the policy requirements"), and a claim-completing
 * noun ends the phrase and is dropped from the rewrite ("passes the policy
 * check" becomes "was checked against the policy").
 */
const POLICY_TARGET = String.raw`\bthe\s+(?:[\w-]+\s+){0,4}policy\b(?:(?:['’]s)?\s+(?:requirements?|controls?)\b)?`;
const CLAIM_NOUN = String.raw`(?:(?:['’]s)?\s+(?:checks?|reviews?|audits?|assessments?)\b)?`;
/** What "passes" can claim to pass: a framework, or a "the … policy" phrase that ends there. */
const PASS_TARGET = String.raw`(?:(?<passFw>(?:the\s+)?${FRAMEWORK})|(?<passPolicy>${POLICY_TARGET})${CLAIM_NOUN}${PHRASE_ENDS})`;

interface ClaimShape {
  pattern: RegExp;
  /** The neutral wording for one match; `groups` are the pattern's named groups. */
  rewrite: (groups: Record<string, string | undefined>) => string;
}

const CLAIM_SHAPES: readonly ClaimShape[] = [
  {
    // "fully compliant", "fully GDPR-compliant", "fully compliant with the policy"
    pattern: new RegExp(
      String.raw`${NOT_NEGATED}\bfully${SEP}(?:(?<fw>${FRAMEWORK})${SEP}compliant\b|compliant\b(?:\s+(?:with|to)\s+(?<target>${TARGET}))?)`,
      "gi",
    ),
    rewrite: ({ fw, target }) =>
      fw ? `${fw}-reviewed` : target ? `checked against ${target}` : "reviewed",
  },
  {
    // "SOC 2 compliant", "HIPAA-certified", "SOC 1 attested", "ISO 27001 certification"
    pattern: new RegExp(
      String.raw`${NOT_NEGATED}(?<fw>${FRAMEWORK})${SEP}(?<word>compliant|certified|certification|attested)\b`,
      "gi",
    ),
    rewrite: ({ fw, word }) =>
      word?.toLowerCase() === "certification" ? `${fw} review` : `${fw}-reviewed`,
  },
  {
    // "compliant with GDPR", "certified against ISO 27001", "attested to SOC 1"
    pattern: new RegExp(
      String.raw`${NOT_NEGATED}\b(?:compliant|certified|attested)\s+(?:with|to|against|for|under)\s+(?<target>${TARGET})`,
      "gi",
    ),
    rewrite: ({ target }) => `checked against ${target}`,
  },
  {
    // "has passed SOC 2", "has complied with GDPR", "have fully complied with the policy"
    pattern: new RegExp(
      String.raw`${NOT_NEGATED}${PERFECT_AUX}(?:complied\s+with\s+(?<target>${TARGET})|passed\s+${PASS_TARGET})`,
      "gi",
    ),
    rewrite: ({ aux, target, passFw, passPolicy }) =>
      `${aux ?? ""}been checked against ${target ?? passFw ?? passPolicy}`,
  },
  {
    // #1919 — a possessive before an adjectival "passed": "the vendor's passed
    // SOC 2 report" becomes "the vendor's SOC 2-reviewed report". It starts on
    // "passed", as the next shape does, and wins the tie by coming first.
    pattern: new RegExp(
      String.raw`${NOT_NEGATED}(?<=\w['’]s\s+)passed\s+(?<fw>${ATOMIC_FRAMEWORK("possFw")})(?!${PHRASE_ENDS})`,
      "gi",
    ),
    rewrite: ({ fw }) => `${fw}-reviewed`,
  },
  {
    // "complies with HIPAA", "fully complies with GDPR", "passes SOC 2", "passed SOC2"
    pattern: new RegExp(
      String.raw`${NOT_NEGATED}\b(?:fully\s+)?(?:compl(?:ies|ied)\s+with\s+(?<target>${TARGET})|pass(?:es|ed)\s+${PASS_TARGET})`,
      "gi",
    ),
    rewrite: ({ target, passFw, passPolicy }) =>
      `was checked against ${target ?? passFw ?? passPolicy}`,
  },
];

interface ClaimMatch {
  match: string;
  index: number;
  replacement: string;
}

/**
 * Every claim in `text`, earliest first. Where two shapes overlap ("fully
 * GDPR-compliant" holds "GDPR-compliant") the earlier start wins. Where two
 * start at the same offset (the possessive shape and "passes SOC 2"), the one
 * listed first in `CLAIM_SHAPES` wins: the sort is stable.
 */
function scanClaims(text: string): ClaimMatch[] {
  const candidates: ClaimMatch[] = [];
  for (const shape of CLAIM_SHAPES) {
    for (const m of text.matchAll(shape.pattern)) {
      const replacement = shape.rewrite(m.groups ?? {});
      candidates.push({ match: m[0], index: m.index, replacement: matchCase(m[0], replacement) });
    }
  }
  candidates.sort((a, b) => a.index - b.index);
  const claims: ClaimMatch[] = [];
  let end = 0;
  for (const c of candidates) {
    if (c.index < end) continue;
    claims.push(c);
    end = c.index + c.match.length;
  }
  return claims;
}

/** Keep a sentence-initial capital: "Certified against X" becomes "Checked against X". */
function matchCase(original: string, replacement: string): string {
  const first = original.charAt(0);
  return first !== first.toLowerCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

/** Every compliance or certification claim in `text`, with its offset, earliest first. */
export function findForbiddenComplianceClaims(text: string): { match: string; index: number }[] {
  return scanClaims(text).map(({ match, index }) => ({ match, index }));
}

/**
 * `text` with every compliance or certification claim rewritten to neutral
 * wording ("SOC 2 compliant" becomes "SOC 2-reviewed", "compliant with GDPR"
 * becomes "checked against GDPR"). Text with no claim is returned unchanged.
 */
export function neutraliseComplianceClaims(text: string): string {
  // Overlapping shapes can leave a claim behind ("passes SOC 2 certified
  // controls"): rewrite again until a scan finds nothing. Each pass removes
  // claim words, so this ends; the cap is a backstop.
  let current = text;
  for (let pass = 0; pass < 10; pass += 1) {
    const next = rewriteOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function rewriteOnce(text: string): string {
  const parts: string[] = [];
  let from = 0;
  for (const claim of scanClaims(text)) {
    parts.push(text.slice(from, claim.index), claim.replacement);
    from = claim.index + claim.match.length;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/**
 * A bare or negated "compliant" ("Compliant Vendor Rules", "Non-compliant
 * Vendor List") is not a claim shape, but the summary sentence promises never to
 * contain the word, so it is replaced in code.
 *
 * #1901 — the promise is substring-level: "compliant" inside a joined form
 * ("Noncompliant Rules", "Compliant_x", "GDPRcompliant") is replaced too, so
 * no spelling of a document title carries the word into the sentence.
 */
function stripBareCompliant(text: string): string {
  return text.replace(/(?:\b(?:non|not)[\s_-]*)?compliant/gi, (m) => matchCase(m, "reviewed"));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The governing-findings summary sentence, e.g. "No gaps found against 12 of 40
 * applicable rules in Information Security Policy v3. Not an audit opinion."
 *
 * "No gaps found" is said only when there are no gaps AND no rule still waits on
 * BA input; otherwise the gap count is stated. The title and revision label are
 * neutralised too, so a document named "SOC 2 Compliant Controls" cannot carry a
 * claim into the sentence.
 */
export function governingSummarySentence(input: {
  applicable: number;
  total: number;
  gaps: number;
  needsInput: number;
  documentTitle: string;
  revisionLabel: string;
}): string {
  const { applicable, total, gaps, needsInput } = input;
  const document = [input.documentTitle.trim(), input.revisionLabel.trim()]
    .filter(Boolean)
    .map(neutraliseComplianceClaims)
    .map(stripBareCompliant)
    .join(" ");
  const where = document ? ` in ${document}` : "";
  const scope = `against ${applicable} of ${total} applicable ${total === 1 ? "rule" : "rules"}${where}`;
  if (gaps === 0 && needsInput === 0) {
    return `No gaps found ${scope}. ${GOVERNING_AUDIT_DISCLAIMER}`;
  }
  const open = needsInput > 0 ? `; ${plural(needsInput, "rule needs", "rules need")} BA input` : "";
  return `${plural(gaps, "gap", "gaps")} found ${scope}${open}. ${GOVERNING_AUDIT_DISCLAIMER}`;
}
