/**
 * Epic #194 (C.5) — Eval API client tests.
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
import { evalApi } from "@/lib/eval-api";

const mockApi = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockApi.mockReset());

describe("evalApi.listLeaderboard", () => {
  it("forwards bench + days as query params", async () => {
    mockApi.mockResolvedValueOnce({ runs: [] });
    await evalApi.listLeaderboard({ bench: "swe-bench-pro", days: 7 });
    expect(mockApi).toHaveBeenCalledWith(
      "/eval/leaderboard",
      expect.objectContaining({
        method: "GET",
        params: { bench: "swe-bench-pro", days: 7 },
      }),
    );
  });

  it("omits bench when not specified", async () => {
    mockApi.mockResolvedValueOnce({ runs: [] });
    await evalApi.listLeaderboard();
    const call = mockApi.mock.calls[0]?.[1] as { params?: Record<string, unknown> };
    expect(call.params?.bench).toBeUndefined();
  });
});

describe("evalApi.getRun", () => {
  it("encodes the id into the URL", async () => {
    mockApi.mockResolvedValueOnce({ run: {}, tasks: [] });
    await evalApi.getRun("r 1");
    expect(mockApi).toHaveBeenCalledWith("/eval/leaderboard/runs/r%201", { method: "GET" });
  });
});

describe("evalApi.triggerRun", () => {
  it("POSTs the bench/model body", async () => {
    mockApi.mockResolvedValueOnce({ benchRunId: "r1", status: "completed" });
    await evalApi.triggerRun({ bench: "tau-bench", model: "gpt-5", costCapCents: 100 });
    expect(mockApi).toHaveBeenCalledWith(
      "/eval/leaderboard/run",
      expect.objectContaining({
        method: "POST",
        body: { bench: "tau-bench", model: "gpt-5", costCapCents: 100 },
      }),
    );
  });
});
