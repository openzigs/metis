/**
 * #2447 — the REAL change request page, given a snapshot in which the server
 * redacted what the viewer cannot see a source of: a restricted requirement is
 * a card with its placeholder and no action (no Approve, Edit, History or
 * assignee picker, each of which the server would refuse), and a restricted
 * finding offers no Deep Dive. Everything else renders as before.
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
  const requirement = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: "feature",
    title,
    body: "b",
    priority: "medium",
    labels: [],
    storyPoints: null,
    reviewStatus: "draft",
    evidenceFindingIds: [],
    acceptanceCriteria: [],
    version: 2,
    ...extra,
  });
  const finding = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    body: `${title} body`,
    category: "security",
    severity: "high",
    derivation: "inferred",
    confidence: 0.7,
    agentResultId: "ar-code",
    citations: [],
    tags: [],
    requirementId: null,
    verificationStatus: null,
    supportPanel: null,
    ...extra,
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
      agentResults: [
        {
          id: "ar-code",
          agentKey: "code",
          status: "completed",
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          summary: "s",
          findings: [
            finding("f-hidden", "Restricted", {
              body: "This draws on sources you don't have access to, so its content is hidden.",
              restricted: true,
            }),
            finding("f-open", "Cart keeps items"),
          ],
        },
      ],
      requirements: [
        requirement("req-hidden", "Restricted", {
          body: "This draws on sources you don't have access to, so its content is hidden.",
          restricted: true,
        }),
        requirement("req-open", "Show the receipt"),
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

const userAs = (role: RoleKey): AuthUser => ({
  ...TEST_USER,
  role,
  permissions: [...ROLE_PERMISSIONS[role]],
});

beforeEach(() => {
  vi.clearAllMocks();
  listForProject.mockResolvedValue({
    items: [{ id: "an-1", status: "completed", startedAt: new Date().toISOString() }],
  });
});

describe("Analysis page — what the viewer cannot see a source of (#2447)", () => {
  it("shows a restricted requirement as its placeholder card, with no action", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: userAs("coordinator") }) });
    await user.click(await screen.findByRole("tab", { name: /^Requirements/ }));
    await screen.findByText("Show the receipt");

    const hidden = screen.getByTestId("req-restricted-req-hidden");
    expect(hidden).toHaveTextContent("Restricted");
    expect(hidden).toHaveTextContent("don't have access");
    expect(within(hidden).queryAllByRole("button")).toHaveLength(0);
    expect(within(hidden).queryAllByRole("checkbox")).toHaveLength(0);

    const open = within(document.getElementById("requirement-req-open")!);
    expect(open.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("offers no Deep Dive on a restricted finding, and keeps it on the others", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: userAs("coordinator") }) });
    await user.click(await screen.findByRole("tab", { name: /^Findings/ }));
    await screen.findByText("Cart keeps items");
    expect(screen.getAllByTestId("deep-dive-action")).toHaveLength(1);
  });
});
