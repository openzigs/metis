import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ImpactAffectedSymbolView, ImpactItemView } from "@metis/shared";
import { AffectedSymbolRow } from "@/components/impact/affected-symbol-row";
import { ChangedRequirementGroup } from "@/components/impact/changed-requirement-group";
import {
  ProjectImpactSection,
  ProjectImpactSectionWithUsage,
} from "@/components/impact/project-impact-section";

const useProjectUsageClassification = vi.fn(
  (_projectId?: string) => ({ data: undefined }) as { data: unknown },
);
// Epic #295 Phase 4 (#310) — the wrapper now also fetches cross-project impact;
// default to a benign no-data state for these usage-classification tests.
const useCrossProjectImpact = vi.fn(
  (_projectId?: string) =>
    ({ data: null, isLoading: false, isError: false }) as {
      data: unknown;
      isLoading: boolean;
      isError: boolean;
    },
);
vi.mock("@/lib/impact-analysis-hooks", () => ({
  useProjectUsageClassification: (projectId: string) => useProjectUsageClassification(projectId),
  useCrossProjectImpact: (projectId: string) => useCrossProjectImpact(projectId),
}));

function symbol(over: Partial<ImpactAffectedSymbolView> = {}): ImpactAffectedSymbolView {
  return {
    id: "sym-1",
    codeSymbolId: "cs-1",
    filePath: "src/a.ts",
    qualifiedName: "a.fn",
    startLine: 10,
    endLine: 20,
    relation: "direct",
    depth: 0,
    confidence: 0.9,
    ...over,
  };
}

function item(over: Partial<ImpactItemView> = {}): ImpactItemView {
  return {
    id: "item-1",
    projectId: "project-001",
    requirementId: "req-1",
    requirementTitle: "Add login",
    changeType: "added",
    severity: "high",
    impactScore: 0.5,
    confidence: 0.8,
    matchQuality: "strong",
    matchQualityReason: null,
    affectedFileCount: 1,
    affectedSymbolCount: 2,
    affectedSymbols: [
      symbol({ id: "s1", relation: "direct", depth: 0 }),
      symbol({ id: "s2", relation: "caller", depth: 1 }),
    ],
    affectedTables: [],
    affectedTablesSecondary: [],
    affectedTests: [],
    writePathGaps: [],
    feedback: [],
    summary: null,
    ...over,
  };
}

describe("AffectedSymbolRow", () => {
  it("renders relation, depth and line range", () => {
    render(
      <ul>
        <AffectedSymbolRow symbol={symbol({ relation: "importer", depth: 2 })} />
      </ul>,
    );
    expect(screen.getByTestId("affected-symbol-relation")).toHaveTextContent("Importer");
    expect(screen.getByTestId("affected-symbol-depth")).toHaveTextContent("depth 2");
    expect(screen.getByText(/src\/a\.ts:10-20/)).toBeInTheDocument();
  });

  it("omits line range when startLine is null", () => {
    render(
      <ul>
        <AffectedSymbolRow symbol={symbol({ startLine: null, endLine: null })} />
      </ul>,
    );
    const row = screen.getByTestId("affected-symbol-row");
    expect(row).toHaveAttribute("data-relation", "direct");
  });

  it("renders only the start line when endLine is null", () => {
    render(
      <ul>
        <AffectedSymbolRow
          symbol={symbol({ relation: "dependency", startLine: 7, endLine: null })}
        />
      </ul>,
    );
    expect(screen.getByTestId("affected-symbol-relation")).toHaveTextContent("Dependency");
    expect(screen.getByText(/src\/a\.ts:7$/)).toBeInTheDocument();
  });
});

describe("ChangedRequirementGroup", () => {
  it("splits direct and blast-radius impacts", () => {
    render(<ChangedRequirementGroup item={item()} />);
    expect(screen.getByTestId("direct-impacts")).toBeInTheDocument();
    expect(screen.getByTestId("blast-radius-impacts")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-severity")).toHaveTextContent("high");
    expect(screen.getByText("Add login")).toBeInTheDocument();
  });

  it("renders a scannable headline with direct/file/caller counts", () => {
    render(
      <ChangedRequirementGroup
        item={item({
          affectedSymbols: [
            symbol({ id: "d1", relation: "direct", depth: 0, filePath: "src/a.ts" }),
            symbol({ id: "d2", relation: "direct", depth: 0, filePath: "src/b.ts" }),
            symbol({ id: "c1", relation: "caller", depth: 1, filePath: "src/c.ts" }),
            symbol({ id: "c2", relation: "importer", depth: 1, filePath: "src/c.ts" }),
          ],
        })}
      />,
    );
    // 2 direct across 2 files · 2 callers (relation !== direct)
    expect(screen.getByTestId("impact-headline")).toHaveTextContent(
      "2 directly affected across 2 files · 2 callers",
    );
  });

  it("sorts directly-affected rows by confidence descending", () => {
    render(
      <ChangedRequirementGroup
        item={item({
          affectedSymbols: [
            symbol({ id: "low", relation: "direct", confidence: 0.3, qualifiedName: "a.low" }),
            symbol({ id: "high", relation: "direct", confidence: 0.95, qualifiedName: "a.high" }),
          ],
        })}
      />,
    );
    const directList = screen.getByTestId("direct-impacts");
    const rows = directList.querySelectorAll('[data-testid="affected-symbol-row"]');
    // Strongest hit (0.95) renders first.
    expect(rows[0]).toHaveTextContent("a.high");
    expect(rows[1]).toHaveTextContent("a.low");
  });

  it("collapses the blast radius behind a default-collapsed details expander", () => {
    render(
      <ChangedRequirementGroup
        item={item({
          affectedSymbols: [
            symbol({ id: "d1", relation: "direct" }),
            symbol({ id: "c1", relation: "caller", depth: 1, filePath: "src/x.ts" }),
            symbol({ id: "c2", relation: "caller", depth: 1, filePath: "src/x.ts" }),
            symbol({ id: "c3", relation: "importer", depth: 1, filePath: "src/y.ts" }),
          ],
        })}
      />,
    );
    const details = screen.getByTestId("blast-radius-impacts");
    expect(details.tagName.toLowerCase()).toBe("details");
    expect(details).not.toHaveAttribute("open");
    // Summary describes the K symbols across M files.
    expect(screen.getByTestId("blast-radius-toggle")).toHaveTextContent(
      "Blast radius — 3 symbols across 2 files",
    );
  });

  it("groups blast-radius symbols by file with per-file counts", () => {
    render(
      <ChangedRequirementGroup
        item={item({
          affectedSymbols: [
            symbol({ id: "d1", relation: "direct" }),
            symbol({ id: "c1", relation: "caller", depth: 1, filePath: "src/x.ts" }),
            symbol({ id: "c2", relation: "caller", depth: 1, filePath: "src/x.ts" }),
            symbol({ id: "c3", relation: "importer", depth: 1, filePath: "src/y.ts" }),
          ],
        })}
      />,
    );
    // src/x.ts holds 2 of the radius symbols, src/y.ts holds 1.
    expect(screen.getByText("src/x.ts · 2")).toBeInTheDocument();
    expect(screen.getByText("src/y.ts · 1")).toBeInTheDocument();
  });

  it("falls back when no requirement title and only direct hits", () => {
    render(
      <ChangedRequirementGroup
        item={item({
          requirementTitle: null,
          affectedSymbols: [symbol({ relation: "direct" })],
        })}
      />,
    );
    expect(screen.getByText("Requirement change")).toBeInTheDocument();
    expect(screen.queryByTestId("blast-radius-impacts")).not.toBeInTheDocument();
  });

  it("renders radius-only impacts and varied severities", () => {
    const { rerender } = render(
      <ChangedRequirementGroup
        item={item({
          severity: "low",
          affectedSymbols: [symbol({ relation: "dependency", depth: 2 })],
        })}
      />,
    );
    expect(screen.queryByTestId("direct-impacts")).not.toBeInTheDocument();
    expect(screen.getByTestId("blast-radius-impacts")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-severity")).toHaveTextContent("low");

    rerender(<ChangedRequirementGroup item={item({ severity: "critical" })} />);
    expect(screen.getByTestId("requirement-severity")).toHaveTextContent("critical");

    rerender(<ChangedRequirementGroup item={item({ severity: "medium" })} />);
    expect(screen.getByTestId("requirement-severity")).toHaveTextContent("medium");
  });

  it("renders the #936 secondary (low-relevance) tables in a collapsed section, hidden by default", () => {
    const secondaryTable = {
      id: "st-1",
      objectKind: "table" as const,
      tableName: "shop.audit_log",
      columnName: null,
      columnType: null,
      changeKind: "reference" as const,
      suggestedDdl: "-- Verify table shop.audit_log",
      source: "mybatis" as const,
      reconciliation: null,
      confidence: 0.2,
      relevanceTier: "unlikely" as const,
      relevanceRationale: "tangential fan-out",
    };
    render(
      <ChangedRequirementGroup
        item={item({ affectedTables: [], affectedTablesSecondary: [secondaryTable] })}
      />,
    );
    // The secondary bucket is a collapsed <details> (recall-safe, low-emphasis).
    const secondary = screen.getByTestId("schema-impact-secondary");
    expect(secondary).toBeInTheDocument();
    expect(secondary).not.toHaveAttribute("open");
    expect(screen.getByTestId("schema-impact-secondary-toggle")).toHaveTextContent(/tangential/i);
    // The tangential table is present (rendered) but only inside the collapsed section.
    expect(screen.getByText("shop.audit_log")).toBeInTheDocument();
  });

  it("omits the secondary section entirely when there are no low-relevance tables", () => {
    render(<ChangedRequirementGroup item={item({ affectedTablesSecondary: [] })} />);
    expect(screen.queryByTestId("schema-impact-secondary")).not.toBeInTheDocument();
  });

  it("renders the #932 per-item BA summary block when present, tokenizing backticked identifiers into <code>", () => {
    render(
      <ChangedRequirementGroup
        item={item({ summary: "High-severity change adds a column to the `orders` table." })}
      />,
    );
    const block = screen.getByTestId("impact-item-summary");
    expect(block).toBeInTheDocument();
    expect(block).toHaveTextContent("High-severity change adds a column to the orders table.");
    // #985 (#3) wiring — the backticked identifier renders as a real <code>
    // element, and the visible text carries no literal backtick character. A
    // regression back to `{item.summary}` would fail both assertions.
    const code = block.querySelector("code");
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent("orders");
    expect(block.textContent).not.toContain("`");
  });

  it("omits the #932 summary block when there is no narrative", () => {
    render(<ChangedRequirementGroup item={item({ summary: null })} />);
    expect(screen.queryByTestId("impact-item-summary")).not.toBeInTheDocument();
  });

  describe("#966 table relevance feedback wiring", () => {
    const affectedTable = {
      id: "t-1",
      objectKind: "table" as const,
      tableName: "public.orders",
      columnName: null,
      columnType: null,
      changeKind: "reference" as const,
      suggestedDdl: null,
      source: "mybatis" as const,
      reconciliation: null,
      confidence: 0.7,
    };

    it("renders no thumbs affordance when onMarkFeedback is omitted", () => {
      render(<ChangedRequirementGroup item={item({ affectedTables: [affectedTable] })} />);
      expect(screen.queryByTestId("table-feedback-controls")).toBeNull();
    });

    it("threads onMarkFeedback down to the primary bucket, prefixed with the item id", () => {
      const onMarkFeedback = vi.fn();
      render(
        <ChangedRequirementGroup
          item={item({ id: "item-42", affectedTables: [affectedTable] })}
          onMarkFeedback={onMarkFeedback}
        />,
      );
      screen.getByTestId("table-feedback-relevant").click();
      expect(onMarkFeedback).toHaveBeenCalledWith("item-42", {
        tableName: "public.orders",
        verdict: "relevant",
      });
    });

    it("threads onDeleteFeedback down to the primary bucket, prefixed with the item id", () => {
      const onDeleteFeedback = vi.fn();
      render(
        <ChangedRequirementGroup
          item={item({
            id: "item-42",
            affectedTables: [affectedTable],
            feedback: [
              {
                id: "fb-1",
                impactItemId: "item-42",
                tableName: "public.orders",
                columnName: null,
                verdict: "relevant",
                userId: "user-1",
                userDisplayName: "alice",
                createdAt: "2026-07-20T00:00:00.000Z",
              },
            ],
          })}
          currentUserId="user-1"
          onMarkFeedback={vi.fn()}
          onDeleteFeedback={onDeleteFeedback}
        />,
      );
      screen.getByTestId("table-feedback-relevant").click();
      expect(onDeleteFeedback).toHaveBeenCalledWith("item-42", "fb-1");
    });

    it("also wires the secondary (low-relevance) bucket", () => {
      const onMarkFeedback = vi.fn();
      const secondaryTable = { ...affectedTable, tableName: "shop.audit_log" };
      render(
        <ChangedRequirementGroup
          item={item({
            id: "item-9",
            affectedTables: [],
            affectedTablesSecondary: [secondaryTable],
          })}
          onMarkFeedback={onMarkFeedback}
        />,
      );
      screen.getByTestId("table-feedback-relevant").click();
      expect(onMarkFeedback).toHaveBeenCalledWith("item-9", {
        tableName: "shop.audit_log",
        verdict: "relevant",
      });
    });
  });
});

describe("ProjectImpactSection", () => {
  it("renders items and totals", () => {
    render(<ProjectImpactSection projectId="project-001" projectName="Alpha" items={[item()]} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByTestId("project-impact-total")).toHaveTextContent("1 requirement(s)");
  });

  it("renders empty state and falls back to projectId", () => {
    render(<ProjectImpactSection projectId="project-002" items={[]} />);
    expect(screen.getByText("project-002")).toBeInTheDocument();
    expect(screen.getByTestId("project-impact-empty")).toBeInTheDocument();
  });

  it("renders the usage-classification block when classification is supplied (#298)", () => {
    render(
      <ProjectImpactSection
        projectId="project-001"
        items={[item()]}
        usageClassification={[
          {
            id: "u1",
            projectId: "project-001",
            kind: "table",
            tableName: "crm.customers",
            columnName: null,
            columnType: null,
            usageClass: "used",
            uncertainReason: null,
            evidence: [],
            overriddenClass: null,
            computedAt: "2026-06-18T00:00:00.000Z",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("usage-classification-section")).toBeInTheDocument();
    expect(screen.getByText("crm.customers")).toBeInTheDocument();
  });
});

describe("ProjectImpactSectionWithUsage", () => {
  it("fetches usage classification via the hook and renders it", () => {
    useProjectUsageClassification.mockReturnValue({
      data: [
        {
          id: "u2",
          projectId: "project-001",
          kind: "table",
          tableName: "crm.orders",
          columnName: null,
          columnType: null,
          usageClass: "unreferenced",
          uncertainReason: null,
          evidence: [],
          overriddenClass: null,
          computedAt: "2026-06-18T00:00:00.000Z",
        },
      ],
    } as never);
    render(<ProjectImpactSectionWithUsage projectId="project-001" items={[item()]} />);
    expect(screen.getByTestId("usage-classification-section")).toBeInTheDocument();
    expect(screen.getByText("crm.orders")).toBeInTheDocument();
  });

  it("renders without the usage block when the hook returns no data", () => {
    useProjectUsageClassification.mockReturnValue({ data: undefined } as never);
    render(<ProjectImpactSectionWithUsage projectId="project-001" items={[item()]} />);
    expect(screen.queryByTestId("usage-classification-section")).not.toBeInTheDocument();
  });
});
