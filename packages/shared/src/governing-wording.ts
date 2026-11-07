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
/** A framework, or "the policy", after a preposition ("compliant with the policy"). */
const TARGET = String.raw`(?:${FRAMEWORK}|\bthe\s+policy\b)`;
const SEP = String.raw`[\s-]+`;
/**
 * A negation just before the phrase makes it something other than a claim of
 * compliance. Variable-length lookbehind (ES2018).
 */
const NOT_NEGATED = String.raw`(?<!\b(?:not|non|never|isn't|aren't|wasn't)[\s-]+(?:yet[\s-]+)?(?:fully[\s-]+)?)`;

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
    // "complies with HIPAA", "fully complies with GDPR", "passes SOC 2", "passed SOC2"
    pattern: new RegExp(
      String.raw`${NOT_NEGATED}\b(?:fully\s+)?(?:compl(?:ies|ied)\s+with|pass(?:es|ed))\s+(?<target>${TARGET})`,
      "gi",
    ),
    rewrite: ({ target }) => `was checked against ${target}`,
  },
];

interface ClaimMatch {
  match: string;
  index: number;
  replacement: string;
}

/**
 * Every claim in `text`, earliest first. Where two shapes overlap ("fully
 * GDPR-compliant" holds "GDPR-compliant") the earlier start wins; no two shapes
 * can match at the same offset, as each starts on a different kind of word.
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
  const parts: string[] = [];
  let from = 0;
  for (const claim of scanClaims(text)) {
    parts.push(text.slice(from, claim.index), claim.replacement);
    from = claim.index + claim.match.length;
  }
  parts.push(text.slice(from));
  return parts.join("");
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
    .join(" ");
  const scope = `against ${applicable} of ${total} applicable ${total === 1 ? "rule" : "rules"} in ${document}`;
  if (gaps === 0 && needsInput === 0) {
    return `No gaps found ${scope}. ${GOVERNING_AUDIT_DISCLAIMER}`;
  }
  const open = needsInput > 0 ? `; ${plural(needsInput, "rule needs", "rules need")} BA input` : "";
  return `${plural(gaps, "gap", "gaps")} found ${scope}${open}. ${GOVERNING_AUDIT_DISCLAIMER}`;
}
