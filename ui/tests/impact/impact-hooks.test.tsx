import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ImpactAnalysisDetail, ImpactAnalysisSummary } from "@metis/shared";

vi.mock("@/lib/impact-analysis-api", () => ({
  impactAnalysisApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    usageClassification: vi.fn(),
    markTableFeedback: vi.fn(),
    deleteTableFeedback: vi.fn(),
  },
}));

vi.mock("@/lib/cross-project-api", () => ({
  fetchCrossProjectImpact: vi.fn(),
}));

// #240 — useImpactAnalysis invalidates on socket job-lifecycle transitions.
// Drive the returned event per-test to exercise the invalidation branches.
const useJobLifecycle = vi.fn((_id?: string | null) => null as unknown);
vi.mock("@/hooks/use-job-events", () => ({
  useJobLifecycle: (id: string | null | undefined) => useJobLifecycle(id),
}));

import { impactAnalysisApi } from "@/lib/impact-analysis-api";
import { fetchCrossProjectImpact } from "@/lib/cross-project-api";
import {
  useImpactAnalyses,
  useImpactAnalysis,
  useCreateImpactAnalysis,
  useProjectUsageClassification,
  useCrossProjectImpact,
  useMarkTableFeedback,
  useDeleteTableFeedback,
  impactAnalysisKeys,
} from "@/lib/impact-analysis-hooks";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const summary: ImpactAnalysisSummary = {
  id: "ia-0000000001",
  status: "completed",
  documentId: null,
  summary: null,
  projectCount: 2,
  totalImpactedSymbols: 3,
  startedAt: "2024-01-01T00:00:00.000Z",
  completedAt: "2024-01-01T00:01:00.000Z",
  rerunOfId: null,
};

const detail: ImpactAnalysisDetail = {
  id: "ia-0000000001",
  status: "completed",
  documentId: null,
  sourceText: "text",
  summary: null,
  errorMessage: null,
  totalImpactedSymbols: 0,
  startedAt: "2024-01-01T00:00:00.000Z",
  completedAt: "2024-01-01T00:01:00.000Z",
  projectIds: ["project-001"],
  sharedTableImpacts: [],
  rerunOfId: null,
  items: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no socket job event (the invalidation effect early-returns).
  useJobLifecycle.mockReturnValue(null);
});

describe("impactAnalysisKeys", () => {
  it("builds stable keys", () => {
    expect(impactAnalysisKeys.list()).toEqual(["impact-analyses", "list"]);
    expect(impactAnalysisKeys.detail("x")).toEqual(["impact-analyses", "detail", "x"]);
    expect(impactAnalysisKeys.usageClassification("p")).toEqual([
      "impact-analyses",
      "usage-classification",
      "p",
    ]);
    expect(impactAnalysisKeys.crossProjectImpact("p")).toEqual([
      "impact-analyses",
      "cross-project-impact",
      "p",
    ]);
  });
});

describe("useProjectUsageClassification", () => {
  it("is disabled without a projectId", () => {
    const { result } = renderHook(() => useProjectUsageClassification(null), {
      wrapper: wrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(impactAnalysisApi.usageClassification).not.toHaveBeenCalled();
  });

  it("fetches the classification for a project", async () => {
    vi.mocked(impactAnalysisApi.usageClassification).mockResolvedValue([]);
    const { result } = renderHook(() => useProjectUsageClassification("project-001"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(impactAnalysisApi.usageClassification).toHaveBeenCalledWith("project-001");
  });
});

describe("useCrossProjectImpact", () => {
  it("is disabled without a projectId (no fetch)", () => {
    const { result } = renderHook(() => useCrossProjectImpact(undefined), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchCrossProjectImpact).not.toHaveBeenCalled();
  });

  it("fetches the aggregated cross-project impact for a project", async () => {
    vi.mocked(fetchCrossProjectImpact).mockResolvedValue({
      sourceProjectId: "project-001",
      workspaceId: "ws-1",
      affectedObjects: [],
    });
    const { result } = renderHook(() => useCrossProjectImpact("project-001"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchCrossProjectImpact).toHaveBeenCalledWith("project-001");
    expect(result.current.data?.workspaceId).toBe("ws-1");
  });

  it("surfaces an error (retry disabled) so the read-only view can degrade", async () => {
    vi.mocked(fetchCrossProjectImpact).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useCrossProjectImpact("project-001"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useImpactAnalyses", () => {
  it("fetches the list", async () => {
    vi.mocked(impactAnalysisApi.list).mockResolvedValue([summary]);
    const { result } = renderHook(() => useImpactAnalyses(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([summary]);
  });
});

describe("useImpactAnalysis", () => {
  it("is disabled without an id", () => {
    const { result } = renderHook(() => useImpactAnalysis(null), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe("idle");
    expect(impactAnalysisApi.get).not.toHaveBeenCalled();
  });

  it("fetches a completed analysis and stops polling", async () => {
    vi.mocked(impactAnalysisApi.get).mockResolvedValue(detail);
    const { result } = renderHook(() => useImpactAnalysis("ia-0000000001"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(impactAnalysisApi.get).toHaveBeenCalledWith("ia-0000000001");
  });

  it("keeps polling a running analysis", async () => {
    vi.mocked(impactAnalysisApi.get).mockResolvedValue({ ...detail, status: "running" });
    const { result } = renderHook(() => useImpactAnalysis("ia-0000000001"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe("running");
  });

  it("invalidates the detail query when a socket job-lifecycle event arrives (#240)", async () => {
    // A running transition invalidates the detail query but NOT the list.
    useJobLifecycle.mockReturnValue({ jobId: "ia-0000000001", status: "running" } as never);
    vi.mocked(impactAnalysisApi.get).mockResolvedValue({ ...detail, status: "running" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useImpactAnalysis("ia-0000000001"), { wrapper: Wrapper });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: impactAnalysisKeys.detail("ia-0000000001"),
      }),
    );
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: impactAnalysisKeys.list() });
  });

  it("also invalidates the list when the job reaches a terminal state (#240)", async () => {
    useJobLifecycle.mockReturnValue({ jobId: "ia-0000000001", status: "completed" } as never);
    vi.mocked(impactAnalysisApi.get).mockResolvedValue(detail);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useImpactAnalysis("ia-0000000001"), { wrapper: Wrapper });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: impactAnalysisKeys.list() }),
    );
  });
});

describe("useMarkTableFeedback", () => {
  it("marks a table and invalidates the analysis detail query", async () => {
    vi.mocked(impactAnalysisApi.markTableFeedback).mockResolvedValue({
      id: "fb-1",
      impactItemId: "item-1",
      tableName: "crm.customers",
      columnName: null,
      verdict: "relevant",
      userId: "user-1",
      userDisplayName: "alice",
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMarkTableFeedback("ia-0000000001"), {
      wrapper: Wrapper,
    });
    const res = await result.current.mutateAsync({
      itemId: "item-1",
      tableName: "crm.customers",
      verdict: "relevant",
    });
    expect(res.verdict).toBe("relevant");
    expect(impactAnalysisApi.markTableFeedback).toHaveBeenCalledWith("ia-0000000001", "item-1", {
      tableName: "crm.customers",
      verdict: "relevant",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: impactAnalysisKeys.detail("ia-0000000001"),
    });
  });
});

describe("useDeleteTableFeedback", () => {
  it("removes a feedback mark and invalidates the analysis detail query", async () => {
    vi.mocked(impactAnalysisApi.deleteTableFeedback).mockResolvedValue(undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDeleteTableFeedback("ia-0000000001"), {
      wrapper: Wrapper,
    });
    await result.current.mutateAsync({ itemId: "item-1", feedbackId: "fb-1" });
    expect(impactAnalysisApi.deleteTableFeedback).toHaveBeenCalledWith(
      "ia-0000000001",
      "item-1",
      "fb-1",
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: impactAnalysisKeys.detail("ia-0000000001"),
    });
  });
});

describe("useCreateImpactAnalysis", () => {
  it("creates and returns the response", async () => {
    vi.mocked(impactAnalysisApi.create).mockResolvedValue({
      id: "ia-0000000002",
      status: "pending",
      projectIds: ["project-001"],
    });
    const { result } = renderHook(() => useCreateImpactAnalysis(), { wrapper: wrapper() });
    const res = await result.current.mutateAsync({
      text: "change",
      projectIds: ["project-001"],
    });
    expect(res.id).toBe("ia-0000000002");
    expect(impactAnalysisApi.create).toHaveBeenCalled();
  });
});
