/**
 * Issue #2224 — the #2219 approval UI where it is mounted, on the REAL analysis
 * page: the Edit dialog's warning (removing it from the dialog left every test
 * green), the card of a requirement whose approval an edit reopened (it read
 * "draft", like one never reviewed), and the traceability heading under the
 * card, which kept the old title after a save.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import { makeWrapper, TEST_USER } from "../test-utils";
import { ROLE_PERMISSIONS } from "@metis/shared";
import type { AuthUser } from "@/lib/auth-types";

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
  // The approval read answers nothing usable, so the warning falls back to
  // the card's own status (RequirementApprovalWarning).
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

const { COMPLETED } = vi.hoisted(() => {
  const requirement = (over: Record<string, unknown>) => ({
    type: "feature",
    body: "b",
    priority: "high",
    labels: [],
    storyPoints: null,
    evidenceFindingIds: [],
    acceptanceCriteria: [],
    sourceDivergence: null,
    ...over,
  });
  return {
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
        requirement({
          id: "req-approved",
          title: "Password length",
          reviewStatus: "approved",
          version: 3,
        }),
        requirement({
          id: "req-reopened",
          title: "Session timeout",
          reviewStatus: "draft",
          version: 2,
          approvalReopened: {
            reviewId: "rev-9",
            reviewTitle: "Security sign-off",
            approvedVersion: 1,
          },
        }),
        requirement({ id: "req-draft", title: "Export orders", reviewStatus: "draft", version: 1 }),
      ],
      crossDocFindings: null,
      sourceRequirements: [],
    },
  };
});

const listForProject = vi.hoisted(() => vi.fn());
const updateRequirement = vi.hoisted(() => vi.fn());
const traceabilityChain = vi.hoisted(() => vi.fn());

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
      monthBucket: "2026-11",
      exceeded: false,
    }),
    capabilityPreview: vi.fn().mockResolvedValue({
      codeGraphPresent: true,
      repoSourceIngested: true,
      fusedCodeRetrievalEnabled: true,
      schemaContextEnabled: true,
    }),
    importedRequirements: vi.fn().mockResolvedValue({ items: [], maxSelectable: 8 }),
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
  requirementUpdateApi: { update: updateRequirement },
  requirementSourceApi: { resolveDivergence: vi.fn() },
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

// The real query key, read through a stand-in view: a save that refreshes the
// card's traceability makes it read the chain again.
vi.mock("@/components/traceability/traceability-view", () => {
  const traceabilityKey = (projectId: string, requirementId: string) =>
    ["traceability-chain", projectId, requirementId] as const;
  return {
    traceabilityKey,
    TraceabilityView: ({
      projectId,
      requirementId,
    }: {
      projectId: string;
      requirementId: string;
    }) => {
      useQuery({
        queryKey: traceabilityKey(projectId, requirementId),
        queryFn: () => traceabilityChain(requirementId),
      });
      return null;
    },
  };
});
vi.mock("@/components/traceability/data-mappings-panel", () => ({
  DataMappingsPanel: () => null,
}));
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

const COORDINATOR: AuthUser = {
  ...TEST_USER,
  role: "coordinator",
  permissions: [...ROLE_PERMISSIONS.coordinator],
};

const card = (id: string): HTMLElement => {
  const el = document.getElementById(`requirement-${id}`);
  if (!el) throw new Error(`no requirement card for ${id}`);
  return el;
};

/** The run opens on Summary; the cards are on the Requirements tab. */
async function openRequirements() {
  const user = userEvent.setup();
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: COORDINATOR }) });
  await user.click(await screen.findByRole("tab", { name: /^Requirements/ }));
  await screen.findByText("Export orders");
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  listForProject.mockResolvedValue({
    items: [{ id: "an-1", status: "completed", startedAt: new Date().toISOString() }],
  });
  traceabilityChain.mockResolvedValue({ requirementTitle: "x", specs: [], directCode: [] });
  updateRequirement.mockResolvedValue({ id: "req-approved", version: 4, updatedAt: "" });
});

describe("Analysis page — editing an approved requirement (#2219, #2224)", () => {
  it("the Edit dialog warns before saving an approved requirement", async () => {
    const user = await openRequirements();
    await user.click(within(card("req-approved")).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("req-edit-approval-warning")).toHaveTextContent(
      "Approved as v3; saving creates v4 and returns it to awaiting review.",
    );
  });

  it("the Edit dialog says nothing for a requirement nobody approved", async () => {
    const user = await openRequirements();
    await user.click(within(card("req-draft")).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByTestId("req-edit-approval-warning")).toBeNull();
  });

  it("a reopened approval reads as awaiting re-review, linking the review, not as a draft", async () => {
    await openRequirements();
    const link = within(card("req-reopened")).getByTestId("req-approval-reopened-req-reopened");
    expect(link).toHaveTextContent("Changed since approval · awaiting re-review");
    expect(link).toHaveAttribute("href", "/reviews/rev-9");
    expect(link).toHaveAttribute("title", '"Security sign-off" approved v1');
    expect(within(card("req-draft")).queryByText(/awaiting re-review/)).toBeNull();
    expect(within(card("req-draft")).getByText(/feature · high · draft/)).toBeInTheDocument();
  });

  it("saving refreshes the traceability under the saved card only", async () => {
    const user = await openRequirements();
    await waitFor(() => expect(traceabilityChain).toHaveBeenCalledWith("req-approved"));
    const readsOf = (id: string) => traceabilityChain.mock.calls.filter(([r]) => r === id).length;
    const before = { saved: readsOf("req-approved"), other: readsOf("req-draft") };

    await user.click(within(card("req-approved")).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateRequirement).toHaveBeenCalled());
    await waitFor(() => expect(readsOf("req-approved")).toBeGreaterThan(before.saved));
    expect(readsOf("req-draft")).toBe(before.other);
  });
});
