/**
 * #1136 — after a batch publishes, each created issue is shown with its number
 * and a link, on the batch and on the draft; Watch on a finished batch says it
 * finished instead of "Waiting for events…".
 *
 * The publish page is excluded from UI coverage, so the logic lives in
 * `src/components/publishing/published-issues.tsx`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PublishedIssue } from "@metis/shared";
import {
  BatchPublishedIssues,
  DraftPublishedIssue,
  FinishedBatchSummary,
  isBatchFinished,
  publishedIssuesByDraft,
  type BatchWithIssues,
} from "@/components/publishing/published-issues";

function issue(over: Partial<PublishedIssue> = {}): PublishedIssue {
  return {
    id: "pi_1",
    batchId: "batch_1",
    draftId: "draft_1",
    issueNumber: 12,
    issueId: "I_kw12",
    htmlUrl: "https://github.com/openzigs/flux-v2/issues/12",
    status: "created",
    destination: "github",
    parentIssueNumber: null,
    dedupHash: null,
    bodyHash: null,
    errorMessage: null,
    publishedAt: new Date("2026-10-13T18:19:34Z"),
    ...over,
  };
}

function batch(over: Partial<BatchWithIssues> = {}): BatchWithIssues {
  return {
    id: "batch_1",
    projectId: "proj_1",
    status: "completed",
    targetOwner: "openzigs",
    targetRepo: "flux-v2",
    targetBaseUrl: null,
    provider: "github",
    dryRun: false,
    totalDrafts: 1,
    publishedCount: 1,
    failedCount: 0,
    dedupSkipped: 0,
    archived: false,
    archivedAt: null,
    archiveReason: null,
    archivedById: null,
    dryRunPlan: null,
    startedById: "u1",
    startedAt: new Date("2026-10-13T18:19:00Z"),
    completedAt: new Date("2026-10-13T18:19:40Z"),
    errorMessage: null,
    metadata: null,
    createdAt: new Date("2026-10-13T18:19:00Z"),
    updatedAt: new Date("2026-10-13T18:19:40Z"),
    publishedIssues: [issue()],
    ...over,
  } as BatchWithIssues;
}

describe("BatchPublishedIssues (#1136)", () => {
  it("links each created issue by repository and number", () => {
    render(<BatchPublishedIssues batch={batch()} />);
    const link = screen.getByRole("link", { name: "openzigs/flux-v2#12" });
    expect(link.getAttribute("href")).toBe("https://github.com/openzigs/flux-v2/issues/12");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("lists every issue in issue-number order", () => {
    render(
      <BatchPublishedIssues
        batch={batch({
          publishedIssues: [
            issue({ id: "b", issueNumber: 14, htmlUrl: "https://github.com/o/r/issues/14" }),
            issue({ id: "a", issueNumber: 13, htmlUrl: "https://github.com/o/r/issues/13" }),
          ],
        })}
      />,
    );
    const names = screen.getAllByRole("link").map((l) => l.textContent);
    expect(names).toEqual(["openzigs/flux-v2#13", "openzigs/flux-v2#14"]);
  });

  it("shows a failed issue as failed, without a link", () => {
    render(
      <BatchPublishedIssues
        batch={batch({ publishedIssues: [issue({ status: "failed", issueNumber: 0 })] })}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/not created/i)).toBeTruthy();
  });

  it("never renders a non-http link", () => {
    render(
      <BatchPublishedIssues
        batch={batch({ publishedIssues: [issue({ htmlUrl: "javascript:alert(1)" })] })}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("openzigs/flux-v2#12")).toBeTruthy();
  });

  it("renders nothing for a dry run or a batch with no issues", () => {
    const { container, rerender } = render(
      <BatchPublishedIssues batch={batch({ dryRun: true })} />,
    );
    expect(container.textContent).toBe("");
    rerender(<BatchPublishedIssues batch={batch({ publishedIssues: [] })} />);
    expect(container.textContent).toBe("");
  });
});

describe("publishedIssuesByDraft (#1136)", () => {
  it("maps each draft to the issue it was published as, latest publish winning", () => {
    const older = batch({
      id: "b_old",
      publishedIssues: [
        issue({ batchId: "b_old", draftId: "d1", issueNumber: 3, publishedAt: new Date(1) }),
      ],
    });
    const newer = batch({
      id: "b_new",
      targetRepo: "other",
      publishedIssues: [
        issue({ batchId: "b_new", draftId: "d1", issueNumber: 9, publishedAt: new Date(2) }),
        issue({ batchId: "b_new", draftId: "d2", status: "failed", issueNumber: 0 }),
      ],
    });
    const map = publishedIssuesByDraft([newer, older]);
    expect(map.get("d1")).toEqual([
      {
        destination: "github",
        label: "openzigs/other#9",
        htmlUrl: "https://github.com/openzigs/flux-v2/issues/12",
      },
    ]);
    expect(map.has("d2")).toBe(false);
  });

  it("keeps the latest issue per destination when one draft went to both", () => {
    const b = batch({
      publishedIssues: [
        issue({ id: "gh", draftId: "d1", issueNumber: 12 }),
        issue({
          id: "jira",
          draftId: "d1",
          destination: "jira",
          issueNumber: 0,
          issueId: "10042",
          htmlUrl: "https://acme.atlassian.net/browse/FLUX-7",
        }),
      ],
    });
    expect(
      publishedIssuesByDraft([b])
        .get("d1")!
        .map((r) => r.label),
    ).toEqual(["openzigs/flux-v2#12", "FLUX-7"]);
  });

  it("ignores dry runs and tolerates batches listed without their issues", () => {
    const dry = batch({ dryRun: true });
    const bare = { ...batch(), publishedIssues: undefined } as unknown as BatchWithIssues;
    expect(publishedIssuesByDraft([dry, bare]).size).toBe(0);
    expect(publishedIssuesByDraft(undefined).size).toBe(0);
  });
});

describe("DraftPublishedIssue (#1136)", () => {
  it("says where the draft was published, with a link", () => {
    const map = publishedIssuesByDraft([batch()]);
    render(<DraftPublishedIssue published={map.get("draft_1")} />);
    expect(screen.getByText(/Published as/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "openzigs/flux-v2#12" })).toBeTruthy();
  });

  it("renders nothing for a draft that was never published", () => {
    const { container } = render(<DraftPublishedIssue published={undefined} />);
    expect(container.textContent).toBe("");
  });
});

describe("Jira and both destinations (PR #1275 review)", () => {
  const JIRA_URL = "https://acme.atlassian.net/browse/FLUX-7";
  const jira = (over: Partial<PublishedIssue> = {}) =>
    issue({
      id: "pi_jira",
      destination: "jira",
      issueNumber: 0,
      issueId: "10042",
      htmlUrl: JIRA_URL,
      ...over,
    });

  it("GitHub only: owner/repo#N, never a Jira key", () => {
    const map = publishedIssuesByDraft([batch()]);
    render(<DraftPublishedIssue published={map.get("draft_1")} />);
    expect(screen.getByTestId("draft-published-issue").textContent).toBe(
      "Published as openzigs/flux-v2#12",
    );
  });

  it("Jira only: the issue key and its browse URL, never owner/repo#0", () => {
    const b = batch({ publishedIssues: [jira()] });
    render(<BatchPublishedIssues batch={b} />);
    const link = screen.getByRole("link", { name: "FLUX-7" });
    expect(link.getAttribute("href")).toBe(JIRA_URL);
    expect(screen.queryByText(/#0/)).toBeNull();
    const map = publishedIssuesByDraft([b]);
    render(<DraftPublishedIssue published={map.get("draft_1")} />);
    expect(screen.getByTestId("draft-published-issue").textContent).toBe("Published as FLUX-7");
  });

  it("both: the draft names its GitHub issue and its Jira issue", () => {
    // The Jira record is written last, so a latest-wins rule would show only it.
    const b = batch({
      publishedIssues: [issue({ publishedAt: new Date(1) }), jira({ publishedAt: new Date(2) })],
    });
    render(<DraftPublishedIssue published={publishedIssuesByDraft([b]).get("draft_1")} />);
    expect(screen.getByTestId("draft-published-issue").textContent).toBe(
      "Published as openzigs/flux-v2#12 and FLUX-7",
    );
    expect(screen.getByRole("link", { name: "openzigs/flux-v2#12" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "FLUX-7" })).toBeTruthy();
  });

  it("both: the batch row lists GitHub first, then Jira", () => {
    render(<BatchPublishedIssues batch={batch({ publishedIssues: [jira(), issue()] })} />);
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual([
      "openzigs/flux-v2#12",
      "FLUX-7",
    ]);
  });

  it("a Jira URL with no key still never reads #0", () => {
    render(
      <BatchPublishedIssues
        batch={batch({ publishedIssues: [jira({ htmlUrl: "https://acme.example/x" })] })}
      />,
    );
    expect(screen.getByRole("link", { name: "Jira issue" })).toBeTruthy();
  });

  it("counts failed rows once instead of repeating a line per row", () => {
    render(
      <BatchPublishedIssues
        batch={batch({
          publishedIssues: [
            issue(),
            issue({ id: "f1", status: "failed", issueNumber: 0 }),
            issue({ id: "f2", status: "failed", issueNumber: 0 }),
          ],
        })}
      />,
    );
    expect(screen.getAllByText(/not created/)).toHaveLength(1);
    expect(screen.getByText("2 issues not created")).toBeTruthy();
  });
});

describe("Watch on a finished batch (#1136)", () => {
  it("knows which statuses are finished", () => {
    expect(isBatchFinished("completed")).toBe(true);
    expect(isBatchFinished("failed")).toBe(true);
    expect(isBatchFinished("cancelled")).toBe(true);
    expect(isBatchFinished("running")).toBe(false);
    expect(isBatchFinished("pending")).toBe(false);
  });

  it("says the batch finished, with its counts and the created issues", () => {
    render(<FinishedBatchSummary batch={batch()} />);
    const summary = screen.getByTestId("finished-batch-summary");
    expect(summary.textContent).toContain("This batch has finished");
    expect(summary.textContent).toContain("1 issue created");
    expect(summary.textContent).not.toMatch(/waiting/i);
    expect(screen.getByRole("link", { name: "openzigs/flux-v2#12" })).toBeTruthy();
  });

  it("says a dry run wrote nothing to GitHub", () => {
    render(
      <FinishedBatchSummary
        batch={batch({ dryRun: true, publishedCount: 0, publishedIssues: [] })}
      />,
    );
    expect(screen.getByTestId("finished-batch-summary").textContent).toContain(
      "dry run: nothing was written to GitHub",
    );
  });

  it("names failures and duplicates, and a cancelled or failed status", () => {
    render(
      <FinishedBatchSummary
        batch={batch({
          status: "failed",
          publishedCount: 2,
          failedCount: 1,
          dedupSkipped: 3,
          publishedIssues: [],
        })}
      />,
    );
    const text = screen.getByTestId("finished-batch-summary").textContent ?? "";
    expect(text).toContain("finished with errors");
    expect(text).toContain("2 issues created");
    expect(text).toContain("1 failed");
    expect(text).toContain("3 skipped as duplicates");
  });

  it("says a cancelled batch was cancelled", () => {
    render(<FinishedBatchSummary batch={batch({ status: "cancelled" })} />);
    expect(screen.getByTestId("finished-batch-summary").textContent).toContain("was cancelled");
  });
});
