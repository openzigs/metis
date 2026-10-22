/**
 * Issue #1389 — the REAL analysis page shows ONE notice for the approved
 * requirements a re-synthesis suggested different acceptance criteria for;
 * "Review" filters the list to them and mounts each one's Accept / Dismiss,
 * and "Keep approved criteria for all" sends one request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const { COMPLETED } = vi.hoisted(() => ({
  COMPLETED: {
    id: "an-1",
    projectId: "p1",
    startedById: "u-1",
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    errorMessage: null,
    metadata: null,
    agentResults: [],
    requirements: [
      {
        id: "req-proposed",
        type: "feature",
        title: "Feed listing",
        body: "b",
        priority: "high",
        labels: [],
        storyPoints: null,
        reviewStatus: "approved",
        evidenceFindingIds: [],
        acceptanceCriteria: ["GET /v1/feeds lists the user's feeds."],
        version: 1,
        criteriaProposal: {
          proposed: ["GET /v1/feeds pages its results."],
          at: "2026-10-22T01:23:39.000Z",
        },
      },
      {
        id: "req-unchanged",
        type: "feature",
        title: "Import feeds",
        body: "b",
        priority: "low",
        labels: [],
        storyPoints: null,
        reviewStatus: "approved",
        evidenceFindingIds: [],
        acceptanceCriteria: [],
        version: 0,
        criteriaProposal: null,
      },
    ],
    crossDocFindings: null,
    sourceRequirements: [
      {
        candidateId: "NR-1",
        requirementId: "req-3401",
        title: "Mark all as read",
        externalSource: "github",
        externalId: "3401",
        externalUrl: "https://github.com/miniflux/v2/issues/3401",
      },
    ],
  },
}));

const listForProject = vi.hoisted(() => vi.fn());
const resolveProposal = vi.hoisted(() => vi.fn());
const dismissAll = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", () => ({
  isCodeCitation: () => false,
  analysisApi: {
    listForProject,
    get: vi.fn().mockResolvedValue(COMPLETED),
    personas: vi.fn().mockResolvedValue({ items: [] }),
    costCap: vi.fn().mockResolvedValue({
      monthlyCap: 5_000_000,
      monthlyUsed: 0,
      monthlyRemaining: 5_000_000,
      monthBucket: "2026-10",
      exceeded: false,
    }),
    capabilityPreview: vi.fn().mockResolvedValue({
      codeGraphPresent: true,
      repoSourceIngested: true,
      fusedCodeRetrievalEnabled: true,
      schemaContextEnabled: true,
    }),
    importedRequirements: vi.fn().mockResolvedValue({
      items: [
        {
          id: "req-3401",
          title: "Mark all as read",
          type: "feature",
          externalSource: "github",
          externalId: "3401",
          externalUrl: "https://github.com/miniflux/v2/issues/3401",
        },
      ],
      maxSelectable: 8,
    }),
    start: vi.fn().mockResolvedValue({ id: "an-new" }),
    cancel: vi.fn(),
    regenerateAgent: vi.fn(),
    updateRequirement: vi.fn(),
    listApprovals: vi.fn().mockResolvedValue({ ticketStatus: { allowed: true } }),
    dismissAllCriteriaProposals: dismissAll,
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
  requirementSourceApi: { resolveDivergence: vi.fn() },
  requirementCriteriaProposalApi: { resolve: resolveProposal },
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

function renderPage() {
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Analysis page — re-synthesis suggested different criteria (#1389)", () => {
  const card = (id: string): HTMLElement => {
    const el = document.getElementById(`requirement-${id}`);
    if (!el) throw new Error(`no requirement card for ${id}`);
    return el;
  };
  const openRequirements = async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("tab", { name: /^Requirements/ }));
    return user;
  };

  beforeEach(() => {
    listForProject.mockResolvedValue({
      items: [{ id: "an-1", status: "completed", startedAt: new Date().toISOString() }],
    });
    resolveProposal.mockResolvedValue({ id: "req-proposed", choice: "accept", version: 2 });
    dismissAll.mockResolvedValue({ dismissedCount: 1 });
  });

  it("shows one analysis-level notice and no per-card notice until Review", async () => {
    await openRequirements();
    await screen.findByText("Import feeds");
    expect(screen.getByTestId("criteria-proposals-summary")).toHaveTextContent(
      "Re-synthesis suggested different acceptance criteria for 1 approved requirement",
    );
    expect(screen.queryByTestId("criteria-proposal-req-proposed")).toBeNull();
  });

  it("Review filters the list to the requirements with a suggestion and mounts their answers", async () => {
    const user = await openRequirements();
    await screen.findByText("Import feeds");
    await user.click(screen.getByRole("button", { name: "Review" }));

    expect(document.getElementById("requirement-req-unchanged")).toBeNull();
    const proposed = within(card("req-proposed"));
    await user.click(
      proposed.getByRole("button", {
        name: "Accept suggested acceptance criteria for Feed listing",
      }),
    );
    expect(resolveProposal).toHaveBeenCalledWith("req-proposed", { choice: "accept", version: 1 });

    await user.click(screen.getByRole("button", { name: "Show all requirements" }));
    expect(document.getElementById("requirement-req-unchanged")).not.toBeNull();
  });

  it("Keep approved criteria for all sends one request for the analysis", async () => {
    const user = await openRequirements();
    await screen.findByText("Import feeds");
    await user.click(screen.getByRole("button", { name: "Keep approved criteria for all" }));
    expect(dismissAll).toHaveBeenCalledTimes(1);
    expect(dismissAll).toHaveBeenCalledWith("p1", "an-1");
  });
});
