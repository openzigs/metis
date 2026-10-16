/**
 * #1175 — the reader layout of a business-requirements document: the setting,
 * the main part's targets and caps, the plan in two parts, and the fit of the
 * main part and the appendix. Pure: no model, no database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPENDIX_DIVIDER,
  BRD_MAIN_FIT_SHARE,
  BRD_MAIN_MAX_CHARS,
  BRD_MAIN_PLAN_SHARE,
  BRD_MAIN_SECTION_TARGETS,
  BRD_MAIN_TARGET_CHARS,
  fitReaderDocument,
  isMainSection,
  MAIN_SUMMARY_FLOOR_CHARS,
  mainFitCap,
  mainPlanBudget,
  readBrdLayoutSetting,
  REQUIREMENTS_LEAD_IN,
  withRequirementsLeadIn,
} from "./brd-layout.js";
import {
  fitDocumentToPlan,
  planDocument,
  plannedOmissionNote,
  SINGLE_CALL_SECTION_CHARS,
  type SectionDemand,
} from "./document-plan.js";
import { SHORTENED_NOTE_LEAD } from "./section-size.js";

afterEach(() => vi.unstubAllEnvs());

const length = (markdown: string): number => markdown.length;

describe("DOCS_GEN_BRD_LAYOUT", () => {
  it("is the catalogue layout unless set to reader", () => {
    expect(process.env.DOCS_GEN_BRD_LAYOUT).toBeUndefined();
    expect(readBrdLayoutSetting()).toEqual({ layout: "catalogue" });
    vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "reader");
    expect(readBrdLayoutSetting()).toEqual({ layout: "reader" });
    for (const value of ["catalogue", ""]) {
      vi.stubEnv("DOCS_GEN_BRD_LAYOUT", value);
      expect(readBrdLayoutSetting()).toEqual({ layout: "catalogue" });
    }
  });

  it("returns any other value as unrecognised, in the catalogue layout, as the registry's enum would", () => {
    // The registry schema is z.enum(["reader", "catalogue"]): no case folding.
    for (const value of ["on", "true", "main+appendix", "Reader", "READER"]) {
      vi.stubEnv("DOCS_GEN_BRD_LAYOUT", value);
      expect(readBrdLayoutSetting()).toEqual({ layout: "catalogue", unrecognised: value });
    }
  });
});

describe("the main part's length", () => {
  it("is planned inside the owner's 40-60k, and no more than two single-call asks", () => {
    expect(BRD_MAIN_TARGET_CHARS).toBe(48_000);
    expect(BRD_MAIN_TARGET_CHARS).toBeGreaterThanOrEqual(40_000);
    expect(BRD_MAIN_TARGET_CHARS).toBeLessThanOrEqual(60_000);
    // What Overview and Capabilities asked of the plan in the catalogue layout.
    expect(BRD_MAIN_TARGET_CHARS).toBe(2 * SINGLE_CALL_SECTION_CHARS);
    expect(BRD_MAIN_MAX_CHARS).toBe(60_000);
    expect(Object.keys(BRD_MAIN_SECTION_TARGETS)).toEqual([
      "overview",
      "capabilities",
      "key-rules",
      "requirements",
    ]);
  });

  it("knows the main sections by id", () => {
    for (const id of Object.keys(BRD_MAIN_SECTION_TARGETS)) expect(isMainSection(id)).toBe(true);
    for (const id of [
      "rules",
      "workflows",
      "formulas",
      "data-model",
      "integrations-and-glossary",
    ]) {
      expect(isMainSection(id)).toBe(false);
    }
    // Not an inherited property of the targets object.
    expect(isMainSection("toString")).toBe(false);
  });

  it("is planned its target under the default cap, and a share of a small one", () => {
    expect(mainPlanBudget(237_500)).toBe(48_000);
    expect(mainPlanBudget(40_000)).toBe(40_000 * BRD_MAIN_PLAN_SHARE);
    expect(mainPlanBudget(0)).toBe(0);
    expect(mainPlanBudget(-5)).toBe(0);
  });

  it("is capped at 60k at assembly under the default cap, and at a share of a small one", () => {
    expect(mainFitCap(245_000)).toBe(60_000);
    expect(mainFitCap(40_000)).toBe(40_000 * BRD_MAIN_FIT_SHARE);
    expect(mainFitCap(-1)).toBe(0);
  });
});

describe("planDocument in two parts", () => {
  const main = (id: string, ask: number): SectionDemand => ({
    sectionId: id,
    label: id,
    kind: "single",
    topics: [],
    askChars: ask,
    part: "main",
  });
  const catalogue = (id: string, modules: number, each: number): SectionDemand => ({
    sectionId: id,
    label: id,
    kind: "enumerative",
    part: "appendix",
    topics: Array.from({ length: modules }, (_, i) => ({
      id: `${id}/m${i}`,
      title: `m${i}`,
      priority: modules - i,
      estimatedChars: each,
    })),
  });

  it("gives the main sections their targets first, and the appendix the rest", () => {
    const plan = planDocument({
      sections: [
        main("overview", 8_000),
        main("capabilities", 12_000),
        catalogue("rules", 100, 2_000),
        main("requirements", 16_000),
      ],
      documentMaxChars: 250_000,
      sectionMaxChars: 60_000,
      reservedChars: 10_000,
      mainBudgetChars: 48_000,
    });
    expect(plan.budgetChars).toBe(240_000);
    expect(plan.mainBudgetChars).toBe(48_000);
    // Input order is kept.
    expect(plan.sections.map((s) => s.sectionId)).toEqual([
      "overview",
      "capabilities",
      "rules",
      "requirements",
    ]);
    const byId = Object.fromEntries(plan.sections.map((s) => [s.sectionId, s.budgetChars]));
    expect(byId).toEqual({
      overview: 8_000,
      capabilities: 12_000,
      requirements: 16_000,
      // Bounded by the section cap, not by the main part.
      rules: 60_000,
    });
    expect(plan.sections.reduce((n, s) => n + s.budgetChars, 0) + plan.unallocatedChars).toBe(
      plan.budgetChars,
    );
  });

  it("gives the appendix the room the main part does not ask for", () => {
    const plan = planDocument({
      sections: [main("overview", 5_000), catalogue("rules", 100, 2_000)],
      documentMaxChars: 100_000,
      sectionMaxChars: 200_000,
      mainBudgetChars: 48_000,
    });
    const rules = plan.sections.find((s) => s.sectionId === "rules")!;
    expect(rules.budgetChars).toBe(95_000);
    expect(plan.unallocatedChars).toBe(0);
  });

  it("shares the main budget among the main sections when they ask for more", () => {
    const plan = planDocument({
      sections: [main("a", 30_000), main("b", 30_000), catalogue("rules", 10, 1_000)],
      documentMaxChars: 100_000,
      sectionMaxChars: 60_000,
      mainBudgetChars: 40_000,
    });
    expect(plan.sections.map((s) => s.budgetChars)).toEqual([20_000, 20_000, 10_000]);
  });

  it("never plans the main part more than the document budget", () => {
    const plan = planDocument({
      sections: [main("a", 30_000), catalogue("rules", 10, 1_000)],
      documentMaxChars: 10_000,
      sectionMaxChars: 60_000,
      mainBudgetChars: 48_000,
    });
    expect(plan.mainBudgetChars).toBe(10_000);
    expect(plan.sections[0].budgetChars).toBe(10_000);
    expect(plan.sections[1].budgetChars).toBe(0);
    expect(plan.sections[1].dropped).toHaveLength(10);
  });

  it("is the one-part plan when no section is marked main, or no main budget is given", () => {
    const sections = [catalogue("rules", 30, 3_000), catalogue("workflows", 30, 3_000)];
    const plain = planDocument({ sections, documentMaxChars: 120_000, sectionMaxChars: 60_000 });
    expect(
      planDocument({
        sections,
        documentMaxChars: 120_000,
        sectionMaxChars: 60_000,
        mainBudgetChars: 48_000,
      }),
    ).toEqual(plain);
    expect(plain.mainBudgetChars).toBeUndefined();
    const marked = [main("a", 10_000), ...sections];
    expect(
      planDocument({ sections: marked, documentMaxChars: 120_000, sectionMaxChars: 60_000 }),
    ).toEqual(
      planDocument({
        sections: marked.map(({ part: _part, ...rest }) => rest),
        documentMaxChars: 120_000,
        sectionMaxChars: 60_000,
      }),
    );
  });
});

describe("plannedOmissionNote for the main part", () => {
  const generic = plannedOmissionNote(["RC-9: Exports"], {
    setting: "DOCS_GEN_DOCUMENT_MAX_CHARS",
    maxChars: 60_000,
  });

  it("says, for a section with nothing behind it in the appendix, that what was cut is nowhere else", () => {
    const note = plannedOmissionNote(["RC-9: Exports"], {
      setting: "BRD_MAIN_PART",
      maxChars: 60_000,
    });
    expect(note.startsWith(SHORTENED_NOTE_LEAD)).toBe(true);
    expect(note).toContain("The main part of this document is limited to about 60k characters");
    expect(note).toContain("RC-9: Exports");
    expect(note).toContain("What was left out is not elsewhere in this document");
    expect(note).not.toContain("appendix");
    expect(note).not.toContain("DOCS_GEN_");
  });

  it("points a summary section at the appendix that holds its detail", () => {
    const note = plannedOmissionNote(["Retention"], {
      setting: "BRD_MAIN_SUMMARY",
      maxChars: 60_000,
    });
    expect(note).toContain("The main part of this document is limited to about 60k characters");
    expect(note).toContain("The detail behind this section is in the appendix.");
    expect(note).not.toContain("not elsewhere");
  });

  it("is shorter than the generic note, so a tail cut's note is reworded to it", () => {
    for (const setting of ["BRD_MAIN_PART", "BRD_MAIN_SUMMARY"] as const) {
      expect(
        plannedOmissionNote(["RC-9: Exports"], { setting, maxChars: 60_000 }).length,
      ).toBeLessThan(generic.length);
    }
  });

  it("is what fitDocumentToPlan writes when it is given that limit", () => {
    const topic = (n: number): string => `### RC-${n}: Topic ${n}\n\n${"Body text. ".repeat(40)}`;
    const section = `## Requirements Reconstructed from the Code\n\n${Array.from({ length: 12 }, (_, i) => topic(i + 1)).join("\n\n")}`;
    const fit = fitDocumentToPlan(
      [{ markdown: section, budgetChars: 3_000 }],
      3_000,
      length,
      3_000,
      "BRD_MAIN_PART",
    );
    expect(fit.trimmed).toBe(1);
    expect(fit.sections[0]).toContain("The main part of this document is limited to about 3k");
    expect(fit.sections[0]).toContain("not elsewhere in this document");
    expect(fit.sections[0]).not.toContain("DOCS_GEN_DOCUMENT_MAX_CHARS");
    expect(fit.sections[0].length).toBeLessThanOrEqual(3_000);
  });
});

describe("withRequirementsLeadIn", () => {
  it("puts the fixed lead-in directly under the section heading", () => {
    const md =
      "## Requirements Reconstructed from the Code\n\n### RC-1: Sign in\n\nThe system shall …";
    const out = withRequirementsLeadIn(md);
    expect(out).toBe(
      `## Requirements Reconstructed from the Code\n\n${REQUIREMENTS_LEAD_IN}\n\n### RC-1: Sign in\n\nThe system shall …`,
    );
    // Idempotent: a section that already has it is unchanged.
    expect(withRequirementsLeadIn(out)).toBe(out);
  });

  it("puts it at the top of a section with no heading", () => {
    expect(withRequirementsLeadIn("### RC-1: Sign in")).toBe(
      `${REQUIREMENTS_LEAD_IN}\n\n### RC-1: Sign in`,
    );
  });

  it("says the requirements are inferred from the code, where the approved ones are, and that the numbers are local", () => {
    expect(REQUIREMENTS_LEAD_IN).toContain("Reconstructed from the code");
    expect(REQUIREMENTS_LEAD_IN).toContain("not the project's approved requirements");
    expect(REQUIREMENTS_LEAD_IN).toContain("**Requirements**");
    expect(REQUIREMENTS_LEAD_IN).toContain("scoped to Requirements");
    expect(REQUIREMENTS_LEAD_IN).toContain("local to this document");
    // A blockquote paragraph: one unit a length fit keeps first, never splits.
    expect(REQUIREMENTS_LEAD_IN.startsWith("> ")).toBe(true);
    expect(REQUIREMENTS_LEAD_IN).not.toContain("\n");
  });
});

describe("fitReaderDocument", () => {
  const section = (heading: string, topics: number, perTopic: number): string =>
    [
      `## ${heading}`,
      ...Array.from(
        { length: topics },
        (_, i) =>
          `### ${heading} topic ${i + 1}\n\n${"A sentence of business detail. ".repeat(Math.ceil(perTopic / 31))}`,
      ),
    ].join("\n\n");

  it("returns a document that fits unchanged, in input order", () => {
    const sections = [
      { markdown: section("Executive Summary", 2, 500), budgetChars: 8_000 },
      { markdown: section("Business Rules & Policies", 4, 500), budgetChars: 50_000 },
    ];
    const fit = fitReaderDocument(sections, [true, false], 250_000, length, 250_000);
    expect(fit.sections).toEqual(sections.map((s) => s.markdown));
    expect(fit.trimmed).toBe(0);
    expect(fit.mode).toBe("whole");
    expect(fit.cuts).toEqual(["whole", "whole"]);
    expect(fit.mainChars).toBe(sections[0].markdown.length);
    expect(fit.appendixMaxChars).toBe(
      250_000 - sections[0].markdown.length - APPENDIX_DIVIDER.length - 2,
    );
    expect(fit.omittedTopics).toEqual([[], []]);
  });

  it("holds the main part to its cap even when the document has room, and lists what it cut", () => {
    const sections = [
      { markdown: section("Executive Summary", 3, 2_000), budgetChars: 8_000 },
      { markdown: section("Business Rules & Policies", 10, 2_000), budgetChars: 100_000 },
      { markdown: section("Requirements & Acceptance Criteria", 60, 1_200), budgetChars: 16_000 },
    ];
    const isMain = [true, false, true];
    const fit = fitReaderDocument(sections, isMain, 245_000, length, 250_000);
    // The two main sections and the blank line that joins them.
    const mainChars = fit.sections[0].length + fit.sections[2].length + 2;
    expect(fit.mainChars).toBe(mainChars);
    expect(mainChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    // The requirements ran over; the summary did not.
    expect(fit.cuts[0]).toBe("whole");
    expect(fit.cuts[2]).not.toBe("whole");
    expect(fit.sections[2]).toContain("The main part of this document is limited to about 60k");
    expect(fit.omittedTopics[2].length).toBeGreaterThan(0);
    expect(fit.omittedTopics[2][0]).toMatch(/^Requirements & Acceptance Criteria topic \d+$/);
    // The appendix fitted whole in the rest of the body.
    expect(fit.sections[1]).toBe(sections[1].markdown);
    expect(fit.cuts[1]).toBe("whole");
    expect(fit.trimmed).toBe(1);
    expect(fit.mode).toBe(fit.cuts[2]);
  });

  it("gives the appendix the body limit less the main part as fitted and the divider", () => {
    const sections = [
      { markdown: section("Executive Summary", 2, 1_000), budgetChars: 8_000 },
      { markdown: section("Business Rules & Policies", 40, 2_000), budgetChars: 60_000 },
      { markdown: section("Key Workflows", 40, 2_000), budgetChars: 60_000 },
    ];
    const bodyMax = 100_000;
    const fit = fitReaderDocument(sections, [true, false, false], bodyMax, length, 110_000);
    const appendix = fit.sections[1].length + fit.sections[2].length;
    expect(fit.appendixMaxChars).toBe(bodyMax - fit.mainChars - APPENDIX_DIVIDER.length - 2);
    expect(appendix).toBeLessThanOrEqual(fit.appendixMaxChars);
    // The appendix is cut under the DOCUMENT cap, and its note says so.
    expect(fit.sections[1]).toContain("DOCS_GEN_DOCUMENT_MAX_CHARS");
    expect(fit.sections[1]).toContain("about 110k");
    // And the whole body is within its limit, divider included.
    expect(fit.mainChars + APPENDIX_DIVIDER.length + 2 + appendix).toBeLessThanOrEqual(bodyMax);
    // The room is used: the appendix is not left far short of its limit.
    expect(appendix).toBeGreaterThan(fit.appendixMaxChars - 5_000);
  });

  describe("the order the main part gives up text in", () => {
    // Opening, capabilities, key rules, requirements: as the reader layout orders them.
    const main = (sizes: { caps: number; rules: number; reqs: number }) => [
      { markdown: section("Executive Summary", 2, 1_000), budgetChars: 8_000 },
      { markdown: section("Core Business Capabilities", 40, sizes.caps), budgetChars: 12_000 },
      { markdown: section("Key Business Rules", 40, sizes.rules), budgetChars: 12_000 },
      {
        markdown: section("Requirements Reconstructed from the Code", 60, sizes.reqs),
        budgetChars: 16_000,
      },
    ];
    const isMain = [true, true, true, true];
    const isSummary = [false, true, true, false];

    it("cuts the summaries first and leaves the requirements whole while they fit", () => {
      // 4 + 40 + 40 + 30 = ~114k against a 60k cap: the requirements (~30k) fit
      // in what the summaries leave.
      const sections = main({ caps: 1_000, rules: 1_000, reqs: 500 });
      const fit = fitReaderDocument(sections, isMain, 245_000, length, 250_000, isSummary);
      expect(fit.mainChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
      expect(fit.cuts[0]).toBe("whole");
      expect(fit.cuts[3]).toBe("whole");
      expect(fit.sections[3]).toBe(sections[3].markdown);
      for (const i of [1, 2]) {
        expect(fit.cuts[i]).not.toBe("whole");
        expect(fit.sections[i]).toContain("behind this section is in the appendix");
      }
      // The room the requirements leave is used by the summaries.
      expect(fit.mainChars).toBeGreaterThan(BRD_MAIN_MAX_CHARS - 3_000);
    });

    it("keeps the summaries at their floor and cuts the requirements, saying what was lost is nowhere else", () => {
      // The requirements alone (~76k) are over the cap.
      const sections = main({ caps: 1_000, rules: 1_000, reqs: 1_250 });
      const fit = fitReaderDocument(sections, isMain, 245_000, length, 250_000, isSummary);
      expect(fit.mainChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
      // The summaries kept their floor between them, and no more than it.
      const summaries = fit.sections[1].length + fit.sections[2].length;
      expect(summaries).toBeLessThanOrEqual(2 * MAIN_SUMMARY_FLOOR_CHARS);
      expect(summaries).toBeGreaterThan(2 * MAIN_SUMMARY_FLOOR_CHARS - 2_500);
      expect(fit.cuts[3]).not.toBe("whole");
      expect(fit.sections[3]).toContain("not elsewhere in this document");
      expect(fit.sections[3]).not.toContain("in the appendix");
      expect(fit.omittedTopics[3][0]).toMatch(/^Requirements Reconstructed from the Code topic/);
      // The opening, short, is whole.
      expect(fit.cuts[0]).toBe("whole");
    });

    it("keeps each summary's own floor, however unequal their sizes", () => {
      // Capabilities three times the size of Key Rules; the requirements alone
      // over the cap, so both summaries come down to their floors.
      const sections = [
        { markdown: section("Executive Summary", 2, 1_000), budgetChars: 8_000 },
        { markdown: section("Core Business Capabilities", 120, 300), budgetChars: 12_000 },
        { markdown: section("Key Business Rules", 40, 300), budgetChars: 12_000 },
        {
          markdown: section("Requirements Reconstructed from the Code", 60, 1_250),
          budgetChars: 16_000,
        },
      ];
      const fit = fitReaderDocument(sections, isMain, 245_000, length, 250_000, isSummary);
      expect(sections[1].markdown.length).toBeGreaterThan(3 * sections[2].markdown.length - 1_000);
      for (const i of [1, 2]) {
        expect({ i, cut: fit.cuts[i] !== "whole" }).toEqual({ i, cut: true });
        // Each at its own floor: not one 8k budget the larger section takes.
        expect(fit.sections[i].length).toBeLessThanOrEqual(MAIN_SUMMARY_FLOOR_CHARS);
        expect(fit.sections[i].length).toBeGreaterThan(MAIN_SUMMARY_FLOOR_CHARS - 600);
      }
      expect(fit.mainChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    });

    it("keeps a summary shorter than its floor whole, and gives the other the rest of the room", () => {
      const sections = [
        { markdown: section("Executive Summary", 2, 1_000), budgetChars: 8_000 },
        { markdown: section("Core Business Capabilities", 120, 300), budgetChars: 12_000 },
        { markdown: section("Key Business Rules", 6, 300), budgetChars: 12_000 },
        {
          markdown: section("Requirements Reconstructed from the Code", 60, 1_250),
          budgetChars: 16_000,
        },
      ];
      expect(sections[2].markdown.length).toBeLessThan(MAIN_SUMMARY_FLOOR_CHARS);
      const fit = fitReaderDocument(sections, isMain, 245_000, length, 250_000, isSummary);
      expect(fit.sections[2]).toBe(sections[2].markdown);
      expect(fit.cuts[2]).toBe("whole");
      expect(fit.sections[1].length).toBeLessThanOrEqual(MAIN_SUMMARY_FLOOR_CHARS);
      expect(fit.sections[1].length).toBeGreaterThan(MAIN_SUMMARY_FLOOR_CHARS - 600);
    });

    it("shares the room above the floors max-min between unequal summaries", () => {
      // The requirements are short, so the summaries share most of the cap:
      // the shorter one keeps all of itself and the longer one the rest.
      const sections = [
        { markdown: section("Executive Summary", 2, 1_000), budgetChars: 8_000 },
        { markdown: section("Core Business Capabilities", 200, 400), budgetChars: 12_000 },
        { markdown: section("Key Business Rules", 30, 400), budgetChars: 12_000 },
        {
          markdown: section("Requirements Reconstructed from the Code", 10, 500),
          budgetChars: 16_000,
        },
      ];
      const fit = fitReaderDocument(sections, isMain, 245_000, length, 250_000, isSummary);
      expect(fit.sections[2]).toBe(sections[2].markdown);
      expect(fit.sections[3]).toBe(sections[3].markdown);
      expect(fit.cuts[1]).not.toBe("whole");
      expect(fit.mainChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
      expect(fit.mainChars).toBeGreaterThan(BRD_MAIN_MAX_CHARS - 1_500);
    });

    it("cuts nothing while the main part fits", () => {
      const sections = main({ caps: 300, rules: 300, reqs: 200 });
      const fit = fitReaderDocument(sections, isMain, 245_000, length, 250_000, isSummary);
      expect(fit.cuts).toEqual(["whole", "whole", "whole", "whole"]);
      expect(fit.sections).toEqual(sections.map((s) => s.markdown));
    });
  });

  it("reserves no room for a divider when there is no appendix", () => {
    const sections = [{ markdown: section("Executive Summary", 2, 500), budgetChars: 8_000 }];
    const fit = fitReaderDocument(sections, [true], 50_000, length, 50_000);
    expect(fit.appendixMaxChars).toBe(50_000 - fit.mainChars);
    expect(fit.kept).toHaveLength(1);
    expect(fit.unplannedWithinCap).toBe(true);
  });
});
