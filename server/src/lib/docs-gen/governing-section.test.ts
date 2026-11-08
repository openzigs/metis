/**
 * #1877 — the governing-rules section of a requirements BRD, built from the
 * stored governing findings (#1874) and worded through the #1875 guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findForbiddenComplianceClaims, type GoverningFinding } from "@metis/shared";

const db = vi.hoisted(() => ({
  requirementFindMany: vi.fn(),
  analysisFindMany: vi.fn(),
  analysisFindFirst: vi.fn(),
  findingFindMany: vi.fn(),
  userFindMany: vi.fn(),
  ruleCount: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: { findMany: db.requirementFindMany },
    analysis: { findMany: db.analysisFindMany, findFirst: db.analysisFindFirst },
    governingFinding: { findMany: db.findingFindMany },
    user: { findMany: db.userFindMany },
    governingRule: { count: db.ruleCount },
    reviewRequest: { findFirst: vi.fn() },
  },
}));

import {
  GOVERNING_SECTION_HEADING,
  governingSectionFacts,
  loadGoverningSection,
  renderGoverningSection,
  type GoverningSection,
  type GoverningSectionRun,
} from "./governing-section.js";
import {
  CODE_LINKS_APPENDIX_HEADING,
  renderRequirementsDocument,
  requirementsSourceFingerprint,
  synthesizeRequirementsDocument,
  type ScopedRequirement,
} from "./requirements-scope.js";

const NOW = new Date("2026-11-08T10:00:00.000Z");

/** A stored `governing_findings` row, as Prisma returns it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gf-1",
    analysisId: "run-1",
    requirementId: "REQ-001",
    ruleId: "rule-card",
    revisionId: "rev-1",
    revisionLabel: "v1",
    documentTitle: "Information Handling Policy",
    controlId: "EN-03",
    clauseRef: "§4.3",
    status: "compliant",
    reasoning: "Only the last four digits are kept.",
    clauseStart: 10,
    clauseEnd: 60,
    clauseExcerpt: "never stores a full payment card number in any system",
    citationDropped: false,
    modelStatus: null,
    businessQuestion: null,
    decision: null,
    decisionNote: null,
    decidedById: null,
    decidedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** The fixture: three findings, one per status, the gap rejected by the analyst. */
const THREE = [
  row({ decision: "accepted", decidedById: "u1", decidedAt: NOW }),
  row({
    id: "gf-2",
    ruleId: "rule-audit",
    controlId: "AL-02",
    clauseRef: "§5.1",
    status: "gap",
    reasoning: "Bulk exports are not mentioned.",
    clauseExcerpt: "Every bulk export of customer records is written to the audit log",
    decision: "rejected",
    decisionNote: "Exports are out of scope for this release.",
    decidedById: "u1",
    decidedAt: NOW,
  }),
  row({
    id: "gf-3",
    requirementId: "REQ-002",
    ruleId: "rule-retention",
    revisionId: "rev-2",
    revisionLabel: "2026.1",
    documentTitle: "Records Retention Standard",
    controlId: "RT-01",
    clauseRef: "§2",
    status: "needs-ba-input",
    reasoning: "Depends on how long statements are kept.",
    clauseExcerpt: "Statements are kept for seven years",
    businessQuestion: "How long are monthly statements kept?",
  }),
];

const APPLICABILITY = {
  decidedAt: NOW.toISOString(),
  requirements: [
    {
      requirementId: "REQ-001",
      text: "Saved cards keep only the last four digits.",
      decisions: [],
    },
    { requirementId: "REQ-002", text: "Customers get a monthly statement.", decisions: [] },
  ],
};

function req(overrides: Partial<ScopedRequirement> = {}): ScopedRequirement {
  return {
    id: "req-1",
    title: "Save a card",
    body: "A customer can save a card for later.",
    type: "feature",
    priority: "high",
    reviewStatus: "approved",
    verdict: "implemented",
    acceptanceCriteria: JSON.stringify(["The saved card shows its last four digits."]),
    version: 1,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    codeMappings: [],
    implementations: [],
    ...overrides,
  };
}

function withFindings(rows: ReturnType<typeof row>[], metadata: unknown = APPLICABILITY) {
  db.requirementFindMany.mockImplementation(async (args: { select?: { analysisId?: true } }) =>
    args.select?.analysisId ? [{ analysisId: "run-1" }] : [req()],
  );
  db.analysisFindMany.mockResolvedValue([{ id: "run-1", startedAt: NOW }]);
  db.analysisFindFirst.mockImplementation(async (args: { select?: { metadata?: true } }) =>
    args.select?.metadata
      ? { metadata: JSON.stringify({ governingApplicability: metadata }) }
      : { startedAt: NOW },
  );
  db.findingFindMany.mockResolvedValue(rows);
}

beforeEach(() => {
  process.env.GOVERNING_DOCS_ENABLED = "1";
  for (const fn of Object.values(db)) fn.mockReset();
  db.userFindMany.mockResolvedValue([
    { id: "u1", displayName: "Alice Analyst", username: "alice" },
  ]);
  db.ruleCount.mockResolvedValue(12);
  db.analysisFindFirst.mockResolvedValue(null);
});
afterEach(() => {
  delete process.env.GOVERNING_DOCS_ENABLED;
});

/** The section's table rows, keyed by control id. */
function tableRows(markdown: string): Map<string, string[]> {
  const section = markdown.slice(markdown.indexOf(GOVERNING_SECTION_HEADING));
  const rows = new Map<string, string[]>();
  for (const line of section.split("\n")) {
    const cells = line.split(" | ").map((c) => c.replace(/^\| ?| ?\|$/g, "").trim());
    if (cells.length === 5 && /^REQ-/.test(cells[0]!)) rows.set(cells[1]!, cells);
  }
  return rows;
}

describe("the governing-rules section in a requirements BRD — #1877", () => {
  it("lists all three findings with control id, excerpt and revision label, the rejected one marked", async () => {
    withFindings(THREE);
    const { markdown } = await synthesizeRequirementsDocument("p1", { analysisId: "run-1" }, "BRD");

    expect(markdown).toContain(GOVERNING_SECTION_HEADING);
    const rows = tableRows(markdown);
    expect([...rows.keys()]).toEqual(["EN-03", "AL-02", "RT-01"]);
    expect(rows.get("EN-03")).toEqual([
      "REQ-001",
      "EN-03",
      "Compliant",
      "Accepted",
      "Information Handling Policy v1",
    ]);
    expect(rows.get("AL-02")).toEqual([
      "REQ-001",
      "AL-02",
      "Gap",
      "Rejected",
      "Information Handling Policy v1",
    ]);
    expect(rows.get("RT-01")).toEqual([
      "REQ-002",
      "RT-01",
      "Needs BA input",
      "Not decided",
      "Records Retention Standard 2026.1",
    ]);
    // Each finding's own entry: control id, status, decision, revision and verified excerpt.
    expect(markdown).toContain(
      "**AL-02 — Gap.** Decision: **Rejected** by Alice Analyst on 2026-11-08. Rule of Information Handling Policy, revision v1, clause §5.1.",
    );
    expect(markdown).toContain(
      "> “Every bulk export of customer records is written to the audit log”",
    );
    expect(markdown).toContain("> “never stores a full payment card number in any system”");
    expect(markdown).toContain("> “Statements are kept for seven years”");
    expect(markdown).toContain("revision 2026.1, clause §2.");
    expect(markdown).toContain("- **Analyst's note:** Exports are out of scope for this release.");
    expect(markdown).toContain(
      "- **Question for the business:** How long are monthly statements kept?",
    );
    // Grouped under the requirement as the run analysed it.
    expect(markdown).toContain(
      "### REQ-001\n\n_As analysed:_ Saved cards keep only the last four digits.",
    );
    expect(markdown).toContain("### REQ-002\n\n_As analysed:_ Customers get a monthly statement.");
    // After the requirements, before the developers' appendix.
    expect(markdown.indexOf("## Requirements")).toBeLessThan(
      markdown.indexOf(GOVERNING_SECTION_HEADING),
    );
    expect(markdown.indexOf(GOVERNING_SECTION_HEADING)).toBeLessThan(
      markdown.indexOf(CODE_LINKS_APPENDIX_HEADING),
    );
  });

  it("states one summary sentence per document revision, against the revision's rule count", async () => {
    withFindings(THREE);
    db.ruleCount.mockImplementation(async (args: { where: { revisionId: string } }) =>
      args.where.revisionId === "rev-1" ? 40 : 5,
    );
    const { markdown } = await synthesizeRequirementsDocument("p1", { analysisId: "run-1" }, "BRD");
    expect(markdown).toContain(
      "- 1 gap found against 2 of 40 applicable rules in Information Handling Policy v1. Not an audit opinion.",
    );
    expect(markdown).toContain(
      "- 0 gaps found against 1 of 5 applicable rules in Records Retention Standard 2026.1; 1 rule needs BA input. Not an audit opinion.",
    );
  });

  it("counts BA input per rule and gaps per finding, as the analysis view does", () => {
    const wire = (o: Record<string, unknown>): GoverningFinding => ({
      ...(row(o) as unknown as GoverningFinding),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    // One rule waiting on BA input for two requirements, one rule a gap for two.
    const md = renderGoverningSection({
      runs: [
        {
          analysisId: "run-1",
          startedAt: NOW,
          findings: [
            wire({ id: "a", status: "needs-ba-input" }),
            wire({ id: "b", requirementId: "REQ-002", status: "needs-ba-input" }),
            wire({ id: "c", ruleId: "rule-audit", status: "gap" }),
            wire({ id: "d", requirementId: "REQ-002", ruleId: "rule-audit", status: "gap" }),
          ],
          requirementText: new Map(),
          revisions: [
            {
              revisionId: "rev-1",
              documentTitle: "Information Handling Policy",
              revisionLabel: "v1",
              rules: 9,
            },
          ],
        },
      ],
    }).join("\n");
    expect(md).toContain(
      "- 2 gaps found against 2 of 9 applicable rules in Information Handling Policy v1; 1 rule needs BA input. Not an audit opinion.",
    );
  });

  it("names a decider who is gone as a former user", () => {
    const md = renderGoverningSection({
      runs: [
        {
          analysisId: "run-1",
          startedAt: NOW,
          findings: [
            {
              ...(row({
                decision: "accepted",
                decidedById: "gone",
              }) as unknown as GoverningFinding),
              decidedByName: null,
              decidedAt: null,
              createdAt: NOW.toISOString(),
              updatedAt: NOW.toISOString(),
            },
          ],
          requirementText: new Map(),
          revisions: [],
        },
      ],
    }).join("\n");
    expect(md).toContain("Decision: **Accepted** by a former user. Rule of");
  });

  it("contains no compliance or certification claim, even when the stored text makes one", async () => {
    const claims = [
      row({
        documentTitle: "SOC 2 Compliant Controls",
        reasoning: "The requirement is fully GDPR-compliant and SOC 2 certified.",
        clauseExcerpt: "Systems must be HIPAA compliant",
        decision: "accepted",
        decidedAt: NOW,
        decisionNote: "Confirmed: this passes SOC 2.",
      }),
      row({
        id: "gf-2",
        controlId: "GDPR",
        status: "needs-ba-input",
        modelStatus: "compliant",
        reasoning: "Compliant with GDPR as written.",
        businessQuestion: "Is the vendor ISO 27001 certified?",
      }),
    ];
    // The fixture really does carry claims, so a pass below is the guard's work.
    expect(
      findForbiddenComplianceClaims(
        JSON.stringify(claims.map((c) => [c.reasoning, c.clauseExcerpt, c.decisionNote])),
      ).length,
    ).toBeGreaterThan(3);
    withFindings(claims, {
      ...APPLICABILITY,
      requirements: [
        { requirementId: "REQ-001", text: "The app is SOC 2 compliant.", decisions: [] },
      ],
    });
    const { markdown } = await synthesizeRequirementsDocument("p1", { analysisId: "run-1" }, "BRD");

    expect(findForbiddenComplianceClaims(markdown)).toEqual([]);
    // The excerpt is no longer verbatim, and says so.
    expect(markdown).toContain("> “Systems must be HIPAA-reviewed”");
    expect(markdown).toContain("_Compliance wording in this excerpt was neutralised;");
    // The model's unsupported status is explained, not hidden.
    expect(markdown).toContain(
      "- **Status set by METIS:** the model gave Compliant without evidence it could cite, so the finding is recorded as Needs BA input.",
    );
  });

  it("says when a citation was dropped or no excerpt was recorded", () => {
    const run = (findings: GoverningFinding[]): GoverningSection => ({
      runs: [
        {
          analysisId: "run-1",
          startedAt: NOW,
          findings,
          requirementText: new Map(),
          revisions: [],
        },
      ],
    });
    const wire = (o: Partial<GoverningFinding>): GoverningFinding => ({
      ...(row() as unknown as GoverningFinding),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...o,
    });
    const dropped = renderGoverningSection(
      run([
        wire({
          status: "needs-ba-input",
          modelStatus: "compliant",
          citationDropped: true,
          clauseExcerpt: null,
          clauseStart: null,
          clauseEnd: null,
        }),
      ]),
    ).join("\n");
    expect(dropped).toContain(
      "_The cited clause could not be found in this revision's text, so the citation was dropped and the finding waits on BA input._",
    );
    // A dropped citation is its own explanation; the no-evidence line is not added.
    expect(dropped).not.toContain("Status set by METIS");
    const none = renderGoverningSection(run([wire({ clauseExcerpt: null, clauseRef: "" })])).join(
      "\n",
    );
    expect(none).toContain("_No clause excerpt was recorded for this finding._");
    expect(none).toContain("Rule of Information Handling Policy, revision v1.");
    // No requirement text was stored: the id alone heads the requirement.
    expect(none).not.toContain("_As analysed:_");
  });

  it("heads each run when the requirements came from more than one", () => {
    const one = (analysisId: string, startedAt: Date | null): GoverningSectionRun => ({
      analysisId,
      startedAt,
      findings: [
        {
          ...(row({ analysisId }) as unknown as GoverningFinding),
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
      requirementText: new Map([["REQ-001", "Saved cards."]]),
      revisions: [],
    });
    const md = renderGoverningSection({ runs: [one("a", NOW), one("b", null)] }).join("\n");
    expect(md).toContain("the 2 analysis runs these requirements came from");
    expect(md).toContain("### Analysis run started 2026-11-08 10:00:00 UTC");
    expect(md).toContain("### Analysis run (start time not recorded)");
    expect(md).toContain("#### REQ-001");
    // No rule count was read: the sentence still never reads "1 of 0".
    expect(md).toContain("against 1 of 1 applicable rule in");
  });

  it("reads the runs within the project, then the findings and rule counts as the route does", async () => {
    withFindings(THREE);
    await synthesizeRequirementsDocument("p1", { requirementIds: ["req-1"] }, "BRD");
    expect(db.requirementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: "p1", id: { in: ["req-1"] } }),
        select: { analysisId: true },
      }),
    );
    expect(db.analysisFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["run-1"] }, projectId: "p1" } }),
    );
    expect(db.findingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { analysisId: "run-1" } }),
    );
    expect(db.ruleCount).toHaveBeenCalledWith({
      where: {
        revisionId: "rev-1",
        OR: [{ deletedAt: null }, { id: { in: ["rule-card", "rule-audit"] } }],
      },
    });
  });

  it("changes the source fingerprint when a finding is decided", async () => {
    withFindings(THREE);
    const before = await synthesizeRequirementsDocument("p1", { analysisId: "run-1" }, "BRD");
    expect(before.sourceFingerprint).not.toBe(requirementsSourceFingerprint([req()]));
    withFindings([THREE[0]!, THREE[1]!, { ...THREE[2]!, decision: "accepted", decidedAt: NOW }]);
    const after = await synthesizeRequirementsDocument("p1", { analysisId: "run-1" }, "BRD");
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
  });
});

describe("the BRD without governing findings is unchanged — #1877", () => {
  const plain = () =>
    renderRequirementsDocument("BRD", { analysisId: "run-1" }, [req()], {
      analysisStartedAt: NOW,
    });

  it("with the flag off reads no finding and renders the document as before", async () => {
    delete process.env.GOVERNING_DOCS_ENABLED;
    withFindings(THREE);
    const out = await synthesizeRequirementsDocument("p1", { analysisId: "run-1" }, "BRD");
    expect(db.findingFindMany).not.toHaveBeenCalled();
    expect(db.analysisFindMany).not.toHaveBeenCalled();
    expect(out.markdown).toBe(plain());
    expect(out.sourceFingerprint).toBe(requirementsSourceFingerprint([req()]));
    expect(out.markdown).toMatchInlineSnapshot(`
      "# BRD (1 requirement)

      This document covers 1 requirement(s) from the analysis run started 2026-11-08 10:00:00 UTC.
      0 of 1 have recorded code links.

      ## Summary

      | # | Requirement | Type | Priority | Review status | Verdict | Code links |
      |---|---|---|---|---|---|---|
      | R1 | Save a card | feature | high | approved | implemented | 0 |

      ## Requirements

      ### R1. Save a card

      **Type:** feature · **Priority:** high · **Review status:** approved · **Verdict:** implemented

      A customer can save a card for later.

      #### Acceptance criteria

      - The saved card shows its last four digits.

      ## Appendix: code links

      For the developers who build and test these requirements: where each one is recorded in the code. The requirements above do not depend on it.

      **R1. Save a card**

      _No code links recorded for this requirement._
      "
    `);
  });

  it("with no governing document (no findings) renders the document as before", async () => {
    withFindings([]);
    const out = await synthesizeRequirementsDocument("p1", { analysisId: "run-1" }, "BRD");
    expect(db.findingFindMany).toHaveBeenCalled();
    expect(out.markdown).toBe(plain());
    expect(out.markdown).not.toContain(GOVERNING_SECTION_HEADING);
    expect(out.sourceFingerprint).toBe(requirementsSourceFingerprint([req()]));
  });

  it("loads nothing for no runs, or runs outside the project", async () => {
    expect(await loadGoverningSection("p1", [])).toBeNull();
    expect(db.analysisFindMany).not.toHaveBeenCalled();
    db.analysisFindMany.mockResolvedValue([]);
    expect(await loadGoverningSection("p1", ["run-of-p2"])).toBeNull();
    expect(db.findingFindMany).not.toHaveBeenCalled();
  });

  it("fingerprints what a reader sees of each finding", () => {
    const section: GoverningSection = {
      runs: [
        {
          analysisId: "run-1",
          startedAt: NOW,
          findings: [
            {
              ...(row() as unknown as GoverningFinding),
              createdAt: NOW.toISOString(),
              updatedAt: NOW.toISOString(),
            },
          ],
          requirementText: new Map(),
          revisions: [],
        },
      ],
    };
    const base = governingSectionFacts(section);
    const noted = governingSectionFacts({
      runs: [
        {
          ...section.runs[0]!,
          findings: [{ ...section.runs[0]!.findings[0]!, decisionNote: "x" }],
        },
      ],
    });
    expect(noted).not.toBe(base);
  });
});
