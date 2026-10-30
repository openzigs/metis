/**
 * Issue #1220 (PR panel, test-falsifiability) — the REAL analysis page mounts
 * the "Diverged from source" notice on the diverged requirement's card, and its
 * answers reach the API. `SourceDivergenceNotice` has its own tests; this one
 * fails if the card stops mounting it or stops passing the snapshot's field.
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
        id: "req-diverged",
        type: "feature",
        title: "Export orders",
        body: "Refined by the analyst",
        priority: "high",
        labels: ["export"],
        storyPoints: null,
        reviewStatus: "approved",
        evidenceFindingIds: [],
        acceptanceCriteria: [],
        version: 3,
        sourceDivergence: {
          sourceFingerprint: "v1:src-1220",
          detectedAt: "2026-10-16T10:00:00.000Z",
          source: {
            title: "Export orders",
            body: "Changed upstream",
            type: "feature",
            priority: "medium",
            labels: ["export"],
          },
        },
      },
      {
        id: "req-in-sync",
        type: "feature",
        title: "Import feeds",
        body: "b",
        priority: "low",
        labels: [],
        storyPoints: null,
        reviewStatus: "draft",
        evidenceFindingIds: [],
        acceptanceCriteria: [],
        version: 1,
        sourceDivergence: null,
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
const resolveDivergence = vi.hoisted(() => vi.fn());
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
  requirementSourceApi: { resolveDivergence },
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

/** #1587 — answering is a `project.update` write: a coordinator answers here. */
const userAs = (role: RoleKey): AuthUser => ({
  ...TEST_USER,
  role,
  permissions: [...ROLE_PERMISSIONS[role]],
});

function renderPage(user: AuthUser = userAs("coordinator")) {
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: user }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Analysis page — a requirement diverged from its import source (#1220)", () => {
  const card = (id: string): HTMLElement => {
    const el = document.getElementById(`requirement-${id}`);
    if (!el) throw new Error(`no requirement card for ${id}`);
    return el;
  };

  /** The run opens on Summary; the cards are on the Requirements tab. */
  const openRequirements = async (viewer?: AuthUser) => {
    const user = userEvent.setup();
    renderPage(viewer);
    await user.click(await screen.findByRole("tab", { name: /^Requirements/ }));
    return user;
  };

  beforeEach(() => {
    listForProject.mockResolvedValue({
      items: [{ id: "an-1", status: "completed", startedAt: new Date().toISOString() }],
    });
    resolveDivergence.mockResolvedValue({
      id: "req-diverged",
      choice: "local",
      version: 3,
      changed: false,
    });
  });

  it("shows the badge on the diverged requirement's card only", async () => {
    await openRequirements();
    await screen.findByText("Import feeds");
    expect(within(card("req-diverged")).getByText("Diverged from source")).toBeInTheDocument();
    expect(within(card("req-in-sync")).queryByText("Diverged from source")).toBeNull();
    expect(screen.getAllByText("Diverged from source")).toHaveLength(1);
  });

  it("compares the card's text with the source's", async () => {
    const user = await openRequirements();
    await screen.findByText("Import feeds");
    await user.click(within(card("req-diverged")).getByRole("button", { name: "Compare" }));
    const table = within(card("req-diverged")).getByRole("table");
    expect(table).toHaveTextContent("Refined by the analyst");
    expect(table).toHaveTextContent("Changed upstream");
  });

  it("Keep mine and Take the source version answer for that card's requirement", async () => {
    const user = await openRequirements();
    await screen.findByText("Import feeds");
    const diverged = within(card("req-diverged"));

    await user.click(diverged.getByRole("button", { name: "Keep mine" }));
    expect(resolveDivergence).toHaveBeenCalledWith("req-diverged", {
      choice: "local",
      sourceFingerprint: "v1:src-1220",
    });

    await user.click(diverged.getByRole("button", { name: "Take the source version" }));
    expect(resolveDivergence).toHaveBeenLastCalledWith("req-diverged", {
      choice: "source",
      sourceFingerprint: "v1:src-1220",
      version: 3,
    });
  });

  // #1587 — the server refuses both answers without `project.update`.
  it("disables both answers for a developer, with the reason, and still lets them compare", async () => {
    const user = await openRequirements(userAs("developer"));
    await screen.findByText("Import feeds");
    const diverged = within(card("req-diverged"));
    for (const name of ["Keep mine", "Take the source version"]) {
      const button = diverged.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button.closest("[data-hover-hint]")).toHaveAttribute(
        "title",
        "Requires project.update",
      );
      await user.click(button);
    }
    expect(resolveDivergence).not.toHaveBeenCalled();
    expect(diverged.getByRole("button", { name: "Compare" })).toBeEnabled();
  });
});
