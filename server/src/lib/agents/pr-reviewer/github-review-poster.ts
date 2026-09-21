/**
 * Epic #192 (A.4) — GitHub review poster.
 *
 * Wraps `@octokit/rest` to post a structured review (verdict + per-comment
 * inline annotations) to a pull request. The Octokit client is injected so
 * tests stay hermetic and the production build can pull the token from the
 * vault.
 */

export interface OctokitLike {
  pulls: {
    createReview: (params: {
      owner: string;
      repo: string;
      pull_number: number;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: Array<{ path: string; line: number; body: string }>;
    }) => Promise<{ data: { id: number; html_url: string } }>;
  };
}

export interface PostReviewInput {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  prNumber: number;
  verdict: "approve" | "request_changes" | "comment";
  summary: string;
  inlineComments: Array<{ filePath: string; line: number; body: string }>;
}

const VERDICT_TO_EVENT: Record<
  PostReviewInput["verdict"],
  "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

export async function postPrReview(input: PostReviewInput): Promise<{
  reviewId: number;
  reviewUrl: string;
}> {
  const event = VERDICT_TO_EVENT[input.verdict];
  // Octokit rejects line:0 — skip any comment that doesn't have a positive line.
  const comments = input.inlineComments
    .filter((c) => c.filePath && Number.isFinite(c.line) && c.line > 0)
    .slice(0, 50) // GitHub caps at 50 comments per review
    .map((c) => ({ path: c.filePath, line: c.line, body: c.body }));
  const body = input.summary || "METIS PR-Reviewer review";
  const out = await input.octokit.pulls.createReview({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    event,
    body,
    comments: comments.length > 0 ? comments : undefined,
  });
  return { reviewId: out.data.id, reviewUrl: out.data.html_url };
}
