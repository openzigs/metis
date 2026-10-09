/**
 * #977 — the analysis page header, wired on the real page.
 *
 * `analysis-usage-header.test.tsx` covers the cards and `runSpendLabel` as
 * units; these cover the page using them: the project's own budget card fed by
 * `projectsApi.getUsage`, and the selected run's header showing the ledger's
 * live spend while it runs instead of the "0 tok" its unwritten `totalTokens`
 * reads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "../test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "p1" }),
    usePathname: () => "/projects/p1/analysis",
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  setOnRefreshFailure: vi.fn(),
  streamFetch: vi.fn(),
  _resetAuthRetryState: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));
vi.mock("@/hooks/use-job-events", () => ({
  useJobLifecycle: () => null,
  useProjectJobEvents: () => undefined,
}));

const { RUNNING, USAGE } = vi.hoisted(() => ({
  // A run in progress: `totalTokens` is written only when it finishes, so it is
  // still 0 — the ledger is the only live figure.
  RUNNING: {
    id: "an-1",
    projectId: "p1",
    startedById: "u-1",
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    ledgerUsage: { totalTokens: 41_000, costUsd: 0.0123, unpricedTokens: 0 },
    errorMessage: null,
    metadata: null,
    agentResults: [],
    requirements: [],
    crossDocFindings: null,
  },
  // This project's own month: 750k of a 2M budget, $12.34.
  USAGE: {
    projectId: "p1",
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-10-09T00:00:00.000Z",
    inputTokens: 500_000,
    outputTokens: 250_000,
    totalTokens: 750_000,
    costCents: 1234,
    unpriced: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 },
    projectedMonthlyCostCents: 4000,
    monthlyTokenBudget: 2_000_000,
    monthToDateTokens: 750_000,
    monthToDateUnpricedTokens: 0,
    byProvider: [],
    byDay: [],
  },
}));

vi.mock("@/lib/analysis-api", () => ({
  isCodeCitation: () => false,
  analysisApi: {
    listForProject: vi.fn().mockResolvedValue({
      items: [
        { id: "an-1", status: "running", startedAt: new Date().toISOString(), totalTokens: 0 },
      ],
    }),
    get: vi.fn().mockResolvedValue(RUNNING),
    personas: vi.fn().mockResolvedValue({ items: [] }),
    // The deployment-wide cap — deliberately different numbers, so a header
    // that showed this instead of the project's own usage cannot pass.
    costCap: vi.fn().mockResolvedValue({
      monthlyCap: 5_000_000,
      monthlyUsed: 1_530_000,
      monthlyRemaining: 3_470_000,
      monthBucket: "2026-10",
      exceeded: false,
    }),
    start: vi.fn(),
    cancel: vi.fn(),
    regenerateAgent: vi.fn(),
    updateRequirement: vi.fn(),
    listApprovals: vi.fn().mockResolvedValue({ ticketStatus: { allowed: true } }),
  },
}));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: {
    get: vi.fn().mockResolvedValue({ id: "p1", name: "Alpha" }),
    getUsage: vi.fn().mockResolvedValue(USAGE),
  },
  documentsApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));

vi.mock("@/lib/stakeholder-api", () => ({
  stakeholderApi: {
    list: vi.fn().mockResolvedValue([]),
    getContext: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/lib/findings-api", () => ({
  findingsApi: { acknowledgeReview: vi.fn() },
}));

vi.mock("@/lib/collaboration-api", () => ({
  commentApi: {
    listForRequirement: vi.fn().mockResolvedValue([]),
    createForRequirement: vi.fn(),
    listForArtifact: vi.fn(),
    createForArtifact: vi.fn(),
    reply: vi.fn(),
    edit: vi.fn(),
    delete: vi.fn(),
  },
  assignmentApi: { list: vi.fn().mockResolvedValue([]), assign: vi.fn(), unassign: vi.fn() },
  requirementUpdateApi: { update: vi.fn() },
}));

vi.mock("@/lib/history-api", () => ({
  historyApi: {
    list: vi
      .fn()
      .mockResolvedValue({ versions: [], total: 0, page: 1, pageSize: 1, currentVersion: 1 }),
    restore: vi.fn(),
    export: vi.fn(),
  },
}));

vi.mock("@/components/traceability/data-mappings-panel", () => ({
  DataMappingsPanel: () => null,
}));
vi.mock("@/components/traceability/traceability-view", () => ({ TraceabilityView: () => null }));
vi.mock("@/components/requirements/RequirementHistoryTab", () => ({
  RequirementHistoryTab: () => null,
}));
vi.mock("@/components/analysis/ModelRecommendation", () => ({ ModelRecommendation: () => null }));
vi.mock("@/components/analysis/EnhancementStatus", () => ({ EnhancementStatus: () => null }));
vi.mock("@/components/analysis/EnhancementResults", () => ({ EnhancementResults: () => null }));
vi.mock("@/components/analysis/ApprovalsPanel", () => ({ ApprovalsPanel: () => null }));
vi.mock("@/components/analysis/add-documents-panel", () => ({ AddDocumentsPanel: () => null }));
vi.mock("@/components/analysis/evaluate-requirements-panel", () => ({
  EvaluateRequirementsPanel: () => null,
}));
vi.mock("@/components/analysis/CrossDocFindingsPanel", () => ({
  CrossDocFindingsPanel: () => null,
}));
vi.mock("@/components/analysis/StakeholdersPanel", () => ({ StakeholdersPanel: () => null }));
vi.mock("@/components/analysis/analysis-run-summary", () => ({ AnalysisRunSummary: () => null }));
vi.mock("@/components/analysis/traceability-matrix", () => ({ TraceabilityMatrix: () => null }));
vi.mock("@/components/analysis/gap-report", () => ({ GapReport: () => null }));
vi.mock("@/components/analysis/requirement-diff", () => ({ RequirementDiff: () => null }));
vi.mock("@/components/requirements/requirement-links-panel", () => ({
  RequirementLinksPanel: () => null,
}));

import AnalysisPage from "@/app/(authed)/projects/[id]/analysis/page";
import { projectsApi } from "@/lib/projects-api";

function renderPage() {
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("analysis page usage header (#977)", () => {
  it("shows the project's own budget and month-to-date use, not only the deployment cap", async () => {
    renderPage();
    const card = await screen.findByText("This project, this month");
    const budget = card.parentElement as HTMLElement;
    expect(projectsApi.getUsage).toHaveBeenCalledWith("p1");
    expect(budget).toHaveTextContent("750.0k / 2.00M tokens");
    expect(budget).toHaveTextContent("$12.34");
    // The deployment-wide cap is still shown, labelled as such.
    expect(await screen.findByText(/Deployment-wide analysis cap/)).toBeInTheDocument();
  });

  it("shows a running analysis's ledger tokens and cost, not 0 tok", async () => {
    renderPage();
    const started = await screen.findByText(/^Started /);
    await waitFor(() => expect(started).toHaveTextContent("41.0k tok · $0.0123"));
    expect(started.textContent).not.toMatch(/· 0 tok/);
  });
});
