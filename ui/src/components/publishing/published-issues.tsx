"use client";

/**
 * Published issues on the publish page — #1136.
 *
 * Once a batch had published, the page gave no number and no link for what it
 * had created: run 8 read the new issue back with `gh issue list`. Watch on a
 * finished batch showed "Waiting for events…" for events that had already
 * happened. These pieces show what a batch created, on the batch, on each
 * draft, and in Watch.
 *
 * Lives in `components/` deliberately: the publish page is excluded from UI
 * coverage, so logic parked there would be untested by construction.
 */
import type { PublishBatch, PublishBatchStatus, PublishedIssue } from "@metis/shared";

/** A batch as the list endpoint returns it: with the issues it published. */
export type BatchWithIssues = PublishBatch & { publishedIssues?: PublishedIssue[] };

/** One draft's published issue, with the repository it lives in. */
export interface DraftIssue {
  issueNumber: number;
  htmlUrl: string;
  /** `owner/repo` of the batch that created it. */
  repo: string;
}

const FINISHED: ReadonlySet<PublishBatchStatus> = new Set(["completed", "failed", "cancelled"]);

/** A batch that will send no more progress: Watch has nothing to wait for. */
export function isBatchFinished(status: PublishBatchStatus): boolean {
  return FINISHED.has(status);
}

/** Only an http(s) URL becomes a link; anything else is shown as text. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function time(value: Date | string): number {
  return new Date(value).getTime();
}

function IssueLink({ repo, issueNumber, htmlUrl }: DraftIssue) {
  const label = `${repo}#${issueNumber}`;
  const href = safeHref(htmlUrl);
  if (!href) return <span className="font-mono">{label}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-primary underline underline-offset-2"
    >
      {label}
    </a>
  );
}

/**
 * The issue each draft was published as. A draft published more than once
 * (re-published to another repository, say) shows its latest publish. Dry runs
 * create nothing and failed rows have no issue, so neither is listed.
 */
export function publishedIssuesByDraft(
  batches: readonly BatchWithIssues[] | undefined,
): Map<string, DraftIssue & { publishedAt: number }> {
  const out = new Map<string, DraftIssue & { publishedAt: number }>();
  for (const b of batches ?? []) {
    if (b.dryRun) continue;
    for (const i of b.publishedIssues ?? []) {
      if (i.status === "failed") continue;
      const at = time(i.publishedAt);
      const prev = out.get(i.draftId);
      if (prev && prev.publishedAt >= at) continue;
      out.set(i.draftId, {
        issueNumber: i.issueNumber,
        htmlUrl: i.htmlUrl,
        repo: `${b.targetOwner}/${b.targetRepo}`,
        publishedAt: at,
      });
    }
  }
  return out;
}

/** The issues one batch created, for its row in Recent batches. */
export function BatchPublishedIssues({ batch }: { batch: BatchWithIssues }) {
  const issues = [...(batch.publishedIssues ?? [])].sort((a, b) => a.issueNumber - b.issueNumber);
  if (batch.dryRun || issues.length === 0) return null;
  const repo = `${batch.targetOwner}/${batch.targetRepo}`;
  return (
    <ul
      className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs"
      data-testid="batch-published-issues"
    >
      {issues.map((i) => (
        <li key={i.id}>
          {i.status === "failed" ? (
            <span className="text-destructive">1 issue not created</span>
          ) : (
            <IssueLink repo={repo} issueNumber={i.issueNumber} htmlUrl={i.htmlUrl} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** "Published as owner/repo#12", under a draft that has been published. */
export function DraftPublishedIssue({ published }: { published: DraftIssue | undefined }) {
  if (!published) return null;
  return (
    <div className="text-xs text-muted-foreground" data-testid="draft-published-issue">
      Published as <IssueLink {...published} />
    </div>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * #1136 — what Watch shows for a batch that has already finished, instead of
 * waiting for progress events that were sent before Watch was opened.
 */
export function FinishedBatchSummary({ batch }: { batch: BatchWithIssues }) {
  const headline =
    batch.status === "cancelled"
      ? "This batch was cancelled."
      : batch.status === "failed"
        ? "This batch finished with errors."
        : "This batch has finished.";
  const counts = [plural(batch.publishedCount, "issue created", "issues created")];
  if (batch.failedCount > 0) counts.push(`${batch.failedCount} failed`);
  if (batch.dedupSkipped > 0) {
    counts.push(plural(batch.dedupSkipped, "skipped as a duplicate", "skipped as duplicates"));
  }
  return (
    <div className="space-y-1" data-testid="finished-batch-summary">
      <p>
        {headline}{" "}
        {batch.dryRun
          ? "It was a dry run: nothing was written to GitHub."
          : `${counts.join(", ")}.`}
      </p>
      <BatchPublishedIssues batch={batch} />
    </div>
  );
}
