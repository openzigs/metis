/**
 * Issue #2185 — two #1749 guards checked where they are wired, on the REAL
 * analysis page:
 *
 * - The review buttons get the review that just succeeded
 *   (`review.isSuccess ? review.variables : null`), so a requirement approved a
 *   moment ago reads Approved before it is read back. Passing `null` there
 *   reopened the double `PUT` and every component test still passed.
 * - The run summary's document count: a first page of the list drops the
 *   number (`listIsPartial`), and the connectors' repository and database rows,
 *   which a run with no selection does not read as documents, are not counted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
        id: "req-draft",
        title: "Export orders",
        type: "feature",
        body: "b",
        priority: "high",
        labels: [],
        storyPoints: null,
        evidenceFindingIds: [],
        acceptanceCriteria: [],
        sourceDivergence: null,
        reviewStatus: "draft",
        version: 1,
      },
    ],
    crossDocFindings: null,
    sourceRequirements: [],
  },
}));

const listForProject = vi.hoisted(() => vi.fn());
const getAnalysis = vi.hoisted(() => vi.fn());
const updateRequirement = vi.hoisted(() => vi.fn());
const listDocuments = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analysis-api", () => ({
  isCodeCitation: () => false,
  analysisApi: {
    listForProject,
    get: getAnalysis,
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
  documentsApi: { list: listDocuments },
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

vi.mock("@/components/traceability/traceability-view", () => ({
  traceabilityKey: (projectId: string, requirementId: string) =>
    ["traceability-chain", projectId, requirementId] as const,
  TraceabilityView: () => null,
}));
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

let doc = 0;
const docRow = (source: string, status = "ready") => ({
  id: `d-${++doc}`,
  projectId: "p1",
  filename: `${source}-${doc}.md`,
  source,
  mimeType: "text/markdown",
  sizeBytes: 1,
  status,
  chunkCount: 1,
  uploadedAt: new Date().toISOString(),
});

const card = (id: string): HTMLElement => {
  const el = document.getElementById(`requirement-${id}`);
  if (!el) throw new Error(`no requirement card for ${id}`);
  return el;
};

const open = () => {
  const user = userEvent.setup();
  render(<AnalysisPage />, { wrapper: makeWrapper({ initialUser: COORDINATOR }) });
  return user;
};

/** The requirement is read once; every read after that never answers (a slow refetch). */
let holdReads = false;

beforeEach(() => {
  vi.clearAllMocks();
  holdReads = false;
  listForProject.mockResolvedValue({
    items: [{ id: "an-1", status: "completed", startedAt: new Date().toISOString() }],
  });
  getAnalysis.mockImplementation(() =>
    holdReads ? new Promise(() => undefined) : Promise.resolve(COMPLETED),
  );
  updateRequirement.mockResolvedValue({ id: "req-draft", version: 1, updatedAt: "" });
  listDocuments.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
});

describe("Analysis page — a review that just succeeded counts (#1749, #2185)", () => {
  it("reads Approved as soon as the PUT succeeds, so a second click sends nothing", async () => {
    const user = open();
    await user.click(await screen.findByRole("tab", { name: /^Requirements/ }));
    await screen.findByText("Export orders");

    holdReads = true; // the read-back after the review has not answered yet
    await user.click(within(card("req-draft")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(updateRequirement).toHaveBeenCalledTimes(1));

    const approved = await within(card("req-draft")).findByRole("button", { name: "Approved" });
    expect(approved).toBeDisabled();
    expect(within(card("req-draft")).queryByRole("button", { name: "Reject" })).toBeNull();
    await user.click(approved);
    expect(updateRequirement).toHaveBeenCalledTimes(1);
  });
});

describe("Analysis page — the run summary's document count (#1749, #2185)", () => {
  const summary = () => screen.findByTestId("analysis-run-summary");
  // The start form is open on a project with no runs yet.
  beforeEach(() => listForProject.mockResolvedValue({ items: [] }));

  it("counts every ready document when the whole list is loaded", async () => {
    listDocuments.mockResolvedValue({
      items: [docRow("upload"), docRow("upload"), docRow("confluence")],
      total: 3,
      limit: 50,
      offset: 0,
      nextCursor: null,
    });
    open();
    await waitFor(async () =>
      expect(await summary()).toHaveTextContent("This run uses all 3 documents"),
    );
  });

  it("drops the number when the loaded list is only its first page", async () => {
    listDocuments.mockResolvedValue({
      items: [docRow("upload"), docRow("upload"), docRow("upload")],
      total: 120,
      limit: 3,
      offset: 0,
      nextCursor: "after-3",
    });
    open();
    await waitFor(async () =>
      expect(await summary()).toHaveTextContent("This run uses all the project's ready documents"),
    );
    expect(await summary()).not.toHaveTextContent(/\d+ documents/);
  });

  it("never says 'no documents' or all of them when a full first page holds only repository rows", async () => {
    listDocuments.mockResolvedValue({
      items: Array.from({ length: 25 }, () => docRow("repo")),
      total: 90,
      limit: 25,
      offset: 0,
      nextCursor: "after-25",
    });
    open();
    await waitFor(async () =>
      expect(await summary()).toHaveTextContent("not its repository or database rows"),
    );
    expect(await summary()).not.toHaveTextContent("no documents");
  });

  it("does not count the repository and database rows a run with no selection leaves out", async () => {
    listDocuments.mockResolvedValue({
      items: [
        docRow("upload"),
        docRow("generated"),
        docRow("repo"),
        docRow("repo"),
        docRow("db"),
        docRow("upload", "processing"),
      ],
      total: 6,
      limit: 50,
      offset: 0,
      nextCursor: null,
    });
    open();
    await waitFor(async () =>
      expect(await summary()).toHaveTextContent("This run uses all 2 documents"),
    );
  });

  it("#2555 — counts a quarantined document among them and says it is awaiting review", async () => {
    listDocuments.mockResolvedValue({
      items: [docRow("upload"), { ...docRow("upload"), indexState: "quarantined" }],
      total: 2,
      limit: 50,
      offset: 0,
      nextCursor: null,
    });
    open();
    await waitFor(async () =>
      expect(await summary()).toHaveTextContent(
        "This run uses all 2 documents (1 awaiting review)",
      ),
    );
  });
});
