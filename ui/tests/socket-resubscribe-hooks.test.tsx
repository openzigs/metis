/**
 * #642 — every room-subscribing hook re-sends its `subscribe:*` after a
 * disconnect + reconnect, and its live updates resume on the same socket.
 * Before the fix each hook emitted once per effect; `useSocket` returns the
 * same instance across reconnects, so the effect never re-ran and the view
 * went silent until the user navigated away and back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

let socket: FakeSocket;
vi.mock("@/lib/socket-client", () => ({ useSocket: () => socket }));
vi.mock("@/lib/sync-api", () => ({ fetchDriftCount: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/projects-api", () => ({
  documentsApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

import { useProjectDocuments } from "@/hooks/use-project-documents";
import { useProjectDriftCount } from "@/hooks/use-drift-count";
import { useSessionToolEvents } from "@/hooks/use-session-tool-events";
import { useTaskProgress } from "@/hooks/use-task-progress";
import { useConnectorProgress, useConnectorDiscovery } from "@/hooks/use-connector-events";
import { useProjectJobEvents } from "@/hooks/use-job-events";

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  socket = createFakeSocket();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

const project = { projectId: "p1" };

describe("project-room hooks re-subscribe after a reconnect", () => {
  it("useProjectDocuments re-joins and keeps invalidating on document:status", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { unmount } = renderHook(() => useProjectDocuments("p1"), { wrapper });
    expect(socket.emitted("subscribe:project", project)).toBe(1);
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:project", project)).toBe(2);
    invalidate.mockClear();
    act(() => socket.fire("document:status", project));
    expect(invalidate).toHaveBeenCalled();
    unmount();
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:project", project)).toBe(2);
  });

  it("useProjectDriftCount re-joins and keeps re-reading on drift:detected", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { unmount } = renderHook(() => useProjectDriftCount("p1"), { wrapper });
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:project", project)).toBe(2);
    invalidate.mockClear();
    act(() => socket.fire("drift:detected", project));
    expect(invalidate).toHaveBeenCalled();
    unmount();
    expect(socket.listeners("connect")).toBe(0);
  });

  it("useProjectJobEvents re-joins and keeps surfacing job:lifecycle", () => {
    const { result, unmount } = renderHook(() => useProjectJobEvents("p1"), { wrapper });
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:project", project)).toBe(2);
    act(() =>
      socket.fire("job:lifecycle", {
        jobId: "j1",
        kind: "analysis",
        status: "completed",
        projectId: "p1",
      }),
    );
    expect(result.current?.jobId).toBe("j1");
    unmount();
    expect(socket.listeners("connect")).toBe(0);
  });

  it("useConnectorProgress re-joins and keeps tracking progress", () => {
    const { result, unmount } = renderHook(() => useConnectorProgress("p1"));
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:project", project)).toBe(2);
    act(() =>
      socket.fire("connector:progress", {
        connectorId: "c1",
        phase: "ingest",
        step: "Cloning",
        current: 1,
        total: 3,
        ts: 0,
      }),
    );
    expect(result.current.progressMap.c1?.step).toBe("Cloning");
    unmount();
    expect(socket.listeners("connect")).toBe(0);
  });

  it("useConnectorDiscovery re-joins and keeps calling back", () => {
    const onDiscovery = vi.fn();
    const { unmount } = renderHook(() => useConnectorDiscovery("p1", onDiscovery));
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:project", project)).toBe(2);
    act(() => socket.fire("connector:discovery", { connectionsFound: 1, repoLabel: "r" }));
    expect(onDiscovery).toHaveBeenCalledTimes(1);
    unmount();
    expect(socket.listeners("connect")).toBe(0);
  });
});

describe("session and task hooks re-subscribe after a reconnect", () => {
  it("useSessionToolEvents re-joins the session room and keeps delivering", () => {
    const onEvent = vi.fn();
    const { unmount } = renderHook(() => useSessionToolEvents("s1", onEvent));
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:session", { sessionId: "s1" })).toBe(2);
    act(() =>
      socket.fire("ai:tool:event", {
        type: "tool_event",
        phase: "started",
        callId: "c1",
        name: "x",
        sessionId: "s1",
      }),
    );
    expect(onEvent).toHaveBeenCalled();
    unmount();
    expect(socket.emitted("unsubscribe:session", { sessionId: "s1" })).toBe(1);
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:session", { sessionId: "s1" })).toBe(2);
  });

  it("useTaskProgress re-joins the task room and keeps tracking status", () => {
    const { result, unmount } = renderHook(() => useTaskProgress("t1"));
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:task", { taskId: "t1" })).toBe(2);
    act(() => socket.fire("task:status", { taskId: "t1", status: "running" }));
    expect(result.current.status?.status).toBe("running");
    unmount();
    expect(socket.emitted("unsubscribe:task", { taskId: "t1" })).toBe(1);
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:task", { taskId: "t1" })).toBe(2);
  });
});
