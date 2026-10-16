/**
 * #991 — the requirements docs-generation scope: which requirements a filter
 * selects (always within the project), and the document built from them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, count, analysisFindFirst, reviewFindFirst } = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  analysisFindFirst: vi.fn(),
  reviewFindFirst: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: { findMany, count },
    analysis: { findFirst: analysisFindFirst },
    reviewRequest: { findFirst: reviewFindFirst },
  },
}));

import {
  countScopedRequirements,
  headingWithCount,
  loadScopedRequirements,
  neutralizeHtml,
  renderRequirementsDocument,
  requirementsScopeFilterSchema,
  requirementsScopeWhere,
  requirementsSourceFingerprint,
  synthesizeRequirementsDocument,
  type ScopedRequirement,
} from "./requirements-scope.js";

function req(overrides: Partial<ScopedRequirement> = {}): ScopedRequirement {
  return {
    id: "req-1",
    title: "Export invoices",
    body: "Users can export invoices as CSV.",
    type: "feature",
    priority: "medium",
    reviewStatus: "approved",
    verdict: "implemented",
    acceptanceCriteria: JSON.stringify(["CSV has one row per invoice."]),
    version: 1,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    codeMappings: [],
    implementations: [],
    ...overrides,
  };
}

beforeEach(() => {
  findMany.mockReset();
  count.mockReset();
  analysisFindFirst.mockReset().mockResolvedValue(null);
  reviewFindFirst.mockReset().mockResolvedValue(null);
});

describe("requirementsScopeFilterSchema", () => {
  it("accepts an analysis run, a selection or a review", () => {
    expect(requirementsScopeFilterSchema.safeParse({ analysisId: "a1" }).success).toBe(true);
    expect(requirementsScopeFilterSchema.safeParse({ requirementIds: ["r1"] }).success).toBe(true);
    expect(requirementsScopeFilterSchema.safeParse({ reviewRequestId: "rv" }).success).toBe(true);
  });

  it("rejects a filter that selects nothing, or an empty or oversized selection", () => {
    expect(requirementsScopeFilterSchema.safeParse({ approvedOnly: true }).success).toBe(false);
    expect(requirementsScopeFilterSchema.safeParse({ requirementIds: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 501 }, (_, i) => `r${i}`);
    expect(requirementsScopeFilterSchema.safeParse({ requirementIds: tooMany }).success).toBe(
      false,
    );
  });
});

describe("requirementsScopeWhere", () => {
  it("always filters on the project and live rows", () => {
    expect(requirementsScopeWhere("p1", { analysisId: "a1" })).toEqual({
      projectId: "p1",
      deletedAt: null,
      analysisId: "a1",
    });
  });

  it("scopes a review to the project's own reviews and narrows to approved", () => {
    expect(
      requirementsScopeWhere("p1", {
        reviewRequestId: "rv",
        requirementIds: ["r1", "r1", "r2"],
        approvedOnly: true,
      }),
    ).toEqual({
      projectId: "p1",
      deletedAt: null,
      id: { in: ["r1", "r2"] },
      reviewItems: { some: { reviewRequestId: "rv", reviewRequest: { projectId: "p1" } } },
      reviewStatus: "approved",
    });
  });

  it("counts through the same project-scoped where", async () => {
    count.mockResolvedValue(3);
    await expect(countScopedRequirements("p1", { analysisId: "a1" })).resolves.toBe(3);
    expect(count).toHaveBeenCalledWith({
      where: { projectId: "p1", deletedAt: null, analysisId: "a1" },
    });
  });
});

describe("loadScopedRequirements", () => {
  it("reads code mappings within the project and orders by priority", async () => {
    findMany.mockResolvedValue([
      req({ id: "low", priority: "low" }),
      req({ id: "crit", priority: "critical" }),
      req({ id: "odd", priority: "unknown" }),
      req({ id: "high", priority: "high" }),
    ]);
    const rows = await loadScopedRequirements("p1", { analysisId: "a1" });
    expect(rows.map((r) => r.id)).toEqual(["crit", "high", "low", "odd"]);
    const args = findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ projectId: "p1", deletedAt: null, analysisId: "a1" });
    expect(args.select.codeMappings.where).toEqual({ projectId: "p1" });
  });
});

describe("renderRequirementsDocument", () => {
  it("renders each requirement with its criteria and code links", () => {
    const md = renderRequirementsDocument("Invoices BRD", { analysisId: "run-7" }, [
      req({
        codeMappings: [
          {
            filePath: "src/export.ts",
            startLine: 10,
            endLine: 40,
            confidence: 0.82,
            source: "semantic",
          },
        ],
        implementations: [
          {
            prNumber: 12,
            prUrl: "https://github.com/o/r/pull/12",
            filePath: "src/csv.ts",
            startLine: 5,
            endLine: 5,
          },
        ],
      }),
      req({ id: "req-2", title: "Audit log", reviewStatus: null, verdict: null, body: "  " }),
    ]);
    expect(md).toContain("# Invoices BRD (2 requirements)\n");
    expect(md).toContain("covers 2 requirement(s) from the selected analysis run.");
    expect(md).toContain("1 of 2 have recorded code links.");
    expect(md).toContain(
      "| R1 | Export invoices | feature | medium | approved | implemented | 2 |",
    );
    expect(md).toContain("| R2 | Audit log | feature | medium | draft | not assessed | 0 |");
    expect(md).toContain("### R1. Export invoices");
    expect(md).toContain("Users can export invoices as CSV.");
    expect(md).toContain("- CSV has one row per invoice.");
    expect(md).toContain("- `src/export.ts:10-40` — semantic mapping, confidence 82%");
    expect(md).toContain(
      "- `src/csv.ts:5` — implemented in [PR #12](https://github.com/o/r/pull/12)",
    );
    expect(md).toContain("_No description recorded._");
    expect(md).toContain("_No code links recorded for this requirement._");
  });

  it("says when no criteria were derived and names every selector used", () => {
    const md = renderRequirementsDocument(
      "T",
      { reviewRequestId: "rv-1", requirementIds: ["a", "b"], approvedOnly: true },
      [req({ acceptanceCriteria: "[]" })],
    );
    expect(md).toContain(
      "from the selected review and 2 selected requirement(s), approved requirements only.",
    );
    expect(md).toContain("_No acceptance criteria were derived for this requirement._");
  });

  it("keeps stored text from breaking the table or injecting HTML or links", () => {
    const md = renderRequirementsDocument("T", { analysisId: "a" }, [
      req({
        title: "A | B <img src=x onerror=alert(1)>",
        body: "Run <script>x()</script> but keep `List<String>`",
        codeMappings: [
          { filePath: "a`b.ts", startLine: null, endLine: null, confidence: 1, source: "manual" },
        ],
        implementations: [
          {
            prNumber: 3,
            prUrl: "javascript:void0",
            filePath: "x.ts",
            startLine: null,
            endLine: null,
          },
        ],
      }),
    ]);
    expect(md).toContain("| R1 | A \\| B &lt;img src=x onerror=alert(1)> |");
    expect(md).not.toContain("<script>");
    expect(md).toContain("`List<String>`");
    expect(md).toContain("- `a'b.ts` — manual mapping");
    expect(md).toContain("implemented in PR #3");
    expect(md).not.toContain("javascript:");
  });

  it("escapes a stored backslash so it cannot unescape a column separator", () => {
    const md = renderRequirementsDocument("T", { analysisId: "a" }, [req({ title: "A\\|B" })]);
    // `A\|B` → `A\\\|B`: an escaped backslash, then an escaped pipe.
    expect(md).toContain("| R1 | A\\\\\\|B |");
  });
});

describe("neutralizeHtml", () => {
  it("escapes tags outside code and leaves fenced blocks alone", () => {
    expect(neutralizeHtml("a <b>\n```\n<c>\n```\n`<d>` <e>")).toBe(
      "a &lt;b>\n```\n<c>\n```\n`<d>` &lt;e>",
    );
  });
});

describe("requirementsSourceFingerprint", () => {
  it("changes when a requirement or its code links change", () => {
    const base = requirementsSourceFingerprint([req()]);
    expect(requirementsSourceFingerprint([req()])).toBe(base);
    expect(requirementsSourceFingerprint([req({ version: 2 })])).not.toBe(base);
    expect(
      requirementsSourceFingerprint([
        req({
          codeMappings: [
            { filePath: "x.ts", startLine: 1, endLine: 2, confidence: 0.5, source: "manual" },
          ],
        }),
      ]),
    ).not.toBe(base);
  });
});

describe("synthesizeRequirementsDocument", () => {
  it("builds the document and fingerprint from the loaded requirements", async () => {
    findMany.mockResolvedValue([req()]);
    const out = await synthesizeRequirementsDocument("p1", { analysisId: "a1" }, "BRD");
    expect(out.requirementCount).toBe(1);
    expect(out.markdown).toContain("### R1. Export invoices");
    expect(out.sourceFingerprint).toBe(requirementsSourceFingerprint([req()]));
  });

  it("fails rather than publishing an empty document", async () => {
    findMany.mockResolvedValue([]);
    await expect(synthesizeRequirementsDocument("p1", { analysisId: "a1" }, "BRD")).rejects.toThrow(
      /No requirements match/,
    );
  });
});

describe("requirements chosen from one run — #1129", () => {
  it("says the document covers the chosen requirements of the run, with the count in the title", () => {
    const md = renderRequirementsDocument(
      "Business Requirements",
      { analysisId: "run-8", requirementIds: ["a", "b", "c", "d", "e"] },
      ["a", "b", "c", "d", "e"].map((id) => req({ id })),
    );
    expect(md.startsWith("# Business Requirements (5 requirements)\n")).toBe(true);
    expect(md).toContain(
      "This document covers 5 requirement(s) from those chosen from the selected analysis run.",
    );
    expect(md).not.toContain("selected requirement(s)");
  });

  it("does not repeat a count the title already states", () => {
    expect(headingWithCount("BRD — 5 requirements", 5)).toBe("BRD — 5 requirements");
    expect(headingWithCount("BRD", 1)).toBe("BRD (1 requirement)");
    expect(headingWithCount("BRD — 15 requirements", 5)).toBe(
      "BRD — 15 requirements (5 requirements)",
    );
  });
});

/**
 * #1170 — walkthrough run 9: the scoped BRD escaped the clarification markers
 * into visible text, listed every body's "## Clarifications" in the outline as a
 * sibling of "## Requirements", and named the run by its internal id.
 */
describe("requirement bodies carrying METIS markers — #1170", () => {
  const clarified = (n: number, flag: boolean) =>
    [
      `Requirement ${n} body.`,
      "",
      "<!-- metis:clarifications:start -->",
      "## Clarifications",
      "",
      "_Answers recorded during METIS clarification, verbatim._",
      "",
      ...(flag
        ? [
            "> **Check the acceptance criteria.** Edit them. <!-- metis:criteria-predate-answers -->",
            "",
          ]
        : []),
      `- **Q:** Question ${n}?`,
      `  **A:** Answer ${n}. _(typed by the requester)_`,
      "<!-- metis:clarifications:end -->",
    ].join("\n");
  const five = [1, 2, 3, 4, 5].map((n) =>
    req({
      id: `r${n}`,
      title: `Requirement ${n}`,
      body: clarified(n, n === 2),
      acceptanceCriteria: JSON.stringify([`Criterion ${n}.`]),
    }),
  );

  it("renders no marker, escaped or raw, and keeps the clarification text", () => {
    const md = renderRequirementsDocument("BRD", { analysisId: "a" }, five);
    expect(md).not.toMatch(/metis:/);
    expect(md).not.toContain("&lt;!--");
    expect(md).toContain("- **Q:** Question 2?\n  **A:** Answer 2. _(typed by the requester)_");
    expect(md).toContain("> **Check the acceptance criteria.** Edit them.\n");
  });

  it("contains every requirement the summary lists, each with its criteria", () => {
    const md = renderRequirementsDocument("BRD", { analysisId: "a" }, five);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(md).toContain(`| R${n} | Requirement ${n} |`);
      expect(md).toContain(`### R${n}. Requirement ${n}`);
      expect(md).toContain(`- Criterion ${n}.`);
      expect(md).toContain(`Answer ${n}.`);
    }
  });

  it("nests a body's own headings under its requirement, outside code fences only", () => {
    const md = renderRequirementsDocument("BRD", { analysisId: "a" }, [
      req({ body: "# Top\n\n## Clarifications\n\n```md\n## kept in code\n```\n\n##### Deep" }),
    ]);
    // The document's outline is its own: one H2 per part, one H3 per requirement.
    // (The third match is the fenced line, which is code and stays as written.)
    expect(md.match(/^## .*/gm)).toEqual(["## Summary", "## Requirements", "## kept in code"]);
    expect(md).toContain("#### Top\n");
    expect(md).toContain("#### Clarifications\n");
    expect(md).toContain("```md\n## kept in code\n```");
    expect(md).toContain("##### Deep");
  });

  const bodyOf = (body: string) => {
    const md = renderRequirementsDocument("BRD", { analysisId: "a" }, [req({ body })]);
    const start = md.indexOf("\n\n", md.indexOf("**Type:**")) + 2;
    return md.slice(start, md.indexOf("\n\n#### Acceptance criteria"));
  };

  it("does not close a fence on a line that carries an info string", () => {
    // CommonMark: a closing fence takes no info string, so "```js" is content.
    const body = "```md\n```js\n## inside the block\n```\n## after";
    expect(bodyOf(body)).toBe("```md\n```js\n## inside the block\n```\n#### after");
  });

  it("closes a fence only with the same character, at least as long", () => {
    expect(bodyOf("````\n```\n## still code\n~~~~\n````\n# out")).toBe(
      "````\n```\n## still code\n~~~~\n````\n#### out",
    );
  });

  it("nests setext headings as ATX H4, joining a multi-line title", () => {
    expect(bodyOf("Background\n==========\n\nText.\n\nScope of\nthe change\n---\n\nMore.")).toBe(
      "#### Background\n\nText.\n\n#### Scope of the change\n\nMore.",
    );
  });

  it("keeps a thematic break, a list's or quote's break, and a table delimiter as they are", () => {
    const body = [
      "Para.",
      "",
      "---",
      "",
      "- item",
      "---",
      "",
      "> quote",
      "---",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "a | b",
      "--- | ---",
      "",
      "***",
      "    indented code",
      "---",
    ].join("\n");
    expect(bodyOf(body)).toBe(body);
  });

  it("handles CRLF bodies: a fence closes, setext and ATX headings nest, markers go", () => {
    // Review 5548504686: with a trailing \r the closer did not match, so the
    // fence stayed open and "## After" kept its H2.
    expect(bodyOf("```\r\ncode\r\n```\r\n## After\r\n")).toBe("```\ncode\n```\n#### After");
    expect(bodyOf("Title\r\n===\r\n\r\nText.\r\n\r\nSub\r\n---\r\n")).toBe(
      "#### Title\n\nText.\n\n#### Sub",
    );
    const md = renderRequirementsDocument("BRD", { analysisId: "a" }, [
      req({
        body: "Body.\r\n\r\n<!-- metis:clarifications:start -->\r\n## Clarifications\r\n- **Q:** q\r\n  **A:** a\r\n<!-- metis:clarifications:end -->\r\n",
      }),
    ]);
    expect(md).not.toMatch(/metis:|\r/);
    expect(md).toContain("#### Clarifications\n- **Q:** q\n  **A:** a");
  });

  it("ends the heading candidate at a list item, a quote or a thematic break", () => {
    // CommonMark: each interrupts the paragraph, so the `---` under it is a
    // thematic break and nothing is folded into a heading.
    for (const body of ["Para\n- item\n---", "Para\n> quote\n---", "Para\n1. one\n---"]) {
      expect(bodyOf(body)).toBe(body);
    }
    expect(bodyOf("Para\n***\nNext\n---")).toBe("Para\n***\n#### Next");
    // An indented line cannot interrupt a paragraph: it continues it.
    expect(bodyOf("Para\n    more\n===")).toBe("#### Para more");
  });

  it("never reads a bare --- under a table row as a heading underline", () => {
    expect(bodyOf("| a |\n---")).toBe("| a |\n---");
    expect(bodyOf("Text\n| a | b |\n===")).toBe("Text\n| a | b |\n===");
  });

  it("ends the heading candidate at an ATX heading or a fence", () => {
    // Without the reset, the `---` would fold "Para" and the heading or the
    // fence into one "####" line.
    expect(bodyOf("Para\n# H\n---")).toBe("Para\n#### H\n---");
    expect(bodyOf("Para\n```\nx\n```\n---")).toBe("Para\n```\nx\n```\n---");
  });

  it("reads an indented list marker inside a paragraph as its text, not a new item", () => {
    // Four columns of indent cannot start a list item: the line continues "Para".
    expect(bodyOf("Para\n    - x\n---")).toBe("#### Para - x");
  });

  it("leaves a list item's continuation paragraph inside its item", () => {
    // Third adversarial panel on PR #1179: rewritten at column 0, "para" ended the list.
    for (const body of ["- item\n\n  para\n  ---\n  more", "1. item\n\n   para\n   ==="]) {
      expect(bodyOf(body)).toBe(body);
    }
    // An ATX heading inside an item is nested and keeps its indent.
    expect(bodyOf("- item\n\n  ## Inside")).toBe("- item\n\n  #### Inside");
    // An unindented paragraph after the list is top level again.
    expect(bodyOf("- item\n\nAfter\n---")).toBe("- item\n\n#### After");
  });

  it("treats a tab-indented line as code, never as heading text", () => {
    expect(bodyOf("\tcode\n---")).toBe("\tcode\n---");
    expect(bodyOf("  \tcode\n===")).toBe("  \tcode\n===");
  });

  it("nests a setext heading after an ATX heading or a fence without a blank line", () => {
    expect(bodyOf("# One\nTwo\n===\n```\nx\n```\nThree\n---")).toBe(
      "#### One\n#### Two\n```\nx\n```\n#### Three",
    );
  });
});

describe("the run and review are named, never by id — #1170", () => {
  it("names the analysis run by its start time", () => {
    const md = renderRequirementsDocument(
      "BRD",
      { analysisId: "cmvahloo52ogq3g9kw84hy7wp", requirementIds: ["a"] },
      [req()],
      { analysisStartedAt: new Date("2026-10-16T04:48:09.123Z") },
    );
    expect(md).not.toContain("cmvahloo52ogq3g9kw84hy7wp");
    expect(md).toContain(
      "This document covers 1 requirement(s) from those chosen from the analysis run started 2026-10-16 04:48:09 UTC.",
    );
  });

  it("names a review by its title, and falls back to words when either is unknown", () => {
    const named = renderRequirementsDocument("BRD", { reviewRequestId: "rv-secret-id" }, [req()], {
      reviewTitle: "Sprint 12 | intake <b>",
    });
    expect(named).not.toContain("rv-secret-id");
    expect(named).toContain("from review “Sprint 12 \\| intake &lt;b>”.");
    const unnamed = renderRequirementsDocument(
      "BRD",
      { analysisId: "run-x", reviewRequestId: "rv-y" },
      [req()],
    );
    expect(unnamed).not.toMatch(/run-x|rv-y/);
    expect(unnamed).toContain("from the selected analysis run and the selected review.");
  });

  it("loads the start time and the review title within the project", async () => {
    findMany.mockResolvedValue([req()]);
    analysisFindFirst.mockResolvedValue({ startedAt: new Date("2026-10-16T04:48:09Z") });
    reviewFindFirst.mockResolvedValue({ title: "Intake review" });
    const out = await synthesizeRequirementsDocument(
      "p1",
      { analysisId: "a1", reviewRequestId: "rv1" },
      "BRD",
    );
    expect(analysisFindFirst).toHaveBeenCalledWith({
      where: { id: "a1", projectId: "p1" },
      select: { startedAt: true },
    });
    expect(reviewFindFirst).toHaveBeenCalledWith({
      where: { id: "rv1", projectId: "p1" },
      select: { title: true },
    });
    expect(out.markdown).toContain(
      "from the analysis run started 2026-10-16 04:48:09 UTC and review “Intake review”.",
    );
  });

  it("does not read a run or review the filter does not name", async () => {
    findMany.mockResolvedValue([req()]);
    await synthesizeRequirementsDocument("p1", { requirementIds: ["r1"] }, "BRD");
    expect(analysisFindFirst).not.toHaveBeenCalled();
    expect(reviewFindFirst).not.toHaveBeenCalled();
  });
});
