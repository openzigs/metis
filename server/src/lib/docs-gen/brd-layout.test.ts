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
  mainFitCap,
  mainPlanBudget,
  readBrdLayoutSetting,
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
    for (const value of ["reader", " Reader ", "READER"]) {
      vi.stubEnv("DOCS_GEN_BRD_LAYOUT", value);
      expect(readBrdLayoutSetting()).toEqual({ layout: "reader" });
    }
    for (const value of ["catalogue", "", "  "]) {
      vi.stubEnv("DOCS_GEN_BRD_LAYOUT", value);
      expect(readBrdLayoutSetting()).toEqual({ layout: "catalogue" });
    }
  });

  it("returns any other value as unrecognised, in the catalogue layout", () => {
    for (const value of ["on", "true", "main+appendix"]) {
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
  it("names the main part and points at the appendix, not a setting", () => {
    const note = plannedOmissionNote(["BR-9: Exports"], {
      setting: "BRD_MAIN_PART",
      maxChars: 60_000,
    });
    expect(note.startsWith(SHORTENED_NOTE_LEAD)).toBe(true);
    expect(note).toContain("The main part of this document is limited to about 60k characters");
    expect(note).toContain("BR-9: Exports");
    expect(note).toContain("The module-by-module detail is in the appendix.");
    expect(note).not.toContain("DOCS_GEN_");
  });

  it("is what fitDocumentToPlan writes when it is given that limit", () => {
    const topic = (n: number): string => `### BR-${n}: Topic ${n}\n\n${"Body text. ".repeat(40)}`;
    const section = `## Requirements & Acceptance Criteria\n\n${Array.from({ length: 12 }, (_, i) => topic(i + 1)).join("\n\n")}`;
    const fit = fitDocumentToPlan(
      [{ markdown: section, budgetChars: 3_000 }],
      3_000,
      length,
      3_000,
      "BRD_MAIN_PART",
    );
    expect(fit.trimmed).toBe(1);
    expect(fit.sections[0]).toContain("The main part of this document is limited to about 3k");
    expect(fit.sections[0]).not.toContain("DOCS_GEN_DOCUMENT_MAX_CHARS");
    expect(fit.sections[0].length).toBeLessThanOrEqual(3_000);
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
    const mainChars = fit.sections[0].length + fit.sections[2].length;
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

  it("reserves no room for a divider when there is no appendix", () => {
    const sections = [{ markdown: section("Executive Summary", 2, 500), budgetChars: 8_000 }];
    const fit = fitReaderDocument(sections, [true], 50_000, length, 50_000);
    expect(fit.appendixMaxChars).toBe(50_000 - fit.mainChars);
    expect(fit.kept).toHaveLength(1);
    expect(fit.unplannedWithinCap).toBe(true);
  });
});
