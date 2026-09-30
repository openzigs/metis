/**
 * Issue #30 — the Analysis page split into deep-linkable sub-views.
 *
 * One run used to render everything on a single 113,001 px page. These drive
 * the real page: only the active tab mounts, the tab and run live in the URL,
 * Questions and Approvals carry outstanding counts, findings filter by
 * severity / category / agent and page at 20, and the run form is collapsed
 * once there are runs to read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { makeWrapper, TEST_USER } from "../test-utils";

const nav = vi.hoisted(() => ({ search: new URLSearchParams(), replace: vi.fn() }));
/**
 * Issue #487 — every render of the Approvals stub: the run it was handed and
 * the run and tab the URL named at that moment. A render whose props lag the
 * URL is the one-frame flash of the old run or tab.
 */
const tabRenders = vi.hoisted(() => [] as { value: string; urlTab: string | null }[]);
const approvalsRenders = vi.hoisted(
  () => [] as { analysisId: string; urlRun: string | null; urlTab: string | null }[],
);

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "p1" }),
    usePathname: () => "/projects/p1/analysis",
    useRouter: () => ({
      push: vi.fn(),
      replace: nav.replace,
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
vi.mock("@/components/analysis/EnhancementResults", () => ({
  EnhancementResults: () => <div data-testid="enhancement-results-stub" />,
}));
// Stands in for the real panel's contract: resolving an approval invalidates
// ["approvals", analysisId] (ApprovalsPanel.tsx).
vi.mock("@/components/analysis/ApprovalsPanel", async () => {
  const { useQueryClient } = await import("@tanstack/react-query");
  return {
    ApprovalsPanel: ({ analysisId }: { analysisId: string }) => {
      const qc = useQueryClient();
      approvalsRenders.push({
        analysisId,
        urlRun: nav.search.get("analysisId"),
        urlTab: nav.search.get("tab"),
      });
      return (
        <div id="approvals" data-testid="approvals-panel-stub">
          <button
            type="button"
            onClick={() => void qc.invalidateQueries({ queryKey: ["approvals", analysisId] })}
          >
            Resolve approval
          </button>
        </div>
      );
    },
  };
});
// Issue #487 — the real tab bar, recording the tab it is handed against the
// tab the URL names. (A panel stub cannot see a stale tab: Radix Presence
// renders the outgoing content once more whichever way the page resyncs.)
vi.mock("@/components/analysis/AnalysisResultTabs", async () => {
  const actual = await vi.importActual<typeof import("@/components/analysis/AnalysisResultTabs")>(
    "@/components/analysis/AnalysisResultTabs",
  );
  return {
    AnalysisResultTabs: (props: Parameters<typeof actual.AnalysisResultTabs>[0]) => {
      tabRenders.push({ value: props.value, urlTab: nav.search.get("tab") });
      return <actual.AnalysisResultTabs {...props} />;
    },
  };
});
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

const apiMock = analysisApi as unknown as {
  get: ReturnType<typeof vi.fn>;
  listForProject: ReturnType<typeof vi.fn>;
  listApprovals: ReturnType<typeof vi.fn>;
};

/** Mirrors the vi.mock factory's listForProject default (one completed run). */
const DEFAULT_RUNS = {
  items: [
    { id: "an-1", status: "completed", startedAt: new Date().toISOString(), totalTokens: 10 },
  ],
};

const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const CATEGORIES = ["security", "architecture", "performance"];

/** 105 findings split across two agents — the "100+ findings" of the AC. */
function manyFindings() {
  const make = (agentKey: string, n: number, offset: number) =>
    Array.from({ length: n }, (_, i) => {
      const k = i + offset;
      return {
        id: `f-${k}`,
        title: `Finding ${k}`,
        body: "body",
        category: CATEGORIES[k % CATEGORIES.length],
        severity: SEVERITIES[k % SEVERITIES.length],
        derivation: "inferred",
        confidence: 0.5,
        agentResultId: `ar-${agentKey}`,
        citations: [],
        tags: [],
        requirementId: null,
        verificationStatus: null,
        supportPanel: null,
      };
    });
  return {
    ...SNAPSHOT,
    metadata: {
      enhancement: { enableClarification: true, enableWebResearch: false },
      structuredRequirements: { requirements: [], totalAmbiguities: 14, totalEvidenceNeeds: 0 },
    },
    requirements: Array.from({ length: 12 }, (_, i) => ({
      ...SNAPSHOT.requirements[0],
      id: `req-${i}`,
      title: `Requirement ${i}`,
    })),
    agentResults: [
      {
        ...SNAPSHOT.agentResults[0],
        id: "ar-code",
        agentKey: "code",
        findings: make("code", 60, 0),
      },
      {
        ...SNAPSHOT.agentResults[0],
        id: "ar-document",
        agentKey: "document",
        findings: make("document", 45, 60),
      },
      SNAPSHOT.agentResults[1],
    ],
  };
}

function renderPage() {
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
}

const findingTitles = () =>
  within(screen.getByTestId("findings-section"))
    .queryAllByText(/^Finding \d+$/)
    .map((el) => el.textContent);

let scrolled: Element[] = [];

const lastReplace = () => nav.replace.mock.calls.at(-1)?.[0] as string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  scrolled = [];
  HTMLElement.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  nav.search = new URLSearchParams();
  approvalsRenders.length = 0;
  tabRenders.length = 0;
  apiMock.get.mockResolvedValue(SNAPSHOT);
  apiMock.listApprovals.mockResolvedValue({
    items: [],
    ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 },
  });
});

// PR #478 review — a test that stands the router in with a `replace`
// implementation must not leak it when an assertion fails before cleanup.
afterEach(() => {
  nav.replace.mockReset();
});

describe("only the active sub-view mounts", () => {
  it("opens on Summary with no requirement, finding or agent card in the DOM", async () => {
    renderPage();
    await screen.findByTestId("analysis-outcome-card");
    expect(screen.queryByTestId("requirements-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("findings-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approvals-panel-stub")).not.toBeInTheDocument();
    expect(screen.queryByTestId("enhancement-results-stub")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });

  it.each([
    ["requirements", "requirements-section"],
    ["findings", "findings-section"],
    ["questions", "enhancement-results-stub"],
    ["approvals", "approvals-panel-stub"],
  ])("?tab=%s deep-links straight to that view", async (tab, testId) => {
    nav.search = new URLSearchParams(`tab=${tab}`);
    renderPage();
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    expect(screen.queryByTestId("analysis-outcome-card")).not.toBeInTheDocument();
  });

  it("?tab=agents shows the agent output", async () => {
    nav.search = new URLSearchParams("tab=agents");
    renderPage();
    expect(await screen.findByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });

  // PR #416 review — ApprovalsPanel renders nothing when a run has none.
  it("says so when the run has no approval checkpoints", async () => {
    nav.search = new URLSearchParams("tab=approvals");
    renderPage();
    expect(await screen.findByTestId("approvals-none")).toBeInTheDocument();
  });

  it("says so when the run asked no clarifying questions", async () => {
    nav.search = new URLSearchParams("tab=questions");
    renderPage();
    expect(await screen.findByTestId("questions-none")).toBeInTheDocument();
  });
});

describe("the URL carries the tab and the run", () => {
  it("writes the tab, keeping the run, when a tab is clicked", async () => {
    nav.search = new URLSearchParams("analysisId=an-1");
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: /^Findings/ }));
    expect(await screen.findByTestId("findings-section")).toBeInTheDocument();
    expect(lastReplace()).toBe("/projects/p1/analysis?analysisId=an-1&tab=findings");
    expect(nav.replace.mock.calls.at(-1)?.[1]).toEqual({ scroll: false });
  });

  it("writes the run when a past run is picked", async () => {
    apiMock.listForProject.mockResolvedValueOnce({
      items: [
        { id: "an-new", status: "completed", startedAt: new Date().toISOString(), totalTokens: 1 },
        { id: "an-old", status: "completed", startedAt: new Date().toISOString(), totalTokens: 1 },
      ],
    });
    nav.search = new URLSearchParams("tab=findings");
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /an-old/ }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("an-old"));
    expect(lastReplace()).toBe("/projects/p1/analysis?tab=findings&analysisId=an-old");
  });

  it("turns 'Go to approvals' into the Approvals tab", async () => {
    apiMock.get.mockResolvedValue({ ...SNAPSHOT, requirements: [] });
    apiMock.listApprovals.mockResolvedValue({
      items: [],
      ticketStatus: { allowed: false, pendingCount: 2, rejectedCount: 0 },
    });
    nav.search = new URLSearchParams("tab=findings");
    renderPage();
    const link = await screen.findByRole("link", { name: "Go to approvals" });
    await userEvent.click(link);
    expect(await screen.findByTestId("approvals-panel-stub")).toBeInTheDocument();
    expect(lastReplace()).toBe("/projects/p1/analysis?tab=approvals");
    // #406 — and scrolls to the panel, which mounts after the tab switch.
    await waitFor(() => expect(scrolled).toEqual([screen.getByTestId("approvals-panel-stub")]));
  });
});

// Issue #406 — the Publish page's "Resolve approvals" link ends in #approvals,
// but the panel mounts only after the run, detail and approvals queries
// resolve, so the browser's own fragment scroll finds nothing.
describe("the #approvals deep link", () => {
  afterEach(() => {
    window.history.replaceState(null, "", window.location.pathname);
  });

  it("scrolls to the approvals panel once it mounts", async () => {
    window.history.replaceState(null, "", "#approvals");
    nav.search = new URLSearchParams("analysisId=an-1&tab=approvals");
    renderPage();
    const panel = await screen.findByTestId("approvals-panel-stub");
    await waitFor(() => expect(scrolled).toEqual([panel]));
  });

  it("opens the Approvals tab for a fragment-only link with no ?tab=", async () => {
    window.history.replaceState(null, "", "#approvals");
    nav.search = new URLSearchParams("analysisId=an-1");
    renderPage();
    const panel = await screen.findByTestId("approvals-panel-stub");
    await waitFor(() => expect(scrolled).toEqual([panel]));
  });

  it("a tab switch cancels a scroll still waiting for its target", async () => {
    // ?tab=summary wins over the fragment, so #approvals is pending, not mounted.
    window.history.replaceState(null, "", "#approvals");
    nav.search = new URLSearchParams("analysisId=an-1&tab=summary");
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: /Findings/ }));
    await userEvent.click(screen.getByRole("tab", { name: /Approvals/ }));
    await screen.findByTestId("approvals-panel-stub");
    await screen.findByTestId("approvals-none");
    expect(scrolled).toEqual([]);
  });

  it("does not scroll without the fragment", async () => {
    nav.search = new URLSearchParams("analysisId=an-1&tab=approvals");
    renderPage();
    await screen.findByTestId("approvals-panel-stub");
    await screen.findByTestId("approvals-none");
    expect(scrolled).toEqual([]);
  });
});

// Issue #406 — how the page wires GenerateIssuesAction. The component has its
// own tests; these catch a wrong prop (requirementCount, hasFindings,
// ticketStatus, approvalsState) that those cannot see.
describe("Generate GitHub Issues on the Findings tab", () => {
  beforeEach(() => {
    nav.search = new URLSearchParams("tab=findings");
  });

  it("links to Publish for this run when it has requirements", async () => {
    renderPage();
    expect(await screen.findByRole("link", { name: /Generate GitHub Issues/ })).toHaveAttribute(
      "href",
      "/projects/p1/publish?analysisId=an-1",
    );
  });

  it("names the pending approvals holding the requirements back", async () => {
    apiMock.get.mockResolvedValue({ ...SNAPSHOT, requirements: [] });
    apiMock.listApprovals.mockResolvedValue({
      items: [],
      ticketStatus: { allowed: false, pendingCount: 2, rejectedCount: 0 },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("generate-issues-reason")).toHaveTextContent(
        "2 pending approval(s) must be resolved",
      ),
    );
    expect(screen.queryByRole("link", { name: /Generate GitHub Issues/ })).not.toBeInTheDocument();
  });

  it("names a rejected approval", async () => {
    apiMock.get.mockResolvedValue({ ...SNAPSHOT, requirements: [] });
    apiMock.listApprovals.mockResolvedValue({
      items: [],
      ticketStatus: { allowed: false, pendingCount: 0, rejectedCount: 1 },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("generate-issues-reason")).toHaveTextContent(
        "1 approval(s) were rejected",
      ),
    );
  });

  it("says it is checking while the approvals query is in flight", async () => {
    apiMock.get.mockResolvedValue({ ...SNAPSHOT, requirements: [] });
    apiMock.listApprovals.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByTestId("generate-issues-reason")).toHaveTextContent(
      "Checking approvals…",
    );
  });

  it("says the gate could not be checked when the approvals query fails", async () => {
    apiMock.get.mockResolvedValue({ ...SNAPSHOT, requirements: [] });
    apiMock.listApprovals.mockRejectedValue(new Error("boom"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("generate-issues-reason")).toHaveTextContent(
        "Couldn't check the approval gate",
      ),
    );
  });

  it("explains an ungated run with findings but no requirements", async () => {
    apiMock.get.mockResolvedValue({ ...SNAPSHOT, requirements: [] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("generate-issues-reason")).toHaveTextContent(
        "No requirements to generate issues from.",
      ),
    );
  });

  it("offers nothing on an ungated run with no findings and no requirements", async () => {
    apiMock.get.mockResolvedValue({
      ...SNAPSHOT,
      requirements: [],
      agentResults: SNAPSHOT.agentResults.map((a) => ({ ...a, findings: [] })),
    });
    renderPage();
    await screen.findByTestId("findings-section");
    await waitFor(() => expect(apiMock.listApprovals).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("generate-issues-reason")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Generate GitHub Issues/ }),
    ).not.toBeInTheDocument();
  });
});

describe("outstanding counts on Questions and Approvals", () => {
  it("shows open questions and pending approvals", async () => {
    apiMock.get.mockResolvedValue(manyFindings());
    apiMock.listApprovals.mockResolvedValue({
      items: [],
      ticketStatus: { allowed: false, pendingCount: 12, rejectedCount: 0 },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("analysis-tab-count-approvals")).toHaveTextContent("12"),
    );
    expect(screen.getByTestId("analysis-tab-count-questions")).toHaveTextContent("14");
    expect(screen.getByTestId("analysis-tab-count-findings")).toHaveTextContent("105");
    expect(screen.getByTestId("analysis-tab-count-requirements")).toHaveTextContent("12");
  });

  it("refreshes the pending count when the approvals panel resolves one", async () => {
    apiMock.listApprovals
      .mockResolvedValueOnce({
        items: [],
        ticketStatus: { allowed: false, pendingCount: 2, rejectedCount: 0 },
      })
      .mockResolvedValue({
        items: [],
        ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 },
      });
    nav.search = new URLSearchParams("tab=approvals");
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("analysis-tab-count-approvals")).toHaveTextContent("2"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Resolve approval" }));
    await waitFor(() =>
      expect(screen.getByTestId("analysis-tab-count-approvals")).toHaveTextContent("0"),
    );
  });
});

describe("findings: filters and paging with 100+ findings", () => {
  beforeEach(() => {
    apiMock.get.mockResolvedValue(manyFindings());
    nav.search = new URLSearchParams("tab=findings");
  });

  it("mounts one page of 20, and pages through the rest", async () => {
    renderPage();
    await screen.findByTestId("findings-section");
    await waitFor(() => expect(findingTitles()).toHaveLength(20));
    expect(screen.getAllByTestId("deep-dive-action")).toHaveLength(20);
    expect(screen.getByTestId("findings-pager-range")).toHaveTextContent(
      "Showing 1–20 of 105 findings",
    );

    await userEvent.click(
      within(screen.getByTestId("findings-pager")).getByRole("button", { name: "Next" }),
    );
    expect(screen.getByTestId("findings-pager-range")).toHaveTextContent(
      "Showing 21–40 of 105 findings",
    );
    expect(findingTitles()).toHaveLength(20);
  });

  // PR #416 review — filters belong to a run; switching runs clears them.
  it("clears the findings filters when another run is picked", async () => {
    apiMock.listForProject.mockResolvedValue({
      items: [
        { id: "an-new", status: "completed", startedAt: new Date().toISOString(), totalTokens: 1 },
        { id: "an-old", status: "completed", startedAt: new Date().toISOString(), totalTokens: 1 },
      ],
    });
    nav.search = new URLSearchParams("tab=findings");
    renderPage();
    await screen.findByTestId("findings-section");
    await userEvent.selectOptions(screen.getByTestId("finding-filter-agent"), "document");
    expect(screen.getByTestId("finding-filter-agent")).toHaveValue("document");
    await userEvent.click(await screen.findByRole("button", { name: /an-old/ }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("an-old"));
    await waitFor(() => expect(screen.getByTestId("finding-filter-agent")).toHaveValue(""));
    // A persistent mock outlives clearAllMocks: restore the module default.
    apiMock.listForProject.mockResolvedValue(DEFAULT_RUNS);
  });

  it("filters by severity, category and agent, and returns to page 1", async () => {
    renderPage();
    await screen.findByTestId("findings-section");
    await userEvent.click(
      within(screen.getByTestId("findings-pager")).getByRole("button", { name: "Next" }),
    );

    await userEvent.selectOptions(screen.getByTestId("finding-filter-severity"), "critical");
    // 105 findings, severity cycles every 5 → 21 critical.
    expect(screen.getByTestId("findings-pager-range")).toHaveTextContent(
      "Showing 1–20 of 21 findings",
    );
    for (const el of within(screen.getByTestId("findings-section")).getAllByTestId(
      "finding-severity",
    ))
      expect(el).toHaveTextContent("critical");

    await userEvent.selectOptions(screen.getByTestId("finding-filter-category"), "security");
    // critical ⇔ k%5==0, security ⇔ k%3==0 → k%15==0: 0,15,…,105 → 7 of 0..104.
    expect(findingTitles()).toHaveLength(7);
    expect(screen.queryByTestId("findings-pager")).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByTestId("finding-filter-agent"), "document");
    // …of which those with k ≥ 60: 60, 75, 90.
    expect(findingTitles()).toEqual(["Finding 60", "Finding 75", "Finding 90"]);

    // No finding in this run is verifier-confirmed.
    await userEvent.click(screen.getByTestId("verification-filter-confirmed"));
    expect(findingTitles()).toEqual([]);
    expect(screen.getByTestId("findings-no-match")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("finding-filter-clear"));
    expect(findingTitles()).toHaveLength(20);
  });
});

describe("requirements are paged", () => {
  it("shows five at a time", async () => {
    apiMock.get.mockResolvedValue(manyFindings());
    nav.search = new URLSearchParams("tab=requirements");
    renderPage();
    await screen.findByText("Requirement 0");
    expect(screen.queryByText("Requirement 5")).not.toBeInTheDocument();
    await userEvent.click(
      within(screen.getByTestId("requirements-pager")).getByRole("button", { name: "Next" }),
    );
    expect(screen.getByText("Requirement 5")).toBeInTheDocument();
    expect(screen.queryByText("Requirement 0")).not.toBeInTheDocument();
  });
});

describe("starting a run is separate from reading one", () => {
  it("collapses the run form when the project has runs, and opens it on demand", async () => {
    renderPage();
    const toggle = await screen.findByTestId("start-analysis-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Start a new analysis" })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByRole("heading", { name: "Start a new analysis" })).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(screen.queryByRole("heading", { name: "Start a new analysis" })).not.toBeInTheDocument();
  });

  it("opens the run form on a project with no runs", async () => {
    apiMock.listForProject.mockResolvedValueOnce({ items: [] });
    renderPage();
    expect(await screen.findByTestId("start-analysis-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("heading", { name: "Start a new analysis" })).toBeInTheDocument();
  });
});

// Issue #424 — the findings filters live in the URL so a filtered view can be shared.
describe("findings filters in the URL", () => {
  beforeEach(() => {
    apiMock.get.mockResolvedValue(manyFindings());
  });

  it("opens a shared link already filtered", async () => {
    nav.search = new URLSearchParams(
      "analysisId=an-1&tab=findings&severity=critical&category=security&agent=document",
    );
    renderPage();
    await screen.findByTestId("findings-section");
    await waitFor(() =>
      expect(findingTitles()).toEqual(["Finding 60", "Finding 75", "Finding 90"]),
    );
    expect(screen.getByTestId("finding-filter-severity")).toHaveValue("critical");
    expect(screen.getByTestId("finding-filter-agent")).toHaveValue("document");
  });

  it("opens a shared link filtered by verification", async () => {
    nav.search = new URLSearchParams("tab=findings&verification=confirmed");
    renderPage();
    expect(await screen.findByTestId("findings-no-match")).toBeInTheDocument();
    expect(screen.getByTestId("verification-filter-confirmed")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("writes each filter change into the URL, pinned to the run, and clears it", async () => {
    nav.search = new URLSearchParams("tab=findings");
    renderPage();
    await screen.findByTestId("findings-section");
    await waitFor(() => expect(findingTitles()).toHaveLength(20));
    await userEvent.selectOptions(screen.getByTestId("finding-filter-severity"), "critical");
    expect(lastReplace()).toBe(
      "/projects/p1/analysis?tab=findings&analysisId=an-1&severity=critical",
    );
    expect(nav.replace.mock.calls.at(-1)?.[1]).toEqual({ scroll: false });
    await userEvent.click(screen.getByTestId("finding-filter-clear"));
    expect(lastReplace()).toBe("/projects/p1/analysis?tab=findings&analysisId=an-1");
  });

  it("drops the filters from the URL when another run is picked", async () => {
    apiMock.listForProject.mockResolvedValue({
      items: [
        { id: "an-new", status: "completed", startedAt: new Date().toISOString(), totalTokens: 1 },
        { id: "an-old", status: "completed", startedAt: new Date().toISOString(), totalTokens: 1 },
      ],
    });
    nav.search = new URLSearchParams("tab=findings&severity=critical");
    renderPage();
    await screen.findByTestId("findings-section");
    await userEvent.click(await screen.findByRole("button", { name: /an-old/ }));
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("an-old"));
    expect(lastReplace()).toBe("/projects/p1/analysis?tab=findings&analysisId=an-old");
    await waitFor(() => expect(screen.getByTestId("finding-filter-severity")).toHaveValue(""));
    apiMock.listForProject.mockResolvedValue(DEFAULT_RUNS);
  });
});

// Issue #476 — the filters follow the URL on a soft navigation, as `tab` does.
describe("findings filters resync from the URL while mounted", () => {
  beforeEach(() => {
    apiMock.get.mockResolvedValue(manyFindings());
  });

  /** Render, and return a soft navigation: new search params, same mounted page. */
  function renderNavigable() {
    const { rerender } = render(<AnalysisPage />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    return (query: string) => {
      nav.search = new URLSearchParams(query);
      rerender(<AnalysisPage />);
    };
  }

  it("applies and shows the filters of a second link opened on the mounted page", async () => {
    nav.search = new URLSearchParams("analysisId=an-1&tab=findings&severity=critical");
    const navigate = renderNavigable();
    await screen.findByTestId("findings-section");
    await waitFor(() =>
      expect(screen.getByTestId("findings-pager-range")).toHaveTextContent("of 21 findings"),
    );

    navigate("analysisId=an-1&tab=findings&severity=critical&category=security&agent=document");
    await waitFor(() =>
      expect(findingTitles()).toEqual(["Finding 60", "Finding 75", "Finding 90"]),
    );
    expect(screen.getByTestId("finding-filter-severity")).toHaveValue("critical");
    expect(screen.getByTestId("finding-filter-category")).toHaveValue("security");
    expect(screen.getByTestId("finding-filter-agent")).toHaveValue("document");

    // Back to the unfiltered view.
    navigate("analysisId=an-1&tab=findings");
    await waitFor(() => expect(findingTitles()).toHaveLength(20));
    expect(screen.getByTestId("finding-filter-severity")).toHaveValue("");
    expect(screen.getByTestId("finding-filter-agent")).toHaveValue("");
    expect(screen.getByTestId("findings-pager-range")).toHaveTextContent(
      "Showing 1–20 of 105 findings",
    );
  });

  it("follows the verification filter too", async () => {
    nav.search = new URLSearchParams("tab=findings");
    const navigate = renderNavigable();
    await screen.findByTestId("findings-section");
    navigate("tab=findings&verification=confirmed");
    expect(await screen.findByTestId("findings-no-match")).toBeInTheDocument();
    expect(screen.getByTestId("verification-filter-confirmed")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("returns to page 1 when the URL brings different filters", async () => {
    nav.search = new URLSearchParams("tab=findings");
    const navigate = renderNavigable();
    await screen.findByTestId("findings-section");
    await waitFor(() => expect(findingTitles()).toHaveLength(20));
    await userEvent.click(
      within(screen.getByTestId("findings-pager")).getByRole("button", { name: "Next" }),
    );
    expect(screen.getByTestId("findings-pager-range")).toHaveTextContent(
      "Showing 21–40 of 105 findings",
    );
    navigate("tab=findings&severity=critical");
    await waitFor(() =>
      expect(screen.getByTestId("findings-pager-range")).toHaveTextContent(
        "Showing 1–20 of 21 findings",
      ),
    );
  });

  it("does not loop or reset the page when its own filter write echoes back", async () => {
    nav.search = new URLSearchParams("tab=findings");
    const navigate = renderNavigable();
    // Stand in for the router: a replace becomes the new search params.
    let echo: string | null = null;
    nav.replace.mockImplementation((href: string) => {
      echo = href.split("?")[1] ?? "";
    });
    await screen.findByTestId("findings-section");
    await waitFor(() => expect(findingTitles()).toHaveLength(20));

    await userEvent.selectOptions(screen.getByTestId("finding-filter-severity"), "critical");
    await userEvent.click(
      within(screen.getByTestId("findings-pager")).getByRole("button", { name: "Next" }),
    );
    expect(screen.getByTestId("findings-pager-range")).toHaveTextContent(
      "Showing 21–21 of 21 findings",
    );
    const writes = nav.replace.mock.calls.length;

    // The router delivers the write only now, after the reader paged on.
    navigate(echo!);
    navigate(echo!);
    expect(screen.getByTestId("findings-pager-range")).toHaveTextContent(
      "Showing 21–21 of 21 findings",
    );
    expect(screen.getByTestId("finding-filter-severity")).toHaveValue("critical");
    expect(nav.replace).toHaveBeenCalledTimes(writes);
  });

  // Issue #487 — the tab resyncs during render, as the filters do, so the old
  // tab's panel never renders against the new URL.
  it("switches the tab without rendering the old one against the new URL", async () => {
    nav.search = new URLSearchParams("analysisId=an-1&tab=approvals");
    const navigate = renderNavigable();
    await screen.findByTestId("approvals-panel-stub");
    navigate("analysisId=an-1&tab=findings");
    expect(await screen.findByTestId("findings-section")).toBeInTheDocument();
    expect(screen.queryByTestId("approvals-panel-stub")).not.toBeInTheDocument();
    expect(tabRenders.filter((r) => r.urlTab === "findings" && r.value !== "findings")).toEqual([]);
  });
});

// Issue #487 — a link naming a different run switches the run, not just the
// filters and tab: `selectedAnalysisId` used to be read from the URL only
// while it was still null.
describe("the run resyncs from the URL while mounted", () => {
  const RUN_A = {
    id: "an-a",
    status: "completed",
    startedAt: new Date().toISOString(),
    totalTokens: 1,
  };
  const RUN_B = {
    id: "an-b",
    status: "completed",
    startedAt: new Date().toISOString(),
    totalTokens: 1,
  };

  beforeEach(() => {
    apiMock.listForProject.mockResolvedValue({ items: [RUN_A, RUN_B] });
    // Run A: 105 "Finding N" findings and 12 requirements. Run B: one finding.
    apiMock.get.mockImplementation(async (id: string) =>
      id === "an-b" ? { ...SNAPSHOT, id: "an-b" } : { ...manyFindings(), id },
    );
  });
  afterEach(() => {
    apiMock.listForProject.mockResolvedValue(DEFAULT_RUNS);
  });

  function renderNavigable() {
    const { rerender } = render(<AnalysisPage />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    return (query: string) => {
      nav.search = new URLSearchParams(query);
      rerender(<AnalysisPage />);
    };
  }

  it("switches to the run a second link names, with that link's filters", async () => {
    nav.search = new URLSearchParams("analysisId=an-a&tab=findings");
    const navigate = renderNavigable();
    await waitFor(() =>
      expect(screen.getByTestId("findings-pager-range")).toHaveTextContent("of 105 findings"),
    );

    navigate("analysisId=an-b&tab=findings&severity=high");
    expect(
      await screen.findByText("Reconciliation manager lacks XDOCK support"),
    ).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith("an-b");
    expect(findingTitles()).toEqual([]);
    expect(screen.getByTestId("finding-filter-severity")).toHaveValue("high");
  });

  it("never renders the old run against the new URL", async () => {
    nav.search = new URLSearchParams("analysisId=an-a&tab=approvals");
    const navigate = renderNavigable();
    await waitFor(() => expect(approvalsRenders.some((r) => r.analysisId === "an-a")).toBe(true));
    navigate("analysisId=an-b&tab=approvals");
    await waitFor(() => expect(approvalsRenders.some((r) => r.analysisId === "an-b")).toBe(true));
    expect(approvalsRenders.filter((r) => r.urlRun === "an-b" && r.analysisId !== "an-b")).toEqual(
      [],
    );
  });

  it("returns the requirements to page 1 on a run switch", async () => {
    nav.search = new URLSearchParams("analysisId=an-a&tab=requirements");
    const navigate = renderNavigable();
    await screen.findByText("Requirement 0");
    await userEvent.click(
      within(screen.getByTestId("requirements-pager")).getByRole("button", { name: "Next" }),
    );
    expect(screen.getByText("Requirement 5")).toBeInTheDocument();

    // Run B with run A's twelve requirements, so only the page can differ.
    apiMock.get.mockImplementation(async (id: string) => ({ ...manyFindings(), id }));
    navigate("analysisId=an-b&tab=requirements");
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("an-b"));
    expect(await screen.findByText("Requirement 0")).toBeInTheDocument();
    expect(screen.queryByText("Requirement 5")).not.toBeInTheDocument();
  });

  it("drops run A's coverage filter on a run switch (PR #496 review)", async () => {
    nav.search = new URLSearchParams("analysisId=an-a&tab=requirements");
    const navigate = renderNavigable();
    await screen.findByText("Requirement 0");
    // No fixture requirement carries coverage, so "No evidence" hides them all.
    await userEvent.click(screen.getByTestId("coverage-filter-no_evidence"));
    expect(screen.queryByText("Requirement 0")).not.toBeInTheDocument();

    apiMock.get.mockImplementation(async (id: string) => ({ ...manyFindings(), id }));
    navigate("analysisId=an-b&tab=requirements");
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("an-b"));
    // A filter carried over from run A would hide run B's requirements.
    expect(await screen.findByText("Requirement 0")).toBeInTheDocument();
    expect(screen.getByTestId("coverage-filter-all")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the shown run for an id that is not in this project's list", async () => {
    nav.search = new URLSearchParams("analysisId=an-a&tab=findings");
    const navigate = renderNavigable();
    await waitFor(() =>
      expect(screen.getByTestId("findings-pager-range")).toHaveTextContent("of 105 findings"),
    );
    navigate("analysisId=an-foreign&tab=findings");
    expect(screen.getByTestId("findings-pager-range")).toHaveTextContent("of 105 findings");
    expect(apiMock.get).not.toHaveBeenCalledWith("an-foreign");
  });

  it("keeps a picked run while the router has yet to deliver its write", async () => {
    nav.search = new URLSearchParams("analysisId=an-a&tab=findings");
    const navigate = renderNavigable();
    let echo: string | null = null;
    nav.replace.mockImplementation((href: string) => {
      echo = href.split("?")[1] ?? "";
    });
    await waitFor(() =>
      expect(screen.getByTestId("findings-pager-range")).toHaveTextContent("of 105 findings"),
    );
    await userEvent.click(screen.getByRole("button", { name: /an-b/ }));
    expect(
      await screen.findByText("Reconciliation manager lacks XDOCK support"),
    ).toBeInTheDocument();

    // A re-render still carrying the old URL must not send the reader back.
    navigate("analysisId=an-a&tab=findings");
    expect(screen.getByText("Reconciliation manager lacks XDOCK support")).toBeInTheDocument();
    const writes = nav.replace.mock.calls.length;
    navigate(echo!);
    expect(screen.getByText("Reconciliation manager lacks XDOCK support")).toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledTimes(writes);
  });
});

// Issue #424 — `?requirementId=` (the promote dialog's link) opens the page holding it.
describe("the requirement deep link", () => {
  beforeEach(() => {
    apiMock.get.mockResolvedValue(manyFindings());
  });

  it("opens the page holding the requirement and scrolls to it", async () => {
    nav.search = new URLSearchParams("analysisId=an-1&tab=requirements&requirementId=req-7");
    renderPage();
    const title = await screen.findByText("Requirement 7");
    expect(screen.queryByText("Requirement 0")).not.toBeInTheDocument();
    expect(screen.getByTestId("requirements-pager")).toHaveTextContent("Page 2 of 3");
    const card = document.getElementById("requirement-req-7");
    expect(card).toContainElement(title);
    expect(card).toHaveAttribute("data-deep-linked", "true");
    await waitFor(() => expect(scrolled).toEqual([card]));
  });

  it("opens the Requirements tab for a link with no ?tab=", async () => {
    nav.search = new URLSearchParams("requirementId=req-11");
    renderPage();
    expect(await screen.findByText("Requirement 11")).toBeInTheDocument();
    expect(screen.getByTestId("requirements-pager")).toHaveTextContent("Page 3 of 3");
    await waitFor(() => expect(scrolled).toEqual([document.getElementById("requirement-req-11")]));
  });

  it("leaves page 1 alone when the run does not hold the requirement", async () => {
    nav.search = new URLSearchParams("tab=requirements&requirementId=req-elsewhere");
    renderPage();
    expect(await screen.findByText("Requirement 0")).toBeInTheDocument();
    expect(screen.getByTestId("requirements-pager")).toHaveTextContent("Page 1 of 3");
    expect(scrolled).toEqual([]);
  });

  it("does not pull the reader back once they page away", async () => {
    nav.search = new URLSearchParams("tab=requirements&requirementId=req-7");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: TEST_USER, queryClient }) });
    await screen.findByText("Requirement 7");
    await userEvent.click(
      within(screen.getByTestId("requirements-pager")).getByRole("button", { name: "Previous" }),
    );
    expect(screen.getByText("Requirement 0")).toBeInTheDocument();
    // A refetch of the run (a socket event, #240) that brings changed data — a
    // requirement edited elsewhere — must not re-apply the link.
    const changed = manyFindings();
    changed.requirements[0] = { ...changed.requirements[0], title: "Requirement 0 (edited)" };
    apiMock.get.mockResolvedValue(changed);
    await queryClient.invalidateQueries();
    expect(await screen.findByText("Requirement 0 (edited)")).toBeInTheDocument();
    expect(screen.queryByText("Requirement 7")).not.toBeInTheDocument();
  });

  // PR #470 review: a promote appends the requirement to a run whose detail is
  // usually still cached. The cached snapshot, which lacks it, must not use up
  // the link before the refetch that brings it lands.
  it("follows the link once a refetch brings the requirement a cached run lacked", async () => {
    nav.search = new URLSearchParams("tab=requirements&requirementId=req-11");
    const beforePromote = manyFindings();
    beforePromote.requirements = beforePromote.requirements.slice(0, 11);
    apiMock.get.mockResolvedValue(beforePromote);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: TEST_USER, queryClient }) });
    expect(await screen.findByText("Requirement 0")).toBeInTheDocument();
    expect(screen.getByTestId("requirements-pager")).toHaveTextContent("Page 1 of 3");
    apiMock.get.mockResolvedValue(manyFindings());
    await queryClient.invalidateQueries();
    expect(await screen.findByText("Requirement 11")).toBeInTheDocument();
    expect(screen.getByTestId("requirements-pager")).toHaveTextContent("Page 3 of 3");
    await waitFor(() => expect(scrolled).toEqual([document.getElementById("requirement-req-11")]));
  });
});

// Issue #424 — Traceability says why it is empty while a run is in progress.
describe("the Traceability tab before a run completes", () => {
  it("shows an empty state while the run is in progress", async () => {
    apiMock.get.mockResolvedValue({ ...SNAPSHOT, status: "running", completedAt: null });
    nav.search = new URLSearchParams("tab=traceability");
    renderPage();
    expect(await screen.findByTestId("traceability-pending")).toHaveTextContent(
      /when the run completes/,
    );
  });

  it.each(["failed", "cancelled"])("says a %s run has no traceability", async (status) => {
    apiMock.get.mockResolvedValue({ ...SNAPSHOT, status, completedAt: null });
    nav.search = new URLSearchParams("tab=traceability");
    renderPage();
    expect(await screen.findByTestId("traceability-pending")).toHaveTextContent(/did not complete/);
  });

  it("shows no empty state once the run completed", async () => {
    nav.search = new URLSearchParams("tab=traceability");
    renderPage();
    await screen.findByRole("tab", { name: /Traceability/, selected: true });
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    await screen.findByTestId("analysis-result-tabs");
    expect(screen.queryByTestId("traceability-pending")).not.toBeInTheDocument();
  });
});
