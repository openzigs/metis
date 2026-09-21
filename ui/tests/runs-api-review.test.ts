/**
 * Epic #192 (A.6) — runs-api review() helper tests.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "@/lib/api-client";
import { runsApi } from "@/lib/runs-api";

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

afterEach(() => mockedFetch.mockReset());

describe("runsApi.review", () => {
  it("encodes the run id and hits /run-reviews/:id", async () => {
    mockedFetch.mockResolvedValueOnce({ runId: "run/special id", review: null });
    await runsApi.review("run/special id");
    expect(mockedFetch).toHaveBeenCalledWith(
      `/run-reviews/${encodeURIComponent("run/special id")}`,
    );
  });

  it("returns review payload as-is", async () => {
    const payload = {
      runId: "r1",
      review: {
        judge: { verdicts: [], comments: [], overallVerdict: "comment", summary: "" },
        sandboxResults: [],
        reviewId: 1,
        reviewUrl: "u",
        postedAt: null,
      },
    };
    mockedFetch.mockResolvedValueOnce(payload);
    const out = await runsApi.review("r1");
    expect(out).toEqual(payload);
  });
});
