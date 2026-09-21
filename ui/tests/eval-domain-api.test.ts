/**
 * Epic #803 (Epic 09) — Domain Eval API client tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status = 0;
    constructor(message: string) {
      super(message);
    }
  },
}));

import { apiFetch } from "@/lib/api-client";
import { domainEvalApi } from "@/lib/eval-api";

const mockApi = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockApi.mockReset());

describe("domainEvalApi.listRuns", () => {
  it("forwards the days window as a query param", async () => {
    mockApi.mockResolvedValueOnce({ runs: [] });
    await domainEvalApi.listRuns({ days: 30 });
    expect(mockApi).toHaveBeenCalledWith(
      "/eval/domain/runs",
      expect.objectContaining({ method: "GET", params: { days: 30 } }),
    );
  });

  it("omits days when not provided", async () => {
    mockApi.mockResolvedValueOnce({ runs: [] });
    await domainEvalApi.listRuns();
    const call = mockApi.mock.calls[0]?.[1] as { params?: Record<string, unknown> };
    expect(call.params?.days).toBeUndefined();
  });
});

describe("domainEvalApi.getRun", () => {
  it("encodes the run id into the URL", async () => {
    mockApi.mockResolvedValueOnce({});
    await domainEvalApi.getRun("2026-06-07T00:00:00Z");
    expect(mockApi).toHaveBeenCalledWith("/eval/domain/runs/2026-06-07T00%3A00%3A00Z", {
      method: "GET",
    });
  });
});
