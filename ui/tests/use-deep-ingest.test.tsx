/**
 * Issue #373 — Deep Ingest runs in the background.
 *
 * The server answers `202 { jobId }` at once and reports the outcome on the
 * `job:lifecycle` bus (kind `repo-ingest`). This hook starts the run, follows
 * that job until it ends, and turns a second click on a busy connector into
 * "already running" (attaching to the running job) instead of a bare 409.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JobLifecycleEvent } from "@metis/shared";

const toastInfo = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    info: (msg: string) => toastInfo(msg),
    error: (msg: string) => toastError(msg),
    success: (msg: string) => toastSuccess(msg),
    warning: (msg: string) => toastWarning(msg),
  },
}));

type Handler = (data: unknown) => void;
function makeFakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const emit = vi.fn();
  const socket = {
    emit,
    on: vi.fn((name: string, fn: Handler) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
    }),
    off: vi.fn((name: string, fn: Handler) => {
      handlers.get(name)?.delete(fn);
    }),
  };
  const fire = (name: string, data: unknown) => handlers.get(name)?.forEach((fn) => fn(data));
  return { socket, fire, emit };
}
let fake = makeFakeSocket();
vi.mock("@/lib/socket-client", () => ({ useSocket: () => fake.socket }));

const deepIngest = vi.fn();
vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { deepIngest: (...args: unknown[]) => deepIngest(...args) },
}));

import { ApiError } from "@/lib/api-client";
import { useDeepIngest } from "@/hooks/use-deep-ingest";
import { __resetTerminalToastsForTests } from "@/lib/terminal-toast";

const ev = (over: Partial<JobLifecycleEvent>): JobLifecycleEvent => ({
  kind: "repo-ingest",
  jobId: "job-1",
  projectId: "p1",
  status: "started",
  ts: 1,
  ...over,
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fake = makeFakeSocket();
  deepIngest.mockReset();
  toastInfo.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  toastWarning.mockReset();
  __resetTerminalToastsForTests();
});

describe("useDeepIngest (#373)", () => {
  it("stays running after the 202 and follows the job to completion", async () => {
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "r1", status: "started" });
    const onSettled = vi.fn();
    const { result } = renderHook(() => useDeepIngest("p1", { onSettled }), { wrapper });

    act(() => result.current.start("r1"));
    await waitFor(() =>
      expect(fake.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" }),
    );
    expect(deepIngest).toHaveBeenCalledWith("p1", "r1");
    // The request has answered, but the ingest is still running.
    expect(result.current.runningConnectorId).toBe("r1");
    expect(result.current.outcome).toBeNull();

    act(() => fake.fire("job:lifecycle", ev({ status: "progress", progress: 40, message: "x" })));
    expect(result.current.progress?.progress).toBe(40);
    expect(result.current.runningConnectorId).toBe("r1");

    act(() =>
      fake.fire("job:lifecycle", ev({ status: "completed", message: "Deep ingest complete: 42" })),
    );
    expect(result.current.runningConnectorId).toBeNull();
    expect(result.current.outcome).toEqual({
      connectorId: "r1",
      status: "completed",
      message: "Deep ingest complete: 42",
      failureCount: 0,
    });
    expect(toastSuccess).toHaveBeenCalledWith("Deep ingest complete: 42");
    expect(onSettled).toHaveBeenCalledWith("r1");
  });

  it("#432 — carries the failure count of a run that completed with failures", async () => {
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "r1", status: "started" });
    const { result } = renderHook(() => useDeepIngest("p1"), { wrapper });
    act(() => result.current.start("r1"));
    await waitFor(() =>
      expect(fake.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" }),
    );
    const message = "Deep ingest completed with 3 failures: 3 source files could not be ingested.";
    act(() => fake.fire("job:lifecycle", ev({ status: "completed", message, failureCount: 3 })));
    expect(result.current.outcome).toEqual({
      connectorId: "r1",
      status: "completed",
      message,
      failureCount: 3,
    });
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith(message);
  });

  it("reports a failed run with the server's generic error", async () => {
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "r1", status: "started" });
    const { result } = renderHook(() => useDeepIngest("p1"), { wrapper });
    act(() => result.current.start("r1"));
    await waitFor(() =>
      expect(fake.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" }),
    );
    act(() =>
      fake.fire("job:lifecycle", ev({ status: "failed", error: "Repository ingestion failed." })),
    );
    expect(result.current.outcome).toEqual({
      connectorId: "r1",
      status: "failed",
      message: "Repository ingestion failed.",
      failureCount: 0,
    });
    expect(result.current.runningConnectorId).toBeNull();
  });

  it("a second click on a busy connector says so and follows the running job", async () => {
    deepIngest.mockRejectedValue(
      new ApiError(
        409,
        "A deep ingest is already running for this repository",
        "INGEST_IN_PROGRESS",
        {
          jobId: "job-running",
        },
      ),
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useDeepIngest("p1", { onError }), { wrapper });
    act(() => result.current.start("r1"));
    await waitFor(() =>
      expect(fake.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-running" }),
    );
    expect(toastInfo).toHaveBeenCalledWith("A deep ingest is already running for this repository");
    expect(toastError).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.runningConnectorId).toBe("r1");
  });

  it("a busy connector with no deep-ingest job (another sync holds it) is still told so", async () => {
    deepIngest.mockRejectedValue(
      new ApiError(409, "An ingest is already running for this connector", "INGEST_IN_PROGRESS", {
        code: "INGEST_IN_PROGRESS",
      }),
    );
    const { result } = renderHook(() => useDeepIngest("p1"), { wrapper });
    act(() => result.current.start("r1"));
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith("An ingest is already running for this connector"),
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(fake.emit).not.toHaveBeenCalledWith("subscribe:job", expect.anything());
    expect(result.current.runningConnectorId).toBeNull();
  });

  it("any other failure is an error toast and clears the connector's progress", async () => {
    deepIngest.mockRejectedValue(new ApiError(500, "boom"));
    const onError = vi.fn();
    const { result } = renderHook(() => useDeepIngest("p1", { onError }), { wrapper });
    act(() => result.current.start("r1"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("boom"));
    expect(onError).toHaveBeenCalledWith("r1");
    expect(result.current.runningConnectorId).toBeNull();
  });

  it("a non-API failure falls back to a generic message", async () => {
    deepIngest.mockRejectedValue(new TypeError("fetch failed"));
    const { result } = renderHook(() => useDeepIngest("p1"), { wrapper });
    act(() => result.current.start("r1"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Deep ingest failed"));
  });

  it("clearOutcome drops the last result", async () => {
    deepIngest.mockResolvedValue({ jobId: "job-1", connectorId: "r1", status: "started" });
    const { result } = renderHook(() => useDeepIngest("p1"), { wrapper });
    act(() => result.current.start("r1"));
    await waitFor(() =>
      expect(fake.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" }),
    );
    act(() => fake.fire("job:lifecycle", ev({ status: "completed" })));
    expect(result.current.outcome?.message).toBe("Deep ingest complete");
    act(() => result.current.clearOutcome());
    expect(result.current.outcome).toBeNull();
  });
});
