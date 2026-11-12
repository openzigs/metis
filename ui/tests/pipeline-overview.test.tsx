/**
 * #29 (epic #26) — <ProjectPipelineOverview>: the project Overview's stage
 * status, the project checklist (#2349), and live-status plumbing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useParams: () => ({ id: "p1" }),
  usePathname: () => "/projects/p1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { list: vi.fn() },
  dbConnectorsApi: { list: vi.fn() },
}));
vi.mock("@/lib/projects-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/projects-api")>()),
  documentsApi: { list: vi.fn() },
}));
vi.mock("@/lib/analysis-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/analysis-api")>()),
  analysisApi: { listForProject: vi.fn(), get: vi.fn() },
}));
vi.mock("@/lib/publishing-api", () => ({ publishingApi: { listBatches: vi.fn() } }));
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  apiFetch: vi.fn(),
}));
vi.mock("@/hooks/use-job-events", () => ({ useProjectJobEvents: vi.fn() }));
vi.mock("@/hooks/use-connector-events", () => ({ useConnectorProgress: vi.fn() }));
let permissions: string[] = ["issue.preview"];
vi.mock("@/lib/auth-context", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-context")>()),
  useAuth: () => ({ user: { id: "u1", permissions } }),
}));

import { ProjectPipelineOverview } from "@/components/projects/pipeline-overview";
import { repoConnectorsApi, dbConnectorsApi } from "@/lib/connectors-api";
import { documentsApi } from "@/lib/projects-api";
import { analysisApi } from "@/lib/analysis-api";
import { publishingApi } from "@/lib/publishing-api";
import { apiFetch } from "@/lib/api-client";
import { useProjectJobEvents } from "@/hooks/use-job-events";
import { useConnectorProgress } from "@/hooks/use-connector-events";
import ChangeAnalysisPage from "@/app/(authed)/projects/[id]/changes/page";
import { getProjectTabModel, resolveActiveProjectTab } from "@/components/projects/project-tabs";

const repos = vi.mocked(repoConnectorsApi.list);
const dbs = vi.mocked(dbConnectorsApi.list);
const docsList = vi.mocked(documentsApi.list);
const listAnalyses = vi.mocked(analysisApi.listForProject);
const getAnalysis = vi.mocked(analysisApi.get);
const batches = vi.mocked(publishingApi.listBatches);
const fetchMock = vi.mocked(apiFetch);
const progress = vi.mocked(useConnectorProgress);

type Progress = ReturnType<typeof useConnectorProgress>;
function setProgress(map: Record<string, unknown>) {
  progress.mockReturnValue({ progressMap: map, clearProgress: vi.fn() } as unknown as Progress);
}

let generatedDocs: Array<{ status: string }> = [];

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function renderOverview(qc = client()) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...render(<ProjectPipelineOverview projectId="p1" />, { wrapper: Wrapper }) };
}

const COMPLETED = {
  id: "a1",
  projectId: "p1",
  startedById: "u1",
  status: "completed" as const,
  startedAt: "2026-09-01T10:00:00Z",
  completedAt: "2026-09-01T10:05:00Z",
  totalTokens: 0,
  errorMessage: null,
  requirementCounts: { draft: 0, approved: 0, rejected: 0, deferred: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  setProgress({});
  permissions = ["issue.preview"];
  generatedDocs = [];
  repos.mockResolvedValue([]);
  dbs.mockResolvedValue([]);
  docsList.mockResolvedValue({ items: [], total: 0, limit: 25, offset: 0 });
  listAnalyses.mockResolvedValue({ items: [] });
  batches.mockResolvedValue([]);
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/projects/p1/docs") return generatedDocs;
    if (url === "/projects/p1/analyses") return { items: [COMPLETED] };
    return [];
  });
});

/** The name the project tab bar gives the tab a path belongs to. */
const tabLabel = (path: string) =>
  resolveActiveProjectTab(path, getProjectTabModel("p1"))?.section.label;

describe("the checklist (#2349)", () => {
  it("numbers the five steps of the analyst's job, with Publish optional", async () => {
    renderOverview();
    const list = await screen.findByTestId("project-checklist");
    expect(within(list).getByRole("heading", { name: "Get started" })).toBeInTheDocument();
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("h3")?.textContent)).toEqual([
      "1.Add knowledge",
      "2.Ready: ask a question",
      "3.New change request",
      "4.Review",
      "5.Deliverable",
      "Publish (optional)",
    ]);
    expect(list.querySelector("ol")).not.toBeNull();
    expect(screen.getByTestId("checklist-progress")).toHaveTextContent(
      "0 of 5 steps done. Publishing is optional.",
    );
  });

  it("deep-links every step to where it is done", async () => {
    renderOverview();
    await screen.findByTestId("project-checklist");
    const href = (id: string) => screen.getByTestId(`pipeline-action-${id}`).getAttribute("href");
    expect(href("sources")).toBe("/projects/p1/connections");
    expect(href("ingest")).toBe("/projects/p1/connections");
    expect(href("analyze")).toBe("/projects/p1/analysis");
    expect(href("review")).toBe("/projects/p1/requirements");
    expect(href("docs")).toBe("/projects/p1/documentation");
    expect(href("publish")).toBe("/projects/p1/publish");
    expect(screen.getByTestId("pipeline-action-sources")).toHaveTextContent("Add knowledge");
    expect(screen.getByTestId("pipeline-action-analyze")).toHaveTextContent("New change request");
  });

  it("names the project tab each step opens, as the tab bar names it", async () => {
    renderOverview();
    await screen.findByTestId("project-checklist");
    const tab = (id: string) => screen.getByTestId(`pipeline-tab-${id}`).textContent;
    expect(tab("sources")).toBe(`in ${tabLabel("/projects/p1/connections")}`);
    expect(tab("analyze")).toBe(`in ${tabLabel("/projects/p1/analysis")}`);
    expect(tab("review")).toBe("in Requirements");
    expect(tab("docs")).toBe(`in ${tabLabel("/projects/p1/documentation")}`);
    expect(tab("publish")).toBe(`in ${tabLabel("/projects/p1/publish")}`);
  });

  it("contains no settings inputs", async () => {
    const { container } = renderOverview();
    await screen.findByTestId("project-checklist");
    expect(container.querySelector("input, select, textarea")).toBeNull();
  });

  it("reads complete with every required step done and nothing published", async () => {
    listAnalyses.mockResolvedValue({ items: [COMPLETED] });
    getAnalysis.mockResolvedValue({ requirements: [{ reviewStatus: "approved" }] } as never);
    docsList.mockResolvedValue({
      items: [{ status: "ready", chunkCount: 4 } as never],
      total: 1,
      limit: 100,
      offset: 0,
    });
    generatedDocs = [{ status: "ready" }];
    renderOverview();
    const list = await screen.findByTestId("project-checklist");
    await waitFor(() =>
      expect(within(list).getByRole("heading", { level: 2 })).toHaveTextContent("Every step done"),
    );
    expect(screen.getByTestId("checklist-progress")).toHaveTextContent("5 of 5 steps done");
    expect(screen.getByTestId("pipeline-status-publish")).toHaveTextContent(
      "Nothing published yet",
    );
    // Ready → ask the question on this page's knowledge search.
    expect(screen.getByTestId("pipeline-action-ingest")).toHaveAttribute(
      "href",
      "/projects/p1#knowledge-search",
    );
    expect(screen.getByTestId("pipeline-tab-ingest")).toHaveTextContent("in Overview");
  });
});

describe("checklist steps", () => {
  it("keeps every step and its action once an analysis exists", async () => {
    listAnalyses.mockResolvedValue({ items: [COMPLETED] });
    getAnalysis.mockResolvedValue({
      requirements: [
        { reviewStatus: "draft" },
        { reviewStatus: "draft" },
        { reviewStatus: "approved" },
        { reviewStatus: "rejected" },
        { reviewStatus: "deferred" },
      ],
    } as never);
    renderOverview();
    await screen.findByTestId("pipeline-stage-analyze");
    for (const id of ["sources", "ingest", "analyze", "review", "docs", "publish"]) {
      expect(screen.getByTestId(`pipeline-stage-${id}`)).toBeInTheDocument();
    }
    await waitFor(() =>
      expect(screen.getByTestId("pipeline-action-review")).toHaveTextContent(
        "Review 2 requirements",
      ),
    );
    expect(screen.getByTestId("pipeline-action-review")).toHaveAttribute(
      "href",
      "/projects/p1/analysis?analysisId=a1",
    );
    expect(getAnalysis).toHaveBeenCalledWith("a1");
    expect(screen.getByTestId("pipeline-status-review")).toHaveTextContent(
      "2 requirements awaiting review",
    );
    // The state is announced, not only colour-coded.
    expect(screen.getByTestId("pipeline-stage-review")).toHaveTextContent("Needs attention:");
  });

  // #66 — observed after #63 merged: three generated docs held in quarantine
  // left the Ingest card on "Ingesting — at least 3 documents processing".
  it("shows quarantined generated docs as awaiting review, not ingesting", async () => {
    listAnalyses.mockResolvedValue({ items: [COMPLETED] });
    getAnalysis.mockResolvedValue({ requirements: [] } as never);
    const doc = (id: string, chunkCount: number) =>
      ({
        id,
        projectId: "p1",
        filename: `generated-doc-${id}.md`,
        source: "generated",
        mimeType: "text/markdown",
        sizeBytes: 10,
        status: "processing",
        indexState: "quarantined",
        chunkCount,
        uploadedAt: "2026-09-22T10:00:00Z",
        processedAt: "2026-09-22T10:00:00Z",
      }) as const;
    docsList.mockResolvedValue({
      items: [doc("d1", 26), doc("d2", 58), doc("d3", 1)],
      total: 3,
      limit: 100,
      offset: 0,
    });
    renderOverview();

    const ingest = await screen.findByTestId("pipeline-stage-ingest");
    expect(ingest).not.toHaveTextContent(/ingesting|processing/i);
    expect(ingest).not.toHaveTextContent("In progress:");
    expect(screen.getByTestId("pipeline-status-ingest")).toHaveTextContent(
      "3 documents awaiting review",
    );
    await waitFor(() =>
      expect(screen.getByTestId("pipeline-status-review")).toHaveTextContent(
        "3 documents awaiting review in quarantine",
      ),
    );
    expect(screen.getByTestId("pipeline-action-review")).toHaveAttribute(
      "href",
      "/projects/p1/settings#quarantine",
    );
    expect(screen.getByTestId("pipeline-secondary-action-review")).toHaveAttribute(
      "href",
      "/projects/p1/requirements",
    );
  });

  it("polls the document list only while a document is really ingesting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = (indexState: string) => ({
        id: indexState,
        projectId: "p1",
        filename: "a.md",
        source: "upload" as const,
        mimeType: "text/markdown",
        sizeBytes: 1,
        status: "processing" as const,
        indexState,
        chunkCount: 1,
        uploadedAt: "2026-09-22T10:00:00Z",
      });
      docsList.mockResolvedValue({ items: [row("quarantined")], total: 1, limit: 100, offset: 0 });
      const quarantined = renderOverview();
      await screen.findByTestId("project-pipeline");
      await act(() => vi.advanceTimersByTimeAsync(16_000));
      expect(docsList).toHaveBeenCalledTimes(1);
      quarantined.unmount();

      docsList.mockClear();
      docsList.mockResolvedValue({ items: [row("pending")], total: 1, limit: 100, offset: 0 });
      renderOverview();
      await screen.findByTestId("project-pipeline");
      await act(() => vi.advanceTimersByTimeAsync(16_000));
      expect(docsList.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#867 — reads a generation that is being cancelled as still running, and keeps polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      listAnalyses.mockResolvedValue({ items: [COMPLETED] });
      getAnalysis.mockResolvedValue({ requirements: [] } as never);
      generatedDocs = [{ status: "cancelling" }];
      renderOverview();
      expect(await screen.findByTestId("pipeline-status-docs")).toHaveTextContent(
        "Generating 1 document",
      );
      const docsReads = () =>
        fetchMock.mock.calls.filter(([url]) => url === "/projects/p1/docs").length;
      const before = docsReads();
      await act(() => vi.advanceTimersByTimeAsync(16_000));
      expect(docsReads()).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("links the code summary as 'Code Overview'", async () => {
    renderOverview();
    const link = await screen.findByTestId("pipeline-code-overview-link");
    expect(link).toHaveAttribute("href", "/projects/p1/overview");
    expect(link).toHaveTextContent("Code Overview");
  });

  it("reports generated docs from the docs endpoint", async () => {
    listAnalyses.mockResolvedValue({ items: [COMPLETED] });
    getAnalysis.mockResolvedValue({ requirements: [] } as never);
    generatedDocs = [{ status: "generating" }];
    renderOverview();
    expect(await screen.findByTestId("pipeline-status-docs")).toHaveTextContent(
      "Generating 1 document",
    );
    expect(fetchMock).toHaveBeenCalledWith("/projects/p1/docs");
  });

  it("warns, rather than failing, when one stage cannot be loaded", async () => {
    batches.mockRejectedValue(new Error("boom"));
    renderOverview();
    expect(await screen.findByTestId("pipeline-partial")).toHaveTextContent(/could not be loaded/);
    expect(screen.getByTestId("project-checklist")).toBeInTheDocument();
  });

  // Review of #63 — `reader` lacks `issue.preview`; the batches request used to
  // 403 on every visit, raising the partial-load alert and a false "Nothing
  // published yet".
  it("does not request publish history a reader may not read", async () => {
    permissions = [];
    batches.mockRejectedValue(new Error("403"));
    renderOverview();
    expect(await screen.findByTestId("pipeline-status-publish")).toHaveTextContent(
      "Publish history is not available to your role",
    );
    expect(batches).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pipeline-partial")).toBeNull();
  });

  it("reads the newest full page of documents, so counts are not capped at 25", async () => {
    renderOverview();
    await screen.findByTestId("project-checklist");
    expect(docsList).toHaveBeenCalledWith("p1", { limit: 100 });
  });

  it("shows a loading status first", () => {
    repos.mockReturnValue(new Promise(() => {}));
    renderOverview();
    expect(screen.getByRole("status")).toHaveTextContent("Loading project status");
  });
});

describe("live status", () => {
  it("subscribes to the project's job events", async () => {
    renderOverview();
    await screen.findByTestId("project-checklist");
    expect(useProjectJobEvents).toHaveBeenCalledWith("p1");
    expect(useConnectorProgress).toHaveBeenCalledWith("p1");
  });

  it("shows a running ingest, then re-reads connectors and documents when it ends", async () => {
    setProgress({ c1: { connectorId: "c1", phase: "deep-ingest", step: "clone", ts: 1 } });
    const { rerender } = renderOverview();
    expect(await screen.findByTestId("pipeline-status-ingest")).toHaveTextContent("Ingesting");
    const reposBefore = repos.mock.calls.length;
    const docsBefore = docsList.mock.calls.length;

    repos.mockResolvedValue([
      { status: "connected", lastIngestAt: "2026-09-02T08:00:00Z" } as never,
    ]);
    setProgress({});
    await act(async () => {
      rerender(<ProjectPipelineOverview projectId="p1" />);
    });
    await waitFor(() => expect(repos.mock.calls.length).toBeGreaterThan(reposBefore));
    expect(docsList.mock.calls.length).toBeGreaterThan(docsBefore);
    await waitFor(() =>
      expect(screen.getByTestId("pipeline-status-ingest")).toHaveTextContent(
        /repository last ingested/,
      ),
    );
  });
});

// The Changes page reads the same `analyses.forProject` cache key. It used to
// store a bare array there while every other reader stores `{ items }`, so a
// visit to Changes left the Overview (and the Analysis page) reading
// `undefined.items` from a still-fresh cache and reporting "No analysis yet".
describe("shared analyses cache", () => {
  it("reads the analyses list correctly after the Changes page populated it", async () => {
    // The app's QueryClient serves a list for 30s without refetching
    // (lib/query-client.ts); mirror that so the cached shape is what renders.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const changes = render(<ChangeAnalysisPage />, { wrapper: Wrapper });
    await waitFor(() => expect(qc.getQueryData(["analyses", "project", "p1"])).toBeDefined());
    changes.unmount();

    listAnalyses.mockClear();
    getAnalysis.mockResolvedValue({ requirements: [] } as never);
    renderOverview(qc);
    // The fresh cache is served without a refetch — it must have the right shape.
    expect(await screen.findByTestId("pipeline-status-analyze")).toHaveTextContent(
      /Last analysis completed/,
    );
    expect(listAnalyses).not.toHaveBeenCalled();
  });
});
