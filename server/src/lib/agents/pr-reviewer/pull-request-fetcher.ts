/**
 * #1471 — read a pull request's title, description, URL, head SHA and branch
 * from GitHub, for a job queued without the webhook's payload.
 */
import type { DiffFetchOctokit } from "./diff-fetcher.js";
import type { PrReviewJob } from "./queue.js";

/** The pull request facts a review needs, read from GitHub. */
export interface FetchedPullRequest {
  title: string;
  body: string;
  htmlUrl: string;
  headSha: string | null;
  branchName: string | null;
}

/**
 * #1471 — read the pull request itself. A manual re-run is queued with no
 * webhook payload, so without this it would review an empty description (and
 * record a false `no_linked_issue`) against the SHA the *last* review saw.
 */
export async function fetchPullRequest(
  octokit: DiffFetchOctokit,
  job: Pick<PrReviewJob, "owner" | "repo" | "prNumber">,
): Promise<FetchedPullRequest> {
  const res = await octokit.pulls.get({
    owner: job.owner,
    repo: job.repo,
    pull_number: job.prNumber,
  });
  const pr = (res.data ?? {}) as {
    title?: unknown;
    body?: unknown;
    html_url?: unknown;
    head?: { sha?: unknown; ref?: unknown };
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    title: str(pr.title) ?? `PR #${job.prNumber}`,
    body: typeof pr.body === "string" ? pr.body : "",
    htmlUrl: str(pr.html_url) ?? `https://github.com/${job.owner}/${job.repo}/pull/${job.prNumber}`,
    headSha: str(pr.head?.sha),
    branchName: str(pr.head?.ref),
  };
}
