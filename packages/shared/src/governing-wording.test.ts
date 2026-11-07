import { describe, expect, it } from "vitest";
import {
  findForbiddenComplianceClaims,
  governingSummarySentence,
  neutraliseComplianceClaims,
} from "./governing-wording.js";

/** Each phrase is embedded in a sentence so the guard is tested on prose, not on bare tokens. */
const FORBIDDEN: readonly string[] = [
  "SOC 2 compliant",
  "SOC-2 Compliant",
  "soc2 certified",
  "fully GDPR-compliant",
  "GDPR compliant",
  "HIPAA compliant",
  "HIPAA-certified",
  "PCI DSS compliant",
  "PCI-DSS certified",
  "ISO 27001 certified",
  "ISO/IEC 27001 certification",
  "SOC 1 attested",
  "SOC 3 certification",
  "SOC 2 Type II compliant",
  "SOC II certified",
  "fully compliant",
  "Fully-Compliant",
  "passes SOC 2",
  "passed SOC2",
  "compliant with GDPR",
  "compliant with the policy",
  "complies with HIPAA",
  "certified against ISO 27001",
  "attested to SOC 1",
];

const NEUTRAL: readonly string[] = [
  "This maps to SOC 2 control CC6.1 on logical access.",
  "There is a gap against the GDPR retention rule.",
  "HIPAA requires audit logging of every PHI access.",
  "The vendor supplied its SOC 2 Type II report.",
  "ISO 27001 Annex A.8.15 covers logging.",
  "PCI DSS requirement 3.4 covers stored card numbers.",
  "The policy requires encryption at rest.",
  "Our certified engineers reviewed the SOC 2 criteria.",
  "The GDPR compliance team owns this rule.",
  "The system must comply with GDPR Article 17.",
  "No gaps found against 12 of 40 applicable rules in Information Security Policy v3. Not an audit opinion.",
];

describe("findForbiddenComplianceClaims (#1875)", () => {
  it.each(FORBIDDEN)("detects %j", (phrase) => {
    const text = `The new export feature is ${phrase} as of today.`;
    expect(findForbiddenComplianceClaims(text)).toEqual([
      { match: phrase, index: text.indexOf(phrase) },
    ]);
  });

  it.each(NEUTRAL)("does not flag %j", (text) => {
    expect(findForbiddenComplianceClaims(text)).toEqual([]);
  });

  it("does not flag a negation, which is not a claim of compliance", () => {
    expect(
      findForbiddenComplianceClaims(
        "The flow is not SOC 2 compliant yet and is non-compliant with GDPR; it is not fully compliant.",
      ),
    ).toEqual([]);
  });

  it("reports every claim in order with its offset", () => {
    const text = "We are SOC 2 certified and fully compliant with GDPR.";
    expect(findForbiddenComplianceClaims(text)).toEqual([
      { match: "SOC 2 certified", index: 7 },
      { match: "fully compliant with GDPR", index: 27 },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(findForbiddenComplianceClaims("")).toEqual([]);
  });
});

describe("neutraliseComplianceClaims (#1875)", () => {
  it.each(FORBIDDEN)("leaves no claim behind for %j", (phrase) => {
    const out = neutraliseComplianceClaims(`The new export feature is ${phrase} as of today.`);
    expect(findForbiddenComplianceClaims(out)).toEqual([]);
    expect(out).not.toMatch(/\bcompliant\b|\bcertified\b|\bcertification\b|\battested\b/i);
    expect(out.startsWith("The new export feature is ")).toBe(true);
    expect(out.endsWith(" as of today.")).toBe(true);
  });

  it.each(NEUTRAL)("leaves neutral text untouched: %j", (text) => {
    expect(neutraliseComplianceClaims(text)).toBe(text);
  });

  it.each([
    ["The system is SOC 2 compliant.", "The system is SOC 2-reviewed."],
    ["a fully GDPR-compliant design", "a GDPR-reviewed design"],
    ["It has ISO/IEC 27001 certification.", "It has ISO/IEC 27001 review."],
    ["It is compliant with the policy.", "It is checked against the policy."],
    ["It is fully compliant with HIPAA.", "It is checked against HIPAA."],
    ["The feature is fully compliant.", "The feature is reviewed."],
    [
      "The app passes SOC 2 certified controls.",
      "The app was checked against SOC 2-reviewed controls.",
    ],
    [
      "It is compliant with HIPAA compliant hosting.",
      "It is checked against HIPAA-reviewed hosting.",
    ],
    ["It is compliant with the GDPR.", "It is checked against the GDPR."],
    [
      "Compliant with the Information Security Policy.",
      "Checked against the Information Security Policy.",
    ],
    ["The app passes SOC 2.", "The app was checked against SOC 2."],
    ["The design complies with GDPR.", "The design was checked against GDPR."],
    ["Certified against ISO 27001.", "Checked against ISO 27001."],
  ])("rewrites %j as %j", (input, expected) => {
    expect(neutraliseComplianceClaims(input)).toBe(expected);
  });

  it("rewrites every claim in a passage and is idempotent", () => {
    const text = "We are SOC 2 certified, HIPAA compliant and fully compliant with GDPR.";
    const once = neutraliseComplianceClaims(text);
    expect(once).toBe("We are SOC 2-reviewed, HIPAA-reviewed and checked against GDPR.");
    expect(neutraliseComplianceClaims(once)).toBe(once);
  });
});

/** A small seeded PRNG so the property run is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = [
  "Information Security Policy",
  "SOC 2 Compliant Controls",
  "Fully Compliant Retention Standard",
  "GDPR-compliant Data Handling",
  "HIPAA Certified Vendor Rules",
  "Payments (PCI DSS) Policy",
  "Compliant Vendor Rules",
  "Non-compliant Vendor List",
  "Not SOC 2 Compliant Systems",
  "Compliant with HIPAA Compliant Hosting Standard",
];
const REVISIONS = ["v3", "2026-01", "", "rev 4 (SOC 2 certified)"];

describe("curly apostrophe negation (#1875)", () => {
  it("leaves a typographic-apostrophe negation alone", () => {
    expect(neutraliseComplianceClaims("It isn\u2019t SOC 2 compliant.")).toBe(
      "It isn\u2019t SOC 2 compliant.",
    );
  });
});

describe("governingSummarySentence (#1875)", () => {
  it("drops a missing document name instead of leaving 'in .'", () => {
    expect(
      governingSummarySentence({
        applicable: 1,
        total: 2,
        gaps: 0,
        needsInput: 0,
        documentTitle: " ",
        revisionLabel: "",
      }),
    ).toBe("No gaps found against 1 of 2 applicable rules. Not an audit opinion.");
  });

  it("reads as the agreed sentence when nothing is open", () => {
    expect(
      governingSummarySentence({
        applicable: 12,
        total: 40,
        gaps: 0,
        needsInput: 0,
        documentTitle: "Information Security Policy",
        revisionLabel: "v3",
      }),
    ).toBe(
      "No gaps found against 12 of 40 applicable rules in Information Security Policy v3. Not an audit opinion.",
    );
  });

  it("states the gap count, not 'No gaps found', when there are gaps", () => {
    const sentence = governingSummarySentence({
      applicable: 12,
      total: 40,
      gaps: 3,
      needsInput: 2,
      documentTitle: "Information Security Policy",
      revisionLabel: "v3",
    });
    expect(sentence).toBe(
      "3 gaps found against 12 of 40 applicable rules in Information Security Policy v3; 2 rules need BA input. Not an audit opinion.",
    );
  });

  it("uses the singular for one gap, one rule needing input and one rule in total", () => {
    expect(
      governingSummarySentence({
        applicable: 1,
        total: 1,
        gaps: 1,
        needsInput: 1,
        documentTitle: "Retention Standard",
        revisionLabel: "",
      }),
    ).toBe(
      "1 gap found against 1 of 1 applicable rule in Retention Standard; 1 rule needs BA input. Not an audit opinion.",
    );
  });

  it("does not say 'No gaps found' while rules still need BA input", () => {
    const sentence = governingSummarySentence({
      applicable: 5,
      total: 9,
      gaps: 0,
      needsInput: 2,
      documentTitle: "Access Policy",
      revisionLabel: "v1",
    });
    expect(sentence).toBe(
      "0 gaps found against 5 of 9 applicable rules in Access Policy v1; 2 rules need BA input. Not an audit opinion.",
    );
  });

  it("neutralises a claim carried in the document title or revision label", () => {
    const sentence = governingSummarySentence({
      applicable: 2,
      total: 3,
      gaps: 0,
      needsInput: 0,
      documentTitle: "SOC 2 Compliant Controls",
      revisionLabel: "rev 4 (SOC 2 certified)",
    });
    expect(sentence).toBe(
      "No gaps found against 2 of 3 applicable rules in SOC 2-reviewed Controls rev 4 (SOC 2-reviewed). Not an audit opinion.",
    );
  });

  it("property: over generated inputs it ends with the disclaimer, never says 'compliant' and states gaps", () => {
    const rand = mulberry32(1875);
    const int = (max: number) => Math.floor(rand() * (max + 1));
    for (let i = 0; i < 2000; i += 1) {
      const total = int(200);
      const applicable = int(total);
      const gaps = rand() < 0.4 ? 0 : int(applicable);
      const needsInput = rand() < 0.5 ? 0 : int(applicable);
      const input = {
        applicable,
        total,
        gaps,
        needsInput,
        documentTitle: TITLES[int(TITLES.length - 1)]!,
        revisionLabel: REVISIONS[int(REVISIONS.length - 1)]!,
      };
      const sentence = governingSummarySentence(input);
      expect(sentence.endsWith(" Not an audit opinion.")).toBe(true);
      expect(sentence).not.toMatch(/compliant/i);
      expect(findForbiddenComplianceClaims(sentence)).toEqual([]);
      if (gaps > 0) {
        expect(sentence.startsWith(`${gaps} gap`)).toBe(true);
        expect(sentence).not.toContain("No gaps found");
      }
      if (gaps === 0 && needsInput === 0) {
        expect(sentence.startsWith("No gaps found against ")).toBe(true);
      }
      expect(sentence).toContain(` ${applicable} of ${total} applicable rule`);
    }
  });
});
