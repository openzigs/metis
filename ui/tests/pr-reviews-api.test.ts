/**
 * Epic #394 P2 (#404) — pr-reviews-api client tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "@/lib/api-client";
import { prReviewsApi } from "@/lib/pr-reviews-api";

const mockApi = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mockApi.mockReset());

describe("prReviewsApi.list", () => {
  it("issues GET without query string when no opts are provided", async () => {
    mockApi.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    const out = await prReviewsApi.list("p1");
    expect(mockApi).toHaveBeenCalledWith("/projects/p1/pr-reviews");
    expect(out.items).toEqual([]);
  });

  it("appends limit + offset when provided", async () => {
    mockApi.mockResolvedValue({ items: [], total: 0, limit: 25, offset: 50 });
    await prReviewsApi.list("p1", { limit: 25, offset: 50 });
    expect(mockApi).toHaveBeenCalledWith("/projects/p1/pr-reviews?limit=25&offset=50");
  });

  it("URL-encodes the project id", async () => {
    mockApi.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    await prReviewsApi.list("a/b");
    expect(mockApi).toHaveBeenCalledWith("/projects/a%2Fb/pr-reviews");
  });

  it("returns the unwrapped API payload", async () => {
    mockApi.mockResolvedValue({
      items: [
        {
          id: "1",
          projectId: "p1",
          repoOwner: "o",
          repoName: "r",
          prNumber: 1,
          prUrl: "u",
          lastReviewedSha: null,
          lastVerdict: null,
          lastRunId: null,
          acVerdicts: [],
          acPassRate: 0,
          updatedAt: "x",
          createdAt: "x",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const out = await prReviewsApi.list("p1");
    expect(out.items).toHaveLength(1);
    expect(out.items[0].repoOwner).toBe("o");
  });
});

describe("prReviewsApi.detail", () => {
  it("encodes the project id and supplies owner/repo as query params", async () => {
    mockApi.mockResolvedValue({
      id: "1",
      projectId: "p1",
      repoOwner: "o",
      repoName: "r",
      prNumber: 7,
      prUrl: "u",
      lastReviewedSha: null,
      lastVerdict: null,
      lastRunId: null,
      acVerdicts: [],
      acPassRate: 0,
      updatedAt: "x",
      createdAt: "x",
    });
    await prReviewsApi.detail("p&1", 7, { owner: "o", name: "r" });
    expect(mockApi).toHaveBeenCalledWith("/projects/p%261/pr-reviews/7?owner=o&repo=r");
  });
});

describe("prReviewsApi.reReview", () => {
  it("POSTs to the re-review endpoint with owner+repo body", async () => {
    mockApi.mockResolvedValue({ jobId: "job-1", queueDepth: 1, prNumber: 7 });
    const out = await prReviewsApi.reReview("p1", 7, { owner: "o", name: "r" });
    expect(out).toEqual({ jobId: "job-1", queueDepth: 1, prNumber: 7 });
    expect(mockApi).toHaveBeenCalledWith("/projects/p1/pr-reviews/7/re-review", {
      method: "POST",
      body: { owner: "o", repo: "r" },
    });
  });

  it("URL-encodes the project id segment", async () => {
    mockApi.mockResolvedValue({ jobId: "job-2", queueDepth: 0, prNumber: 9 });
    await prReviewsApi.reReview("p/1", 9, { owner: "o", name: "r" });
    expect(mockApi).toHaveBeenCalledWith(
      "/projects/p%2F1/pr-reviews/9/re-review",
      expect.any(Object),
    );
  });
});
