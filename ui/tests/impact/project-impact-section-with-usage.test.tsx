/**
 * ProjectImpactSectionWithUsage — smart-wrapper tests, Epic #295 Phase 4 (#310).
 *
 * The wrapper is what actually MOUNTS the cross-project views on the
 * impact-analysis detail page: it fetches the aggregated cross-project impact
 * for a project and renders BOTH the aggregated {@link CrossProjectImpactSection}
 * AND the per-table "used by N projects" badge built from the same result.
 *
 * These tests drive the wrapper's four states by mocking the query hooks
 * (deterministic, no QueryClient / no network):
 *   - loading  → a loading placeholder for the cross-project block
 *   - error    → a graceful "unavailable" message (read-only view degrades)
 *   - empty    → the presentational empty state (no other projects)
 *   - populated→ the aggregated section + the badge wired with REAL data
 *
 * Safety: every state is read-only — assert no drop/alter affordance leaks in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CrossProjectImpactResult, ImpactItemView } from "@metis/shared";

// Control both query hooks the wrapper depends on. The usage-classification hook
// is held to a benign default (no classification block); each test drives the
// cross-project hook explicitly.
const useProjectUsageClassification = vi.fn();
const useCrossProjectImpact = vi.fn();
vi.mock("@/lib/impact-analysis-hooks", () => ({
  useProjectUsageClassification: (id: string | null | undefined) =>
    useProjectUsageClassification(id),
  useCrossProjectImpact: (id: string | null | undefined) => useCrossProjectImpact(id),
}));

import { ProjectImpactSectionWithUsage } from "@/components/impact/project-impact-section";

function item(over: Partial<ImpactItemView> = {}): ImpactItemView {
  return {
    id: "it-1",
    projectId: "p1",
    requirementId: "r-1",
    requirementTitle: "Change orders flow",
    changeType: "modified",
    severity: "high",
    impactScore: 0.5,
    confidence: 0.9,
    matchQuality: "strong",
    matchQualityReason: null,
    affectedSymbolCount: 1,
    affectedFileCount: 1,
    affectedSymbols: [],
    affectedTables: [
      {
        id: "t-1",
        objectKind: "table",
        tableName: "public.orders",
        columnName: null,
        columnType: null,
        changeKind: "reference",
        suggestedDdl: "-- Verify table public.orders",
        source: "mybatis",
        reconciliation: "matched",
        confidence: 0.9,
      },
    ],
    affectedTablesSecondary: [],
    affectedTests: [],
    writePathGaps: [],
    feedback: [],
    summary: null,
    ...over,
  };
}

function impactResult(
  affectedObjects: CrossProjectImpactResult["affectedObjects"] = [],
): CrossProjectImpactResult {
  return { sourceProjectId: "p1", workspaceId: "ws", affectedObjects };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no usage classification (the #298 block stays hidden).
  useProjectUsageClassification.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
});

describe("ProjectImpactSectionWithUsage — cross-project wiring", () => {
  it("renders a loading placeholder while the cross-project impact is fetching", () => {
    useCrossProjectImpact.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<ProjectImpactSectionWithUsage projectId="p1" projectName="Alpha" items={[item()]} />);
    expect(screen.getByTestId("cross-project-impact-loading")).toBeInTheDocument();
    // The aggregated section is NOT shown yet.
    expect(screen.queryByTestId("cross-project-impact-section")).not.toBeInTheDocument();
    // No "used by" badge while loading.
    expect(screen.queryByTestId("cross-project-used-by")).not.toBeInTheDocument();
  });

  it("renders a graceful error message when the cross-project fetch fails", () => {
    useCrossProjectImpact.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<ProjectImpactSectionWithUsage projectId="p1" items={[item()]} />);
    const err = screen.getByTestId("cross-project-impact-error");
    expect(err).toBeInTheDocument();
    // Read-only degrade: never an executable affordance.
    expect(err).not.toHaveTextContent(/DROP|ALTER/);
    expect(screen.queryByTestId("cross-project-impact-section")).not.toBeInTheDocument();
  });

  it("renders the empty state when no other project in the workspace is affected", () => {
    useCrossProjectImpact.mockReturnValue({
      data: impactResult([]),
      isLoading: false,
      isError: false,
    });
    render(<ProjectImpactSectionWithUsage projectId="p1" items={[item()]} />);
    expect(screen.getByTestId("cross-project-impact-section")).toBeInTheDocument();
    expect(screen.getByTestId("cross-project-impact-empty")).toBeInTheDocument();
    // Empty → no per-table badge either.
    expect(screen.queryByTestId("cross-project-used-by")).not.toBeInTheDocument();
  });

  it("renders the aggregated section AND the per-table badge with REAL data when populated", () => {
    useCrossProjectImpact.mockReturnValue({
      data: impactResult([
        {
          objectName: "orders",
          schemaName: "public",
          objectType: "table",
          alsoUsedByProjects: [
            { projectId: "p2", projectName: "Beta", usageClass: "used", evidenceCount: 3 },
            { projectId: "p3", projectName: "Gamma", usageClass: "uncertain", evidenceCount: 0 },
          ],
        },
      ]),
      isLoading: false,
      isError: false,
    });
    render(<ProjectImpactSectionWithUsage projectId="p1" projectName="Alpha" items={[item()]} />);

    // 1) The aggregated cross-project section renders the shared object.
    const section = screen.getByTestId("cross-project-impact-section");
    expect(section).toBeInTheDocument();
    expect(screen.getByTestId("cross-project-affected-object")).toHaveAttribute(
      "data-object-name",
      "public.orders",
    );

    // 2) The per-table "used by N projects" badge is fed by the SAME result.
    const badge = screen.getByTestId("cross-project-used-by");
    expect(badge).toHaveAttribute("data-project-count", "2");
    expect(badge).toHaveTextContent("used by 2 other projects");
    expect(badge).toHaveAttribute("title", expect.stringContaining("Beta, Gamma"));

    // 3) `uncertain` is rendered clearly + visually distinct (safety contract).
    const distinct = section.querySelector('[data-usage-class="uncertain"]');
    expect(distinct).not.toBeNull();
    expect(distinct).toHaveAttribute("data-distinct", "true");

    // 4) Read-only everywhere — no drop/alter affordance.
    expect(section).not.toHaveTextContent(/DROP|ALTER/i);
  });

  it("passes the projectId through to BOTH query hooks (so the right data is fetched)", () => {
    useCrossProjectImpact.mockReturnValue({
      data: impactResult([]),
      isLoading: false,
      isError: false,
    });
    render(<ProjectImpactSectionWithUsage projectId="p-xyz" items={[]} />);
    expect(useProjectUsageClassification).toHaveBeenCalledWith("p-xyz");
    expect(useCrossProjectImpact).toHaveBeenCalledWith("p-xyz");
  });
});
