/**
 * #1218 — the reader-layout BRD's requirements section built from the
 * project's approved requirements: rendered from the stored rows, never cut
 * mid-requirement, and read only within the project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, analysisFindMany, layout } = vi.hoisted(() => ({
  findMany: vi.fn(),
  analysisFindMany: vi.fn(),
  layout: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: { requirement: { findMany }, analysis: { findMany: analysisFindMany } },
}));
vi.mock("./brd-layout.js", async (original) => ({
  ...(await original<typeof import("./brd-layout.js")>()),
  readBrdLayoutSetting: layout,
}));

import {
  APPROVED_REQUIREMENTS_HEADING,
  approvedRequirementsFacts,
  approvedRequirementsMaxChars,
  loadApprovedRequirements,
  overflowPointer,
  readsApprovedRequirements,
  renderApprovedRequirementsSection,
} from "./approved-requirements-section.js";
import {
  BRD_MAIN_MAX_CHARS,
  BRD_MAIN_PLAN_SHARE,
  BRD_MAIN_SECTION_TARGETS,
  BRD_MAIN_TARGET_CHARS,
  fitReaderDocument,
  mainFitCap,
  mainPlanBudget,
} from "./brd-layout.js";
import { findCodeIdentifiers } from "./main-part-language.js";
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

beforeEach(() => {
  findMany.mockReset();
  analysisFindMany.mockReset();
  layout.mockReset();
});

describe("loadApprovedRequirements", () => {
  const run = (id: string, requirements: number, metadata: string | null = null) => ({
    id,
    status: "completed",
    metadata,
    _count: { requirements },
  });

  it("reads the live, approved requirements of the Requirements hub's default run (#1230)", async () => {
    analysisFindMany.mockResolvedValue([run("run-3", 0), run("run-2", 4), run("run-1", 9)]);
    findMany.mockResolvedValue([]);
    await loadApprovedRequirements("p1");
    // The runs are this project's completed (or re-opened, #1252) live ones,
    // newest first, each with its live requirements counted within the project.
    expect(analysisFindMany.mock.calls[0][0]).toEqual({
      where: {
        projectId: "p1",
        deletedAt: null,
        OR: [{ status: "completed" }, { status: "running", completedAt: { not: null } }],
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        completedAt: true,
        metadata: true,
        _count: { select: { requirements: { where: { projectId: "p1", deletedAt: null } } } },
      },
    });
    const where = findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      projectId: "p1",
      deletedAt: null,
      analysisId: "run-2",
      reviewStatus: "approved",
    });
    // The code links are read within the project too.
    expect(findMany.mock.calls[0][0].select.codeMappings.where).toEqual({ projectId: "p1" });
  });

  it("reads the re-run whose requirements are all draft, not an older run's approvals (#1230)", async () => {
    // The newest run has requirements (all draft): it is the current set, as
    // the hub shows it, so it is the run read, and it lists none approved.
    analysisFindMany.mockResolvedValue([run("rerun", 5), run("older-approved", 7)]);
    findMany.mockResolvedValue([]);
    expect(await loadApprovedRequirements("p1")).toEqual([]);
    expect(findMany.mock.calls[0][0].where.analysisId).toBe("rerun");
  });

  it("skips background rows, as the hub's list does", async () => {
    analysisFindMany.mockResolvedValue([
      run("ingest", 0, '{"source":"code-graph-ingest"}'),
      run("import", 2, '{"kind":"import","source":"jira"}'),
    ]);
    findMany.mockResolvedValue([]);
    await loadApprovedRequirements("p1");
    expect(findMany.mock.calls[0][0].where.analysisId).toBe("import");
    // With no run holding requirements, the newest non-background run.
    analysisFindMany.mockResolvedValue([
      run("research", 0, '{"source":"docs-gen-domain-research"}'),
      run("empty", 0, "not json"),
    ]);
    await loadApprovedRequirements("p1");
    expect(findMany.mock.calls[1][0].where.analysisId).toBe("empty");
  });

  it("reads no requirements when the project has no completed run", async () => {
    analysisFindMany.mockResolvedValue([]);
    expect(await loadApprovedRequirements("p1")).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("approvedRequirementsFacts (#1230)", () => {
  it("covers every rendered field but not version or updatedAt", () => {
    const base = approvedRequirementsFacts([req(1)]);
    expect(
      approvedRequirementsFacts([
        req(1, { version: 9, updatedAt: new Date("2026-10-09T00:00:00Z") }),
      ]),
    ).toBe(base);
    expect(approvedRequirementsFacts([req(1, { title: "Edited" })])).not.toBe(base);
    expect(approvedRequirementsFacts([req(1, { reviewStatus: "draft" })])).not.toBe(base);
    expect(approvedRequirementsFacts([req(1), req(2)])).not.toBe(base);
    expect(base).not.toContain("updatedAt");
  });

  it("changes with each field the section renders", () => {
    const base = approvedRequirementsFacts([req(1)]);
    const edits: Partial<ScopedRequirement>[] = [
      { id: "req-other" },
      { title: "Edited" },
      { body: "Edited body" },
      { type: "constraint" },
      { priority: "low" },
      { reviewStatus: "draft" },
      { verdict: "missing" },
      { acceptanceCriteria: JSON.stringify(["Edited criterion"]) },
    ];
    for (const edit of edits) expect(approvedRequirementsFacts([req(1, edit)])).not.toBe(base);
  });

  it("ignores the code links, which the section does not show (review B1)", () => {
    const base = approvedRequirementsFacts([req(1)]);
    const relinked = req(1, {
      codeMappings: [
        { filePath: "src/new.ts", startLine: 1, endLine: 9, confidence: 0.4, source: "manual" },
      ],
      implementations: [
        {
          prNumber: 7,
          prUrl: "https://example.test/pr/7",
          filePath: "src/new.ts",
          startLine: null,
          endLine: null,
        },
      ],
    });
    expect(approvedRequirementsFacts([relinked])).toBe(base);
    expect(base).not.toContain("codeMappings");
    // The section itself is unchanged by the relink: the facts follow what is shown.
    expect(renderApprovedRequirementsSection([relinked], 100_000).markdown).toBe(
      renderApprovedRequirementsSection([req(1)], 100_000).markdown,
    );
  });
});

describe("readsApprovedRequirements (#1230)", () => {
  it("is a full or repository BRD under the reader layout", () => {
    layout.mockReturnValue({ layout: "reader" });
    expect(readsApprovedRequirements({ scope: "full", scopeFilter: "{}" })).toBe(true);
    expect(
      readsApprovedRequirements({
        scope: "repository",
        scopeFilter: '{"repoConnectorId":"c","docType":"business-requirements"}',
      }),
    ).toBe(true);
    expect(readsApprovedRequirements({ scope: "full", scopeFilter: "null" })).toBe(true);
    expect(
      readsApprovedRequirements({ scope: "full", scopeFilter: '{"docType":"architecture"}' }),
    ).toBe(false);
    expect(
      readsApprovedRequirements({ scope: "full", scopeFilter: '{"docType":"user-guide"}' }),
    ).toBe(false);
    expect(readsApprovedRequirements({ scope: "requirements", scopeFilter: "{}" })).toBe(false);
    expect(readsApprovedRequirements({ scope: "module", scopeFilter: "{}" })).toBe(false);
    expect(readsApprovedRequirements({ scope: "full", scopeFilter: "{not json" })).toBe(false);
    layout.mockReturnValue({ layout: "catalogue" });
    expect(readsApprovedRequirements({ scope: "full", scopeFilter: "{}" })).toBe(false);
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

  it("leaves room for every other main section, the #1223 reader Capabilities included", () => {
    // #1223 gave Capabilities its own reader prompt, not a new section id: the
    // main part is still four sections, so the other three are 32k.
    const others = Object.entries(BRD_MAIN_SECTION_TARGETS).filter(([id]) => id !== "requirements");
    expect(others.map(([id]) => id).sort()).toEqual(["capabilities", "key-rules", "overview"]);
    const otherChars = others.reduce((n, [, chars]) => n + chars, 0);
    expect(otherChars).toBe(32_000);
    for (const body of [250_000, 120_000, 90_000, 40_000]) {
      expect(
        approvedRequirementsMaxChars(body) + otherChars * (mainFitCap(body) / BRD_MAIN_MAX_CHARS),
      ).toBeLessThanOrEqual(mainFitCap(body) + 1);
    }
  });
});

describe("the main-part code identifier check (#1223) on the section's own text", () => {
  it("finds nothing in the R<n>. headings, the id line, the lead-in or the pointer", () => {
    const requirements = [
      req(1, { id: "cmg1x2y3z0000abcd" }),
      req(2, { id: "REQ-001" }),
      req(3, { id: "R3." }),
    ];
    const { markdown } = renderApprovedRequirementsSection(requirements, 28_000);
    expect(markdown).toContain("### R1. Requirement 1");
    expect(markdown).toContain("**Requirement id:** `REQ-001`");
    expect(findCodeIdentifiers(markdown)).toEqual([]);
    const cut = renderApprovedRequirementsSection(requirements, 1_200).markdown;
    expect(cut).toContain("did not fit");
    expect(findCodeIdentifiers(cut)).toEqual([]);
  });

  it("would flag analyst-written code names and a snake_case stored id, which is why the section is exempt", () => {
    const { markdown } = renderApprovedRequirementsSection(
      [req(1, { id: "req_12", body: "The `markAsRead()` call updates entry_status." })],
      28_000,
    );
    expect(findCodeIdentifiers(markdown).map((h) => h.text)).toEqual(
      expect.arrayContaining(["req_12", "markAsRead()", "entry_status"]),
    );
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

  it("says, in a scoped document, that only requirements linked to its code are listed (#1246)", () => {
    const scoped = renderApprovedRequirementsSection([req(1)], 28_000, undefined, {
      scoped: true,
    }).markdown;
    expect(scoped).toContain(
      "approved requirement linked to code in this document's repository or paths.",
    );
    expect(scoped).toContain("**Only requirements linked to this part of the code are listed.**");
    expect(scoped).toContain(
      "a pull request counts only if it is in a repository connected to this project under the same owner and name",
    );
    expect(scoped).toContain(
      "Approved requirements with no code link, or linked only to other code, are not listed here",
    );
    expect(findCodeIdentifiers(scoped)).toEqual([]);
    const unscoped = renderApprovedRequirementsSection([req(1)], 28_000).markdown;
    expect(unscoped).not.toContain("linked to");
    // Its overflow pointer counts the linked requirements, not every approved one.
    const cut = renderApprovedRequirementsSection([req(1), req(2)], 1_000, undefined, {
      scoped: true,
    }).markdown;
    expect(cut).toContain(
      "approved requirements linked to this document's code are listed here.**",
    );
    expect(findCodeIdentifiers(cut)).toEqual([]);
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

describe("renderApprovedRequirementsSection — the overflow search (#1230)", () => {
  it("finds the same longest prefix a scan would, for every budget", () => {
    // Uneven sizes, so a wrong midpoint shows.
    const requirements = Array.from({ length: 12 }, (_, i) =>
      req(i + 1, { body: "Stored text. ".repeat((i * 7) % 11) }),
    );
    const total = requirements.length;
    const full = renderApprovedRequirementsSection(requirements, Infinity).markdown;
    const [head, ...entries] = full.split(/\n\n(?=### R\d+\. )/);
    expect(entries).toHaveLength(total);
    const withPointer = (n: number): string =>
      [head, ...entries.slice(0, n), overflowPointer(n, total)].join("\n\n");
    for (let maxChars = 200; maxChars < full.length; maxChars += 97) {
      const { markdown, listed } = renderApprovedRequirementsSection(requirements, maxChars);
      let expected = 0;
      while (expected < total && withPointer(expected + 1).length <= maxChars) expected += 1;
      expect({ maxChars, listed }).toEqual({ maxChars, listed: expected });
      expect(markdown).toBe(withPointer(listed));
    }
  });

  it("measures O(log N) candidate prefixes, not one per requirement", () => {
    const requirements = Array.from({ length: 1_000 }, (_, i) => req(i + 1));
    const measure = vi.fn((markdown: string) => markdown.length);
    const { listed } = renderApprovedRequirementsSection(requirements, 50_000, measure);
    expect(listed).toBeGreaterThan(10);
    expect(listed).toBeLessThan(1_000);
    // One for the whole list, then about log2(1000) = 10 probes. The scan
    // this replaced measured listed + 1 more (over 100 here).
    expect(measure.mock.calls.length).toBeLessThanOrEqual(12);
  });
});
