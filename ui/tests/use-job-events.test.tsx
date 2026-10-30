/**
 * Unit tests for the job-lifecycle socket consumer (Epic #238 / #240 + #243).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { DocSectionProgressEvent, JobLifecycleEvent } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { createQueryClient } from "@/lib/query-client";
import {
  useJobLifecycle,
  useDocSectionProgress,
  useProjectJobEvents,
  PROGRESS_INVALIDATION_MS,
} from "@/hooks/use-job-events";

// ── fake socket ────────────────────────────────────────────────────────────
type Handler = (data: unknown) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const emit = vi.fn();
  const socket = {
    connected: true,
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

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const lifecycle = (over: Partial<JobLifecycleEvent>): JobLifecycleEvent => ({
  kind: "analysis",
  jobId: "job-1",
  projectId: "p1",
  status: "started",
  ts: 1,
  ...over,
});

beforeEach(() => {
  fake = makeFakeSocket();
  vi.clearAllMocks();
});

const subscribes = (jobId: string) =>
  fake.emit.mock.calls.filter(
    ([name, payload]) => name === "subscribe:job" && (payload as { jobId: string }).jobId === jobId,
  ).length;

const listeners = (name: string) => fake.handlers.get(name)?.size ?? 0;

// #473 — a reconnect (network blip, or the token-refresh disconnect+connect)
// drops this socket's rooms on the server, so each room is re-joined on every
// connect after the first — by `joinJobRoom`, once per socket (#486). The first
// connect needs nothing: the emits made before it were buffered and reach the
// server on it.
function reconnect() {
  fake.socket.connected = false;
  act(() => fake.fire("disconnect", "transport close"));
  fake.socket.connected = true;
  act(() => fake.fire("connect", undefined));
}

// #486 — `documentation/page.tsx` mounts both hooks for the same job, twice.
// A reconnect re-joins that one room once, not once per hook instance.
describe("several hooks following one job across a reconnect (#486)", () => {
  it("sends one subscribe:job for the job, however many hooks follow it", () => {
    const qc = new QueryClient();
    renderHook(
      () => {
        useJobLifecycle("job-1");
        useDocSectionProgress("job-1");
        useJobLifecycle("job-1");
        useDocSectionProgress("job-1");
      },
      { wrapper: wrapper(qc) },
    );
    expect(listeners("connect")).toBe(1);
    fake.emit.mockClear();
    reconnect();
    expect(subscribes("job-1")).toBe(1);
  });

  it("sends no extra subscribe on the first connect", () => {
    fake.socket.connected = false;
    const qc = new QueryClient();
    renderHook(
      () => {
        useJobLifecycle("job-1");
        useDocSectionProgress("job-1");
      },
      { wrapper: wrapper(qc) },
    );
    act(() => fake.fire("connect", undefined));
    // One buffered join per hook, and nothing on top.
    expect(subscribes("job-1")).toBe(2);
  });
});

describe.each([
  ["useJobLifecycle", (id: string) => useJobLifecycle(id)],
  ["useDocSectionProgress", (id: string) => useDocSectionProgress(id)],
])("%s across a reconnect (#473)", (_name, hook) => {
  it("re-subscribes to the job's room on a reconnect", () => {
    const qc = new QueryClient();
    renderHook(() => hook("job-1"), { wrapper: wrapper(qc) });
    expect(subscribes("job-1")).toBe(1);
    reconnect();
    expect(subscribes("job-1")).toBe(2);
    reconnect();
    expect(subscribes("job-1")).toBe(3);
  });

  it("does not subscribe again on the first connect", () => {
    fake.socket.connected = false;
    const qc = new QueryClient();
    renderHook(() => hook("job-1"), { wrapper: wrapper(qc) });
    act(() => fake.fire("connect", undefined));
    expect(subscribes("job-1")).toBe(1);
    // A later connect is a reconnect.
    reconnect();
    expect(subscribes("job-1")).toBe(2);
  });

  it("removes its connect listener on unmount", () => {
    const qc = new QueryClient();
    const { unmount } = renderHook(() => hook("job-1"), { wrapper: wrapper(qc) });
    expect(listeners("connect")).toBe(1);
    unmount();
    expect(listeners("connect")).toBe(0);
    fake.emit.mockClear();
    reconnect();
    expect(fake.emit).not.toHaveBeenCalled();
  });

  it("re-subscribes to the new job, not the old one, after the job changes", () => {
    const qc = new QueryClient();
    const { rerender } = renderHook(({ id }) => hook(id), {
      wrapper: wrapper(qc),
      initialProps: { id: "job-1" },
    });
    rerender({ id: "job-2" });
    fake.emit.mockClear();
    reconnect();
    expect(subscribes("job-2")).toBe(1);
    expect(subscribes("job-1")).toBe(0);
  });
});

describe("useJobLifecycle", () => {
  it("subscribes to the job room and tracks the latest matching event", () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useJobLifecycle("job-1"), { wrapper: wrapper(qc) });

    expect(fake.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-1" });

    act(() => fake.fire("job:lifecycle", lifecycle({ status: "progress", progress: 40 })));
    expect(result.current?.status).toBe("progress");
    expect(result.current?.progress).toBe(40);
  });

  it("ignores events for other jobs", () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useJobLifecycle("job-1"), { wrapper: wrapper(qc) });
    act(() => fake.fire("job:lifecycle", lifecycle({ jobId: "other" })));
    expect(result.current).toBeNull();
  });

  it("unsubscribes and removes the listener on unmount", () => {
    const qc = new QueryClient();
    const { unmount } = renderHook(() => useJobLifecycle("job-1"), { wrapper: wrapper(qc) });
    unmount();
    expect(fake.emit).toHaveBeenCalledWith("unsubscribe:job", { jobId: "job-1" });
    expect(fake.socket.off).toHaveBeenCalled();
  });

  it("does nothing without a jobId", () => {
    const qc = new QueryClient();
    renderHook(() => useJobLifecycle(null), { wrapper: wrapper(qc) });
    expect(fake.emit).not.toHaveBeenCalled();
  });
});

describe("useDocSectionProgress", () => {
  const section = (over: Partial<DocSectionProgressEvent>): DocSectionProgressEvent => ({
    jobId: "doc-1",
    projectId: "p1",
    section: "Overview",
    status: "generating",
    ts: 1,
    ...over,
  });

  it("accumulates per-section progress keyed by section label", () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useDocSectionProgress("doc-1"), { wrapper: wrapper(qc) });

    act(() => fake.fire("job:doc-section", section({ section: "Overview", status: "generating" })));
    act(() => fake.fire("job:doc-section", section({ section: "Risks", status: "degraded" })));
    act(() => fake.fire("job:doc-section", section({ section: "Overview", status: "done" })));

    expect(result.current.Overview.status).toBe("done");
    expect(result.current.Risks.status).toBe("degraded");
    expect(Object.keys(result.current)).toHaveLength(2);
  });

  it("ignores sections for other jobs", () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useDocSectionProgress("doc-1"), { wrapper: wrapper(qc) });
    act(() => fake.fire("job:doc-section", section({ jobId: "other", section: "X" })));
    expect(Object.keys(result.current)).toHaveLength(0);
  });

  it("#980 — a new run of the same job clears the last run's section states", () => {
    const qc = new QueryClient();
    const { result, unmount } = renderHook(() => useDocSectionProgress("doc-1"), {
      wrapper: wrapper(qc),
    });
    act(() => fake.fire("job:doc-section", section({ section: "Risks", status: "degraded" })));
    // Progress and another job's start leave the sections alone.
    act(() => fake.fire("job:lifecycle", lifecycle({ jobId: "doc-1", status: "progress" })));
    act(() => fake.fire("job:lifecycle", lifecycle({ jobId: "other", status: "started" })));
    expect(result.current.Risks.status).toBe("degraded");
    // The regenerate starts: "Needs review" must not linger on an undrafted section.
    act(() => fake.fire("job:lifecycle", lifecycle({ jobId: "doc-1", status: "started" })));
    expect(result.current).toEqual({});
    act(() => fake.fire("job:doc-section", section({ section: "Overview", status: "generating" })));
    expect(Object.keys(result.current)).toEqual(["Overview"]);
    unmount();
    expect(fake.socket.off).toHaveBeenCalledWith("job:lifecycle", expect.any(Function));
  });
});

describe("useProjectJobEvents", () => {
  it("subscribes to the project room and invalidates analysis caches on a transition", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });

    expect(fake.emit).toHaveBeenCalledWith("subscribe:project", { projectId: "p1" });

    act(() => fake.fire("job:lifecycle", lifecycle({ kind: "analysis", status: "completed" })));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["analyses", "project", "p1"] });
  });

  it("invalidates document caches for a doc-generation transition", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });

    act(() =>
      fake.fire("job:lifecycle", lifecycle({ kind: "doc-generation", status: "completed" })),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["documents", "project", "p1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["documents"] });
  });

  // #29 — the Documentation list (and the Overview's docs stage) read
  // ["generated-docs", projectId], which the two keys above never matched, so a
  // finished generation stayed "generating" until something else refetched.
  it("invalidates the generated-docs list for a doc-generation transition", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });

    act(() =>
      fake.fire("job:lifecycle", lifecycle({ kind: "doc-generation", status: "completed" })),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["generated-docs", "p1"] });
  });

  it("invalidates the impact-analysis list for an impact transition", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });

    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({ kind: "impact-analysis", projectId: null, status: "completed" }),
      ),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["impact-analyses", "list"] });
  });

  it("ignores lifecycle events scoped to a different project", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });
    act(() => fake.fire("job:lifecycle", lifecycle({ projectId: "other" })));
    expect(spy).not.toHaveBeenCalled();
  });

  // ---- Epic #406 (#419): new long-running kinds handled generically --------

  it("surfaces a new-kind lifecycle event as the latest banner value", () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });

    act(() =>
      fake.fire(
        "job:lifecycle",
        lifecycle({ kind: "pr-review", status: "progress", progress: 30 }),
      ),
    );
    expect(result.current?.kind).toBe("pr-review");
    expect(result.current?.status).toBe("progress");
    expect(result.current?.progress).toBe(30);
  });

  it("invalidates a sensible project-scoped default for an unmapped new kind", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });

    act(() =>
      fake.fire("job:lifecycle", lifecycle({ kind: "embeddings-reindex", status: "completed" })),
    );
    // The generic default refreshes the project detail so any project surface converges.
    expect(spy).toHaveBeenCalledWith({ queryKey: ["projects", "detail", "p1"] });
  });

  it("does NOT fire the doc-generation special case for a new kind", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });

    act(() => fake.fire("job:lifecycle", lifecycle({ kind: "pr-review", status: "completed" })));
    // The doc-generation-only `["documents"]` blanket invalidation must not run.
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ["documents"] });
  });

  it("still fires the doc-generation special case (regression)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });

    act(() =>
      fake.fire("job:lifecycle", lifecycle({ kind: "doc-generation", status: "completed" })),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["documents", "project", "p1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["documents"] });
  });
});

// #1570 — a doc generation emits a `progress` event per Phase-1 chunk and per
// section. Each one used to refetch the whole ["generated-docs", projectId]
// prefix (the list, every cached doc, its version body, changed symbols and
// provenance), so one open Documentation page made ~3 GETs a second and
// tripped the 900 / 15 min docs limiter.
describe("useProjectJobEvents progress throttling (#1570)", () => {
  const progress = (over: Partial<JobLifecycleEvent> = {}) =>
    lifecycle({ kind: "doc-generation", jobId: "doc-1", status: "progress", ...over });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mount() {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const view = renderHook(() => useProjectJobEvents("p1"), { wrapper: wrapper(qc) });
    return { spy, ...view };
  }

  it("refreshes the list and only the generating doc, exactly, without cancelling a fetch", () => {
    const { spy } = mount();
    act(() => fake.fire("job:lifecycle", progress()));
    expect(spy.mock.calls).toEqual([
      [{ queryKey: ["generated-docs", "p1"], exact: true }, { cancelRefetch: false }],
      [{ queryKey: ["generated-docs", "p1", "doc-1"], exact: true }, { cancelRefetch: false }],
    ]);
  });

  it("refreshes at most once per window however many progress events arrive", () => {
    const { spy } = mount();
    act(() => {
      for (let i = 0; i < 50; i++) fake.fire("job:lifecycle", progress({ progress: i }));
    });
    expect(spy).toHaveBeenCalledTimes(2);
    // The window's trailing refresh picks up the last progress.
    act(() => vi.advanceTimersByTime(PROGRESS_INVALIDATION_MS));
    expect(spy).toHaveBeenCalledTimes(4);
    // Nothing more without new events.
    act(() => vi.advanceTimersByTime(PROGRESS_INVALIDATION_MS * 3));
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("refreshes again at once when the window has passed", () => {
    const { spy } = mount();
    act(() => fake.fire("job:lifecycle", progress()));
    act(() => vi.advanceTimersByTime(PROGRESS_INVALIDATION_MS));
    act(() => fake.fire("job:lifecycle", progress()));
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("throttles each job on its own", () => {
    const { spy } = mount();
    act(() => fake.fire("job:lifecycle", progress({ jobId: "doc-1" })));
    act(() => fake.fire("job:lifecycle", progress({ jobId: "doc-2" })));
    expect(spy).toHaveBeenCalledWith(
      { queryKey: ["generated-docs", "p1", "doc-2"], exact: true },
      { cancelRefetch: false },
    );
  });

  it("refreshes a terminal transition at once, and drops the pending trailing refresh", () => {
    const { spy } = mount();
    act(() => fake.fire("job:lifecycle", progress()));
    act(() => fake.fire("job:lifecycle", progress()));
    spy.mockClear();
    act(() => fake.fire("job:lifecycle", progress({ status: "completed" })));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["generated-docs", "p1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["documents"] });
    spy.mockClear();
    act(() => vi.advanceTimersByTime(PROGRESS_INVALIDATION_MS));
    expect(spy).not.toHaveBeenCalled();
  });

  it("starts a window on a transition, so the first progress after `started` waits", () => {
    const { spy } = mount();
    act(() => fake.fire("job:lifecycle", progress({ status: "started" })));
    spy.mockClear();
    act(() => fake.fire("job:lifecycle", progress()));
    expect(spy).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(PROGRESS_INVALIDATION_MS));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps the kind's own keys for a progress event of another kind", () => {
    const { spy } = mount();
    act(() => fake.fire("job:lifecycle", lifecycle({ kind: "analysis", status: "progress" })));
    expect(spy).toHaveBeenCalledWith(
      { queryKey: ["analyses", "project", "p1"] },
      { cancelRefetch: false },
    );
  });

  // The whole path with the app's own query client: a doc detail answered 429
  // waits out Retry-After, and progress events meanwhile do not restart it.
  it("leaves a doc detail waiting out a 429's Retry-After alone, then retries it", async () => {
    const qc = createQueryClient();
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({ id: "doc-1", status: "generating" })
      .mockRejectedValueOnce(
        new ApiError(429, "Too many", "GENERATED_DOCS_RATE_LIMITED", undefined, 60_000),
      )
      .mockResolvedValue({ id: "doc-1", status: "ready" });
    renderHook(
      () => {
        useProjectJobEvents("p1");
        return useQuery({ queryKey: ["generated-docs", "p1", "doc-1"], queryFn });
      },
      { wrapper: wrapper(qc) },
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(queryFn).toHaveBeenCalledTimes(1);

    // The first progress refetches, and is answered 429.
    act(() => fake.fire("job:lifecycle", progress()));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(queryFn).toHaveBeenCalledTimes(2);

    // Progress keeps arriving through the wait; none of it reaches the server.
    for (let s = 0; s < 50; s++) {
      act(() => fake.fire("job:lifecycle", progress()));
      await act(() => vi.advanceTimersByTimeAsync(1_000));
    }
    expect(queryFn).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(qc.getQueryState(["generated-docs", "p1", "doc-1"])).toMatchObject({
      status: "success",
      data: { id: "doc-1", status: "ready" },
    });
  });

  it("cancels a pending trailing refresh on unmount", () => {
    const { spy, unmount } = mount();
    act(() => fake.fire("job:lifecycle", progress()));
    act(() => fake.fire("job:lifecycle", progress()));
    spy.mockClear();
    unmount();
    act(() => vi.advanceTimersByTime(PROGRESS_INVALIDATION_MS));
    expect(spy).not.toHaveBeenCalled();
  });
});
