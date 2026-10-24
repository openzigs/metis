/**
 * #1471 — read a pull request's title, description, URL, head and base SHAs
 * and branch from GitHub, for a job queued without the webhook's payload.
 */
import type { DiffFetchOctokit } from "./diff-fetcher.js";
import type { PrReviewJob } from "./queue.js";

/** The pull request facts a review needs, read from GitHub. */
export interface FetchedPullRequest {
  title: string;
  body: string;
  htmlUrl: string;
  /** The commit the review is of — always present (a PR without one is a failed read). */
  headSha: string;
  /** The base branch's commit, for the `base...head` diff; `null` if GitHub sent none. */
  baseSha: string | null;
  branchName: string | null;
}

/**
 * #1471 — read the pull request itself. A manual re-run is queued with no
 * webhook payload, so without this it would review an empty description (and
 * record a false `no_linked_issue`) against the SHA the *last* review saw.
 * Throws when GitHub's answer names no head commit: there is nothing to pin
 * the review to, so it is a failed read, not a review of an unknown commit.
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
    base?: { sha?: unknown };
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const headSha = str(pr.head?.sha);
  if (!headSha) {
    throw new Error(`pull request ${job.prNumber} has no head commit`);
  }
  return {
    title: str(pr.title) ?? `PR #${job.prNumber}`,
    body: typeof pr.body === "string" ? pr.body : "",
    htmlUrl: str(pr.html_url) ?? `https://github.com/${job.owner}/${job.repo}/pull/${job.prNumber}`,
    headSha,
    baseSha: str(pr.base?.sha),
    branchName: str(pr.head?.ref),
  };
}
