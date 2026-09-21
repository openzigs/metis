/**
 * #961/#994 — weak requirement→code match banner.
 *
 * A `weak` matchQuality (the requirement seeded poorly) must surface an explicit
 * "low-confidence match" banner so a thin result reads as "re-word the
 * requirement", not a confident answer. A well-named requirement
 * (`strong`/`moderate`) must NOT show the banner. #994 — the banner copy is
 * conditioned on `matchQualityReason`: "didn't clearly name an entity/screen"
 * may ONLY render for `reason="no-entity"` (zero seeds); `reason="scattered"`
 * (several near-tied seeds, no dominant entity) gets distinct wording so the
 * banner never claims the requirement named nothing when it actually fanned out
 * across unrelated areas. The banner is distinct from the #936 relevance
 * secondary bucket.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type {
  ImpactAffectedTableView,
  ImpactItemView,
  MatchQuality,
  MatchQualityReason,
} from "@metis/shared";
import { ChangedRequirementGroup } from "./changed-requirement-group";

function item(matchQuality: MatchQuality, overrides: Partial<ImpactItemView> = {}): ImpactItemView {
  const matchQualityReason: MatchQualityReason =
    overrides.matchQualityReason ?? (matchQuality === "weak" ? "no-entity" : null);
  return {
    id: "it-1",
    projectId: "p1",
    requirementId: "r1",
    requirementTitle: "Some requirement",
    changeType: "modified",
    severity: "medium",
    impactScore: 0.5,
    confidence: 0.3,
    matchQuality,
    matchQualityReason,
    affectedFileCount: 1,
    affectedSymbolCount: 1,
    summary: null,
    affectedSymbols: [
      {
        id: "s1",
        codeSymbolId: "cs1",
        filePath: "src/Foo.java",
        qualifiedName: "com.example.Foo.bar",
        startLine: 1,
        endLine: 2,
        relation: "direct",
        depth: 0,
        confidence: 0.3,
      },
    ],
    affectedTests: [],
    writePathGaps: [],
    affectedTables: [],
    affectedTablesSecondary: [],
    feedback: [],
    ...overrides,
  };
}

describe("ChangedRequirementGroup weak-match banner (#961)", () => {
  it("renders the no-entity banner for a weak match with zero seeds", () => {
    render(<ChangedRequirementGroup item={item("weak", { matchQualityReason: "no-entity" })} />);
    const banner = screen.getByTestId("weak-match-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/low-confidence match/i);
    expect(banner.textContent).toMatch(/didn't clearly name an entity\/screen/i);
    expect(banner.textContent).toMatch(/naming the feature, table, or module/i);
  });

  it("does NOT render the banner for a moderate match", () => {
    render(<ChangedRequirementGroup item={item("moderate")} />);
    expect(screen.queryByTestId("weak-match-banner")).not.toBeInTheDocument();
  });

  it("does NOT render the banner for a strong match", () => {
    render(<ChangedRequirementGroup item={item("strong")} />);
    expect(screen.queryByTestId("weak-match-banner")).not.toBeInTheDocument();
  });
});

describe("ChangedRequirementGroup weak-match banner reason copy (#994)", () => {
  it("renders distinct 'scattered' copy for a weak match with no dominant shared entity", () => {
    render(<ChangedRequirementGroup item={item("weak", { matchQualityReason: "scattered" })} />);
    const banner = screen.getByTestId("weak-match-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/low-confidence match/i);
    expect(banner.textContent).toMatch(/matched code across several unrelated areas/i);
    // Must NOT claim the requirement failed to name anything — that's factually
    // wrong for the scattered case (#994's reported bug).
    expect(banner.textContent).not.toMatch(/didn't clearly name an entity/i);
  });

  it("the no-entity and scattered banners render genuinely different copy", () => {
    const { unmount } = render(
      <ChangedRequirementGroup item={item("weak", { matchQualityReason: "no-entity" })} />,
    );
    const noEntityText = screen.getByTestId("weak-match-banner").textContent;
    unmount();
    render(<ChangedRequirementGroup item={item("weak", { matchQualityReason: "scattered" })} />);
    const scatteredText = screen.getByTestId("weak-match-banner").textContent;
    expect(noEntityText).not.toBe(scatteredText);
  });
});

describe("ChangedRequirementGroup affected-tests grouping (#962)", () => {
  const testSymbol = (id: string, qualifiedName: string, filePath: string) => ({
    id,
    codeSymbolId: id,
    filePath,
    qualifiedName,
    startLine: 1,
    endLine: 2,
    relation: "caller" as const,
    depth: 1,
    confidence: 0.6,
  });

  it("renders a Tests group with a count and does NOT mix tests into the prod radius", () => {
    render(
      <ChangedRequirementGroup
        item={item("strong", {
          affectedTests: [
            testSymbol(
              "t1",
              "org.AccountMapperTest.testUpdate",
              "src/test/java/AccountMapperTest.java",
            ),
            testSymbol(
              "t2",
              "org.AccountServiceTest.testUpdate",
              "src/test/java/AccountServiceTest.java",
            ),
          ],
        })}
      />,
    );
    const group = screen.getByTestId("affected-tests");
    expect(group).toBeInTheDocument();
    expect(screen.getByTestId("affected-tests-toggle").textContent).toMatch(/Tests \(2\)/);
    // Two distinct test files ⇒ two file groups.
    expect(screen.getAllByTestId("affected-tests-file-group")).toHaveLength(2);
  });

  it("omits the Tests group when there are no impacted test files", () => {
    render(<ChangedRequirementGroup item={item("strong")} />);
    expect(screen.queryByTestId("affected-tests")).not.toBeInTheDocument();
  });
});

describe("ChangedRequirementGroup write-path coverage callout (#962)", () => {
  it("renders the callout for an untested write path", () => {
    render(
      <ChangedRequirementGroup
        item={item("strong", {
          writePathGaps: [
            {
              tableName: "account",
              writingSymbols: ["org.AccountMapper.updateAccount"],
              coveredWritingSymbols: [],
            },
          ],
        })}
      />,
    );
    const callout = screen.getByTestId("write-path-gap-callout");
    expect(callout).toBeInTheDocument();
    expect(callout.textContent).toMatch(/untested write path/i);
    expect(callout.textContent).toContain("account");
    expect(callout.textContent).toContain("org.AccountMapper.updateAccount");
    expect(screen.getAllByTestId("write-path-gap-row")).toHaveLength(1);
  });

  it("#1012 — distinguishes a PARTIALLY covered table from an untested one", () => {
    render(
      <ChangedRequirementGroup
        item={item("strong", {
          writePathGaps: [
            {
              tableName: "account",
              writingSymbols: ["org.AccountMapper.updateAccount"],
              coveredWritingSymbols: ["org.AccountMapper.insertAccount"],
            },
          ],
        })}
      />,
    );
    const row = screen.getByTestId("write-path-gap-row");
    expect(row.textContent).toContain("1 of 2");
    expect(row.textContent).toContain("write paths are untested");
    // Only the UNCOVERED writer is named — naming the covered one here would send
    // QA at a mutation that already has a test.
    expect(row.textContent).toContain("org.AccountMapper.updateAccount");
    expect(row.textContent).not.toContain("org.AccountMapper.insertAccount");
    expect(row.textContent).not.toMatch(/No test covers/i);
  });

  it("pluralizes the header for multiple untested tables", () => {
    render(
      <ChangedRequirementGroup
        item={item("strong", {
          writePathGaps: [
            { tableName: "account", writingSymbols: ["A.w"], coveredWritingSymbols: [] },
            { tableName: "orders", writingSymbols: ["O.w"], coveredWritingSymbols: [] },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("write-path-gap-callout").textContent).toMatch(
      /2 impacted tables have untested write paths/i,
    );
    expect(screen.getAllByTestId("write-path-gap-row")).toHaveLength(2);
  });

  it("does NOT render the callout when the write path is fully covered", () => {
    render(<ChangedRequirementGroup item={item("strong", { writePathGaps: [] })} />);
    expect(screen.queryByTestId("write-path-gap-callout")).not.toBeInTheDocument();
  });
});

describe("ChangedRequirementGroup tangential secondary bucket (#1022)", () => {
  // The export shows `relevance: unlikely related` + the rationale for these
  // pruned tables; the UI must not silently drop that tier + rationale. They
  // live behind the collapsed "Possibly-tangential" disclosure (recall safety),
  // but inside it the tier badge and rationale must render, matching the export.
  const secondaryTable = (
    over: Partial<ImpactAffectedTableView> = {},
  ): ImpactAffectedTableView => ({
    id: "sec-1",
    objectKind: "table",
    tableName: "item",
    columnName: null,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: "-- Verify table item — tangential to the change",
    source: "mybatis",
    reconciliation: "matched",
    confidence: 0.2,
    relevanceTier: "unlikely",
    relevanceRationale: "Catalog data itself is not affected by the loyalty change.",
    ...over,
  });

  it("renders the unlikely tier badge and rationale inside the tangential disclosure", () => {
    render(
      <ChangedRequirementGroup
        item={item("strong", { affectedTablesSecondary: [secondaryTable()] })}
      />,
    );
    const secondary = screen.getByTestId("schema-impact-secondary");
    const badge = within(secondary).getByTestId("schema-relevance-tier");
    expect(badge).toHaveAttribute("data-relevance-tier", "unlikely");
    expect(badge).toHaveTextContent("Unlikely related");
    expect(within(secondary).getByTestId("schema-relevance-rationale")).toHaveTextContent(
      "Catalog data itself is not affected by the loyalty change.",
    );
  });

  it("counts DISTINCT tables, not table+column rows, in the pruned header (#1023)", () => {
    render(
      <ChangedRequirementGroup
        item={item("strong", {
          affectedTablesSecondary: [
            secondaryTable(),
            secondaryTable({ id: "sec-c1", objectKind: "column", columnName: "itemid" }),
            secondaryTable({ id: "sec-c2", objectKind: "column", columnName: "qty" }),
            secondaryTable({ id: "sec-c3", objectKind: "column", columnName: "name" }),
          ],
        })}
      />,
    );
    const toggle = screen.getByTestId("schema-impact-secondary-toggle");
    // One table (`item`) with three column rows is ONE pruned table, not four.
    expect(toggle).toHaveTextContent("1 table pruned as low-relevance");
    expect(toggle.textContent).not.toMatch(/\b4\b/);
  });

  it("pluralizes the pruned header across multiple distinct tables (#1023)", () => {
    render(
      <ChangedRequirementGroup
        item={item("strong", {
          affectedTablesSecondary: [
            secondaryTable({ id: "s1", tableName: "item" }),
            secondaryTable({ id: "s2", tableName: "inventory" }),
            secondaryTable({ id: "s3", tableName: "sequence" }),
          ],
        })}
      />,
    );
    expect(screen.getByTestId("schema-impact-secondary-toggle")).toHaveTextContent(
      "3 tables pruned as low-relevance",
    );
  });
});
