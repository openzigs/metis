/**
 * Epic #406 (#420) — global active-jobs aggregator hook tests.
 *
 * Verifies the module-level store that powers the "N jobs running" indicator:
 *  - `job:lifecycle` events upsert active jobs and remove them on a terminal
 *    transition (the indicator clears when all jobs finish),
 *  - ANY JobKind is tracked (not just doc-generation),
 *  - progress/message are carried and preserved across transitions,
 *  - `jobKindLabel` maps known kinds and gracefully title-cases unknown ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { JobKind, JobLifecycleEvent } from "@metis/shared";
import { useDocSectionProgress, useJobLifecycle } from "@/hooks/use-job-events";
import { useJobToast } from "@/hooks/use-job-toast";
import {
  useActiveJobs,
  useFollowJobs,
  applyJobLifecycleEvent,
  REPLAY_WAIT_MS,
  jobKindLabel,
  __resetActiveJobsForTests,
} from "@/hooks/use-active-jobs";

// ── fake socket (mirrors use-job-events.test.tsx) ───────────────────────────
type Handler = (data: unknown) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    connected: true,
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
  const listeners = (name: string) => handlers.get(name)?.size ?? 0;
  return { socket, fire, listeners };
}

let fake = makeFakeSocket();

// useJobToast imports sonner; nothing here reaches a terminal toast.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => fake.socket,
}));

const lifecycle = (over: Partial<JobLifecycleEvent>): JobLifecycleEvent => ({
  kind: "doc-generation",
  jobId: "job-1",
  projectId: "p1",
  status: "started",
  ts: 1,
  ...over,
});

beforeEach(() => {
  fake = makeFakeSocket();
  __resetActiveJobsForTests();
  vi.clearAllMocks();
});

describe("useActiveJobs", () => {
  it("starts empty and attaches a job:lifecycle listener", () => {
    const { result } = renderHook(() => useActiveJobs());
    expect(result.current).toEqual([]);
    expect(fake.socket.on).toHaveBeenCalledWith("job:lifecycle", expect.any(Function));
  });

  it("tracks a job that starts and reports progress", () => {
    const { result } = renderHook(() => useActiveJobs());

    act(() => fake.fire("job:lifecycle", lifecycle({ status: "started" })));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].jobId).toBe("job-1");

    act(() => fake.fire("job:lifecycle", lifecycle({ status: "progress", progress: 42 })));
    expect(result.current[0].progress).toBe(42);
  });

  it("removes a job when it reaches a terminal state (clears the indicator)", () => {
    const { result } = renderHook(() => useActiveJobs());
    act(() => fake.fire("job:lifecycle", lifecycle({ status: "started" })));
    expect(result.current).toHaveLength(1);

    act(() => fake.fire("job:lifecycle", lifecycle({ status: "completed" })));
    expect(result.current).toHaveLength(0);
  });

  it("removes a job on a failed transition too", () => {
    const { result } = renderHook(() => useActiveJobs());
    act(() => fake.fire("job:lifecycle", lifecycle({ status: "started" })));
    act(() => fake.fire("job:lifecycle", lifecycle({ status: "failed", error: "boom" })));
    expect(result.current).toHaveLength(0);
  });

  it("tracks multiple jobs of DIFFERENT kinds simultaneously (not just doc-gen)", () => {
    const { result } = renderHook(() => useActiveJobs());
    act(() => fake.fire("job:lifecycle", lifecycle({ jobId: "a", kind: "doc-generation", ts: 1 })));
    act(() => fake.fire("job:lifecycle", lifecycle({ jobId: "b", kind: "scan", ts: 2 })));
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({ jobId: "c", kind: "analysis", projectId: "p2", ts: 3 }),
      ),
    );

    expect(result.current).toHaveLength(3);
    const kinds = result.current.map((j) => j.kind);
    expect(kinds).toContain("scan");
    expect(kinds).toContain("analysis");
    // Oldest-first ordering by ts.
    expect(result.current.map((j) => j.jobId)).toEqual(["a", "b", "c"]);
  });

  it("preserves the last-known progress/message when a later event omits them", () => {
    const { result } = renderHook(() => useActiveJobs());
    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({ status: "progress", progress: 30, message: "Step 1" }),
      ),
    );
    // A bare transition with no progress/message must not wipe the prior values.
    act(() => fake.fire("job:lifecycle", lifecycle({ status: "progress" })));
    expect(result.current[0].progress).toBe(30);
    expect(result.current[0].message).toBe("Step 1");
  });

  it("ignores malformed events without a jobId", () => {
    const { result } = renderHook(() => useActiveJobs());
    act(() => fake.fire("job:lifecycle", { kind: "scan", status: "started" }));
    expect(result.current).toHaveLength(0);
  });

  it("removes the job:lifecycle listener on unmount", () => {
    const { unmount } = renderHook(() => useActiveJobs());
    unmount();
    expect(fake.socket.off).toHaveBeenCalledWith("job:lifecycle", expect.any(Function));
  });

  it("is a no-op for a terminal event for an unknown job", () => {
    const { result } = renderHook(() => useActiveJobs());
    act(() => fake.fire("job:lifecycle", lifecycle({ jobId: "never-seen", status: "completed" })));
    expect(result.current).toHaveLength(0);
  });
});

describe("applyJobLifecycleEvent (direct store access)", () => {
  it("guards against null/undefined input", () => {
    expect(() => applyJobLifecycleEvent(null as unknown as JobLifecycleEvent)).not.toThrow();
    expect(() => applyJobLifecycleEvent(undefined as unknown as JobLifecycleEvent)).not.toThrow();
  });
});

describe("jobKindLabel", () => {
  it("maps every known kind to a friendly label", () => {
    const known: JobKind[] = [
      "analysis",
      "doc-generation",
      "impact-analysis",
      "scan",
      "pr-review",
      "import-sync",
      "embeddings-reindex",
      "spec-kit",
      "overview-regenerate",
    ];
    for (const k of known) {
      expect(jobKindLabel(k)).toMatch(/\S/);
    }
    expect(jobKindLabel("doc-generation")).toBe("Documentation");
    expect(jobKindLabel("scan")).toBe("Security scan");
  });

  it("title-cases an unknown future kind without a code edit", () => {
    expect(jobKindLabel("brand-new-kind" as JobKind)).toBe("Brand New Kind");
  });
});

/**
 * #430 — a followed job the server's replay cannot account for (API restart, or
 * evicted from the 500-job replay cache) stops counting as running.
 */
describe("useFollowJobs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const follow = (ids: string[]) =>
    renderHook(() => {
      useFollowJobs(ids);
      return useActiveJobs();
    });

  it("subscribes to each job's room", () => {
    applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
    follow(["job-1"]);
    expect(fake.socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" });
  });

  it("forgets a job when no replay arrives in time", () => {
    applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
    const { result } = follow(["job-1"]);
    act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS - 1));
    expect(result.current).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toHaveLength(0);
  });

  it("keeps a job whose replay says it is still running", () => {
    applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
    const { result } = follow(["job-1"]);
    act(() => fake.fire("job:lifecycle", lifecycle({ kind: "repo-ingest", status: "progress" })));
    act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS * 2));
    expect(result.current.map((j) => j.jobId)).toEqual(["job-1"]);
  });

  it("forgets only the followed jobs that heard nothing", () => {
    applyJobLifecycleEvent(lifecycle({ jobId: "a", ts: 1 }));
    applyJobLifecycleEvent(lifecycle({ jobId: "b", ts: 2 }));
    const { result } = follow(["a", "b"]);
    act(() => fake.fire("job:lifecycle", lifecycle({ jobId: "b", status: "progress" })));
    act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS));
    expect(result.current.map((j) => j.jobId)).toEqual(["b"]);
  });

  it("starts the clock only once the socket connects", () => {
    fake.socket.connected = false;
    applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
    const { result } = follow(["job-1"]);
    act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS * 2));
    expect(result.current).toHaveLength(1);
    act(() => fake.fire("connect", undefined));
    // The emits made before the first connect were buffered and reach the
    // server on it, so the first connect joins nothing again.
    expect(fake.socket.emit.mock.calls.filter(([name]) => name === "subscribe:job")).toHaveLength(
      1,
    );
    act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS));
    expect(result.current).toHaveLength(0);
  });

  // #465 — a reconnect drops this socket's rooms on the server.
  describe("after a disconnect and reconnect", () => {
    const reconnect = () => {
      fake.socket.connected = false;
      act(() => fake.fire("disconnect", "transport close"));
      fake.socket.connected = true;
      act(() => fake.fire("connect", undefined));
    };

    it("re-subscribes to each followed job's room", () => {
      applyJobLifecycleEvent(lifecycle({ jobId: "a", ts: 1 }));
      applyJobLifecycleEvent(lifecycle({ jobId: "b", ts: 2 }));
      follow(["a", "b"]);
      fake.socket.emit.mockClear();
      reconnect();
      expect(fake.socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "a" });
      expect(fake.socket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "b" });
    });

    // #486 — the room is re-joined by `joinJobRoom`, once per socket, not once
    // per hook following the job.
    it("re-joins a job followed by several hooks exactly once", () => {
      applyJobLifecycleEvent(lifecycle({ jobId: "a", ts: 1 }));
      renderHook(() => {
        useFollowJobs(["a"]);
        useJobToast("a");
      });
      fake.socket.emit.mockClear();
      reconnect();
      expect(
        fake.socket.emit.mock.calls.filter(
          ([name, p]) => name === "subscribe:job" && (p as { jobId: string }).jobId === "a",
        ),
      ).toHaveLength(1);
    });

    it("does not forget a still-running job while the socket is down", () => {
      applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
      const { result } = follow(["job-1"]);
      act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS - 1_000));
      fake.socket.connected = false;
      act(() => fake.fire("disconnect", "transport close"));
      // Offline well past the original deadline: nothing could have arrived.
      act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS * 4));
      expect(result.current.map((j) => j.jobId)).toEqual(["job-1"]);
      fake.socket.connected = true;
      act(() => fake.fire("connect", undefined));
      act(() => fake.fire("job:lifecycle", lifecycle({ kind: "repo-ingest", status: "progress" })));
      act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS * 2));
      expect(result.current.map((j) => j.jobId)).toEqual(["job-1"]);
    });

    it("waits a full REPLAY_WAIT_MS again from the reconnect", () => {
      applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
      const { result } = follow(["job-1"]);
      act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS - 1_000));
      reconnect();
      act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS - 1));
      expect(result.current).toHaveLength(1);
      act(() => vi.advanceTimersByTime(1));
      expect(result.current).toHaveLength(0);
    });

    it("needs a fresh replay: a job heard before the drop is forgotten if the server lost it", () => {
      applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
      const { result } = follow(["job-1"]);
      act(() => fake.fire("job:lifecycle", lifecycle({ kind: "repo-ingest", status: "progress" })));
      act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS));
      expect(result.current).toHaveLength(1);
      // e.g. the API restarted: the reconnect brings no replay for the job.
      reconnect();
      act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS));
      expect(result.current).toHaveLength(0);
    });

    // #473 — intended: after a deliberate `socket.disconnect()` with no
    // reconnect (a logout outside the renewal path), the wait stays paused, so
    // a job the server lost stays listed until reload instead of being
    // forgotten after REPLAY_WAIT_MS. Nothing can be heard while offline, and
    // forgetting a job that may still be running is the worse mistake.
    it("keeps a job listed while the socket stays deliberately disconnected", () => {
      applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
      const { result } = follow(["job-1"]);
      fake.socket.connected = false;
      act(() => fake.fire("disconnect", "io client disconnect"));
      act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS * 10));
      expect(result.current.map((j) => j.jobId)).toEqual(["job-1"]);
    });

    it("stops listening for connect/disconnect on unmount", () => {
      applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
      const { unmount } = follow(["job-1"]);
      // The hook's clock, plus the one re-join listener `joinJobRoom` owns (#486).
      expect(fake.listeners("connect")).toBe(2);
      expect(fake.listeners("disconnect")).toBe(1);
      unmount();
      // #473 — assert each listener is gone: the emit check below cannot see a
      // leaked `disconnect` listener, which only clears a timer.
      expect(fake.listeners("connect")).toBe(0);
      expect(fake.listeners("disconnect")).toBe(0);
      fake.socket.emit.mockClear();
      reconnect();
      expect(fake.socket.emit).not.toHaveBeenCalled();
    });
  });

  it("does nothing, and forgets nothing, with no jobs to follow", () => {
    applyJobLifecycleEvent(lifecycle({}));
    const { result } = follow([]);
    act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS));
    expect(fake.socket.emit).not.toHaveBeenCalled();
    expect(result.current).toHaveLength(1);
  });

  it("cancels the clock and releases the rooms on unmount", () => {
    applyJobLifecycleEvent(lifecycle({ kind: "repo-ingest" }));
    const { unmount } = follow(["job-1"]);
    unmount();
    act(() => vi.advanceTimersByTime(REPLAY_WAIT_MS));
    const { result } = renderHook(() => useActiveJobs());
    expect(result.current).toHaveLength(1);
    expect(fake.socket.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "job-1" });
  });

  it("leaves another follower of the same job in the room on unmount", () => {
    const other = renderHook(() => useJobLifecycle("job-1"));
    const { unmount } = follow(["job-1"]);
    unmount();
    expect(fake.socket.emit).not.toHaveBeenCalledWith("unsubscribe:job", expect.anything());
    other.unmount();
    expect(fake.socket.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "job-1" });
  });

  // #465 — the mirror case, once per hook: the OTHER follower unmounts while
  // useFollowJobs stays mounted. Each fails if that hook's cleanup emits
  // `unsubscribe:job` itself instead of releasing through `joinJobRoom`.
  it.each<[string, () => unknown]>([
    ["useJobLifecycle", () => useJobLifecycle("job-1")],
    ["useDocSectionProgress", () => useDocSectionProgress("job-1")],
    ["useJobToast", () => useJobToast("job-1")],
  ])("keeps useFollowJobs in the room when %s unmounts first", (_name, hook) => {
    const followed = follow(["job-1"]);
    const other = renderHook(hook);
    other.unmount();
    expect(fake.socket.emit).not.toHaveBeenCalledWith("unsubscribe:job", expect.anything());
    followed.unmount();
    expect(fake.socket.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "job-1" });
  });
});
