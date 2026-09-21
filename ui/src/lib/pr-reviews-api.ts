/**
 * Epic #394 P2 (#404) — typed client for the PR-review history endpoints.
 */
import { apiFetch } from "@/lib/api-client";

export interface PrReviewVerdict {
  acId: string;
  verdict: "satisfied" | "not_satisfied" | "uncertain";
  reasoning: string;
  evidenceFiles: string[];
}

export interface PrReviewStateView {
  id: string;
  projectId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  lastReviewedSha: string | null;
  lastVerdict: string | null;
  lastRunId: string | null;
  acVerdicts: PrReviewVerdict[];
  acPassRate: number;
  updatedAt: string;
  createdAt: string;
}

export interface PrReviewsListResponse {
  items: PrReviewStateView[];
  total: number;
  limit: number;
  offset: number;
}

export const prReviewsApi = {
  async list(
    projectId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<PrReviewsListResponse> {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString();
    const path = `/projects/${encodeURIComponent(projectId)}/pr-reviews${qs ? `?${qs}` : ""}`;
    return apiFetch<PrReviewsListResponse>(path);
  },

  async detail(
    projectId: string,
    prNumber: number,
    repo: { owner: string; name: string },
  ): Promise<PrReviewStateView> {
    const params = new URLSearchParams({ owner: repo.owner, repo: repo.name });
    const path = `/projects/${encodeURIComponent(projectId)}/pr-reviews/${prNumber}?${params.toString()}`;
    return apiFetch<PrReviewStateView>(path);
  },

  /**
   * Epic #394 P2 review #404 — manually re-enqueue a review onto the
   * worker queue. Requires `pr.review.manage`; the API surfaces a 403
   * when the caller lacks the permission and the page renders a clear
   * message instead of a generic error.
   */
  async reReview(
    projectId: string,
    prNumber: number,
    repo: { owner: string; name: string },
  ): Promise<{ jobId: string; queueDepth: number; prNumber: number }> {
    const path = `/projects/${encodeURIComponent(projectId)}/pr-reviews/${prNumber}/re-review`;
    return apiFetch<{ jobId: string; queueDepth: number; prNumber: number }>(path, {
      method: "POST",
      body: { owner: repo.owner, repo: repo.name },
    });
  },
};
