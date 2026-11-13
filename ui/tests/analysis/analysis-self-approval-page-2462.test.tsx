/**
 * #2462 — the REAL change request page disables Approve on a requirement the
 * viewer wrote or edited, in a project that does not allow self-approval, and
 * says why before the click: the same hint as the Requirements list (#2452),
 * with the link to Project settings → Approval gate. The server marks the
 * snapshot's requirement `selfApprovalForbidden`; this fails if the card stops
 * reading the flag or stops passing it to its Approve.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper, TEST_USER } from "../test-utils";
import { ROLE_PERMISSIONS, type RoleKey } from "@metis/shared";
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
  const requirement = (id: string, title: string, reviewStatus: string) => ({
    id,
    type: "feature",
    title,
    body: "b",
    priority: "medium",
    labels: [],
    storyPoints: null,
    reviewStatus,
    evidenceFindingIds: [],
    acceptanceCriteria: [],
    version: 2,
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
        {
          ...requirement("req-mine", "Pay with a saved card", "draft"),
          selfApprovalForbidden: true,
        },
        requirement("req-theirs", "Refund to card", "draft"),
        requirement("req-approved", "Show the receipt", "approved"),
      ],
      crossDocFindings: null,
      sourceRequirements: [],
    },
  };
});

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

const update = vi.hoisted(() => vi.fn());
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
  requirementUpdateApi: { update },
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
import { SELF_APPROVAL_HINT } from "@/components/requirements/approval-ladder";
import { REQUIRES_REQUIREMENT_APPROVE } from "@/lib/permission-hints";

const userAs = (role: RoleKey): AuthUser => ({
  ...TEST_USER,
  role,
  permissions: [...ROLE_PERMISSIONS[role]],
});

const card = (id: string) => {
  const el = document.getElementById(`requirement-${id}`);
  if (!el) throw new Error(`no requirement card for ${id}`);
  return within(el);
};

/** The run opens on Summary; the cards are on the Requirements tab. */
async function openRequirements(viewer: AuthUser = userAs("coordinator")) {
  const user = userEvent.setup();
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: viewer }) });
  await user.click(await screen.findByRole("tab", { name: /^Requirements/ }));
  await screen.findByText("Show the receipt");
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  listForProject.mockResolvedValue({
    items: [{ id: "an-1", status: "completed", startedAt: new Date().toISOString() }],
  });
  update.mockResolvedValue({ id: "req-mine", version: 2 });
});

describe("Analysis page — Approve says up front when self-approval is not allowed (#2462)", () => {
  it("disables Approve on the author's requirement, with the reason, before any click", async () => {
    const user = await openRequirements();
    const approve = card("req-mine").getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(approve.closest("[data-hover-hint]")).toHaveAttribute("title", SELF_APPROVAL_HINT);
    await user.click(approve);
    expect(update).not.toHaveBeenCalled();
  });

  it("links the card to the self-approval setting, and still offers Reject", async () => {
    await openRequirements();
    expect(card("req-mine").getByTestId("approval-gate-settings-link")).toHaveAttribute(
      "href",
      "/projects/p1/settings#approval-gate",
    );
    expect(card("req-mine").getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("leaves a requirement the viewer did not write, and an approved one, as they were", async () => {
    const user = await openRequirements();
    const approve = card("req-theirs").getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    expect(approve.closest("[data-hover-hint]")).toBeNull();
    await user.click(approve);
    expect(update).toHaveBeenCalledWith("req-theirs", { reviewStatus: "approved", version: 2 });
    expect(card("req-approved").queryByRole("button", { name: "Approve" })).toBeNull();
    expect(card("req-approved").getByRole("button", { name: "Approved" })).toBeDisabled();
  });

  it("gives a viewer without requirement.approve the permission as the reason", async () => {
    await openRequirements(userAs("developer"));
    const approve = card("req-mine").getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(approve.closest("[data-hover-hint]")).toHaveAttribute(
      "title",
      REQUIRES_REQUIREMENT_APPROVE,
    );
  });
});
