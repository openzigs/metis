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

/**
 * One published issue as a reader names it: `owner/repo#12` on GitHub, the
 * issue key (`PROJ-12`) on Jira.
 */
export interface IssueRef {
  destination: "github" | "jira";
  label: string;
  htmlUrl: string;
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

/**
 * PR #1275 review — a Jira record is stored with `issueNumber: 0` (Jira has
 * keys, not numbers) and its browse URL, so it must never read `owner/repo#0`.
 * The key is the last segment of `…/browse/PROJ-12`; when the URL does not
 * carry one, the issue is called "Jira issue".
 */
export function jiraKeyFromUrl(url: string): string | null {
  return /\/browse\/([A-Z][A-Z0-9_]*-\d+)\b/i.exec(url)?.[1]?.toUpperCase() ?? null;
}

/** How a reader names one published issue, by where it was published. */
export function issueRef(
  issue: PublishedIssue,
  batch: Pick<PublishBatch, "targetOwner" | "targetRepo">,
): IssueRef {
  if (issue.destination === "jira") {
    return {
      destination: "jira",
      label: jiraKeyFromUrl(issue.htmlUrl) ?? "Jira issue",
      htmlUrl: issue.htmlUrl,
    };
  }
  return {
    destination: "github",
    label: `${batch.targetOwner}/${batch.targetRepo}#${issue.issueNumber}`,
    htmlUrl: issue.htmlUrl,
  };
}

function IssueLink({ label, htmlUrl }: IssueRef) {
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
 * What each draft was published as: its latest GitHub issue and its latest
 * Jira issue, GitHub first. A draft published to "both" shows both; one
 * re-published elsewhere shows the latest per destination. Dry runs create
 * nothing and failed rows have no issue, so neither is listed.
 */
export function publishedIssuesByDraft(
  batches: readonly BatchWithIssues[] | undefined,
): Map<string, IssueRef[]> {
  const latest = new Map<string, { ref: IssueRef; at: number }>();
  for (const b of batches ?? []) {
    if (b.dryRun) continue;
    for (const i of b.publishedIssues ?? []) {
      if (i.status === "failed") continue;
      const ref = issueRef(i, b);
      const key = `${i.draftId}\u0000${ref.destination}`;
      const at = time(i.publishedAt);
      const prev = latest.get(key);
      if (prev && prev.at >= at) continue;
      latest.set(key, { ref, at });
    }
  }
  const out = new Map<string, IssueRef[]>();
  for (const [key, { ref }] of latest) {
    const draftId = key.slice(0, key.indexOf("\u0000"));
    const refs = out.get(draftId) ?? [];
    refs.push(ref);
    refs.sort((a, b) =>
      a.destination === b.destination ? 0 : a.destination === "github" ? -1 : 1,
    );
    out.set(draftId, refs);
  }
  return out;
}

/** The issues one batch created, for its row in Recent batches. */
export function BatchPublishedIssues({ batch }: { batch: BatchWithIssues }) {
  const all = batch.publishedIssues ?? [];
  if (batch.dryRun || all.length === 0) return null;
  const created = all
    .filter((i) => i.status !== "failed")
    .map((i) => issueRef(i, batch))
    // GitHub by number first, then Jira by key.
    .sort((a, b) =>
      a.destination !== b.destination
        ? a.destination === "github"
          ? -1
          : 1
        : a.label.localeCompare(b.label, undefined, { numeric: true }),
    );
  const failed = all.length - created.length;
  return (
    <ul
      className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs"
      data-testid="batch-published-issues"
    >
      {created.map((ref) => (
        <li key={`${ref.destination}:${ref.label}:${ref.htmlUrl}`}>
          <IssueLink {...ref} />
        </li>
      ))}
      {failed > 0 && (
        <li className="text-destructive">
          {plural(failed, "issue not created", "issues not created")}
        </li>
      )}
    </ul>
  );
}

/** "Published as owner/repo#12 and PROJ-7", under a draft that has been published. */
export function DraftPublishedIssue({ published }: { published: readonly IssueRef[] | undefined }) {
  if (!published || published.length === 0) return null;
  return (
    <div className="text-xs text-muted-foreground" data-testid="draft-published-issue">
      Published as{" "}
      {published.map((ref, i) => (
        <span key={`${ref.destination}:${ref.label}`}>
          {i > 0 && " and "}
          <IssueLink {...ref} />
        </span>
      ))}
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
