/**
 * Issue #1903 — the REAL analysis page offers "Start from these citations"
 * (#1840) only to a viewer who may edit requirements (`project.update`). The
 * #1840 panel test toggles `canEdit` directly; this proves the page passes it
 * from the viewer's permissions, for both roles. The server enforces the same
 * permission on the borrow itself (403, #1839).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PermissionKey, SimilarRequirementItem } from "@metis/shared";
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
    metadata: {},
    agentResults: [],
    requirements: [
      {
        id: "req-recall",
        type: "feature",
        title: "Recall a batch",
        body: "b",
        priority: "high",
        labels: [],
        storyPoints: null,
        reviewStatus: "draft",
        evidenceFindingIds: [],
        acceptanceCriteria: [],
        version: 1,
        sourceItems: [],
      },
    ],
    crossDocFindings: null,
    sourceRequirements: [],
  },
}));

const LOT: SimilarRequirementItem = {
  requirementId: "req-lot",
  analysisId: "an-1",
  key: "REQ-7",
  title: "Lot tracking for recalls",
  status: "approved",
  score: 0.8,
  label: "overlap",
  codeLinks: [
    {
      mappingId: "m-1",
      filePath: "src/lots.ts",
      startLine: 3,
      endLine: 9,
      source: "analysis-grounding",
      freshness: "fresh",
    },
  ],
  codeLinksTruncated: false,
  notDuplicate: false,
  linkedAsDuplicate: false,
};

const forRequirement = vi.hoisted(() => vi.fn());
vi.mock("@/lib/similar-requirements-api", () => ({
  similarRequirementsApi: {
    forRequirement,
    forDraft: vi.fn().mockResolvedValue({ items: [] }),
    notDuplicate: vi.fn(),
    borrowCitations: vi.fn(),
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

const ACTION = "Start from the citations of REQ-7 Lot tracking for recalls";

async function openRequirements(permissions: PermissionKey[]) {
  render(<AnalysisPage />, {
    wrapper: makeWrapper({ initialUser: { ...TEST_USER, permissions } }),
  });
  await userEvent.setup().click(await screen.findByRole("tab", { name: /^Requirements/ }));
  // The similar requirement is listed for either role: only the action differs.
  expect(
    await screen.findByRole("link", { name: "REQ-7 Lot tracking for recalls" }),
  ).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  listForProject.mockResolvedValue({
    items: [{ id: "an-1", status: "completed", startedAt: new Date().toISOString() }],
  });
  forRequirement.mockResolvedValue({ items: [LOT] });
});

describe("Analysis page — 'Start from these citations' follows the viewer's role (#1903)", () => {
  it("offers it to a viewer with project.update", async () => {
    await openRequirements(["project.read", "project.update"]);
    expect(screen.getByRole("button", { name: ACTION })).toBeInTheDocument();
    expect(forRequirement).toHaveBeenCalledWith("p1", "req-recall", expect.any(AbortSignal));
  });

  it("does not offer it to a viewer without project.update", async () => {
    await openRequirements(["project.read", "analysis.read"]);
    expect(screen.queryByRole("button", { name: ACTION })).toBeNull();
  });
});
