/**
 * Unit tests for the task-progress socket consumer (Issue #422 / Epic #406).
 *
 * Verifies the hook subscribes to the EXISTING `task:{id}` room, renders live
 * `task:progress`, fires the terminal callback on `task:status`, ignores cross-task
 * noise, and cleanly unsubscribes — without widening any authorization.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { TaskProgressEvent, TaskStatusEvent } from "@metis/shared";
import { useTaskProgress, isTerminalTaskStatus } from "@/hooks/use-task-progress";

// ── fake socket (mirrors use-job-events.test.tsx) ───────────────────────────
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
  const fire = (name: string, data: unknown) => {
    handlers.get(name)?.forEach((fn) => fn(data));
  };
  return { socket, fire, emit, handlers };
}

let fake = makeFakeSocket();

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => fake.socket,
}));

const progress = (over: Partial<TaskProgressEvent>): TaskProgressEvent => ({
  taskId: "task-1",
  step: "scanner.scan.symbol",
  current: 3,
  total: 10,
  progress: 30,
  ts: 1,
  ...over,
});

const status = (over: Partial<TaskStatusEvent>): TaskStatusEvent => ({
  taskId: "task-1",
  type: "scanner.run-scan",
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  ts: 1,
  ...over,
});

beforeEach(() => {
  fake = makeFakeSocket();
  vi.clearAllMocks();
});

describe("isTerminalTaskStatus", () => {
  it("treats completed/failed/cancelled as terminal and running/pending as not", () => {
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
    expect(isTerminalTaskStatus("running")).toBe(false);
    expect(isTerminalTaskStatus("pending")).toBe(false);
  });
});

describe("useTaskProgress", () => {
  it("subscribes to the task room and renders live progress from task:progress", () => {
    const { result } = renderHook(() => useTaskProgress("task-1"));
    expect(fake.emit).toHaveBeenCalledWith("subscribe:task", { taskId: "task-1" });

    act(() => fake.fire("task:progress", progress({ progress: 42, current: 5, total: 12 })));
    expect(result.current.progress?.progress).toBe(42);
    expect(result.current.progress?.current).toBe(5);
    expect(result.current.progress?.total).toBe(12);
    expect(result.current.progress?.step).toBe("scanner.scan.symbol");
  });

  it("ignores progress for other tasks", () => {
    const { result } = renderHook(() => useTaskProgress("task-1"));
    act(() => fake.fire("task:progress", progress({ taskId: "other", progress: 99 })));
    expect(result.current.progress).toBeNull();
  });

  it("tracks the latest task:status and fires onTerminal exactly on a terminal transition", () => {
    const onTerminal = vi.fn();
    const { result } = renderHook(() => useTaskProgress("task-1", onTerminal));

    act(() => fake.fire("task:status", status({ status: "running" })));
    expect(result.current.status?.status).toBe("running");
    expect(onTerminal).not.toHaveBeenCalled();

    act(() => fake.fire("task:status", status({ status: "completed" })));
    expect(result.current.status?.status).toBe("completed");
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("fires onTerminal for a failed transition too", () => {
    const onTerminal = vi.fn();
    renderHook(() => useTaskProgress("task-1", onTerminal));
    act(() => fake.fire("task:status", status({ status: "failed", errorMessage: "boom" })));
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("ignores status for other tasks", () => {
    const onTerminal = vi.fn();
    const { result } = renderHook(() => useTaskProgress("task-1", onTerminal));
    act(() => fake.fire("task:status", status({ taskId: "other", status: "completed" })));
    expect(result.current.status).toBeNull();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("does nothing without a taskId (terminal scan / no live task)", () => {
    const { result } = renderHook(() => useTaskProgress(null));
    expect(fake.emit).not.toHaveBeenCalled();
    expect(result.current.progress).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it("unsubscribes and removes listeners on unmount", () => {
    const { unmount } = renderHook(() => useTaskProgress("task-1"));
    unmount();
    expect(fake.emit).toHaveBeenCalledWith("unsubscribe:task", { taskId: "task-1" });
    expect(fake.socket.off).toHaveBeenCalledWith("task:progress", expect.any(Function));
    expect(fake.socket.off).toHaveBeenCalledWith("task:status", expect.any(Function));
  });

  it("resets state and re-subscribes when the taskId changes", () => {
    const { result, rerender } = renderHook(({ id }) => useTaskProgress(id), {
      initialProps: { id: "task-1" as string | null },
    });
    act(() => fake.fire("task:progress", progress({ taskId: "task-1", progress: 50 })));
    expect(result.current.progress?.progress).toBe(50);

    rerender({ id: "task-2" });
    // Old task's progress must not leak into the new subscription.
    expect(result.current.progress).toBeNull();
    expect(fake.emit).toHaveBeenCalledWith("unsubscribe:task", { taskId: "task-1" });
    expect(fake.emit).toHaveBeenCalledWith("subscribe:task", { taskId: "task-2" });
  });
});
