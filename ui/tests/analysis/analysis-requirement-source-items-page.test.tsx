/**
 * Issue #1063 (PR #1095 panel, T5) — the REAL analysis page mounts the
 * imported-item line on each requirement card. `RequirementSourceItems` has its
 * own tests; nothing checked that the page renders it, so deleting the mount
 * left every suite green.
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
        id: "req-linked",
        type: "feature",
        title: "Define terminate-all-sessions scope",
        body: "b",
        priority: "high",
        labels: [],
        storyPoints: null,
        reviewStatus: "draft",
        evidenceFindingIds: [],
        acceptanceCriteria: [],
        version: 1,
        sourceItems: [
          {
            candidateId: "NR-4",
            requirementId: "req-4074",
            title: "Add a button to terminate all sessions",
            externalSource: "github",
            externalId: "4074",
            externalUrl: "https://github.com/miniflux/v2/issues/4074",
          },
        ],
      },
      {
        id: "req-added",
        type: "chore",
        title: "Complete intake scope",
        body: "b",
        priority: "medium",
        labels: [],
        storyPoints: null,
        reviewStatus: "draft",
        evidenceFindingIds: [],
        acceptanceCriteria: [],
        version: 1,
        sourceItems: [],
      },
      {
        id: "req-unrecorded",
        type: "feature",
        title: "Webhook delivery retries",
        body: "b",
        priority: "low",
        labels: [],
        storyPoints: null,
        reviewStatus: "draft",
        evidenceFindingIds: [],
        acceptanceCriteria: [],
        version: 1,
        sourceItems: null,
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

function renderPage() {
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Analysis page — where each requirement came from (#1063)", () => {
  const card = (id: string): HTMLElement => {
    const el = document.getElementById(`requirement-${id}`);
    if (!el) throw new Error(`no requirement card for ${id}`);
    return el;
  };

  /** The run opens on Summary; the cards are on the Requirements tab. */
  const openRequirements = async (): Promise<void> => {
    renderPage();
    await userEvent.setup().click(await screen.findByRole("tab", { name: /^Requirements/ }));
  };

  beforeEach(() => {
    listForProject.mockResolvedValue({
      items: [{ id: "an-1", status: "completed", startedAt: new Date().toISOString() }],
    });
  });

  it("shows the imported item's own title and a link back, on that requirement's card", async () => {
    await openRequirements();
    await screen.findByText("Define terminate-all-sessions scope");
    const line = within(card("req-linked")).getByTestId("requirement-source-item-NR-4");
    expect(line).toHaveTextContent("Imported as: Add a button to terminate all sessions");
    const link = within(line).getByRole("link", { name: "github #4074" });
    expect(link).toHaveAttribute("href", "https://github.com/miniflux/v2/issues/4074");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("marks a requirement the analysis added, on its own card only", async () => {
    await openRequirements();
    await screen.findByText("Complete intake scope");
    expect(
      within(card("req-added")).getByTestId("requirement-added-by-analysis"),
    ).toHaveTextContent("Added by the analysis");
    expect(within(card("req-linked")).queryByTestId("requirement-added-by-analysis")).toBeNull();
    expect(screen.getAllByTestId("requirement-added-by-analysis")).toHaveLength(1);
  });

  it("shows nothing for a requirement whose source was not recorded", async () => {
    await openRequirements();
    await screen.findByText("Webhook delivery retries");
    const unrecorded = within(card("req-unrecorded"));
    expect(unrecorded.queryByTestId("requirement-added-by-analysis")).toBeNull();
    expect(unrecorded.queryByTestId("requirement-source-items")).toBeNull();
    expect(card("req-unrecorded")).not.toHaveTextContent("Imported as");
  });
});
