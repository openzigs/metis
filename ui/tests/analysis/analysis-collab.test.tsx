/**
 * Epic #34 — Analysis page collaboration mounts.
 *
 * Verifies the wiring added by the collaboration epic on the requirements
 * surface:
 *   - AC1: a per-requirement "Comments" toggle opens the CommentPanel scoped
 *     to that requirement.
 *   - AC4: the AssigneePicker + SLA badge render per requirement.
 *   - AC2: a 409 from the optimistic-lock save opens the MergeConflictModal
 *     seeded with the server diff (instead of a generic error toast).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "../test-utils";

// ---- next/navigation -------------------------------------------------------

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

// ---- API client (ApiError + apiFetch used by AuthProvider) -----------------

vi.mock("@/lib/api-client", () => ({
  // AuthProvider receives `initialUser` so it never calls /auth/me; this stub
  // only exists for any incidental import.
  apiFetch: vi.fn().mockResolvedValue({}),
  setOnRefreshFailure: vi.fn(),
  streamFetch: vi.fn(),
  _resetAuthRetryState: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code: string | undefined;
    details: unknown;
    constructor(status: number, message: string, code?: string, details?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
}));

// ---- Socket (presence / job events) ----------------------------------------

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));
vi.mock("@/hooks/use-job-events", () => ({
  useJobLifecycle: () => null,
  useProjectJobEvents: () => undefined,
}));

// ---- Data APIs -------------------------------------------------------------

const { SNAPSHOT } = vi.hoisted(() => {
  const REQ = {
    id: "req-1",
    type: "feature",
    title: "Login screen",
    body: "Build the login screen",
    priority: "high",
    labels: [] as string[],
    storyPoints: null,
    reviewStatus: "draft",
    evidenceFindingIds: [] as string[],
    // AC2 — version rendered into the snapshot; the edit/review save submits THIS
    // version (no extra history round-trip) so a stale form reliably 409s.
    version: 4,
  };
  return {
    SNAPSHOT: {
      id: "an-1",
      projectId: "p1",
      startedById: "u-1",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalTokens: 10,
      errorMessage: null,
      inputTokens: 5,
      outputTokens: 5,
      metadata: null,
      agentResults: [] as unknown[],
      requirements: [REQ],
      crossDocFindings: null,
    },
  };
});

vi.mock("@/lib/analysis-api", () => ({
  analysisApi: {
    listForProject: vi.fn().mockResolvedValue({
      items: [
        { id: "an-1", status: "completed", startedAt: new Date().toISOString(), totalTokens: 10 },
      ],
    }),
    get: vi.fn().mockResolvedValue(SNAPSHOT),
    personas: vi.fn().mockResolvedValue({ items: [] }),
    costCap: vi.fn().mockResolvedValue({
      monthlyCap: 0,
      monthlyUsed: 0,
      monthlyRemaining: 0,
      monthBucket: "x",
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
  projectsApi: { get: vi.fn().mockResolvedValue({ id: "p1", name: "Alpha" }) },
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

// ---- Collaboration + history APIs (the code under test) --------------------

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
  assignmentApi: {
    list: vi.fn().mockResolvedValue([]),
    assign: vi.fn(),
    unassign: vi.fn(),
  },
  requirementUpdateApi: {
    update: vi.fn(),
  },
}));

vi.mock("@/lib/history-api", () => ({
  historyApi: {
    list: vi
      .fn()
      .mockResolvedValue({ versions: [], total: 0, page: 1, pageSize: 1, currentVersion: 4 }),
    restore: vi.fn(),
    export: vi.fn(),
  },
}));

// ---- Heavy sub-panels that self-fetch — render inert ----------------------

vi.mock("@/components/traceability/data-mappings-panel", () => ({
  DataMappingsPanel: () => null,
}));
vi.mock("@/components/traceability/traceability-view", () => ({
  TraceabilityView: () => null,
}));
vi.mock("@/components/requirements/RequirementHistoryTab", () => ({
  RequirementHistoryTab: () => null,
}));
vi.mock("@/components/analysis/ModelRecommendation", () => ({
  ModelRecommendation: () => null,
}));
vi.mock("@/components/analysis/EnhancementStatus", () => ({
  EnhancementStatus: () => null,
}));
vi.mock("@/components/analysis/EnhancementResults", () => ({
  EnhancementResults: () => null,
}));
vi.mock("@/components/analysis/ApprovalsPanel", () => ({
  ApprovalsPanel: () => null,
}));
vi.mock("@/components/analysis/add-documents-panel", () => ({
  AddDocumentsPanel: () => null,
}));
vi.mock("@/components/analysis/evaluate-requirements-panel", () => ({
  EvaluateRequirementsPanel: () => null,
}));
vi.mock("@/components/analysis/CrossDocFindingsPanel", () => ({
  CrossDocFindingsPanel: () => null,
}));
vi.mock("@/components/analysis/StakeholdersPanel", () => ({
  StakeholdersPanel: () => null,
}));
vi.mock("@/components/analysis/analysis-run-summary", () => ({
  AnalysisRunSummary: () => null,
}));

import AnalysisPage from "@/app/(authed)/projects/[id]/analysis/page";
import { ApiError } from "@/lib/api-client";
import { commentApi, requirementUpdateApi } from "@/lib/collaboration-api";

const commentMock = commentApi as unknown as {
  listForRequirement: ReturnType<typeof vi.fn>;
};
const updateMock = requirementUpdateApi as unknown as {
  update: ReturnType<typeof vi.fn>;
};

function renderPage() {
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
}

async function waitForRequirement() {
  await waitFor(() => expect(screen.getByText("Login screen")).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  commentMock.listForRequirement.mockResolvedValue([]);
});

describe("AnalysisPage header copy (Requirements Analysis disambiguation)", () => {
  it("renders the 'Requirements Analysis' title and the Impact-Analysis contrast subtitle", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { name: /Requirements Analysis — Alpha/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Synthesize structured requirements & acceptance criteria from this project's documents and code\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/use Impact Analysis\./i)).toBeInTheDocument();
  });
});

// Issue #58 — screen-reader audit. The analyze flow exposes a clean heading
// hierarchy (single h1 → h2 section) and every specialist-agent checkbox is
// programmatically named via its wrapping <label>, so an SR user can select
// agents and orient without visual cues.
describe("AnalysisPage — screen-reader affordances (#58)", () => {
  it("exposes an h1, an h2 section, and named agent checkboxes", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { level: 1, name: /Requirements Analysis/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Start a new analysis" }),
    ).toBeInTheDocument();
    // Each specialist-agent checkbox carries an accessible name from its label.
    // With empty personas the label renders as "{avatar} {key} — {role}"; the
    // "— {key}" role fragment uniquely names each agent checkbox (the enhancement
    // "Enhance with web research" toggle has no em-dash, so /web/ alone would be
    // ambiguous).
    for (const agent of ["document", "code", "database", "web"]) {
      expect(
        screen.getByRole("checkbox", { name: new RegExp(`—\\s*${agent}`, "i") }),
      ).toBeInTheDocument();
    }
  });

  it("gives the per-requirement Comments control an accessible name (#58)", async () => {
    renderPage();
    await waitForRequirement();
    expect(screen.getByRole("button", { name: "Comments for Login screen" })).toBeInTheDocument();
  });
});

describe("AnalysisPage collaboration (Epic #34)", () => {
  it("renders the assignee picker + SLA badge per requirement (AC4)", async () => {
    renderPage();
    await waitForRequirement();
    expect(screen.getByTestId("req-collab-req-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add assignee/i })).toBeInTheDocument();
    // No assignments → "No SLA".
    expect(screen.getByText(/No SLA/i)).toBeInTheDocument();
  });

  it("opens the comment panel scoped to the requirement (AC1)", async () => {
    renderPage();
    await waitForRequirement();
    fireEvent.click(screen.getByTestId("req-comments-req-1"));
    await waitFor(() => expect(commentMock.listForRequirement).toHaveBeenCalledWith("req-1"));
    // #281 — the panel header reflects the requirement's actual name, not a
    // generic "Requirement comments" placeholder.
    expect(screen.getByRole("heading", { name: /Login screen/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Requirement comments$/i }),
    ).not.toBeInTheDocument();
  });

  it("saves through the optimistic-lock PUT with the RENDERED version (AC2/M2)", async () => {
    updateMock.update.mockResolvedValue({ id: "req-1", version: 5, updatedAt: "now" });
    renderPage();
    await waitForRequirement();
    // Open edit modal.
    fireEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]);
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "Login page" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      // version 4 comes from the rendered snapshot fixture, NOT a fresh history
      // read — proving the stale-form version is what's submitted (M2).
      expect(updateMock.update).toHaveBeenCalledWith(
        "req-1",
        expect.objectContaining({ title: "Login page", version: 4 }),
      ),
    );
  });

  it("routes review-status (approve) through the locked PUT with version (AC2/M1)", async () => {
    updateMock.update.mockResolvedValue({ id: "req-1", version: 5, updatedAt: "now" });
    renderPage();
    await waitForRequirement();
    fireEvent.click(screen.getAllByRole("button", { name: /^approve$/i })[0]);
    await waitFor(() =>
      // Approve must use the same optimistic-locked endpoint as field edits,
      // carrying the rendered version so concurrent review changes 409 (M1).
      expect(updateMock.update).toHaveBeenCalledWith(
        "req-1",
        expect.objectContaining({ reviewStatus: "approved", version: 4 }),
      ),
    );
  });

  it("opens the merge-conflict modal with the server diff on a 409 (AC2)", async () => {
    updateMock.update.mockRejectedValue(
      new ApiError(409, "conflict", "VERSION_CONFLICT", {
        serverVersion: 7,
        diff: [{ field: "title", server: "Server title", client: "Login page" }],
      }),
    );
    renderPage();
    await waitForRequirement();
    fireEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]);
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "Login page" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    // Merge modal appears with both versions visible.
    await waitFor(() => expect(screen.getByText(/Merge Conflict/i)).toBeInTheDocument());
    expect(screen.getByText("Server title")).toBeInTheDocument();
    expect(screen.getByText("Login page")).toBeInTheDocument();
  });

  it("resubmits with the server version when the conflict is resolved (AC2)", async () => {
    updateMock.update
      .mockRejectedValueOnce(
        new ApiError(409, "conflict", "VERSION_CONFLICT", {
          serverVersion: 7,
          diff: [{ field: "title", server: "Server title", client: "Login page" }],
        }),
      )
      .mockResolvedValueOnce({ id: "req-1", version: 8, updatedAt: "now" });
    renderPage();
    await waitForRequirement();
    fireEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]);
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "Login page" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/Merge Conflict/i)).toBeInTheDocument());
    // Default resolution = accept server version. Resolve & Save.
    fireEvent.click(screen.getByRole("button", { name: /resolve & save/i }));
    await waitFor(() =>
      expect(updateMock.update).toHaveBeenLastCalledWith(
        "req-1",
        expect.objectContaining({ title: "Server title", version: 7 }),
      ),
    );
  });
});
