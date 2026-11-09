/**
 * #2060 (Epic #1866) — the one source of the governing-findings e2e fixture.
 *
 * `server/scripts/e2e-seed-governing.ts` seeds these values and
 * `e2e/tests/analysis-governing-findings.spec.ts` asserts them, so the two
 * cannot drift. The seed stores a workspace governing document whose current
 * revision has these rules extracted (cited by offsets into `POLICY_TEXT`), and
 * a completed analysis whose stored applicability, governing findings and open
 * clarification round are what a real run with the feature on would leave.
 *
 * Why seeded: the e2e stack runs the `offline-stub` provider, whose prose no
 * rule extraction, applicability screen or findings check can read, so no
 * governing finding is ever reached by running the pipeline (`e2e/README.md`).
 */

export interface GoverningFixtureRule {
  /** The key the spec names a rule by; never stored. */
  key: "access" | "retention" | "transfer" | "logging";
  controlId: string;
  summary: string;
  clauseRef: string;
  /** Verbatim in `POLICY_TEXT`: the seed stores its offsets. */
  clauseExcerpt: string;
  category: string;
  /** What applicability decided for the fixture's requirement. */
  verdict: "applies" | "does-not-apply" | "uncertain";
  /** The finding the rule produced; null for a rule that does not apply. */
  finding: {
    status: "compliant" | "gap" | "needs-ba-input";
    reasoning: string;
    businessQuestion?: string;
  } | null;
}

export const GOVERNING_FIXTURE = {
  documentTitle: "Customer Data Handling Policy",
  framework: "Internal policy",
  revisionLabel: "v2",
  /** The analysis's one requirement the rules were judged against. */
  requirementId: "REQ-GOV-2060",
  requirementText:
    "Account managers can export a customer's order history as a CSV file and share it with the regional office.",
  /** The business fact that would settle the uncertain rule (#1872). */
  businessFact: "Where the regional office that receives the export is located.",
  /** The open clarifying question that settles the uncertain rule. */
  questionId: "q-governing-2060",
  question: "Is the regional office located outside the country where the customer's data is held?",
  /** Notes the spec types into Accept and Reject. */
  acceptNote: "Confirmed with the data owner on the export review (e2e #2060).",
  rejectNote: "Exports keep 90 days of history only, see the export spec (e2e #2060).",
  /** The mock admin's display name (`fixtures/seed-user.ts`), shown as the decider. */
  deciderName: "System Admin",
} as const;

export const GOVERNING_RULES: readonly GoverningFixtureRule[] = [
  {
    key: "access",
    controlId: "AC-2",
    summary: "Customer data exports are limited to staff with an assigned account role.",
    clauseRef: "§2.1",
    clauseExcerpt:
      "Only staff holding an assigned account role may export customer records from a production system.",
    category: "access-control",
    verdict: "applies",
    finding: {
      status: "compliant",
      reasoning:
        "The requirement limits the export to account managers, who hold an assigned account role.",
    },
  },
  {
    key: "retention",
    controlId: "DR-4",
    summary: "Exported customer files state how long they are kept and are deleted after it.",
    clauseRef: "§4.3",
    clauseExcerpt:
      "Every exported file of customer records must state its retention period and be deleted when that period ends.",
    category: "data-retention",
    verdict: "applies",
    finding: {
      status: "gap",
      reasoning:
        "The requirement creates a CSV export but says nothing about how long the file is kept or when it is deleted.",
    },
  },
  {
    key: "transfer",
    controlId: "PV-7",
    summary: "Customer data sent outside its home country needs a transfer assessment.",
    clauseRef: "§7.2",
    clauseExcerpt:
      "Customer records sent to an office outside the country where they are held require a completed transfer assessment first.",
    category: "privacy",
    verdict: "uncertain",
    finding: {
      status: "needs-ba-input",
      reasoning:
        "Whether this rule applies depends on where the regional office is, which the requirement does not say.",
      businessQuestion: "Where is the regional office that receives the export?",
    },
  },
  {
    key: "logging",
    controlId: "LG-1",
    summary: "Payment card numbers never appear in application logs.",
    clauseRef: "§9.1",
    clauseExcerpt: "Application logs must never contain a full payment card number.",
    category: "logging",
    verdict: "does-not-apply",
    finding: null,
  },
];

/** The revision's extracted text: every rule's clause excerpt appears in it verbatim. */
export const POLICY_TEXT = [
  `${GOVERNING_FIXTURE.documentTitle} ${GOVERNING_FIXTURE.revisionLabel}`,
  ...GOVERNING_RULES.map((r) => `${r.clauseRef} ${r.clauseExcerpt}`),
].join("\n\n");

/** The rules that produced a finding, in the order the findings route lists them (control id). */
export function rulesWithFindings(): GoverningFixtureRule[] {
  return GOVERNING_RULES.filter((r) => r.finding !== null).sort((a, b) =>
    a.controlId.localeCompare(b.controlId),
  );
}

export function fixtureRule(key: GoverningFixtureRule["key"]): GoverningFixtureRule {
  const rule = GOVERNING_RULES.find((r) => r.key === key);
  if (!rule) throw new Error(`no governing fixture rule ${key}`);
  return rule;
}
