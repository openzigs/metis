/**
 * Review of #63 — the Overview's Ingest stage driven by the REAL
 * `useConnectorProgress` hook, fed the event shapes the server actually emits
 * on `connector:progress`.
 *
 * `pipeline-overview.test.tsx` mocks that hook, which is why it could not see
 * that the hook never clears a count-less event: connection tests
 * (`repo-service.ts`, phase `test`), metadata fetches (phase `metadata`) and
 * database introspection (`db-service.ts`, phase `introspect`) carry no
 * `current`/`total`, so their entries stay in the map for good. The stage used
 * to read any entry as an ingest and stayed on "Ingesting…" forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

type Handler = (data: unknown) => void;
const handlers = new Map<string, Handler>();
const socket = {
  connected: true,
  emit: vi.fn(),
  on: vi.fn((event: string, fn: Handler) => handlers.set(event, fn)),
  off: vi.fn((event: string) => handlers.delete(event)),
};
vi.mock("@/lib/socket-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/socket-client")>()),
  useSocket: () => socket,
}));
vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { list: vi.fn(async () => [{ status: "connected", lastIngestAt: null }]) },
  dbConnectorsApi: { list: vi.fn(async () => []) },
}));
vi.mock("@/lib/projects-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/projects-api")>()),
  documentsApi: { list: vi.fn(async () => ({ items: [], total: 0, limit: 100, offset: 0 })) },
}));
vi.mock("@/lib/analysis-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/analysis-api")>()),
  analysisApi: { listForProject: vi.fn(async () => ({ items: [] })), get: vi.fn() },
}));
vi.mock("@/lib/publishing-api", () => ({
  publishingApi: { listBatches: vi.fn(async () => []) },
}));
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  apiFetch: vi.fn(async () => []),
}));
vi.mock("@/hooks/use-job-events", () => ({ useProjectJobEvents: vi.fn() }));
vi.mock("@/lib/auth-context", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-context")>()),
  useAuth: () => ({ user: { id: "u1", permissions: ["issue.preview"] } }),
}));

import { ProjectPipelineOverview } from "@/components/projects/pipeline-overview";
import { __resetActiveJobsForTests, applyJobLifecycleEvent } from "@/hooks/use-active-jobs";
import { repoConnectorsApi } from "@/lib/connectors-api";

function renderOverview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ProjectPipelineOverview projectId="p1" />, { wrapper: Wrapper });
}

/** Deliver one `connector:progress` event, as `socket-emitter.ts` shapes it. */
function emit(event: Record<string, unknown>) {
  const fn = handlers.get("connector:progress");
  if (!fn) throw new Error("the overview is not listening for connector:progress");
  act(() => fn({ connectorId: "c1", projectId: "p1", kind: "repo", ts: Date.now(), ...event }));
}

const ingestStatus = () => screen.getByTestId("pipeline-status-ingest").textContent ?? "";

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  __resetActiveJobsForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Ingest stage with the real useConnectorProgress", () => {
  it.each([
    ["a repository connection test", { phase: "test", step: "repo.get" }],
    ["a repository metadata fetch", { phase: "metadata", step: "tree" }],
    ["a database introspection", { phase: "introspect", step: "schema", kind: "db" }],
  ])("is not left ingesting by %s", async (_label, event) => {
    renderOverview();
    await screen.findByTestId("pipeline-status-ingest");
    emit(event);
    expect(ingestStatus()).not.toMatch(/Ingesting/);
    expect(ingestStatus()).toBe("Nothing ingested yet");
  });

  it("stays out of 'Ingesting' ten minutes after a connection test", async () => {
    renderOverview();
    await screen.findByTestId("pipeline-status-ingest");
    vi.useFakeTimers();
    emit({ phase: "test", step: "repo.get" });
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(ingestStatus()).not.toMatch(/Ingesting/);
  });

  it("shows a deep ingest while it runs and clears once it reaches its total", async () => {
    renderOverview();
    await screen.findByTestId("pipeline-status-ingest");
    vi.useFakeTimers();
    emit({ phase: "deep-ingest", step: "clone", current: 1, total: 5 });
    expect(ingestStatus()).toBe("Ingesting…");
    emit({ phase: "deep-ingest", step: "done", current: 5, total: 5 });
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(ingestStatus()).not.toMatch(/Ingesting/);
  });

  it("shows a file ingest while it runs", async () => {
    renderOverview();
    await screen.findByTestId("pipeline-status-ingest");
    emit({ phase: "ingest", step: "src/a.ts", current: 1, total: 40 });
    expect(ingestStatus()).toBe("Ingesting…");
  });
});

/**
 * #273 — the New-project wizard starts a Deep Ingest and navigates here. The
 * job's `started` event went out before this browser joined the project room, so
 * the Overview reads the job from the shared active-jobs store, and asks for the
 * job's last transition (`subscribe:job` replays it) in case it already ended.
 */
describe("Ingest stage with a repo-ingest job started elsewhere (#273)", () => {
  const started = (projectId = "p1") =>
    applyJobLifecycleEvent({
      kind: "repo-ingest",
      jobId: "job-1",
      projectId,
      status: "started",
      ts: 1,
    });

  function lifecycle(status: "progress" | "completed" | "failed") {
    const fn = handlers.get("job:lifecycle");
    if (!fn) throw new Error("the overview is not listening for job:lifecycle");
    act(() => fn({ kind: "repo-ingest", jobId: "job-1", projectId: "p1", status, ts: 2 }));
  }

  it("reads 'Ingesting…' on arrival, before any socket event", async () => {
    started();
    renderOverview();
    await screen.findByTestId("pipeline-status-ingest");
    expect(ingestStatus()).toBe("Ingesting…");
    expect(socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" });
  });

  it("clears, and re-reads what the ingest wrote, when the job's end is replayed", async () => {
    started();
    renderOverview();
    await screen.findByTestId("pipeline-status-ingest");
    const reposList = vi.mocked(repoConnectorsApi.list);
    const before = reposList.mock.calls.length;
    lifecycle("completed");
    expect(ingestStatus()).toBe("Nothing ingested yet");
    await vi.waitFor(() => expect(reposList.mock.calls.length).toBeGreaterThan(before));
  });

  it("ignores a repo ingest running in another project", async () => {
    started("p2");
    renderOverview();
    await screen.findByTestId("pipeline-status-ingest");
    expect(ingestStatus()).toBe("Nothing ingested yet");
    expect(socket.emit).not.toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" });
  });
});
