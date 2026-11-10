import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { QueryClient } from "@tanstack/react-query";
import { makeWrapper } from "./test-utils";
import { __resetTerminalToastsForTests } from "@/lib/terminal-toast";
import AdminEmbeddingsPage from "@/app/(authed)/settings/embeddings/page";
import {
  embeddingsApi,
  type EmbeddingsStatus,
  type EmbeddingsCoverageReport,
} from "@/lib/embeddings-api";

vi.mock("@/lib/embeddings-api", () => ({
  embeddingsApi: {
    status: vi.fn(),
    coverage: vi.fn(),
    reindex: vi.fn(),
  },
}));

// ── sonner + socket mocks (Issue #423 async reindex) ─────────────────────────
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

type Handler = (data: unknown) => void;
function makeFakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    emit: vi.fn(),
    on: vi.fn((name: string, fn: Handler) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
    }),
    off: vi.fn((name: string, fn: Handler) => {
      handlers.get(name)?.delete(fn);
    }),
  };
  const fire = (name: string, data: unknown) => handlers.get(name)?.forEach((fn) => fn(data));
  return { socket, fire };
}
let fake = makeFakeSocket();
vi.mock("@/lib/socket-client", () => ({
  // AuthProvider closes the socket whenever the session ends (#1391).
  closeSocket: vi.fn(),
  useSocket: () => fake.socket,
}));

const statusMock = vi.mocked(embeddingsApi.status);
const coverageMock = vi.mocked(embeddingsApi.coverage);
const reindexMock = vi.mocked(embeddingsApi.reindex);
// `next/navigation` is mocked in tests/setup.ts; the router is one shared object.
const useSearchParamsMock = vi.mocked(useSearchParams);
const routerReplace = vi.mocked(useRouter)().replace as ReturnType<typeof vi.fn>;

/** Open the page at `/settings/embeddings?<query>`. */
function atQuery(query: string) {
  useSearchParamsMock.mockReturnValue(
    new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
  );
}

function makeStatus(over: Partial<EmbeddingsStatus> = {}): EmbeddingsStatus {
  return {
    active: {
      key: "xenova",
      model: "Xenova/bge-small-en-v1.5",
      dimension: 384,
      requiresEgress: false,
      healthy: true,
      error: null,
    },
    backends: [
      { key: "offline", label: "Offline hash", requiresEgress: false, offlineCapable: true },
      { key: "bedrock", label: "Bedrock gateway", requiresEgress: true, offlineCapable: false },
    ],
    ...over,
  };
}

function makeCoverage(over: Partial<EmbeddingsCoverageReport> = {}): EmbeddingsCoverageReport {
  return {
    totalChunks: 10,
    modelCounts: { "old-model": 10 },
    currentModel: "Xenova/bge-small-en-v1.5",
    currentDimension: 384,
    matchingChunks: 0,
    mismatchedModels: ["old-model"],
    needsReindex: true,
    ...over,
  };
}

const lifecycle = (over: Record<string, unknown>) => ({
  kind: "embeddings-reindex",
  jobId: "job-x",
  projectId: "proj_1",
  status: "started",
  ts: 1,
  ...over,
});

beforeEach(() => {
  fake = makeFakeSocket();
  // #425 — reset the module-level terminal-toast dedup so the success test's
  // `job-x` does not suppress the failure test's toast (both reuse the id).
  __resetTerminalToastsForTests();
  vi.clearAllMocks();
});

describe("AdminEmbeddingsPage", () => {
  it("renders the active backend with a healthy badge and the registry", async () => {
    statusMock.mockResolvedValue(makeStatus());

    render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByTestId("active-key")).toHaveTextContent("xenova"));
    expect(screen.getByTestId("health-badge")).toHaveTextContent("Healthy");
    expect(screen.getByText("Xenova/bge-small-en-v1.5")).toBeInTheDocument();
    expect(screen.getByText("384")).toBeInTheDocument();
    expect(screen.getByText("Offline hash")).toBeInTheDocument();
    expect(screen.getByText("Bedrock gateway")).toBeInTheDocument();
  });

  it("shows an unhealthy badge and the error message", async () => {
    statusMock.mockResolvedValue(
      makeStatus({
        active: {
          key: "bedrock",
          model: "titan",
          dimension: 1024,
          requiresEgress: true,
          healthy: false,
          error: "gateway unreachable",
        },
      }),
    );

    render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByTestId("health-badge")).toHaveTextContent("Unhealthy"));
    expect(screen.getByTestId("health-error")).toHaveTextContent("gateway unreachable");
  });

  it("enqueues an async reindex, shows live progress, then the terminal result + success toast", async () => {
    statusMock.mockResolvedValue(makeStatus());
    coverageMock.mockResolvedValue(makeCoverage());
    reindexMock.mockResolvedValue({ jobId: "job-x", projectId: "proj_1", status: "started" });

    render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(statusMock).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId("project-id-input"), { target: { value: "proj_1" } });
    fireEvent.click(screen.getByRole("button", { name: /check coverage/i }));

    await waitFor(() => expect(coverageMock).toHaveBeenCalledWith("proj_1"));
    await waitFor(() => expect(screen.getByTestId("needs-reindex")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("reindex-button"));
    await waitFor(() => expect(reindexMock).toHaveBeenCalledWith("proj_1"));

    // Page subscribes to the enqueued job and shows a live progress bar.
    await waitFor(() =>
      expect(fake.socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-x" }),
    );
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({ status: "progress", progress: 50, message: "Re-embedded 5/10 chunks" }),
      ),
    );
    expect(screen.getByTestId("reindex-progress")).toBeInTheDocument();
    expect(screen.getByTestId("reindex-progress-message")).toHaveTextContent(
      "Re-embedded 5/10 chunks",
    );

    // Terminal completion → success toast (verbatim message) + persistent result line.
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({
          status: "completed",
          progress: 100,
          message: "Reindexed 10 of 10 chunks to Xenova/bge-small-en-v1.5 (384d).",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("reindex-result")).toHaveTextContent("Reindexed 10 of 10 chunks"),
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      "Reindexed 10 of 10 chunks to Xenova/bge-small-en-v1.5 (384d).",
    );
    // Progress bar clears once the job is terminal.
    expect(screen.queryByTestId("reindex-progress")).not.toBeInTheDocument();
  });

  it("fires an error toast (no raw leak) when the reindex job fails", async () => {
    statusMock.mockResolvedValue(makeStatus());
    coverageMock.mockResolvedValue(makeCoverage());
    reindexMock.mockResolvedValue({ jobId: "job-x", projectId: "proj_1", status: "started" });

    render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(statusMock).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId("project-id-input"), { target: { value: "proj_1" } });
    fireEvent.click(screen.getByRole("button", { name: /check coverage/i }));
    await waitFor(() => expect(screen.getByTestId("needs-reindex")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("reindex-button"));
    await waitFor(() =>
      expect(fake.socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-x" }),
    );
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({ status: "failed", error: "The embeddings reindex failed. Please try again." }),
      ),
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The embeddings reindex failed. Please try again."),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId("reindex-result")).not.toBeInTheDocument();
  });

  // #1579 — a reload mid-reindex showed "Up to date" with a live Reindex button
  // while the server said `shadow.inProgress`, and never followed the run.
  describe("a reindex already running when the page loads (#1579)", () => {
    const running = (jobId: string | null) =>
      makeCoverage({
        matchingChunks: 10,
        mismatchedModels: [],
        needsReindex: false,
        shadow: { inProgress: true, shadowChunks: 4, resumable: true, jobId },
      });

    afterEach(() => {
      useSearchParamsMock.mockImplementation(
        () => new URLSearchParams() as ReturnType<typeof useSearchParams>,
      );
    });

    it("re-checks the project named in the URL, so a reload keeps it", async () => {
      atQuery("projectId=proj_url");
      statusMock.mockResolvedValue(makeStatus());
      coverageMock.mockResolvedValue(makeCoverage());

      render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });

      await waitFor(() => expect(coverageMock).toHaveBeenCalledWith("proj_url"));
      expect(screen.getByTestId("project-id-input")).toHaveValue("proj_url");
    });

    // #2196 — through the router and as `projectId`, like the other settings pages.
    it("puts the checked project in the URL through the router, keeping other params", async () => {
      atQuery("tab=coverage");
      statusMock.mockResolvedValue(makeStatus());
      coverageMock.mockResolvedValue(makeCoverage());

      render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
      fireEvent.change(screen.getByTestId("project-id-input"), { target: { value: " proj_9 " } });
      fireEvent.click(screen.getByRole("button", { name: /check coverage/i }));

      await waitFor(() => expect(coverageMock).toHaveBeenCalledWith("proj_9"));
      expect(routerReplace).toHaveBeenCalledWith(
        "/settings/embeddings?tab=coverage&projectId=proj_9",
      );
    });

    it("does not read the old `project` param", async () => {
      atQuery("project=proj_old");
      statusMock.mockResolvedValue(makeStatus());
      coverageMock.mockResolvedValue(makeCoverage());

      render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
      await waitFor(() => expect(statusMock).toHaveBeenCalled());

      expect(screen.getByTestId("project-id-input")).toHaveValue("");
      expect(coverageMock).not.toHaveBeenCalled();
    });

    it("follows the running job's progress and offers no second reindex", async () => {
      atQuery("projectId=proj_1");
      statusMock.mockResolvedValue(makeStatus());
      coverageMock.mockResolvedValue(running("job-x"));

      render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });

      await waitFor(() =>
        expect(fake.socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-x" }),
      );
      expect(screen.getByTestId("reindex-in-progress")).toHaveTextContent("Reindex in progress");
      expect(screen.queryByTestId("coverage-ok")).not.toBeInTheDocument();
      expect(screen.getByTestId("reindex-button")).toBeDisabled();
      expect(screen.getByTestId("reindex-button")).toHaveTextContent("Reindexing…");

      act(() =>
        fake.fire(
          "job:lifecycle",
          lifecycle({ status: "progress", progress: 40, message: "Re-embedded 4/10 chunks" }),
        ),
      );
      expect(screen.getByTestId("reindex-progress-message")).toHaveTextContent(
        "Re-embedded 4/10 chunks",
      );

      // The run ends: coverage is read again and the page is idle once more.
      coverageMock.mockResolvedValue(makeCoverage({ needsReindex: false, mismatchedModels: [] }));
      act(() =>
        fake.fire(
          "job:lifecycle",
          lifecycle({ status: "completed", progress: 100, message: "Reindexed 10 of 10 chunks." }),
        ),
      );
      await waitFor(() => expect(screen.getByTestId("coverage-ok")).toBeInTheDocument());
      expect(screen.getByTestId("reindex-result")).toHaveTextContent("Reindexed 10 of 10 chunks.");
      expect(screen.getByTestId("reindex-button")).toBeEnabled();
      expect(screen.queryByTestId("reindex-progress")).not.toBeInTheDocument();
    });

    it("does not go back to a job it saw end when coverage still reads it as running", async () => {
      atQuery("projectId=proj_1");
      statusMock.mockResolvedValue(makeStatus());
      coverageMock.mockResolvedValue(running("job-x"));

      render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
      await waitFor(() =>
        expect(fake.socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-x" }),
      );

      act(() => fake.fire("job:lifecycle", lifecycle({ status: "completed", message: "Done." })));
      await waitFor(() => expect(coverageMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByTestId("reindex-progress")).not.toBeInTheDocument());
      const subscribes = fake.socket.emit.mock.calls.filter(([name]) => name === "subscribe:job");
      expect(subscribes).toHaveLength(1);
    });

    // #2196 — the page's own job ended, but coverage read a moment before the
    // run released its guard still lists it running: keep re-reading until it
    // does not, or the page sits on "Reindex in progress" until a reload.
    it("keeps re-reading coverage after its job ends while coverage still lists it running", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        atQuery("projectId=proj_1");
        statusMock.mockResolvedValue(makeStatus());
        coverageMock.mockResolvedValue(running("job-x"));

        render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
        await waitFor(() =>
          expect(fake.socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-x" }),
        );

        act(() => fake.fire("job:lifecycle", lifecycle({ status: "completed", message: "Done." })));
        await waitFor(() => expect(coverageMock).toHaveBeenCalledTimes(2));
        expect(screen.getByTestId("reindex-in-progress")).toBeInTheDocument();
        expect(screen.getByTestId("reindex-button")).toBeDisabled();

        coverageMock.mockResolvedValue(makeCoverage({ needsReindex: false, mismatchedModels: [] }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        await waitFor(() => expect(screen.getByTestId("coverage-ok")).toBeInTheDocument());
        expect(screen.getByTestId("reindex-button")).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    // #2196 — a followed job never re-read coverage, so a server that died
    // mid-reindex (no terminal event) froze the progress bar until a reload.
    it("re-reads coverage slowly while following a re-attached job, and lets go of one that died", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        atQuery("projectId=proj_1");
        statusMock.mockResolvedValue(makeStatus());
        coverageMock.mockResolvedValue(running("job-x"));

        render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
        await waitFor(() => expect(screen.getByTestId("reindex-progress")).toBeInTheDocument());

        // Not at the fast "cannot follow" cadence: the job's events drive the bar.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(coverageMock).toHaveBeenCalledTimes(1);

        // The server restarted: nothing runs, and the run left a checkpoint.
        coverageMock.mockResolvedValue(makeCoverage());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        await waitFor(() => expect(screen.getByTestId("needs-reindex")).toBeInTheDocument());
        expect(screen.queryByTestId("reindex-progress")).not.toBeInTheDocument();
        expect(screen.getByTestId("reindex-button")).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    // #2218 — two reads in a row, not one: see the multi-replica test below.
    it("lets go of a job this page started once two coverage reads after it say nothing runs", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        statusMock.mockResolvedValue(makeStatus());
        coverageMock.mockResolvedValue(makeCoverage());
        reindexMock.mockResolvedValue({ jobId: "job-x", projectId: "proj_1", status: "started" });

        render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
        fireEvent.change(screen.getByTestId("project-id-input"), { target: { value: "proj_1" } });
        fireEvent.click(screen.getByRole("button", { name: /check coverage/i }));
        await waitFor(() => expect(screen.getByTestId("needs-reindex")).toBeInTheDocument());

        fireEvent.click(screen.getByTestId("reindex-button"));
        // Coverage read before the job started still says nothing runs: that is
        // not a dead run, so the page follows the job.
        await waitFor(() => expect(screen.getByTestId("reindex-progress")).toBeInTheDocument());

        // While the run is alive, the slow re-read sees it and the page keeps following.
        coverageMock.mockResolvedValue(running("job-x"));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        await waitFor(() => expect(coverageMock).toHaveBeenCalledTimes(2));
        expect(screen.getByTestId("reindex-progress")).toBeInTheDocument();

        // Then its server dies: the next re-read says nothing runs. One read is
        // not enough to let go (#2218); the one after it is.
        coverageMock.mockResolvedValue(makeCoverage());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        await waitFor(() => expect(coverageMock).toHaveBeenCalledTimes(3));
        expect(screen.getByTestId("reindex-progress")).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        await waitFor(() => expect(screen.getByTestId("needs-reindex")).toBeInTheDocument());
        expect(screen.queryByTestId("reindex-progress")).not.toBeInTheDocument();
        expect(screen.getByTestId("reindex-button")).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    // #2213 — a lost own job stayed in state: the page kept re-reading coverage
    // every 15 s, and a later reindex was followed under the dead job's id.
    it("forgets a job it lost: stops re-reading, and follows a later reindex by its own id", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        statusMock.mockResolvedValue(makeStatus());
        coverageMock.mockResolvedValue(makeCoverage());
        reindexMock.mockResolvedValue({ jobId: "job-x", projectId: "proj_1", status: "started" });

        render(<AdminEmbeddingsPage />, { wrapper: makeWrapper({ queryClient: client }) });
        fireEvent.change(screen.getByTestId("project-id-input"), { target: { value: "proj_1" } });
        fireEvent.click(screen.getByRole("button", { name: /check coverage/i }));
        await waitFor(() => expect(screen.getByTestId("needs-reindex")).toBeInTheDocument());

        fireEvent.click(screen.getByTestId("reindex-button"));
        await waitFor(() => expect(screen.getByTestId("reindex-progress")).toBeInTheDocument());

        // The job's server dies: the next two re-reads say nothing runs.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        await waitFor(() => expect(screen.getByTestId("needs-reindex")).toBeInTheDocument());
        const readsWhenLost = coverageMock.mock.calls.length;

        // Nothing runs and nothing is followed: no more re-reads.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(45_000);
        });
        expect(coverageMock).toHaveBeenCalledTimes(readsWhenLost);

        // Another reindex starts for the project; the page follows it, not the dead id.
        coverageMock.mockResolvedValue(running("job-y"));
        await act(async () => {
          await client.refetchQueries();
        });
        await waitFor(() =>
          expect(fake.socket.emit).toHaveBeenLastCalledWith("subscribe:job", { jobId: "job-y" }),
        );
        expect(screen.getByTestId("reindex-progress")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    // #2218 — on Postgres with several replicas a read can reach another
    // replica before the job's own has taken the reindex lease: it says nothing
    // runs although the job is about to. One such read used to drop the job for
    // good; the page now waits for a second read in a row.
    it("keeps following its job through one read that says nothing runs, then the lease is seen", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        statusMock.mockResolvedValue(makeStatus());
        coverageMock.mockResolvedValue(makeCoverage());
        reindexMock.mockResolvedValue({ jobId: "job-x", projectId: "proj_1", status: "started" });

        render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
        fireEvent.change(screen.getByTestId("project-id-input"), { target: { value: "proj_1" } });
        fireEvent.click(screen.getByRole("button", { name: /check coverage/i }));
        await waitFor(() => expect(screen.getByTestId("needs-reindex")).toBeInTheDocument());

        fireEvent.click(screen.getByTestId("reindex-button"));
        await waitFor(() => expect(screen.getByTestId("reindex-progress")).toBeInTheDocument());

        // Read 1 after the enqueue reaches a replica before the lease is taken.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        await waitFor(() => expect(coverageMock).toHaveBeenCalledTimes(2));
        expect(screen.getByTestId("reindex-progress")).toBeInTheDocument();
        expect(screen.getByTestId("reindex-button")).toBeDisabled();

        // Read 2 sees the lease (another replica: no job id). Still the page's job.
        coverageMock.mockResolvedValue(running(null));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        await waitFor(() => expect(coverageMock).toHaveBeenCalledTimes(3));
        expect(screen.getByTestId("reindex-progress")).toBeInTheDocument();
        expect(fake.socket.emit).toHaveBeenLastCalledWith("subscribe:job", { jobId: "job-x" });

        // A running read between two idle ones restarts the count.
        coverageMock.mockResolvedValue(makeCoverage());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        await waitFor(() => expect(coverageMock).toHaveBeenCalledTimes(4));
        expect(screen.getByTestId("reindex-progress")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    // #2213 — a coverage read sent just before Reindex, resolving just after,
    // counted as "read after the enqueue" and dropped the page's new job.
    it("keeps following its job when a coverage read sent before the enqueue lands after it", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        statusMock.mockResolvedValue(makeStatus());
        coverageMock.mockResolvedValue(makeCoverage());
        reindexMock.mockResolvedValue({ jobId: "job-x", projectId: "proj_1", status: "started" });

        render(<AdminEmbeddingsPage />, { wrapper: makeWrapper({ queryClient: client }) });
        fireEvent.change(screen.getByTestId("project-id-input"), { target: { value: "proj_1" } });
        fireEvent.click(screen.getByRole("button", { name: /check coverage/i }));
        await waitFor(() => expect(screen.getByTestId("needs-reindex")).toBeInTheDocument());

        // A coverage read goes out, and is still in flight when Reindex is clicked.
        let resolveRead: (report: EmbeddingsCoverageReport) => void = () => {};
        coverageMock.mockImplementationOnce(
          () => new Promise<EmbeddingsCoverageReport>((resolve) => (resolveRead = resolve)),
        );
        let refetch: Promise<void> = Promise.resolve();
        act(() => {
          refetch = client.refetchQueries();
        });
        await waitFor(() => expect(coverageMock).toHaveBeenCalledTimes(2));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });

        fireEvent.click(screen.getByTestId("reindex-button"));
        await waitFor(() => expect(screen.getByTestId("reindex-progress")).toBeInTheDocument());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });

        // It lands after the enqueue, from before the job started: nothing runs.
        await act(async () => {
          resolveRead(makeCoverage({ totalChunks: 11 }));
          await refetch;
          await vi.advanceTimersByTimeAsync(10);
        });
        await waitFor(() => expect(screen.getByText("11")).toBeInTheDocument());

        expect(screen.getByTestId("reindex-progress")).toBeInTheDocument();
        expect(screen.getByTestId("reindex-button")).toBeDisabled();
        expect(screen.queryByTestId("needs-reindex")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("says a reindex runs that it cannot follow when the server cannot name its job, and polls", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        atQuery("projectId=proj_1");
        statusMock.mockResolvedValue(makeStatus());
        coverageMock.mockResolvedValue(running(null));

        render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });

        await waitFor(() => expect(screen.getByTestId("reindex-elsewhere")).toBeInTheDocument());
        // #2196 — neutral: the run may be this process's own, or the CLI's.
        expect(screen.getByTestId("reindex-elsewhere")).toHaveTextContent(
          "A reindex is running for this project that this page cannot follow.",
        );
        expect(screen.getByTestId("reindex-elsewhere")).not.toHaveTextContent(/server process/);
        expect(screen.getByTestId("reindex-in-progress")).toBeInTheDocument();
        expect(screen.getByTestId("reindex-button")).toBeDisabled();
        expect(screen.queryByTestId("reindex-progress")).not.toBeInTheDocument();
        expect(fake.socket.emit).not.toHaveBeenCalledWith("subscribe:job", expect.anything());

        coverageMock.mockResolvedValue(makeCoverage({ needsReindex: false, mismatchedModels: [] }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        await waitFor(() => expect(screen.getByTestId("coverage-ok")).toBeInTheDocument());
        expect(screen.queryByTestId("reindex-elsewhere")).not.toBeInTheDocument();
        expect(screen.getByTestId("reindex-button")).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("marks coverage up to date when no reindex is needed", async () => {
    statusMock.mockResolvedValue(makeStatus());
    coverageMock.mockResolvedValue(
      makeCoverage({ matchingChunks: 10, mismatchedModels: [], needsReindex: false }),
    );

    render(<AdminEmbeddingsPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(statusMock).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId("project-id-input"), { target: { value: "proj_2" } });
    fireEvent.click(screen.getByRole("button", { name: /check coverage/i }));

    await waitFor(() => expect(screen.getByTestId("coverage-ok")).toBeInTheDocument());
  });
});
