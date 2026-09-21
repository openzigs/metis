import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useConnectorProgress, useConnectorDiscovery } from "@/hooks/use-connector-events";

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
