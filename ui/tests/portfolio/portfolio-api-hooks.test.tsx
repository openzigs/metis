/**
 * #1626 — the portfolio API client's URLs, and the detail hook: it polls a
 * running assessment, stops once it is terminal, and re-reads on a job event.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const useJobLifecycle = vi.fn((_id?: string | null) => null as unknown);
vi.mock("@/hooks/use-job-events", () => ({
  useJobLifecycle: (id: string | null | undefined) => useJobLifecycle(id),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ApiError, apiFetch } from "@/lib/api-client";
import { portfolioApi } from "@/lib/portfolio-api";
import {
  PORTFOLIO_POLL_BACKOFF_MS,
  PORTFOLIO_POLL_MS,
  PORTFOLIO_PROGRESS_REFRESH_MS,
  PORTFOLIO_SOCKET_LIVE_MS,
  isFinalReadError,
  isTerminalStatus,
  portfolioKeys,
  portfolioPollInterval,
  useCreatePortfolioAssessment,
  usePortfolioAssessment,
  usePortfolioAssessments,
} from "@/lib/portfolio-hooks";
import { view } from "./fixtures";

const fetchMock = vi.mocked(apiFetch);

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  useJobLifecycle.mockReturnValue(null);
});

describe("portfolioApi", () => {
  it("POSTs a start request", async () => {
    fetchMock.mockResolvedValue({ id: "pa-1" });
    await portfolioApi.create({ statement: "x", scope: "all-accessible" });
    expect(fetchMock).toHaveBeenCalledWith("/portfolio-assessments", {
      method: "POST",
      body: { statement: "x", scope: "all-accessible" },
    });
  });

  it("GETs one assessment, its id encoded", async () => {
    fetchMock.mockResolvedValue({});
    await portfolioApi.get("pa/1");
    expect(fetchMock).toHaveBeenCalledWith("/portfolio-assessments/pa%2F1");
  });

  it("lists the caller's own, or a product's", async () => {
    fetchMock.mockResolvedValue([]);
    await portfolioApi.list();
    expect(fetchMock).toHaveBeenLastCalledWith("/portfolio-assessments");
    await portfolioApi.list("p-1");
    expect(fetchMock).toHaveBeenLastCalledWith("/portfolio-assessments", {
      params: { productId: "p-1" },
    });
  });
});

describe("isTerminalStatus", () => {
  it("is true only for completed and failed", () => {
    const statuses: Array<Parameters<typeof isTerminalStatus>[0]> = [
      "pending",
      "running",
      "completed",
      "failed",
      undefined,
    ];
    expect(statuses.map((s) => isTerminalStatus(s))).toEqual([false, false, true, true, false]);
  });
});

describe("usePortfolioAssessment", () => {
  it("polls while running and stops once completed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock
        .mockResolvedValueOnce(view({ status: "running" }))
        .mockResolvedValue(view({ status: "completed" }));
      const { result } = renderHook(() => usePortfolioAssessment("pa-1"), {
        wrapper: wrapper(client()),
      });
      await waitFor(() => expect(result.current.query.data?.status).toBe("running"));
      await vi.advanceTimersByTimeAsync(PORTFOLIO_POLL_MS + 100);
      await waitFor(() => expect(result.current.query.data?.status).toBe("completed"));
      const calls = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock.mock.calls.length).toBe(calls);
      expect(fetchMock).toHaveBeenCalledWith("/portfolio-assessments/pa-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fetch without an id", () => {
    renderHook(() => usePortfolioAssessment(null), { wrapper: wrapper(client()) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-reads the assessment on a job event, and the list on completion", async () => {
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    fetchMock.mockResolvedValue(view({ status: "running" }));
    useJobLifecycle.mockReturnValue({ jobId: "pa-1", status: "progress", progress: 50 });
    const { result, rerender } = renderHook(() => usePortfolioAssessment("pa-1"), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.job).toMatchObject({ progress: 50 }));
    expect(spy).toHaveBeenCalledWith({ queryKey: portfolioKeys.detail("pa-1") });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: portfolioKeys.list() });

    useJobLifecycle.mockReturnValue({ jobId: "pa-1", status: "completed" });
    rerender();
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: portfolioKeys.list() }));
  });
});

describe("#1673 — polling within the read limiter", () => {
  const running = { data: { status: "running" as const }, error: null };
  const NOW = 1_000_000;

  it("stops on a terminal status, and on a 403 or 404 that no later read will change", () => {
    expect(portfolioPollInterval({ data: { status: "completed" }, error: null }, 0, NOW)).toBe(
      false,
    );
    expect(portfolioPollInterval({ data: { status: "failed" }, error: null }, 0, NOW)).toBe(false);
    // `isTerminalStatus(undefined)` is false: without this, a 404 was polled forever.
    expect(portfolioPollInterval({ error: new ApiError(404, "gone") }, 0, NOW)).toBe(false);
    expect(portfolioPollInterval({ error: new ApiError(403, "no") }, 0, NOW)).toBe(false);
    expect(isFinalReadError(new ApiError(500, "x"))).toBe(false);
    expect(isFinalReadError(new Error("x"))).toBe(false);
  });

  it("keeps polling through a transient error, and waits out a 429", () => {
    expect(portfolioPollInterval({ ...running, error: new ApiError(503, "x") }, 0, NOW)).toBe(
      PORTFOLIO_POLL_MS,
    );
    expect(portfolioPollInterval({ ...running, error: new ApiError(429, "slow") }, 0, NOW)).toBe(
      PORTFOLIO_POLL_BACKOFF_MS,
    );
    const later = new ApiError(429, "slow", undefined, undefined, 60_000);
    expect(later.retryAfterMs).toBe(60_000);
    expect(portfolioPollInterval({ ...running, error: later }, 0, NOW)).toBe(60_000);
  });

  it("backs off while job events arrive, and falls back to the fast poll when they stop", () => {
    expect(portfolioPollInterval(running, 0, NOW)).toBe(PORTFOLIO_POLL_MS);
    expect(portfolioPollInterval(running, NOW - 1_000, NOW)).toBe(PORTFOLIO_POLL_BACKOFF_MS);
    expect(portfolioPollInterval(running, NOW - PORTFOLIO_SOCKET_LIVE_MS, NOW)).toBe(
      PORTFOLIO_POLL_MS,
    );
    // The backed-off rate stays well inside 300 reads per 15 minutes.
    expect((15 * 60_000) / PORTFOLIO_POLL_BACKOFF_MS).toBeLessThanOrEqual(60);
    // #1680 — so does the fast one, with room left for a second tab's reads.
    expect((15 * 60_000) / PORTFOLIO_POLL_MS).toBeLessThanOrEqual(180);
  });

  it("stops polling an assessment that answers 404", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockRejectedValue(new ApiError(404, "Portfolio assessment not found"));
      const { result } = renderHook(() => usePortfolioAssessment("pa-1"), {
        wrapper: wrapper(client()),
      });
      await waitFor(() => expect(result.current.query.isError).toBe(true));
      const calls = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads on progress at most once per window, but always on a transition", async () => {
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    fetchMock.mockResolvedValue(view({ status: "running" }));
    useJobLifecycle.mockReturnValue({ jobId: "pa-1", status: "progress", progress: 10 });
    const { rerender } = renderHook(() => usePortfolioAssessment("pa-1"), {
      wrapper: wrapper(qc),
    });
    const detailCalls = () =>
      spy.mock.calls.filter(
        (c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: portfolioKeys.detail("pa-1") }),
      ).length;
    await waitFor(() => expect(detailCalls()).toBe(1));
    useJobLifecycle.mockReturnValue({ jobId: "pa-1", status: "progress", progress: 20 });
    rerender();
    useJobLifecycle.mockReturnValue({ jobId: "pa-1", status: "progress", progress: 30 });
    rerender();
    expect(detailCalls()).toBe(1);
    useJobLifecycle.mockReturnValue({ jobId: "pa-1", status: "completed" });
    rerender();
    await waitFor(() => expect(detailCalls()).toBe(2));
    expect(PORTFOLIO_PROGRESS_REFRESH_MS).toBeGreaterThan(0);
  });
});

describe("usePortfolioAssessments", () => {
  it("reads a product's list under the list key", async () => {
    fetchMock.mockResolvedValue([]);
    const qc = client();
    renderHook(() => usePortfolioAssessments("p-1"), { wrapper: wrapper(qc) });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/portfolio-assessments", {
        params: { productId: "p-1" },
      }),
    );
    expect(qc.getQueryCache().find({ queryKey: portfolioKeys.productList("p-1") })).toBeDefined();
  });
});

describe("useCreatePortfolioAssessment", () => {
  it("starts an assessment and refreshes the lists", async () => {
    fetchMock.mockResolvedValue({ id: "pa-9" });
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useCreatePortfolioAssessment(), { wrapper: wrapper(qc) });
    const res = await result.current.mutateAsync({ statement: "x", scope: "all-accessible" });
    expect(res).toEqual({ id: "pa-9" });
    expect(spy).toHaveBeenCalledWith({ queryKey: portfolioKeys.list() });
  });
});
