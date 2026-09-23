/**
 * #29 (epic #26) — <ProjectPipelineOverview>: the project Overview's stage
 * status, the first-run checklist, and live-status plumbing.
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

describe("first-run checklist", () => {
  it("shows a numbered five-step checklist on a brand-new project", async () => {
    renderOverview();
    const list = await screen.findByTestId("first-run-checklist");
    expect(within(list).getByRole("heading", { name: "Get started" })).toBeInTheDocument();
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("h3")?.textContent)).toEqual([
      "1.Connect sources",
      "2.Ingest",
      "3.Analyze",
      "4.Review requirements",
      "5.Publish",
    ]);
    expect(list.querySelector("ol")).not.toBeNull();
    expect(screen.queryByTestId("pipeline-stage-sources")).toBeNull();
  });

  it("deep-links every step to where it is done", async () => {
    renderOverview();
    await screen.findByTestId("first-run-checklist");
    const href = (id: string) => screen.getByTestId(`pipeline-action-${id}`).getAttribute("href");
    expect(href("sources")).toBe("/projects/p1/connections");
    expect(href("ingest")).toBe("/projects/p1/connections");
    expect(href("analyze")).toBe("/projects/p1/analysis");
    expect(href("review")).toBe("/projects/p1/requirements");
    expect(href("publish")).toBe("/projects/p1/publish");
    expect(screen.getByTestId("pipeline-action-sources")).toHaveTextContent("Connect a source");
  });

  it("contains no settings inputs", async () => {
    const { container } = renderOverview();
    await screen.findByTestId("first-run-checklist");
    expect(container.querySelector("input, select, textarea")).toBeNull();
  });
});

describe("stage grid", () => {
  it("replaces the checklist once an analysis exists, with every stage and its action", async () => {
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
    expect(screen.queryByTestId("first-run-checklist")).toBeNull();
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
    expect(screen.getByTestId("first-run-checklist")).toBeInTheDocument();
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
    await screen.findByTestId("first-run-checklist");
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
    await screen.findByTestId("first-run-checklist");
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
