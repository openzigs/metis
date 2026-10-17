/**
 * Issue #1203 — the REAL analysis page marks, on each requirement card, the
 * acceptance criteria one grouped item wrote for several requirements, and
 * links to the others. `SharedCriteriaNote` has its own tests; this checks the
 * page mounts it with the run's metadata, ids and current titles.
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
    metadata: {
      promotionMatching: {
        ambiguousCount: 0,
        ambiguous: [],
        shared: [
          {
            requirementId: "req-linked",
            structuredId: "REQ-1",
            sharedWith: [
              {
                structuredId: "REQ-2",
                title: "Old title",
                requirementId: "req-added",
                approved: true,
              },
              { structuredId: "REQ-9", title: "Rate limit", requirementId: null, approved: false },
            ],
            sharedCriteria: ["Logging out ends every session.", "A reset ends every session."],
            promotedCriteria: ["Logging out ends every session.", "A reset ends every session."],
          },
          {
            requirementId: "req-added",
            structuredId: "REQ-2",
            sharedWith: [
              {
                structuredId: "REQ-1",
                title: "Define scope",
                requirementId: "req-linked",
                approved: true,
              },
            ],
            sharedCriteria: ["Logging out ends every session.", "A reset ends every session."],
            promotedCriteria: ["Logging out ends every session.", "A reset ends every session."],
          },
        ],
        updatedAt: "2026-10-17T00:00:00.000Z",
      },
    },
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
        acceptanceCriteria: ["Logging out ends every session.", "A reset ends every session."],
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
        acceptanceCriteria: ["Logging out ends every session.", "A reset ends every session."],
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

describe("Analysis page — criteria shared between requirements (#1203)", () => {
  const card = (id: string): HTMLElement => {
    const el = document.getElementById(`requirement-${id}`);
    if (!el) throw new Error(`no requirement card for ${id}`);
    return el;
  };

  beforeEach(() => {
    listForProject.mockResolvedValue({
      items: [{ id: "an-1", status: "completed", startedAt: new Date().toISOString() }],
    });
  });

  it("notes the shared criteria on each sharing card, linking the sibling's card by its current title", async () => {
    renderPage();
    await userEvent.setup().click(await screen.findByRole("tab", { name: /^Requirements/ }));
    await screen.findByText("Webhook delivery retries");

    const linked = within(card("req-linked")).getByTestId("shared-criteria-req-linked");
    expect(linked).toHaveTextContent(
      "Shared with Complete intake scope and Rate limit (not approved) — the analysis wrote these acceptance criteria for the group; edit any that don't apply.",
    );
    expect(within(linked).getByRole("link", { name: "Complete intake scope" })).toHaveAttribute(
      "href",
      "/projects/p1/analysis?analysisId=an-1&requirementId=req-added",
    );
    expect(within(card("req-added")).getByTestId("shared-criteria-req-added")).toHaveTextContent(
      "Shared with Define terminate-all-sessions scope —",
    );
    expect(within(card("req-unrecorded")).queryByRole("note", { name: /Shared/ })).toBeNull();
    expect(screen.getAllByText(/^Shared with/)).toHaveLength(2);
  });
});
