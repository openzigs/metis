/**
 * #991 — the requirements docs-generation scope: which requirements a filter
 * selects (always within the project), and the document built from them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, count } = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn() }));
vi.mock("../prisma.js", () => ({ prisma: { requirement: { findMany, count } } }));

import {
  countScopedRequirements,
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
    expect(md).toContain("# Invoices BRD");
    expect(md).toContain("covers 2 requirement(s) from analysis run `run-7`");
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
      "from review `rv-1` and 2 selected requirement(s), approved requirements only.",
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
