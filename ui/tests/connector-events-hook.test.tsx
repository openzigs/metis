import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  INDETERMINATE_CLEAR_MS,
  useConnectorProgress,
  useConnectorDiscovery,
} from "@/hooks/use-connector-events";
import { isDeterminate, progressLabel } from "@/lib/connector-progress";

// Mock socket-client
const mockOn = vi.fn();
const mockOff = vi.fn();
const mockEmit = vi.fn();
const mockSocket = { on: mockOn, off: mockOff, emit: mockEmit, connected: true };

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => mockSocket,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useConnectorProgress (#664)", () => {
  it("subscribes to the project room on mount", () => {
    renderHook(() => useConnectorProgress("proj-1"));
    expect(mockEmit).toHaveBeenCalledWith("subscribe:project", { projectId: "proj-1" });
  });

  it("subscribes to connector:progress events", () => {
    renderHook(() => useConnectorProgress("proj-1"));
    expect(mockOn).toHaveBeenCalledWith("connector:progress", expect.any(Function));
  });

  it("tracks progress per connector", () => {
    const { result } = renderHook(() => useConnectorProgress("proj-1"));

    // Simulate a progress event
    const handler = mockOn.mock.calls.find((c) => c[0] === "connector:progress")?.[1];
    expect(handler).toBeDefined();

    act(() => {
      handler!({
        connectorId: "repo-1",
        phase: "deep-ingest",
        step: "Cloning repository",
        current: 1,
        total: 5,
        ts: Date.now(),
      });
    });

    expect(result.current.progressMap["repo-1"]).toBeDefined();
    expect(result.current.progressMap["repo-1"].step).toBe("Cloning repository");
    expect(result.current.progressMap["repo-1"].current).toBe(1);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useConnectorProgress("proj-1"));
    unmount();
    expect(mockOff).toHaveBeenCalledWith("connector:progress", expect.any(Function));
  });

  const progressHandler = () =>
    mockOn.mock.calls.find((c) => c[0] === "connector:progress")?.[1] as (d: unknown) => void;
  const progress = (over: Record<string, unknown> = {}) => ({
    connectorId: "repo-1",
    phase: "deep-ingest",
    step: "Cloning repository",
    current: 1,
    total: 5,
    ts: 0,
    ...over,
  });

  it("drops a connector's progress on an error event", () => {
    const { result } = renderHook(() => useConnectorProgress("proj-1"));
    act(() => progressHandler()(progress()));
    act(() => progressHandler()(progress({ status: "error" })));
    expect(result.current.progressMap["repo-1"]).toBeUndefined();
  });

  it("clears a completed connector's progress after 2s", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useConnectorProgress("proj-1"));
      act(() => progressHandler()(progress({ current: 5, total: 5 })));
      expect(result.current.progressMap["repo-1"]).toBeDefined();
      act(() => vi.advanceTimersByTime(2000));
      expect(result.current.progressMap["repo-1"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearProgress removes one connector's progress", () => {
    const { result } = renderHook(() => useConnectorProgress("proj-1"));
    act(() => progressHandler()(progress()));
    act(() => result.current.clearProgress("repo-1"));
    expect(result.current.progressMap["repo-1"]).toBeUndefined();
  });
});

describe("useConnectorProgress — runs that end (#762)", () => {
  const handler = () =>
    mockOn.mock.calls.find((c) => c[0] === "connector:progress")?.[1] as (d: unknown) => void;
  const stepped = (over: Record<string, unknown> = {}) => ({
    connectorId: "repo-1",
    phase: "deep-ingest",
    step: "Building code graph",
    current: 2,
    total: 5,
    ts: 0,
    ...over,
  });
  const countless = (over: Record<string, unknown> = {}) => ({
    connectorId: "repo-1",
    phase: "test",
    step: "repo.get",
    ts: 0,
    ...over,
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls onSettled when the last step arrives, so the page refetches the card", () => {
    const onSettled = vi.fn();
    renderHook(() => useConnectorProgress("proj-1", { onSettled }));
    act(() => handler()(stepped()));
    expect(onSettled).not.toHaveBeenCalled();
    act(() => handler()(stepped({ step: "Discovering connections", current: 5 })));
    expect(onSettled).toHaveBeenCalledWith("repo-1");
  });

  it("calls onSettled on an error event", () => {
    const onSettled = vi.fn();
    renderHook(() => useConnectorProgress("proj-1", { onSettled }));
    act(() => handler()(stepped({ status: "error" })));
    expect(onSettled).toHaveBeenCalledWith("repo-1");
  });

  it("clears a count-less entry after a few idle seconds instead of keeping it for good", () => {
    const { result } = renderHook(() => useConnectorProgress("proj-1"));
    act(() => handler()(countless()));
    expect(result.current.progressMap["repo-1"]).toBeDefined();
    act(() => vi.advanceTimersByTime(INDETERMINATE_CLEAR_MS - 1));
    expect(result.current.progressMap["repo-1"]).toBeDefined();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.progressMap["repo-1"]).toBeUndefined();
  });

  it("a newer count-less event restarts the idle clock", () => {
    const { result } = renderHook(() => useConnectorProgress("proj-1"));
    act(() => handler()(countless({ phase: "metadata", step: "repo" })));
    act(() => vi.advanceTimersByTime(INDETERMINATE_CLEAR_MS - 100));
    act(() => handler()(countless({ phase: "metadata", step: "readme" })));
    act(() => vi.advanceTimersByTime(INDETERMINATE_CLEAR_MS - 100));
    expect(result.current.progressMap["repo-1"]?.step).toBe("readme");
  });

  it("a count-less sub-step never replaces a stepped run's row, nor clears it", () => {
    const { result } = renderHook(() => useConnectorProgress("proj-1"));
    act(() => handler()(stepped({ step: "Indexing metadata", current: 4 })));
    act(() => handler()(countless({ phase: "metadata", step: "manifests" })));
    expect(result.current.progressMap["repo-1"].step).toBe("Indexing metadata");
    act(() => vi.advanceTimersByTime(INDETERMINATE_CLEAR_MS * 2));
    expect(result.current.progressMap["repo-1"].step).toBe("Indexing metadata");
  });

  it("an earlier run's completion timer does not clear a newer run", () => {
    const { result } = renderHook(() => useConnectorProgress("proj-1"));
    act(() => handler()(stepped({ current: 5 })));
    act(() => vi.advanceTimersByTime(1000));
    act(() => handler()(stepped({ step: "Resolving source", current: 1 })));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.progressMap["repo-1"]?.step).toBe("Resolving source");
  });
});

describe("progress row helpers (#762)", () => {
  it("labels a count-less phase for people and keeps a stepped run's own step", () => {
    expect(progressLabel({ phase: "test", step: "repo.get" })).toBe("Testing connection");
    expect(progressLabel({ phase: "metadata", step: "languages" })).toBe(
      "Reading repository metadata",
    );
    expect(progressLabel({ phase: "other", step: "raw" })).toBe("raw");
    expect(progressLabel({ phase: "deep-ingest", step: "Building code graph", total: 5 })).toBe(
      "Building code graph",
    );
  });

  it("isDeterminate needs a positive total", () => {
    expect(isDeterminate({ total: 5 })).toBe(true);
    expect(isDeterminate({})).toBe(false);
    expect(isDeterminate({ total: null })).toBe(false);
    expect(isDeterminate({ total: 0 })).toBe(false);
  });
});

describe("useConnectorDiscovery (#669)", () => {
  it("subscribes to the project room on mount", () => {
    renderHook(() => useConnectorDiscovery("proj-1"));
    expect(mockEmit).toHaveBeenCalledWith("subscribe:project", { projectId: "proj-1" });
  });

  it("subscribes to connector:discovery events", () => {
    renderHook(() => useConnectorDiscovery("proj-1"));
    expect(mockOn).toHaveBeenCalledWith("connector:discovery", expect.any(Function));
  });

  it("calls onDiscovery callback when event received", async () => {
    const { toast } = await import("sonner");
    const onDiscovery = vi.fn();
    renderHook(() => useConnectorDiscovery("proj-1", onDiscovery));

    const handler = mockOn.mock.calls.find((c) => c[0] === "connector:discovery")?.[1];
    expect(handler).toBeDefined();

    act(() => {
      handler!({
        projectId: "proj-1",
        connectorId: "repo-1",
        repoLabel: "backend",
        connectionsFound: 2,
        ts: Date.now(),
      });
    });

    expect(toast.info).toHaveBeenCalledWith(
      "2 database connections discovered in backend",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(onDiscovery).toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useConnectorDiscovery("proj-1"));
    unmount();
    expect(mockOff).toHaveBeenCalledWith("connector:discovery", expect.any(Function));
  });
});
