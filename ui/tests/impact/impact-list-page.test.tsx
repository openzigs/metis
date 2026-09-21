import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ImpactAnalysisSummary } from "@metis/shared";

vi.mock("@/lib/impact-analysis-hooks", () => ({
  useImpactAnalyses: vi.fn(),
}));

import { useImpactAnalyses } from "@/lib/impact-analysis-hooks";
import ImpactAnalysesPage from "@/app/(authed)/impact-analyses/page";

const mockUse = vi.mocked(useImpactAnalyses);

function state(over: Partial<ReturnType<typeof useImpactAnalyses>>) {
  return { data: undefined, isLoading: false, isError: false, ...over } as ReturnType<
    typeof useImpactAnalyses
  >;
}

const row: ImpactAnalysisSummary = {
  id: "ia-0000000001",
  status: "completed",
  documentId: null,
  summary: null,
  projectCount: 2,
  totalImpactedSymbols: 5,
  startedAt: "2024-01-01T00:00:00.000Z",
  completedAt: "2024-01-01T00:05:00.000Z",
  rerunOfId: null,
};

beforeEach(() => vi.clearAllMocks());

describe("ImpactAnalysesPage", () => {
  it("shows loading", () => {
    mockUse.mockReturnValue(state({ isLoading: true }));
    render(<ImpactAnalysesPage />);
    expect(screen.getByTestId("impact-list-loading")).toBeInTheDocument();
  });

  it("shows a contrast pointer to the per-project Requirements Analysis tab", () => {
    mockUse.mockReturnValue(state({ data: [] }));
    render(<ImpactAnalysesPage />);
    expect(
      screen.getByText(
        /To synthesize requirements for a single project, use that project's Requirements Analysis tab\./i,
      ),
    ).toBeInTheDocument();
  });

  it("shows error", () => {
    mockUse.mockReturnValue(state({ isError: true }));
    render(<ImpactAnalysesPage />);
    expect(screen.getByTestId("impact-list-error")).toBeInTheDocument();
  });

  it("shows empty state", () => {
    mockUse.mockReturnValue(state({ data: [] }));
    render(<ImpactAnalysesPage />);
    expect(screen.getByTestId("impact-list-empty")).toBeInTheDocument();
  });

  it("renders rows with a link to the detail view", () => {
    mockUse.mockReturnValue(
      state({ data: [row, { ...row, id: "ia-0000000002", completedAt: null }] }),
    );
    render(<ImpactAnalysesPage />);
    expect(screen.getByTestId("impact-list-table")).toBeInTheDocument();
    expect(screen.getByTestId("impact-list-link-ia-0000000001")).toHaveAttribute(
      "href",
      "/impact-analyses/ia-0000000001",
    );
    expect(screen.getByTestId("impact-list-new")).toBeInTheDocument();
  });

  it("flags a re-run row with a lineage badge (#965)", () => {
    mockUse.mockReturnValue(
      state({
        data: [row, { ...row, id: "ia-0000000009", rerunOfId: "ia-0000000001" }],
      }),
    );
    render(<ImpactAnalysesPage />);
    expect(screen.getByTestId("impact-list-rerun-ia-0000000009")).toHaveTextContent("re-run");
    expect(screen.queryByTestId("impact-list-rerun-ia-0000000001")).not.toBeInTheDocument();
  });

  it("falls back to a dash for invalid dates and an outline badge for unknown status", () => {
    mockUse.mockReturnValue(
      state({
        data: [
          {
            ...row,
            id: "ia-0000000003",
            status: "queued" as ImpactAnalysisSummary["status"],
            startedAt: "not-a-date",
            completedAt: null,
          },
        ],
      }),
    );
    render(<ImpactAnalysesPage />);
    const cells = screen.getAllByText("—");
    expect(cells.length).toBeGreaterThanOrEqual(2);
  });
});
