/**
 * #646 — an event the server emits while the socket is down is lost. Each live
 * hook re-reads the state it may have missed on a reconnect (not the initial
 * connect), so the change shows without waiting for another event.
 *
 * Every test follows the same shape: render, let the first read settle, drop
 * the socket, change the server's answer WITHOUT firing the event (it was
 * "lost"), reconnect, and assert the view caught up.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { type ReactNode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

let socket: FakeSocket;
vi.mock("@/lib/socket-client", () => ({ useSocket: () => socket }));

const fetchDriftCount = vi.fn();
vi.mock("@/lib/sync-api", () => ({ fetchDriftCount: (id: string) => fetchDriftCount(id) }));

const listDocuments = vi.fn();
vi.mock("@/lib/projects-api", () => ({
  documentsApi: { list: (id: string) => listDocuments(id) },
}));

const getTask = vi.fn();
vi.mock("@/lib/scheduler-api", () => ({ tasksApi: { get: (id: string) => getTask(id) } }));

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import { useProjectDocuments } from "@/hooks/use-project-documents";
import { useProjectDriftCount } from "@/hooks/use-drift-count";
import { useTaskProgress } from "@/hooks/use-task-progress";
import { useConnectorDiscovery } from "@/hooks/use-connector-events";
import { useProjectJobEvents } from "@/hooks/use-job-events";
import { useOnReconnect } from "@/hooks/use-on-reconnect";
import { queryKeys } from "@/lib/query-keys";
import { impactAnalysisKeys } from "@/lib/impact-analysis-hooks";
import { toast } from "sonner";

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function taskRow(status: string) {
  return {
    id: "t1",
    scheduledJobId: null,
    projectId: "p1",
    type: "scan",
    trigger: "manual",
    status,
    priority: 0,
    payload: "{}",
    result: null,
    errorMessage: null,
    progress: null,
    attempts: 1,
    maxAttempts: 3,
    scheduledFor: null,
    startedAt: null,
    completedAt: null,
    createdById: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:05.000Z",
  };
}

beforeEach(() => {
  socket = createFakeSocket();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchDriftCount.mockReset();
  listDocuments.mockReset();
  getTask.mockReset();
});

describe("query-backed hooks re-read on reconnect (#646)", () => {
  it("useProjectDocuments shows a document that turned ready while the socket was down", async () => {
    listDocuments.mockResolvedValue({ items: [] });
    const { result } = renderHook(() => useProjectDocuments("p1"), { wrapper });
    await waitFor(() => expect(result.current.data?.items).toEqual([]));

    act(() => socket.disconnect());
    // The `document:status` for this transition is emitted now — and lost.
    listDocuments.mockResolvedValue({ items: [{ id: "d1", status: "ready" }] });
    act(() => socket.connect());

    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
  });

  it("useProjectDocuments does not re-read on the initial connect", async () => {
    socket = createFakeSocket(false);
    listDocuments.mockResolvedValue({ items: [] });
    renderHook(() => useProjectDocuments("p1"), { wrapper });
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));
    act(() => socket.connect());
    await new Promise((r) => setTimeout(r, 20));
    expect(listDocuments).toHaveBeenCalledTimes(1);
  });

  it("useProjectDriftCount shows drift detected while the socket was down", async () => {
    fetchDriftCount.mockResolvedValue(0);
    const { result } = renderHook(() => useProjectDriftCount("p1"), { wrapper });
    await waitFor(() => expect(fetchDriftCount).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(0);

    act(() => socket.disconnect());
    fetchDriftCount.mockResolvedValue(3);
    act(() => socket.connect());

    await waitFor(() => expect(result.current).toBe(3));
  });

  it("useProjectJobEvents refreshes every kind's caches after a reconnect", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectJobEvents("p1"), { wrapper });
    expect(invalidate).not.toHaveBeenCalled();

    act(() => socket.reconnect());

    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    for (const key of [
      queryKeys.analyses.forProject("p1"),
      queryKeys.documents.forProject("p1"),
      queryKeys.generatedDocs.forProject("p1"),
      impactAnalysisKeys.list(),
      queryKeys.projects.detail("p1"),
      queryKeys.documents.all,
    ]) {
      expect(keys).toContain(JSON.stringify(key));
    }
  });

  it("useConnectorDiscovery runs the caller's refresh on reconnect without a toast", () => {
    const onDiscovery = vi.fn();
    renderHook(() => useConnectorDiscovery("p1", onDiscovery));
    act(() => socket.reconnect());
    expect(onDiscovery).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });
});

describe("useTaskProgress re-reads the task on reconnect (#646)", () => {
  it("shows a task that finished while the socket was down, and fires onTerminal once", async () => {
    const onTerminal = vi.fn();
    const { result } = renderHook(() => useTaskProgress("t1", onTerminal));
    act(() => socket.fire("task:status", { taskId: "t1", status: "running" }));
    expect(result.current.status?.status).toBe("running");

    act(() => socket.disconnect());
    // The terminal `task:status` is emitted now — and lost.
    getTask.mockResolvedValue(taskRow("completed"));
    act(() => socket.connect());

    await waitFor(() => expect(result.current.status?.status).toBe("completed"));
    expect(getTask).toHaveBeenCalledWith("t1");
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0][0]).toMatchObject({ taskId: "t1", status: "completed" });

    // A later reconnect re-reads the same terminal row: no second onTerminal.
    act(() => socket.reconnect());
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("does not re-read on the initial connect", () => {
    socket = createFakeSocket(false);
    renderHook(() => useTaskProgress("t1"));
    act(() => socket.connect());
    expect(getTask).not.toHaveBeenCalled();
  });

  it("ignores a read that settles after the hook unmounted", async () => {
    let resolve: (row: unknown) => void = () => {};
    getTask.mockReturnValue(new Promise((r) => (resolve = r)));
    const onTerminal = vi.fn();
    const { unmount } = renderHook(() => useTaskProgress("t1", onTerminal));
    act(() => socket.reconnect());
    unmount();
    await act(async () => resolve(taskRow("failed")));
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("keeps the last status when the re-read fails", async () => {
    getTask.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useTaskProgress("t1"));
    act(() => socket.fire("task:status", { taskId: "t1", status: "running" }));
    act(() => socket.reconnect());
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(1));
    expect(result.current.status?.status).toBe("running");
  });
});

describe("useOnReconnect (#646)", () => {
  it("calls the latest callback on each reconnect, not on mount, and stops on unmount", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ cb }) => useOnReconnect(cb), {
      initialProps: { cb: first },
    });
    expect(first).not.toHaveBeenCalled();
    rerender({ cb: second });
    act(() => socket.reconnect());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    // A fresh callback each render does not re-register the listener.
    expect(socket.listeners("connect")).toBe(1);
    unmount();
    expect(socket.listeners("connect")).toBe(0);
  });
});
