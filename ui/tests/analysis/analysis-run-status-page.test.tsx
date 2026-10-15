/**
 * #1143 — the run status on the real analysis page.
 *
 * `analysis-status-badge.test.tsx` covers `RunStatusBadge` as a unit; these
 * cover the page wiring it: the past-runs list and the selected run's header
 * both show a completed run whose agents failed as `completed with errors`,
 * and one whose only fault was dropped citations as `completed with warnings`.
 * The header reads the snapshot's server-computed `failedAgents` /
 * `droppedCitations` (the fixture's `agentResults` is deliberately empty), so a
 * page that went back to a plain status badge, or recomputed from the rows,
 * fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

const { SNAPSHOT, LIST } = vi.hoisted(() => {
  const completed = {
    projectId: "p1",
    status: "completed",
    totalTokens: 1_000,
    ledgerTokens: { withoutCache: 1_000, withCache: 1_000 },
    errorMessage: null,
  };
  return {
    // The selected run: completed, its code agent failed. `agentResults` is
    // empty on purpose — the header must read the snapshot's `failedAgents`.
    SNAPSHOT: {
      ...completed,
      id: "an-errors",
      startedById: "u-1",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      ledgerUsage: null,
      metadata: null,
      failedAgents: ["code"],
      droppedCitations: [],
      agentResults: [],
      requirements: [],
      crossDocFindings: null,
    },
    LIST: [
      {
        ...completed,
        id: "an-errors",
        startedAt: new Date().toISOString(),
        failedAgents: ["code"],
        droppedCitations: [],
      },
      {
        ...completed,
        id: "an-warnings",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        failedAgents: [],
        droppedCitations: [{ agentKey: "document", count: 1 }],
      },
      {
        ...completed,
        id: "an-clean",
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        failedAgents: [],
        droppedCitations: [],
      },
    ],
  };
});

vi.mock("@/lib/analysis-api", () => ({
  isCodeCitation: () => false,
  analysisApi: {
    listForProject: vi.fn().mockResolvedValue({ items: LIST }),
    get: vi.fn().mockResolvedValue(SNAPSHOT),
    personas: vi.fn().mockResolvedValue({ items: [] }),
    costCap: vi.fn().mockResolvedValue(null),
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
    getUsage: vi.fn().mockResolvedValue(null),
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
import { analysisApi } from "@/lib/analysis-api";

function renderPage() {
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
}

/** The past-runs list row for a run, found by its token line. */
async function pastRunRows(): Promise<HTMLElement[]> {
  const tokens = await screen.findAllByTestId("analysis-past-run-tokens");
  return tokens.map((t) => t.closest("button") as HTMLElement);
}

/** The selected run's header (`Run #n <status>`). */
async function header(): Promise<HTMLElement> {
  const started = await screen.findByText(/^Started /);
  return started.parentElement!.querySelector("h3") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(analysisApi.get).mockResolvedValue(SNAPSHOT as never);
});

describe("analysis page run status (#1143)", () => {
  it("the past-runs list shows errors, warnings and a clean completion apart", async () => {
    renderPage();
    const [errors, warnings, clean] = await pastRunRows();
    expect(within(errors).getByText("completed with errors")).toBeInTheDocument();
    expect(within(errors).getByTestId("analysis-failed-agents")).toHaveTextContent("Failed: code");
    expect(within(warnings).getByText("completed with warnings")).toBeInTheDocument();
    expect(within(warnings).getByTestId("analysis-dropped-citations")).toHaveTextContent(
      "Citations dropped: document (1)",
    );
    expect(within(clean).getByText("completed")).toBeInTheDocument();
    expect(within(clean).queryByTestId("analysis-failed-agents")).toBeNull();
    expect(within(clean).queryByTestId("analysis-dropped-citations")).toBeNull();
  });

  it("the selected run's header shows completed with errors and names the failed agent", async () => {
    renderPage();
    const h3 = await header();
    await waitFor(() => expect(within(h3).getByText("completed with errors")).toBeInTheDocument());
    expect(within(h3).getByTestId("analysis-failed-agents")).toHaveTextContent("Failed: code");
  });

  it("the header shows completed with warnings for a run whose only fault was dropped citations", async () => {
    vi.mocked(analysisApi.get).mockResolvedValue({
      ...SNAPSHOT,
      id: "an-warnings",
      failedAgents: [],
      droppedCitations: [{ agentKey: "document", count: 1 }],
    } as never);
    renderPage();
    const h3 = await header();
    await waitFor(() =>
      expect(within(h3).getByText("completed with warnings")).toBeInTheDocument(),
    );
    expect(within(h3).getByTestId("analysis-dropped-citations")).toHaveTextContent(
      "Citations dropped: document (1)",
    );
  });
});
