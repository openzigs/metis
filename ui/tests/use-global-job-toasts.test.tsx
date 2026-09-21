/**
 * Issue #425 (Epic #406) — global terminal-toast consumer tests.
 *
 * Asserts the AC that closes the silent-failure gap: a LIST-view watcher (whose
 * socket is in the `project:{id}` room, so it receives doc-gen / analysis /
 * test-coverage lifecycle events) sees a terminal toast on completion AND on
 * failure WITHOUT being on the op's detail page. Also asserts the
 * NO-DUPLICATE-TOAST invariant: re-delivery of the same terminal event toasts
 * once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { toast } from "sonner";
import type { JobLifecycleEvent } from "@metis/shared";
import { useGlobalJobToasts } from "@/hooks/use-global-job-toasts";
import { __resetTerminalToastsForTests } from "@/lib/terminal-toast";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── fake socket (mirrors use-active-jobs.test.tsx) ──────────────────────────
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
// Lets a test drive the null-socket (not-yet-connected) branch.
let socketOrNull: ReturnType<typeof makeFakeSocket>["socket"] | null = fake.socket;

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => socketOrNull,
}));

const lifecycle = (over: Partial<JobLifecycleEvent>): JobLifecycleEvent => ({
  kind: "doc-generation",
  jobId: "job-1",
  projectId: "p1",
  status: "completed",
  ts: 1,
  ...over,
});

beforeEach(() => {
  fake = makeFakeSocket();
  socketOrNull = fake.socket;
  __resetTerminalToastsForTests();
  vi.clearAllMocks();
});

describe("useGlobalJobToasts", () => {
  it("attaches a single job:lifecycle listener", () => {
    renderHook(() => useGlobalJobToasts());
    expect(fake.socket.on).toHaveBeenCalledWith("job:lifecycle", expect.any(Function));
  });

  it("is a no-op while the socket is not yet connected (null)", () => {
    socketOrNull = null;
    const { unmount } = renderHook(() => useGlobalJobToasts());
    expect(fake.socket.on).not.toHaveBeenCalled();
    // Unmounting with no socket must not throw (no listener was attached).
    expect(() => unmount()).not.toThrow();
  });

  it("FAILURE-TOAST-ON-LIST: shows an error toast for a failed op the user is not detail-viewing", () => {
    // Simulate a list-view watcher: only the global layer is mounted (no detail
    // surface). A doc-gen job the user never opened fails on the bus.
    renderHook(() => useGlobalJobToasts());
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({
          jobId: "doc-7",
          status: "failed",
          error: "Documentation generation failed. Please try again.",
        }),
      ),
    );
    expect(toast.error).toHaveBeenCalledWith("Documentation generation failed. Please try again.");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("SUCCESS-TOAST-ON-COMPLETE: shows a success toast on completion with the event message", () => {
    renderHook(() => useGlobalJobToasts());
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({
          jobId: "an-3",
          kind: "analysis",
          status: "completed",
          message: "Analysis complete",
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Analysis complete");
  });

  it("toasts test-coverage / scan-style kinds generically (any JobKind)", () => {
    renderHook(() => useGlobalJobToasts());
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({
          jobId: "tc-1",
          kind: "import-sync",
          status: "completed",
          message: "Reindexed 42 chunks.",
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Reindexed 42 chunks.");
  });

  it("does NOT toast on non-terminal transitions", () => {
    renderHook(() => useGlobalJobToasts());
    act(() => fake.fire("job:lifecycle", lifecycle({ status: "started" })));
    act(() => fake.fire("job:lifecycle", lifecycle({ status: "progress", progress: 40 })));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("NO DUPLICATE TOAST: a re-delivered terminal event toasts only once", () => {
    renderHook(() => useGlobalJobToasts());
    const ev = lifecycle({ jobId: "redeliver", status: "completed", message: "Done." });
    act(() => fake.fire("job:lifecycle", ev));
    act(() => fake.fire("job:lifecycle", ev));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = renderHook(() => useGlobalJobToasts());
    unmount();
    expect(fake.socket.off).toHaveBeenCalledWith("job:lifecycle", expect.any(Function));
  });
});
