/**
 * #289 — findings from custom and library agents (the analysis agent phase)
 * render in the results view with their SOURCE label, like a specialist's
 * persona chip; a failed agent's reason is shown; and an agent-phase agent
 * offers no single-agent Regenerate (there is no endpoint for it).
 *
 * Scaffolding mirrors analysis-results-hierarchy.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

const { SNAPSHOT, HOSTILE_NAME } = vi.hoisted(() => {
  // Operator-authored agent name: must render as TEXT, never as markup.
  const HOSTILE_NAME = '<img src=x onerror="alert(1)">Threat Modeller';
  const SYNTHESIS_SUMMARY =
    "UC101 introduces Cross-Dock Transfer job processing across three areas. " +
    "No source could be retrieved for concrete class naming, which is a blocking context gap.";
  const LONG_BODY =
    "The reconciliation manager only supports LTL and FTL shipment types and lacks a XDOCK ordering flow. ".repeat(
      10,
    );
  return {
    HOSTILE_NAME,
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
          id: "ar-custom",
          agentKey: "custom:c-1",
          source: { kind: "custom", ref: "custom:c-1", name: HOSTILE_NAME },
          status: "completed",
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          summary: "custom summary",
          findings: [
            {
              id: "f-custom",
              title: "Admin routes have no authorization check",
              body: "Any signed-in user reaches the admin surface.",
              category: "security",
              severity: "high",
              derivation: "inferred",
              confidence: 0.7,
              agentResultId: "ar-custom",
              citations: [],
              tags: [],
              requirementId: null,
              verificationStatus: null,
              supportPanel: null,
            },
          ],
        },
        {
          id: "ar-library",
          agentKey: "library:l-1",
          source: { kind: "library", ref: "library:l-1", name: "Release Reviewer" },
          status: "failed",
          startedAt: null,
          completedAt: null,
          errorMessage:
            "No findings recorded: its answer contained no JSON object after one retry.",
          summary: "prose",
          findings: [],
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

describe("#289 — agent-phase findings in the results view", () => {
  it("renders a custom agent's finding with its source label", async () => {
    renderPage();
    await waitForResults();

    const findings = screen.getByTestId("findings-section");
    const title = within(findings).getByText("Admin routes have no authorization check");
    const card = title.closest("[data-confidence]") as HTMLElement;
    const chip = within(card).getByTestId("persona-tag");
    expect(chip).toHaveAttribute("data-agent-key", "custom:c-1");
    expect(within(chip).getByTestId("persona-tag-name")).toHaveTextContent(HOSTILE_NAME);
    expect(within(chip).getByTestId("persona-tag-role")).toHaveTextContent("Custom agent");
    // Untrusted text is rendered as text: no element was injected.
    expect(document.querySelector("img[src='x']")).toBeNull();

    // The specialist's finding keeps its own (fallback) chip.
    const specialist = within(findings)
      .getByText("Reconciliation manager lacks XDOCK support")
      .closest("[data-confidence]") as HTMLElement;
    expect(within(specialist).getByTestId("persona-tag")).toHaveAttribute("data-agent-key", "code");
  });

  it("lists agent-phase agents by name, shows a failed one's reason, and offers no Regenerate for them", async () => {
    renderPage();
    await waitForResults();

    const reviewer = screen.getByText("Release Reviewer");
    const card = reviewer.closest(".rounded") as HTMLElement;
    expect(card).toHaveTextContent("Library agent");
    expect(card).toHaveTextContent(
      "No findings recorded: its answer contained no JSON object after one retry.",
    );
    expect(within(card).queryByRole("button", { name: "Regenerate" })).toBeNull();

    const custom = screen
      .getAllByText(HOSTILE_NAME)
      .map((el) => el.closest(".rounded") as HTMLElement)
      .find((el) => el && !el.hasAttribute("data-confidence"))!;
    expect(within(custom).queryByRole("button", { name: "Regenerate" })).toBeNull();

    // The built-in specialist still has its Regenerate action.
    expect(screen.getAllByRole("button", { name: "Regenerate" })).toHaveLength(1);
  });
});
