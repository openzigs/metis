/**
 * Epic #298 / Issue #312 — findings-api unit tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { findingsApi } from "@/lib/findings-api";

describe("findingsApi.acknowledgeReview", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ id: "f_1", reviewedAt: "2026-04-28T00:00:00Z" });
  });

  it("POSTs to /findings/:id/review-ack with a note when one is provided", async () => {
    await findingsApi.acknowledgeReview("f_1", "looks legit");
    expect(apiFetchMock).toHaveBeenCalledWith("/findings/f_1/review-ack", {
      method: "POST",
      body: { note: "looks legit" },
    });
  });

  it("POSTs an empty body when no note is provided", async () => {
    await findingsApi.acknowledgeReview("f_2");
    expect(apiFetchMock).toHaveBeenCalledWith("/findings/f_2/review-ack", {
      method: "POST",
      body: {},
    });
  });

  it("returns the parsed response", async () => {
    const out = await findingsApi.acknowledgeReview("f_3");
    expect(out).toEqual({ id: "f_1", reviewedAt: "2026-04-28T00:00:00Z" });
  });
});
