/**
 * #2370 — the review queue client passes `decision=pending` through, so the
 * sidebar's count asks the server for reviews still waiting on my decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api-client";
import { reviewsApi } from "@/lib/reviews-api";

const mockApi = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockResolvedValue({ reviews: [], total: 0, page: 1, pageSize: 1 });
});

describe("reviewsApi.list — decision filter (#2370)", () => {
  it("sends decision=pending alongside assignee=me", async () => {
    await reviewsApi.list({ assignee: "me", status: "in_review", decision: "pending" });
    expect(mockApi).toHaveBeenCalledWith(
      "/reviews",
      expect.objectContaining({
        params: expect.objectContaining({
          assignee: "me",
          status: "in_review",
          decision: "pending",
        }),
      }),
    );
  });

  it("leaves it out when not asked, so the Assigned to me tab still lists decided reviews", async () => {
    await reviewsApi.list({ assignee: "me" });
    const [, opts] = mockApi.mock.calls[0]!;
    expect((opts as { params: Record<string, unknown> }).params.decision).toBeUndefined();
  });
});
