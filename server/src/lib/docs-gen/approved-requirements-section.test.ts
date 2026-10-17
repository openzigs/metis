/**
 * #1218 — the reader-layout BRD's requirements section built from the
 * project's approved requirements: rendered from the stored rows, never cut
 * mid-requirement, and read only within the project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../prisma.js", () => ({ prisma: { requirement: { findMany } } }));

import {
  APPROVED_REQUIREMENTS_HEADING,
  approvedRequirementsMaxChars,
  loadApprovedRequirements,
  overflowPointer,
  renderApprovedRequirementsSection,
} from "./approved-requirements-section.js";
import {
  BRD_MAIN_MAX_CHARS,
  BRD_MAIN_PLAN_SHARE,
  BRD_MAIN_TARGET_CHARS,
  fitReaderDocument,
  mainFitCap,
  mainPlanBudget,
} from "./brd-layout.js";
import type { ScopedRequirement } from "./requirements-scope.js";

function req(n: number, overrides: Partial<ScopedRequirement> = {}): ScopedRequirement {
  return {
    id: `req-${n}`,
    title: `Requirement ${n}`,
    body: `The analyst's edited description of requirement ${n}.`,
    type: "feature",
    priority: "high",
    reviewStatus: "approved",
    verdict: "implemented",
    acceptanceCriteria: JSON.stringify([
      `Given requirement ${n}, when it runs, then a user sees exactly 6 entries.`,
      `Requirement ${n} rejects a password shorter than 6 characters.`,
    ]),
    version: 1,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    codeMappings: [
      { filePath: "internal/x.go", startLine: 1, endLine: 2, confidence: 0.9, source: "auto" },
    ],
    implementations: [],
    ...overrides,
  };
}

beforeEach(() => findMany.mockReset());

describe("loadApprovedRequirements", () => {
  it("selects only live, approved requirements of the one project", async () => {
    findMany.mockResolvedValue([]);
    await loadApprovedRequirements("p1");
    const where = findMany.mock.calls[0][0].where;
    expect(where).toEqual({ projectId: "p1", deletedAt: null, reviewStatus: "approved" });
    // The code links are read within the project too.
    expect(findMany.mock.calls[0][0].select.codeMappings.where).toEqual({ projectId: "p1" });
  });
});

describe("approvedRequirementsMaxChars", () => {
  it("is the share of the main part the other main sections' targets leave", () => {
    // 60k − (8k + 12k + 12k) at the default 250k cap.
    expect(approvedRequirementsMaxChars(250_000)).toBe(28_000);
    expect(approvedRequirementsMaxChars(90_000)).toBe(
      Math.floor((mainFitCap(90_000) * 28_000) / BRD_MAIN_MAX_CHARS),
    );
    expect(approvedRequirementsMaxChars(0)).toBe(0);
  });
});

describe("renderApprovedRequirementsSection", () => {
  it("lists every approved requirement as stored: id, title, body and criteria, no code links", () => {
    const requirements = [req(1), req(2, { acceptanceCriteria: "[]" })];
    const { markdown, listed, total } = renderApprovedRequirementsSection(requirements, 28_000);
    expect({ listed, total }).toEqual({ listed: 2, total: 2 });
    expect(
      markdown.startsWith(`## ${APPROVED_REQUIREMENTS_HEADING}\n\n> **Approved in METIS.**`),
    ).toBe(true);
    expect(markdown).toContain("### R1. Requirement 1");
    expect(markdown).toContain("**Requirement id:** `req-1`");
    expect(markdown).toContain("The analyst's edited description of requirement 1.");
    // The criteria verbatim, one bullet each.
    expect(markdown).toContain(
      "- Given requirement 1, when it runs, then a user sees exactly 6 entries.",
    );
    expect(markdown).toContain("- Requirement 1 rejects a password shorter than 6 characters.");
    expect(markdown).toContain("_No acceptance criteria were derived for this requirement._");
    // A business reader's main part names no code.
    expect(markdown).not.toContain("internal/x.go");
    expect(markdown).not.toContain("#### Code links");
    expect(markdown).not.toContain("did not fit");
    expect(markdown).not.toContain("Reconstructed from the code");
  });

  it("stops at a whole requirement and points to the full list when they are over budget", () => {
    const long = "A long stored description. ".repeat(40);
    const requirements = Array.from({ length: 30 }, (_, i) => req(i + 1, { body: long }));
    const maxChars = 8_000;
    const { markdown, listed, total } = renderApprovedRequirementsSection(requirements, maxChars);
    expect(markdown.length).toBeLessThanOrEqual(maxChars);
    expect(total).toBe(30);
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(30);
    expect(markdown.endsWith(overflowPointer(listed, total))).toBe(true);
    expect(markdown).toContain(`**${listed} of 30 approved requirements are listed here.**`);
    expect(markdown).toContain("**Requirements (analysis run)**");
    // Each listed requirement is whole: its last criterion is there.
    for (let n = 1; n <= listed; n += 1) {
      expect(markdown).toContain(
        `- Requirement ${n} rejects a password shorter than 6 characters.`,
      );
    }
    // And the next one is not there at all, not even its heading.
    expect(markdown).not.toContain(`### R${listed + 1}. `);
    // One more would not have fitted with the pointer.
    const oneMore = renderApprovedRequirementsSection(requirements.slice(0, listed + 1), 1e9);
    expect(oneMore.markdown.length + overflowPointer(listed + 1, total).length).toBeGreaterThan(
      maxChars - 2,
    );
  });

  it("is the heading, lead-in and pointer alone when not one requirement fits", () => {
    const { markdown, listed } = renderApprovedRequirementsSection([req(1), req(2)], 100);
    expect(listed).toBe(0);
    expect(markdown).toContain("**0 of 2 approved requirements are listed here.**");
    expect(markdown).not.toContain("### R1.");
  });

  it("measures with the measure it is given", () => {
    const doubled = (markdown: string): number => markdown.length * 2;
    const plain = renderApprovedRequirementsSection([req(1), req(2), req(3)], 2_000);
    const measured = renderApprovedRequirementsSection([req(1), req(2), req(3)], 2_000, doubled);
    expect(measured.listed).toBeLessThan(plain.listed);
  });
});

describe("the main part with the approved requirements in it", () => {
  const section = (heading: string, topics: number, perTopic: number): string =>
    [
      `## ${heading}`,
      ...Array.from(
        { length: topics },
        (_, i) =>
          `### ${heading} topic ${i + 1}\n\n${"A sentence of business detail. ".repeat(Math.ceil(perTopic / 31))}`,
      ),
    ].join("\n\n");
  const length = (markdown: string): number => markdown.length;

  it("is planned what its sections ask, up to 60k, and a share of a small budget", () => {
    expect(mainPlanBudget(237_500, 37_000)).toBe(37_000);
    expect(mainPlanBudget(237_500, 70_000)).toBe(BRD_MAIN_MAX_CHARS);
    expect(mainPlanBudget(40_000, 37_000)).toBe(40_000 * BRD_MAIN_PLAN_SHARE);
    expect(mainPlanBudget(237_500)).toBe(BRD_MAIN_TARGET_CHARS);
  });

  it("keeps the approved requirements whole and fits the other main sections to what they leave", () => {
    const approved = renderApprovedRequirementsSection(
      Array.from({ length: 200 }, (_, i) => req(i + 1)),
      approvedRequirementsMaxChars(245_000),
    ).markdown;
    const sections = [
      { markdown: section("Executive Summary", 30, 1_000), budgetChars: 8_000 },
      { markdown: section("Core Business Capabilities", 40, 1_000), budgetChars: 12_000 },
      { markdown: section("Key Business Rules", 40, 1_000), budgetChars: 12_000 },
      { markdown: approved, budgetChars: 1 },
      { markdown: section("Business Rules & Policies", 10, 1_000), budgetChars: 100_000 },
    ];
    const isMain = [true, true, true, true, false];
    const isSummary = [false, true, true, false, false];
    const isFixed = [false, false, false, true, false];
    const fit = fitReaderDocument(sections, isMain, 245_000, length, 250_000, isSummary, isFixed);
    expect(fit.sections[3]).toBe(approved);
    expect(fit.cuts[3]).toBe("whole");
    expect(fit.omittedTopics[3]).toEqual([]);
    // Without it marked fixed, the same fit cuts into the requirements.
    const unfixed = fitReaderDocument(sections, isMain, 245_000, length, 250_000, isSummary);
    expect(unfixed.cuts[3]).not.toBe("whole");
    // The opening, too long for what is left, is the one cut.
    expect(fit.cuts[0]).not.toBe("whole");
    expect(fit.mainChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    expect(fit.sections[4]).toBe(sections[4].markdown);
  });

  it("fits a fixed section longer than the main part's room like any other", () => {
    const huge = section("Approved Requirements", 100, 1_000);
    const fit = fitReaderDocument(
      [{ markdown: huge, budgetChars: 1 }],
      [true],
      245_000,
      length,
      250_000,
      [false],
      [true],
    );
    expect(fit.cuts[0]).not.toBe("whole");
    expect(fit.mainChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
  });
});
