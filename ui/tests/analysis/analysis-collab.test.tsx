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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "../test-utils";

// ---- next/navigation -------------------------------------------------------

// Issue #30 — requirements live on their own tab; open it by deep link.
const nav = vi.hoisted(() => ({ search: new URLSearchParams("tab=requirements") }));

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
    useSearchParams: () => nav.search,
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
    acceptanceCriteria: ["A user can sign in", "A wrong password is refused"],
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
    // Issue #30 — with runs on the project the start form is collapsed; open it.
    fireEvent.click(await screen.findByRole("button", { name: "New analysis" }));
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

  it("#990 — edits, removes and adds acceptance criteria and saves the whole list", async () => {
    updateMock.update.mockResolvedValue({ id: "req-1", version: 5, updatedAt: "now" });
    renderPage();
    await waitForRequirement();
    fireEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]);
    await waitFor(() =>
      expect(screen.getByLabelText("Acceptance criterion 1")).toHaveValue("A user can sign in"),
    );

    fireEvent.change(screen.getByLabelText("Acceptance criterion 1"), {
      target: { value: "  A user can sign in with email  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove acceptance criterion 2" }));
    expect(screen.queryByLabelText("Acceptance criterion 2")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
    fireEvent.change(screen.getByLabelText("Acceptance criterion 2"), {
      target: { value: "A locked account cannot sign in" },
    });
    // A blank criterion is dropped, not sent.
    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(updateMock.update).toHaveBeenCalledWith(
        "req-1",
        expect.objectContaining({
          acceptanceCriteria: ["A user can sign in with email", "A locked account cannot sign in"],
          version: 4,
        }),
      ),
    );
  });

  it("#990 — an edit that leaves the criteria alone does not send them", async () => {
    updateMock.update.mockResolvedValue({ id: "req-1", version: 5, updatedAt: "now" });
    renderPage();
    await waitForRequirement();
    fireEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]);
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "Login page" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateMock.update).toHaveBeenCalled());
    expect(updateMock.update.mock.calls[0]![1]).not.toHaveProperty("acceptanceCriteria");
  });

  describe("#990 — an empty stored list prefills from the body the draft reads", () => {
    type Req = { body: string; acceptanceCriteria: string[]; acceptanceCriteriaCleared?: boolean };
    const req = () => SNAPSHOT.requirements[0] as unknown as Req;
    let saved: Req;
    beforeEach(() => {
      saved = { ...req() };
      req().acceptanceCriteria = [];
      req().body = "Build it\n\n## Acceptance criteria\n- Imported one\n- Imported two";
    });
    afterEach(() => {
      delete req().acceptanceCriteriaCleared;
      Object.assign(req(), saved);
    });

    it("shows the body-derived criteria in the editor and does not resend them untouched", async () => {
      updateMock.update.mockResolvedValue({ id: "req-1", version: 5, updatedAt: "now" });
      renderPage();
      await waitForRequirement();
      fireEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]);
      await waitFor(() =>
        expect(screen.getByLabelText("Acceptance criterion 1")).toHaveValue("Imported one"),
      );
      expect(screen.getByLabelText("Acceptance criterion 2")).toHaveValue("Imported two");
      fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
      await waitFor(() => expect(updateMock.update).toHaveBeenCalled());
      expect(updateMock.update.mock.calls[0]![1]).not.toHaveProperty("acceptanceCriteria");
    });

    it("removing every prefilled criterion sends an explicit empty list", async () => {
      updateMock.update.mockResolvedValue({ id: "req-1", version: 5, updatedAt: "now" });
      renderPage();
      await waitForRequirement();
      fireEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]);
      await waitFor(() =>
        expect(screen.getByLabelText("Acceptance criterion 1")).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove acceptance criterion 2" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove acceptance criterion 1" }));
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
      await waitFor(() =>
        expect(updateMock.update).toHaveBeenCalledWith(
          "req-1",
          expect.objectContaining({ acceptanceCriteria: [] }),
        ),
      );
    });
    it("reopening after a clear shows no criteria, as the draft renders none", async () => {
      // What the list API returns once the user has saved an emptied list: the
      // stored list is empty AND flagged cleared, while the body still has a
      // criteria section the draft deliberately no longer reads.
      req().acceptanceCriteriaCleared = true;
      updateMock.update.mockResolvedValue({ id: "req-1", version: 5, updatedAt: "now" });
      renderPage();
      await waitForRequirement();
      fireEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]);
      await waitFor(() =>
        expect(screen.getByText("No acceptance criteria yet.")).toBeInTheDocument(),
      );
      expect(screen.queryByLabelText("Acceptance criterion 1")).not.toBeInTheDocument();
      // Saving another field leaves the cleared list alone.
      fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
      await waitFor(() => expect(updateMock.update).toHaveBeenCalled());
      expect(updateMock.update.mock.calls[0]![1]).not.toHaveProperty("acceptanceCriteria");
    });

    it("caps an over-long body-derived prefill to what the PUT accepts, and says so", async () => {
      // 35 Gherkin lines and one over-long line: more than the 30 x 1,024 the PUT takes.
      const long = `Then ${"x".repeat(1100)}`;
      req().body = [
        "Given a feed",
        "When it is stale",
        long,
        ...Array.from({ length: 32 }, (_, i) => `And step ${i}`),
      ].join("\n");
      updateMock.update.mockResolvedValue({ id: "req-1", version: 5, updatedAt: "now" });
      renderPage();
      await waitForRequirement();
      fireEvent.click(screen.getAllByRole("button", { name: /^edit$/i })[0]);
      await waitFor(() =>
        expect(screen.getByLabelText("Acceptance criterion 30")).toBeInTheDocument(),
      );
      expect(screen.queryByLabelText("Acceptance criterion 31")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(/only the first 30/);
      expect(screen.getByRole("button", { name: "Add criterion" })).toBeDisabled();

      fireEvent.change(screen.getByLabelText("Acceptance criterion 1"), {
        target: { value: "Given a stale feed" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
      await waitFor(() => expect(updateMock.update).toHaveBeenCalled());
      const sent = (updateMock.update.mock.calls[0]![1] as { acceptanceCriteria: string[] })
        .acceptanceCriteria;
      expect(sent).toHaveLength(30);
      expect(sent[0]).toBe("Given a stale feed");
      expect(sent[2]).toHaveLength(1024);
      expect(sent.every((c) => c.length <= 1024)).toBe(true);
    });
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
