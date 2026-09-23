import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { ImpactAnalysisDetail } from "@metis/shared";
import { makeWrapper } from "../test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "ia-0000000001" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/impact-analyses/ia-0000000001",
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/impact-analysis-hooks", () => ({
  useImpactAnalysis: vi.fn(),
  // Epic #292 (#298) — the per-project section now reads usage classification.
  useProjectUsageClassification: vi.fn(() => ({ data: undefined })),
  // Epic #295 Phase 4 (#310) — the per-project section also fetches the
  // aggregated cross-project impact; benign no-data state for the page test.
  useCrossProjectImpact: vi.fn(() => ({ data: null, isLoading: false, isError: false })),
  // Issue #966 — table relevance feedback mutations; benign no-op mutate for
  // the page test (the mutation itself has its own dedicated hook tests).
  useMarkTableFeedback: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteTableFeedback: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  // Issue #965 — re-run + drift; benign no-op mutate + no drift data for this test.
  useRerunImpactAnalysis: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isSuccess: false })),
  useImpactDrift: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
}));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue({ items: [{ id: "project-001", name: "Alpha" }] }),
  },
  documentsApi: { list: vi.fn() },
}));

// #963 — export + Jira-publish actions.
const exportReport = vi.fn();
const publishToJira = vi.fn();
vi.mock("@/lib/impact-analysis-api", () => ({
  impactAnalysisApi: {
    exportReport: (...a: unknown[]) => exportReport(...a),
    publishToJira: (...a: unknown[]) => publishToJira(...a),
  },
}));
const triggerDownload = vi.fn();
vi.mock("@/lib/plugins-api", () => ({
  triggerDownload: (...a: unknown[]) => triggerDownload(...a),
}));

import {
  useImpactAnalysis,
  useImpactDrift,
  useRerunImpactAnalysis,
} from "@/lib/impact-analysis-hooks";
import ImpactAnalysisDetailPage from "@/app/(authed)/impact-analyses/[id]/page";

const mockUse = vi.mocked(useImpactAnalysis);
const mockRerun = vi.mocked(useRerunImpactAnalysis);
const mockDrift = vi.mocked(useImpactDrift);

function state(over: Partial<ReturnType<typeof useImpactAnalysis>>) {
  return { data: undefined, isLoading: false, isError: false, ...over } as ReturnType<
    typeof useImpactAnalysis
  >;
}

const detail: ImpactAnalysisDetail = {
  id: "ia-0000000001",
  status: "completed",
  // #88 — the run's starter; load-bearing for the server's access guard.
  startedById: "user-1",
  documentId: null,
  sourceText: null,
  summary: "Touched 1 project via the `orders` table.",
  errorMessage: null,
  totalImpactedSymbols: 1,
  startedAt: "2024-01-01T00:00:00.000Z",
  completedAt: "2024-01-01T00:01:00.000Z",
  projectIds: ["project-001"],
  sharedTableImpacts: [],
  rerunOfId: null,
  items: [
    {
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
      affectedSymbolCount: 1,
      affectedSymbols: [
        {
          id: "s1",
          codeSymbolId: "cs1",
          filePath: "src/a.ts",
          qualifiedName: "a.fn",
          startLine: 1,
          endLine: 2,
          relation: "direct",
          depth: 0,
          confidence: 0.9,
        },
      ],
      affectedTables: [],
      affectedTablesSecondary: [],
      affectedTests: [],
      writePathGaps: [],
      feedback: [],
      summary: null,
    },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe("ImpactAnalysisDetailPage", () => {
  it("shows loading", () => {
    mockUse.mockReturnValue(state({ isLoading: true }));
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-loading")).toBeInTheDocument();
  });

  it("shows error", () => {
    mockUse.mockReturnValue(state({ isError: true }));
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-error")).toBeInTheDocument();
  });

  it("shows error when no data is returned without an explicit error", () => {
    mockUse.mockReturnValue(state({ data: undefined }));
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-error")).toBeInTheDocument();
  });

  it("shows pending state with a pending status badge", () => {
    mockUse.mockReturnValue(state({ data: { ...detail, status: "pending", items: [] } }));
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-running")).toBeInTheDocument();
    expect(screen.getByTestId("impact-detail-status")).toHaveTextContent("pending");
  });

  it("shows running state", () => {
    mockUse.mockReturnValue(state({ data: { ...detail, status: "running", items: [] } }));
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-running")).toBeInTheDocument();
  });

  it("shows failed state with error message", () => {
    mockUse.mockReturnValue(
      state({ data: { ...detail, status: "failed", errorMessage: "boom", items: [] } }),
    );
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-failed")).toHaveTextContent("boom");
  });

  it("shows a fallback message when failed without an error message", () => {
    mockUse.mockReturnValue(
      state({ data: { ...detail, status: "failed", errorMessage: null, items: [] } }),
    );
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-failed")).toHaveTextContent(
      "The impact analysis failed.",
    );
  });

  it("re-runs the analysis when the Re-run button is clicked (#965)", () => {
    const mutate = vi.fn();
    mockRerun.mockReturnValue({ mutate, isPending: false, isSuccess: false } as never);
    mockUse.mockReturnValue(state({ data: detail }));
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    const btn = screen.getByTestId("impact-rerun");
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(mutate).toHaveBeenCalledWith({ id: "ia-0000000001" });
  });

  it("shows the rerun-of lineage crumb + drift diff for a re-run (#965)", () => {
    mockUse.mockReturnValue(state({ data: { ...detail, rerunOfId: "ia-original" } }));
    mockDrift.mockReturnValue({
      data: {
        headAnalysisId: "ia-0000000001",
        baseAnalysisId: "ia-original",
        requirements: [
          {
            key: "project-001|req:req-1",
            projectId: "project-001",
            requirementId: "req-1",
            requirementTitle: "Add login",
            status: "changed",
            tablesAdded: ["account.status"],
            tablesRemoved: [],
            tablesTierChanged: [],
            symbolsAdded: [],
            symbolsRemoved: [],
            confidenceDelta: 0,
            severityChanged: null,
          },
        ],
        summary: {
          requirementsAdded: 0,
          requirementsRemoved: 0,
          requirementsChanged: 1,
          requirementsUnchanged: 0,
          tablesAdded: 1,
          tablesRemoved: 0,
          symbolsAdded: 0,
          symbolsRemoved: 0,
        },
      },
      isLoading: false,
      isError: false,
    } as never);
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-rerun-of")).toBeInTheDocument();
    expect(screen.getByTestId("impact-drift-section")).toBeInTheDocument();
    expect(screen.getByTestId("impact-drift-tables-added")).toHaveTextContent("account.status");
  });

  it("shows empty state when completed with no items", () => {
    mockUse.mockReturnValue(state({ data: { ...detail, items: [], totalImpactedSymbols: 0 } }));
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-empty")).toBeInTheDocument();
  });

  it("renders per-project sections with resolved project names, tokenizing backticked identifiers into <code>", async () => {
    mockUse.mockReturnValue(state({ data: detail }));
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("impact-detail-projects")).toBeInTheDocument();
    const summary = screen.getByTestId("impact-detail-summary");
    expect(summary).toHaveTextContent("Touched 1 project via the orders table.");
    // #985 (#3) wiring — the backticked identifier renders as a real <code>
    // element, and the visible text carries no literal backtick character. A
    // regression back to `{data.summary}` would fail both assertions.
    const code = summary.querySelector("code");
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent("orders");
    expect(summary.textContent).not.toContain("`");
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
  });

  // #1004 — the analysed requirement text was absent from the page entirely.
  describe("analysed requirement text (#1004)", () => {
    const REQUIREMENT =
      "Customers must be able to cancel an order within 24 hours of placing it.\nA cancelled order must record who cancelled it and when.";

    it("renders the run's source text verbatim", () => {
      mockUse.mockReturnValue(state({ data: { ...detail, sourceText: REQUIREMENT } }));
      render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
      const text = screen.getByTestId("impact-detail-requirement-text");
      expect(text).toHaveTextContent("cancel an order within 24 hours of placing it");
      expect(text.textContent).toBe(REQUIREMENT);
    });

    it("omits the card when the run has no source text", () => {
      mockUse.mockReturnValue(state({ data: { ...detail, sourceText: null } }));
      render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
      expect(screen.queryByTestId("impact-detail-requirement-card")).not.toBeInTheDocument();
    });

    it("omits the card for a blank source text", () => {
      mockUse.mockReturnValue(state({ data: { ...detail, sourceText: "   " } }));
      render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
      expect(screen.queryByTestId("impact-detail-requirement-card")).not.toBeInTheDocument();
    });

    it("never parses the requirement text as markup (untrusted input)", () => {
      mockUse.mockReturnValue(
        state({ data: { ...detail, sourceText: "<img src=x onerror=alert(1)>" } }),
      );
      render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
      const card = screen.getByTestId("impact-detail-requirement-card");
      expect(card.querySelector("img")).toBeNull();
      expect(card).toHaveTextContent("<img src=x onerror=alert(1)>");
    });
  });

  it("groups items whose project was not pre-seeded from projectIds", () => {
    mockUse.mockReturnValue(
      state({
        data: {
          ...detail,
          projectIds: ["project-001"],
          items: [{ ...detail.items[0], id: "item-2", projectId: "project-777" }],
        },
      }),
    );
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.getByText("project-777")).toBeInTheDocument();
  });

  it("omits the summary and falls back to projectId for unknown projects", () => {
    mockUse.mockReturnValue(
      state({
        data: {
          ...detail,
          summary: null,
          status: "queued" as ImpactAnalysisDetail["status"],
          projectIds: ["project-001", "project-999"],
        },
      }),
    );
    render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
    expect(screen.queryByTestId("impact-detail-summary")).not.toBeInTheDocument();
    expect(screen.getByTestId("impact-detail-status")).toHaveTextContent("queued");
    // #964 — the unknown projectId now surfaces in both the requirement-impact
    // matrix column header and the per-project section, so assert ≥1 occurrence.
    expect(screen.getAllByText("project-999").length).toBeGreaterThanOrEqual(1);
  });

  // #963 — export + Jira-publish actions.
  describe("export + publish actions", () => {
    it("enables the actions on a completed run with items", () => {
      mockUse.mockReturnValue(state({ data: detail }));
      render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
      expect(screen.getByTestId("impact-export-md")).not.toBeDisabled();
      expect(screen.getByTestId("impact-publish-jira")).not.toBeDisabled();
    });

    it("disables the actions while the run is still in progress", () => {
      mockUse.mockReturnValue(state({ data: { ...detail, status: "running", items: [] } }));
      render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
      expect(screen.getByTestId("impact-export-md")).toBeDisabled();
      expect(screen.getByTestId("impact-publish-jira")).toBeDisabled();
    });

    it("downloads the markdown report on export", async () => {
      exportReport.mockResolvedValue({ blob: new Blob(["# md"]), filename: "impact.md" });
      mockUse.mockReturnValue(state({ data: detail }));
      render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
      fireEvent.click(screen.getByTestId("impact-export-md"));
      await waitFor(() => expect(exportReport).toHaveBeenCalledWith("ia-0000000001"));
      await waitFor(() => expect(triggerDownload).toHaveBeenCalledTimes(1));
    });

    it("publishes to Jira and shows the issue link", async () => {
      publishToJira.mockResolvedValue({
        provider: "jira",
        issueKey: "IMP-9",
        url: "https://jira.example.com/browse/IMP-9",
      });
      mockUse.mockReturnValue(state({ data: detail }));
      render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
      fireEvent.click(screen.getByTestId("impact-publish-jira"));
      await waitFor(() =>
        expect(screen.getByTestId("impact-publish-jira-link")).toHaveTextContent("IMP-9"),
      );
      expect(publishToJira).toHaveBeenCalledWith("ia-0000000001");
    });

    it("surfaces a publish error inline", async () => {
      publishToJira.mockRejectedValue(new Error("No project has Jira configured"));
      mockUse.mockReturnValue(state({ data: detail }));
      render(<ImpactAnalysisDetailPage />, { wrapper: makeWrapper() });
      fireEvent.click(screen.getByTestId("impact-publish-jira"));
      await waitFor(() =>
        expect(screen.getByTestId("impact-publish-error")).toHaveTextContent(
          "No project has Jira configured",
        ),
      );
    });
  });
});
