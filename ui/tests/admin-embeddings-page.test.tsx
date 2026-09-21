import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { __resetTerminalToastsForTests } from "@/lib/terminal-toast";
import AdminEmbeddingsPage from "@/app/(authed)/admin/embeddings/page";
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
vi.mock("@/lib/socket-client", () => ({ useSocket: () => fake.socket }));

const statusMock = vi.mocked(embeddingsApi.status);
const coverageMock = vi.mocked(embeddingsApi.coverage);
const reindexMock = vi.mocked(embeddingsApi.reindex);

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
