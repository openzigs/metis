/**
 * Epic #609 / Issue #618 — reviews API client tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "@/lib/api-client";
import { reviewsApi } from "@/lib/reviews-api";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({});
});

describe("reviewsApi", () => {
  it("lists the queue with session-scoped filters", async () => {
    await reviewsApi.list({ assignee: "me", status: "in_review", page: 2, pageSize: 10 });
    expect(apiFetchMock).toHaveBeenCalledWith("/reviews", {
      params: {
        assignee: "me",
        requester: undefined,
        status: "in_review",
        projectId: undefined,
        page: 2,
        pageSize: 10,
      },
    });
  });

  it("lists with no filters by default", async () => {
    await reviewsApi.list();
    expect(apiFetchMock).toHaveBeenCalledWith("/reviews", {
      params: {
        assignee: undefined,
        requester: undefined,
        status: undefined,
        projectId: undefined,
        page: undefined,
        pageSize: undefined,
      },
    });
  });

  it("fetches review detail by id", async () => {
    await reviewsApi.get("rev_1");
    expect(apiFetchMock).toHaveBeenCalledWith("/reviews/rev_1");
  });

  it("posts a decision with a note", async () => {
    await reviewsApi.decide("rev_1", "approved", "LGTM");
    expect(apiFetchMock).toHaveBeenCalledWith("/reviews/rev_1/decision", {
      method: "POST",
      body: { decision: "approved", note: "LGTM" },
    });
  });

  it("omits an empty note from the decision body", async () => {
    await reviewsApi.decide("rev_1", "rejected", "");
    expect(apiFetchMock).toHaveBeenCalledWith("/reviews/rev_1/decision", {
      method: "POST",
      body: { decision: "rejected" },
    });
  });
});
