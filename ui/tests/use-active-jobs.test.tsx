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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { JobKind, JobLifecycleEvent } from "@metis/shared";
import {
  useActiveJobs,
  applyJobLifecycleEvent,
  jobKindLabel,
  __resetActiveJobsForTests,
} from "@/hooks/use-active-jobs";

// ── fake socket (mirrors use-job-events.test.tsx) ───────────────────────────
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
