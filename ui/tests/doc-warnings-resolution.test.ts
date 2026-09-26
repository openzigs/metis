/**
 * Issue #252 — the documentation banner resolves degraded-output warnings from
 * the dedicated structured `warnings` column, with a legacy fallback to the
 * `errorMessage` JSON for docs persisted before the migration.
 */
import { describe, expect, it } from "vitest";
import {
  resolveDocWarnings,
  formatWarningDetail,
  tierRangeTag,
  classifyWarningSeverity,
  formatSectionList,
  canShowSchemaGraphTabs,
  groundingModeNotice,
} from "@/app/(authed)/projects/[id]/documentation/page";

const W = (message: string) => ({
  kind: "section-failed",
  section: "Overview",
  message,
  severity: "error",
});

type Tier = "narrative" | "reconstruction" | "literal";

/** A faithfulness `section-ungrounded` warning at a given tier. */
const tierWarning = (section: string, tier: Tier, extra: Record<string, unknown> = {}) => ({
  kind: "section-ungrounded",
  section,
  message: `Section "${section}" detail.`,
  severity: "warning",
  ratio: 0.3,
  threshold: tier === "narrative" ? 0.4 : tier === "reconstruction" ? 0.6 : 0.8,
  tier,
  ...(tier === "narrative" ? { domainContext: true } : {}),
  ...extra,
});

describe("resolveDocWarnings (#252)", () => {
  it("prefers the structured warnings column when present", () => {
    const structured = [W("Section A failed"), W("Section B ungrounded")];
    const out = resolveDocWarnings(structured, '[{"message":"legacy"}]');
    expect(out).toHaveLength(2);
    expect(out.map((w) => w.message)).toEqual(["Section A failed", "Section B ungrounded"]);
  });

  it("filters malformed entries out of the structured column", () => {
    const structured = [W("good"), { kind: "x", section: "", severity: "error" }] as never[];
    const out = resolveDocWarnings(structured, null);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe("good");
  });

  it("falls back to parsing legacy errorMessage JSON when no structured column", () => {
    const out = resolveDocWarnings(null, JSON.stringify([W("legacy warning")]));
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe("legacy warning");
  });

  it("treats a non-JSON legacy errorMessage as a single generic warning", () => {
    const out = resolveDocWarnings(undefined, "boom: synthesizer crashed");
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe("boom: synthesizer crashed");
    expect(out[0].severity).toBe("error");
  });

  it("returns an empty array when there are no warnings at all", () => {
    expect(resolveDocWarnings(null, null)).toEqual([]);
    expect(resolveDocWarnings([], null)).toEqual([]);
  });
});

describe("formatWarningDetail (#273 faithfulness ratio surfacing)", () => {
  it("appends the faithfulness ratio and threshold when present", () => {
    const detail = formatWarningDetail({
      kind: "section-ungrounded",
      section: "Overview & Domain",
      message: 'Section "Overview & Domain" has a faithfulness of 30%...',
      severity: "warning",
      ratio: 0.3,
      threshold: 0.8,
    });
    expect(detail).toContain("faithfulness 30%");
    expect(detail).toContain("threshold 80%");
  });

  it("returns just the message when no ratio is present (back-compat)", () => {
    const detail = formatWarningDetail({
      kind: "section-failed",
      section: "X",
      message: "Section X could not be generated.",
      severity: "error",
    });
    expect(detail).toBe("Section X could not be generated.");
    expect(detail).not.toContain("faithfulness");
  });

  it("renders a domain-context narrative warning as-is, WITHOUT the alarming numeric suffix (#283)", () => {
    const message =
      'Section "Overview & Domain": 20% of claims (9 of 44) are grounded in source ' +
      "code; the remaining claims provide domain/business context from general knowledge " +
      "rather than the codebase.";
    const detail = formatWarningDetail({
      kind: "section-ungrounded",
      section: "Overview & Domain",
      message,
      severity: "warning",
      ratio: 9 / 44,
      threshold: 0.4,
      domainContext: true,
    });
    // The honest message is preserved verbatim, with no "[faithfulness …]" suffix.
    expect(detail).toBe(message);
    expect(detail).not.toContain("[faithfulness");
    expect(detail).not.toContain("threshold");
    expect(detail).toContain("grounded in source code");
  });
});

describe("tierRangeTag (per-section expected-range tags)", () => {
  it("tags a narrative section as within expected range, suggesting web research", () => {
    const tag = tierRangeTag(tierWarning("Overview & Domain", "narrative"));
    expect(tag).toContain("narrative section");
    expect(tag).toContain("within expected range");
    expect(tag).toContain("web research");
  });

  it("tags a reconstruction section as inferred, to verify against source", () => {
    const tag = tierRangeTag(tierWarning("Key Workflows", "reconstruction"));
    expect(tag).toContain("reconstruction section");
    expect(tag).toContain("inferred");
    expect(tag).toContain("verify against source");
  });

  it("tags a literal section as below the code-fidelity bar, to review", () => {
    const tag = tierRangeTag(tierWarning("Business Rules", "literal"));
    expect(tag).toContain("below the code-fidelity bar");
    expect(tag).toContain("review");
  });

  it("returns an empty tag for warnings with no tier (failed/legacy/no-modules)", () => {
    expect(tierRangeTag(W("boom"))).toBe("");
    expect(
      tierRangeTag({ kind: "no-modules", section: "Document", message: "x", severity: "warning" }),
    ).toBe("");
  });
});

describe("formatWarningDetail — tier tags by section type", () => {
  it("appends the narrative tag to a narrative (domainContext) warning, keeping the honest message", () => {
    const detail = formatWarningDetail(tierWarning("Overview & Domain", "narrative"));
    expect(detail).toContain('Section "Overview & Domain" detail.');
    expect(detail).toContain("narrative section, within expected range");
    // domainContext path must NOT add the alarming numeric suffix.
    expect(detail).not.toContain("[faithfulness");
  });

  it("appends the reconstruction tag AND the numeric suffix for a reconstruction warning", () => {
    const detail = formatWarningDetail(tierWarning("Key Workflows", "reconstruction"));
    expect(detail).toContain("[faithfulness 30% (threshold 60%)]");
    expect(detail).toContain("reconstruction section, inferred; verify against source");
  });

  it("appends the literal tag AND the numeric suffix for a literal warning", () => {
    const detail = formatWarningDetail(tierWarning("Business Rules", "literal"));
    expect(detail).toContain("[faithfulness 30% (threshold 80%)]");
    expect(detail).toContain("below the code-fidelity bar, review");
  });

  it("renders the faithfulness suffix WITHOUT a threshold when only ratio is present", () => {
    const detail = formatWarningDetail({
      kind: "section-ungrounded",
      section: "Workflows",
      message: 'Section "Workflows" detail.',
      severity: "warning",
      ratio: 0.42,
      tier: "literal",
    });
    expect(detail).toContain("[faithfulness 42%]");
    expect(detail).not.toContain("threshold");
    expect(detail).toContain("below the code-fidelity bar, review");
  });
});

describe("classifyWarningSeverity (tier-aware banner severity)", () => {
  it("is NOT review-recommended when every section is narrative or reconstruction", () => {
    const { reviewRecommended, concerningSections } = classifyWarningSeverity([
      tierWarning("Overview & Domain", "narrative"),
      tierWarning("Key Workflows", "reconstruction"),
      tierWarning("Data & Domain Model", "reconstruction"),
    ]);
    expect(reviewRecommended).toBe(false);
    expect(concerningSections).toEqual([]);
  });

  it("is review-recommended and names the section when a LITERAL section is below its bar", () => {
    const { reviewRecommended, concerningSections } = classifyWarningSeverity([
      tierWarning("Overview & Domain", "narrative"),
      tierWarning("Business Rules", "literal"),
    ]);
    expect(reviewRecommended).toBe(true);
    expect(concerningSections).toEqual(["Business Rules"]);
  });

  it("is review-recommended for a FAILED section", () => {
    const { reviewRecommended, concerningSections } = classifyWarningSeverity([
      { kind: "section-failed", section: "Calculations", message: "boom", severity: "error" },
      tierWarning("Overview & Domain", "narrative"),
    ]);
    expect(reviewRecommended).toBe(true);
    expect(concerningSections).toEqual(["Calculations"]);
  });

  it("is review-recommended for a no-modules document warning", () => {
    const { reviewRecommended } = classifyWarningSeverity([
      { kind: "no-modules", section: "Document", message: "empty", severity: "warning" },
    ]);
    expect(reviewRecommended).toBe(true);
  });

  it("is review-recommended for a #330 source-unavailable document warning", () => {
    const { reviewRecommended } = classifyWarningSeverity([
      {
        kind: "source-unavailable",
        section: "Document",
        message: "2 of 5 code module(s) could not be read — re-ingest.",
        severity: "error",
      },
    ]);
    expect(reviewRecommended).toBe(true);
  });

  it("treats a legacy untiered section-ungrounded (no tier, no domainContext) as concerning", () => {
    const { reviewRecommended, concerningSections } = classifyWarningSeverity([
      { kind: "section-ungrounded", section: "Workflows", message: "x", severity: "warning" },
    ]);
    expect(reviewRecommended).toBe(true);
    expect(concerningSections).toEqual(["Workflows"]);
  });

  it("honours a legacy domainContext narrative note (no tier) as within tolerance", () => {
    const { reviewRecommended } = classifyWarningSeverity([
      {
        kind: "section-ungrounded",
        section: "Overview",
        message: "x",
        severity: "warning",
        domainContext: true,
      },
    ]);
    expect(reviewRecommended).toBe(false);
  });

  it("dedupes repeated concerning section labels and drops blanks", () => {
    const { concerningSections } = classifyWarningSeverity([
      tierWarning("Business Rules", "literal"),
      tierWarning("Business Rules", "literal"),
      { kind: "section-failed", section: "", message: "boom", severity: "error" },
    ]);
    expect(concerningSections).toEqual(["Business Rules"]);
  });
});

describe("formatSectionList", () => {
  it("quotes a single section", () => {
    expect(formatSectionList(["Business Rules"])).toBe('"Business Rules"');
  });
  it("joins two sections with 'and'", () => {
    expect(formatSectionList(["A", "B"])).toBe('"A" and "B"');
  });
  it("comma-joins three+ sections with a trailing 'and'", () => {
    expect(formatSectionList(["A", "B", "C"])).toBe('"A", "B" and "C"');
  });
  it("falls back to a generic phrase for an empty list", () => {
    expect(formatSectionList([])).toBe("the sections below");
  });
});

describe("canShowSchemaGraphTabs (#1228)", () => {
  it("shows the tabs for a ready database document", () => {
    expect(canShowSchemaGraphTabs(true, "ready")).toBe(true);
  });

  it("STILL shows them when failed table prose degraded the document", () => {
    // The tab strip is the only control that can select the graph view, and the
    // graph is complete even when the prose is not. Gating on `ready` alone hid
    // the explorer for exactly the documents #1228 marks degraded.
    expect(canShowSchemaGraphTabs(true, "degraded")).toBe(true);
  });

  it("hides them while there is no persisted graph yet", () => {
    for (const status of ["pending", "generating", "failed", null, undefined]) {
      expect(canShowSchemaGraphTabs(true, status)).toBe(false);
    }
  });

  it("never shows them for a non-database document", () => {
    expect(canShowSchemaGraphTabs(false, "ready")).toBe(false);
    expect(canShowSchemaGraphTabs(false, "degraded")).toBe(false);
  });
});

describe("DOCS_GEN_GROUNDING labelling (#186)", () => {
  it("formatWarningDetail labels a sampled ratio as sampled", () => {
    expect(
      formatWarningDetail({ ...tierWarning("Business Rules", "literal"), sampled: true }),
    ).toContain("[sampled faithfulness 30% (threshold 80%)]");
    expect(formatWarningDetail(tierWarning("Business Rules", "literal"))).toContain(
      "[faithfulness 30% (threshold 80%)]",
    );
  });

  it("grounding-skipped / grounding-sampled are not 'short of the bar'", () => {
    const { reviewRecommended, concerningSections } = classifyWarningSeverity([
      { kind: "grounding-skipped", section: "A", message: "x", severity: "warning" },
      { kind: "grounding-sampled", section: "B", message: "x", severity: "warning", sampled: true },
    ]);
    expect(reviewRecommended).toBe(false);
    expect(concerningSections).toEqual([]);
  });

  it("groundingModeNotice names the mode, or is null for a fully checked document", () => {
    expect(groundingModeNotice([tierWarning("A", "literal")])).toBeNull();
    expect(
      groundingModeNotice([
        { kind: "grounding-skipped", section: "A", message: "x", severity: "warning" },
      ]),
    ).toMatch(/^Not fact-checked: 1 section\(s\).*DOCS_GEN_GROUNDING=off/);
    // A below-bar warning flagged sampled is enough: no grounding-sampled needed.
    expect(groundingModeNotice([{ ...tierWarning("A", "literal"), sampled: true }])).toMatch(
      /^Spot-checked only: .*DOCS_GEN_GROUNDING=sample/,
    );
  });
});
