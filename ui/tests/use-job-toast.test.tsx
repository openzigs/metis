/**
 * Unit tests for the job-lifecycle progress + terminal-toast hook (Issue #423).
 *
 * Covers the per-op AC at the (shared) consumer layer that all three #423
 * surfaces use:
 *   - progress-emitted: the hook exposes the latest lifecycle event for a bar.
 *   - terminal-toast (success): `completed` fires a success toast carrying the
 *     server's human message VERBATIM — including the Spec Kit grounded line.
 *   - terminal-toast (failure): `failed` fires an error toast with the event's
 *     already-generic message (no raw error leaked).
 *   - spec-kit-completion-line-preserved: asserted explicitly below.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { JobLifecycleEvent } from "@metis/shared";
import { useJobToast, terminalToastText, isTerminalJobStatus } from "@/hooks/use-job-toast";
import { claimTerminalToast, __resetTerminalToastsForTests } from "@/lib/terminal-toast";

// ── mocks ────────────────────────────────────────────────────────────────────
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

const ev = (over: Partial<JobLifecycleEvent>): JobLifecycleEvent => ({
  kind: "spec-kit",
  jobId: "job-1",
  projectId: "p1",
  status: "started",
  ts: 1,
  ...over,
});

beforeEach(() => {
  fake = makeFakeSocket();
  // #425 — the terminal toast is now deduped by a MODULE-LEVEL `jobId` guard, so
  // reset it between tests or a previous test's `job-1` would suppress the next.
  __resetTerminalToastsForTests();
  vi.clearAllMocks();
});

describe("isTerminalJobStatus", () => {
  it("treats completed/failed as terminal and started/progress as non-terminal", () => {
    expect(isTerminalJobStatus("completed")).toBe(true);
    expect(isTerminalJobStatus("failed")).toBe(true);
    expect(isTerminalJobStatus("started")).toBe(false);
    expect(isTerminalJobStatus("progress")).toBe(false);
  });
});

describe("terminalToastText", () => {
  it("uses the completed message verbatim (grounded-completion line preserved)", () => {
    const grounded = "Generated spec.md (v3) in 1320 tokens — grounded on 8 retrieved chunks.";
    expect(terminalToastText(ev({ status: "completed", message: grounded }))).toEqual({
      kind: "success",
      text: grounded,
    });
  });

  it("falls back to a generic success label when completed has no message", () => {
    expect(terminalToastText(ev({ status: "completed", message: undefined }))).toEqual({
      kind: "success",
      text: "Done.",
    });
  });

  it("uses the failed event's (already-generic) error text", () => {
    expect(
      terminalToastText(
        ev({ status: "failed", error: "The Spec Kit operation failed. Please try again." }),
      ),
    ).toEqual({ kind: "error", text: "The Spec Kit operation failed. Please try again." });
  });

  it("falls back to a generic failure label when failed has no error", () => {
    expect(terminalToastText(ev({ status: "failed", error: undefined })).kind).toBe("error");
  });
});

describe("useJobToast", () => {
  it("subscribes to the job room and exposes the latest progress event", () => {
    const { result } = renderHook(() => useJobToast("job-1"));
    expect(fake.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" });

    act(() =>
      fake.fire("job:lifecycle", ev({ status: "progress", progress: 50, message: "halfway" })),
    );
    expect(result.current?.status).toBe("progress");
    expect(result.current?.progress).toBe(50);
    // No terminal toast yet.
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("fires a SUCCESS toast on completed, carrying the grounded line verbatim", () => {
    const grounded = "Generated spec.md (v2) in 1100 tokens — grounded on 5 retrieved chunks.";
    renderHook(() => useJobToast("job-1"));
    act(() =>
      fake.fire("job:lifecycle", ev({ status: "completed", progress: 100, message: grounded })),
    );
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith(grounded);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("fires an ERROR toast on failed with the generic message (no raw leak)", () => {
    renderHook(() => useJobToast("job-1"));
    act(() =>
      fake.fire(
        "job:lifecycle",
        ev({ status: "failed", error: "The embeddings reindex failed. Please try again." }),
      ),
    );
    expect(toastError).toHaveBeenCalledWith("The embeddings reindex failed. Please try again.");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("fires the terminal toast at most once even if the event is redelivered", () => {
    renderHook(() => useJobToast("job-1"));
    const done = ev({ status: "completed", message: "ok" });
    act(() => fake.fire("job:lifecycle", done));
    act(() => fake.fire("job:lifecycle", done));
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("ignores events for other jobs", () => {
    const { result } = renderHook(() => useJobToast("job-1"));
    act(() =>
      fake.fire("job:lifecycle", ev({ jobId: "other", status: "completed", message: "x" })),
    );
    expect(result.current).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("invokes onTerminal once with the terminal event after toasting", () => {
    const onTerminal = vi.fn();
    renderHook(() => useJobToast("job-1", { onTerminal }));
    act(() => fake.fire("job:lifecycle", ev({ status: "completed", message: "ok" })));
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("NO DUPLICATE TOAST across observers: when the global layer already claimed the job, this surface SUPPRESSES its toast but still runs onTerminal", () => {
    const onTerminal = vi.fn();
    // Simulate the global header layer having already observed + toasted this job.
    expect(claimTerminalToast("job-1")).toBe(true);
    renderHook(() => useJobToast("job-1", { onTerminal }));
    act(() => fake.fire("job:lifecycle", ev({ status: "completed", message: "ok" })));
    // Exactly one toast app-wide (the global layer's) — the surface stays silent…
    expect(toastSuccess).not.toHaveBeenCalled();
    // …but its cache-refresh / clear-pending side effect MUST still fire.
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("does nothing and returns null without a jobId", () => {
    const { result } = renderHook(() => useJobToast(null));
    expect(fake.emit).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("unsubscribes and removes the listener on unmount", () => {
    const { unmount } = renderHook(() => useJobToast("job-1"));
    unmount();
    expect(fake.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "job-1" });
    expect(fake.socket.off).toHaveBeenCalled();
  });
});
