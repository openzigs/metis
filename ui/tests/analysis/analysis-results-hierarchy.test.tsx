/**
 * Issue #1232 — the completed-run results page inverted its own hierarchy: the
 * synthesis summary (the only place the outcome is stated) was never rendered,
 * requirements sat below findings, and every finding body was a ~1000-character
 * unbroken paragraph.
 *
 * These assert the hierarchy on the real page: outcome first, then requirements,
 * then findings — and that the pre-existing filters and the deep-dive action
 * survive the reorder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper, TEST_USER } from "../test-utils";

const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));

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

const { SNAPSHOT } = vi.hoisted(() => {
  const SYNTHESIS_SUMMARY =
    "UC101 introduces Cross-Dock Transfer job processing across three areas. " +
    "No source could be retrieved for concrete class naming, which is a blocking context gap.";
  const LONG_BODY =
    "The reconciliation manager only supports LTL and FTL shipment types and lacks a XDOCK ordering flow. ".repeat(
      10,
    );
  return {
    SYNTHESIS_SUMMARY,
    LONG_BODY,
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
      agentResults: [
        {
          id: "ar-code",
          agentKey: "code",
          status: "completed",
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          summary: "code specialist summary",
          findings: [
            {
              id: "f-1",
              title: "Reconciliation manager lacks XDOCK support",
              body: LONG_BODY,
              category: "architecture",
              severity: "high",
              derivation: "inferred",
              confidence: 0.7,
              agentResultId: "ar-code",
              citations: [],
              tags: [],
              requirementId: null,
              // Null on 5 of 8 findings in the reference run — the badge must
              // simply not render rather than leave a placeholder.
              verificationStatus: null,
              supportPanel: null,
            },
          ],
        },
        {
          id: "ar-synth",
          agentKey: "synthesis",
          status: "completed",
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          summary: SYNTHESIS_SUMMARY,
          findings: [],
        },
      ],
      requirements: [
        {
          id: "req-1",
          type: "feature",
          title: "Login screen",
          body: "Build the login screen",
          priority: "high",
          labels: [] as string[],
          storyPoints: null,
          reviewStatus: "draft",
          evidenceFindingIds: [] as string[],
          version: 1,
        },
      ],
      crossDocFindings: null,
    },
  };
});

vi.mock("@/lib/analysis-api", () => ({
  isCodeCitation: () => false,
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
import { analysisApi } from "@/lib/analysis-api";

const apiMock = analysisApi as unknown as { get: ReturnType<typeof vi.fn> };

function renderPage() {
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
}

async function waitForResults() {
  await waitFor(() => expect(screen.getByTestId("findings-section")).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.search = new URLSearchParams();
  apiMock.get.mockResolvedValue(SNAPSHOT);
});

// #29 — the Overview's "Review N requirements" and the Requirements tab link
// here with `?analysisId=`; the page must open that run, not the newest one.
describe("?analysisId deep link (#29)", () => {
  const listMock = analysisApi.listForProject as unknown as ReturnType<typeof vi.fn>;
  const twoRuns = {
    items: [
      { id: "an-new", status: "running", startedAt: new Date().toISOString(), totalTokens: 0 },
      { id: "an-1", status: "completed", startedAt: new Date().toISOString(), totalTokens: 10 },
    ],
  };

  it("selects the requested run when it belongs to this project", async () => {
    listMock.mockResolvedValueOnce(twoRuns);
    nav.search = new URLSearchParams("analysisId=an-1");
    renderPage();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(apiMock.get).toHaveBeenCalledWith("an-1");
    expect(apiMock.get).not.toHaveBeenCalledWith("an-new");
  });

  it("ignores an id that is not in this project's list", async () => {
    listMock.mockResolvedValueOnce(twoRuns);
    nav.search = new URLSearchParams("analysisId=someone-elses");
    renderPage();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(apiMock.get).toHaveBeenCalledWith("an-new");
    expect(apiMock.get).not.toHaveBeenCalledWith("someone-elses");
  });
});

describe("Analysis results hierarchy (#1232)", () => {
  it("renders the synthesis summary above both requirements and findings", async () => {
    renderPage();
    await waitForResults();

    const outcome = screen.getByTestId("analysis-outcome-card");
    expect(outcome).toHaveTextContent(/blocking context gap/i);

    const requirements = screen.getByTestId("requirements-section");
    expect(outcome.compareDocumentPosition(requirements)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("renders requirements before findings in DOM order", async () => {
    renderPage();
    await waitForResults();

    const requirements = screen.getByTestId("requirements-section");
    const findings = screen.getByTestId("findings-section");
    expect(requirements.compareDocumentPosition(findings)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("renders no outcome card when synthesis produced no summary", async () => {
    apiMock.get.mockResolvedValue({
      ...SNAPSHOT,
      agentResults: SNAPSHOT.agentResults.map((a) =>
        a.agentKey === "synthesis" ? { ...a, summary: null } : a,
      ),
    });
    renderPage();
    await waitForResults();

    expect(screen.queryByTestId("analysis-outcome-card")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^outcome$/i })).not.toBeInTheDocument();
  });

  it("clamps a long finding body until the reader expands it", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForResults();

    const body = screen.getByTestId("finding-body");
    expect(body).toHaveAttribute("data-expanded", "false");
    expect(body.className).toMatch(/line-clamp-3/);

    await user.click(screen.getByRole("button", { name: /show more/i }));

    expect(screen.getByTestId("finding-body")).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("finding-body").className).not.toMatch(/line-clamp-3/);
    expect(screen.getByTestId("finding-body")).toHaveTextContent(/XDOCK ordering flow/);
  });

  it("omits the verification badge entirely when the status is null", async () => {
    renderPage();
    await waitForResults();

    const findings = screen.getByTestId("findings-section");
    // No badge span at all — not an empty one. (The filter buttons above the
    // list carry the same words, so query the badge's own role/testid.)
    expect(within(findings).queryByRole("status")).not.toBeInTheDocument();
    expect(within(findings).queryByTestId(/^verification-badge-/) as HTMLElement | null).toBeNull();
    // Severity stays immediately visible.
    expect(within(findings).getByTestId("finding-severity")).toHaveTextContent("high");
  });

  it("keeps the verification filter, coverage filter and deep-dive action working", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForResults();

    expect(screen.getByTestId("verification-filter")).toBeInTheDocument();
    expect(screen.getByTestId("coverage-filter")).toBeInTheDocument();
    expect(screen.getByTestId("deep-dive-action")).toBeEnabled();

    // Filtering to "confirmed" drops the null-status finding.
    await user.click(screen.getByTestId("verification-filter-confirmed"));
    expect(screen.queryByTestId("finding-body")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("verification-filter-all"));
    expect(screen.getByTestId("finding-body")).toBeInTheDocument();

    // Coverage filtering still drives the requirements list.
    await user.click(screen.getByTestId("coverage-filter-no_evidence"));
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
  });
});
