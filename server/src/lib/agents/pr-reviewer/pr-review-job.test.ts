/**
 * #1470 — `executePrReviewJob` writes each job's outcome to `PrReviewState`.
 *
 * Unit-level: every collaborator is a stub so each branch of the executor can
 * be driven on its own. The end-to-end proof (real worker, real SQLite, the
 * page's API) is `server/tests/pr-review-state-1470.sqlite.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resolveAc: vi.fn(),
  fetchPrDiff: vi.fn(),
  runPrReview: vi.fn(),
  startRun: vi.fn(async () => "run_1"),
  finishRun: vi.fn(async () => undefined),
  recordStep: vi.fn(async () => undefined),
  computeRunCost: vi.fn(async () => ({ costCents: 0, totalTokens: 0 })),
  record: vi.fn(async () => ({})),
  auditSkipped: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./ac-traceability.js", () => ({ resolveAcceptanceCriteriaForPr: m.resolveAc }));
vi.mock("./diff-fetcher.js", () => ({ fetchPrDiff: m.fetchPrDiff }));
vi.mock("./agent.js", () => ({
  runPrReview: m.runPrReview,
  defaultBudgetDeps: () => ({ check: vi.fn(), record: vi.fn() }),
}));
vi.mock("./pr-audit.js", () => ({ auditPrReviewSkipped: m.auditSkipped }));
vi.mock("./state-repo.js", () => ({ recordPrReviewOutcome: m.record }));
vi.mock("../../replay/runs-service.js", () => ({
  startRun: m.startRun,
  finishRun: m.finishRun,
  recordStep: m.recordStep,
  computeRunCost: m.computeRunCost,
}));
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ warn: m.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  executePrReviewJob,
  recordPrReviewJobSkip,
  type ExecutePrReviewJobInput,
} from "./pr-review-job.js";
import { createPrReviewQueue } from "./queue.js";

const KEY = { projectId: "p1", repoOwner: "acme", repoName: "site", prNumber: 7 };

function input(over: Partial<ExecutePrReviewJobInput> = {}): ExecutePrReviewJobInput {
  return {
    job: {
      deliveryId: "d1",
      projectId: "p1",
      owner: "acme",
      repo: "site",
      prNumber: 7,
      context: { action: "opened", headSha: "head-sha" },
      attempt: 1,
      enqueuedAt: 0,
    },
    project: {
      id: "p1",
      autoReviewPrs: true,
      prReviewMaxDiffBytes: null,
      prReviewSkipGlobs: null,
    },
    prTitle: "t",
    prBody: "Closes #5",
    prUrl: "https://github.com/acme/site/pull/7",
    installationId: null,
    actor: { type: "webhook", id: null },
    ...over,
  };
}

const deps = { judge: { evaluate: vi.fn() }, octokit: {} as never };

const verdicts = [{ acId: "AC-1", verdict: "satisfied", reasoning: "ok", evidenceFiles: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  m.resolveAc.mockResolvedValue({ criteria: [{ id: "AC-1" }], linkedIssueNumbers: [5] });
  m.fetchPrDiff.mockResolvedValue({ diff: "d", tooLarge: false, rawBytes: 1 });
  m.runPrReview.mockResolvedValue({
    skipped: null,
    verdict: "approve",
    reviewUrl: "https://github.com/acme/site/pull/7#pullrequestreview-1",
    judge: { verdicts, comments: [], overallVerdict: "approve", summary: "s" },
  });
});

describe("executePrReviewJob records its outcome (#1470)", () => {
  it("a completed review: status, verdict, link, run, head SHA and verdicts", async () => {
    const out = await executePrReviewJob(input(), deps);
    expect(out).toEqual({ skipped: null, runId: "run_1" });
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record).toHaveBeenCalledWith(KEY, {
      status: "reviewed",
      headSha: "head-sha",
      acVerdicts: verdicts,
      runId: "run_1",
      verdict: "approve",
      reviewUrl: "https://github.com/acme/site/pull/7#pullrequestreview-1",
    });
    expect(m.finishRun).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("a skip inside the review (budget) is recorded with its reason", async () => {
    m.runPrReview.mockResolvedValue({
      skipped: "budget_exceeded",
      verdict: null,
      reviewUrl: null,
      judge: { verdicts: [], comments: [], overallVerdict: "comment", summary: "" },
    });
    await executePrReviewJob(input(), deps);
    expect(m.record).toHaveBeenCalledWith(KEY, { status: "skipped", reason: "budget_exceeded" });
  });

  it("a review that throws is recorded as failed, pointing at its run", async () => {
    m.runPrReview.mockRejectedValue(new Error("judge down"));
    await executePrReviewJob(input(), deps);
    expect(m.record).toHaveBeenCalledWith(KEY, { status: "failed", runId: "run_1" });
    expect(m.finishRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("a bookkeeping error after the review was posted does not rewrite it as failed", async () => {
    m.recordStep.mockRejectedValueOnce(new Error("db hiccup"));
    await executePrReviewJob(input(), deps);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record).toHaveBeenCalledWith(KEY, expect.objectContaining({ status: "reviewed" }));
  });

  it("no head SHA in the job is recorded as null", async () => {
    await executePrReviewJob(input({ job: { ...input().job, context: {} } }), deps);
    expect(m.record).toHaveBeenCalledWith(KEY, expect.objectContaining({ headSha: null }));
  });

  it("no linked acceptance criteria: skipped with the resolver's reason, nothing fetched", async () => {
    m.resolveAc.mockResolvedValue({
      criteria: [],
      linkedIssueNumbers: [],
      skipReason: "no_linked_issue",
    });
    const out = await executePrReviewJob(input(), deps);
    expect(out.skipped).toBe("ac_resolve_skip");
    expect(m.record).toHaveBeenCalledWith(KEY, { status: "skipped", reason: "no_linked_issue" });
    expect(m.fetchPrDiff).not.toHaveBeenCalled();
  });

  it("a diff GitHub would not return: skipped as diff_unavailable", async () => {
    m.fetchPrDiff.mockRejectedValue(new Error("404"));
    const out = await executePrReviewJob(input(), deps);
    expect(out.skipped).toBe("diff_fetch_failed");
    expect(m.record).toHaveBeenCalledWith(KEY, { status: "skipped", reason: "diff_unavailable" });
    expect(m.startRun).not.toHaveBeenCalled();
  });

  it("a diff over the size limit: skipped as diff_too_large", async () => {
    m.fetchPrDiff.mockResolvedValue({ diff: "", tooLarge: true, rawBytes: 9e9 });
    const out = await executePrReviewJob(input(), deps);
    expect(out.skipped).toBe("diff_too_large");
    expect(m.record).toHaveBeenCalledWith(KEY, { status: "skipped", reason: "diff_too_large" });
  });

  it("review switched off: skipped as auto_review_disabled, with no judge needed and nothing run", async () => {
    const out = await executePrReviewJob(
      input({ project: { ...input().project!, autoReviewPrs: false } }),
      {},
    );
    expect(out).toEqual({ skipped: "no_project_or_auto_review_disabled", runId: null });
    expect(m.record).toHaveBeenCalledWith(KEY, {
      status: "skipped",
      reason: "auto_review_disabled",
    });
    expect(m.resolveAc).not.toHaveBeenCalled();
    expect(m.runPrReview).not.toHaveBeenCalled();
  });

  it("no project: nothing to scope a row to, so nothing is written", async () => {
    const out = await executePrReviewJob(input({ project: null }), deps);
    expect(out.skipped).toBe("no_project_or_auto_review_disabled");
    expect(m.record).not.toHaveBeenCalled();
  });

  it("no judge or GitHub client for a live project: skipped as review_not_configured", async () => {
    const out = await executePrReviewJob(input(), {});
    expect(out.skipped).toBe("no_judge_or_octokit");
    expect(m.record).toHaveBeenCalledWith(KEY, {
      status: "skipped",
      reason: "review_not_configured",
    });
    expect(m.resolveAc).not.toHaveBeenCalled();
    expect(m.startRun).not.toHaveBeenCalled();
  });

  it("the row is keyed by the resolved project, not the job payload's project id", async () => {
    await executePrReviewJob(input({ job: { ...input().job, projectId: "someone-else" } }), deps);
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
      expect.anything(),
    );
  });

  it("a failed state write is logged and never fails the job", async () => {
    m.record.mockRejectedValueOnce(new Error("db down"));
    const out = await executePrReviewJob(input(), deps);
    expect(out).toEqual({ skipped: null, runId: "run_1" });
    expect(m.warn).toHaveBeenCalledWith(
      "pr_review.state_write_failed",
      expect.objectContaining({ prNumber: 7, status: "reviewed", error: "db down" }),
    );
    expect(m.finishRun).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });
});

describe("bookkeeping after the review never makes the queue run it again (#1486)", () => {
  afterEach(() => {
    m.recordStep.mockReset().mockImplementation(async () => undefined);
    m.finishRun.mockReset().mockImplementation(async () => undefined);
  });

  it("a posted review whose run bookkeeping fails still resolves the job", async () => {
    m.recordStep.mockRejectedValue(new Error("db down"));
    m.finishRun.mockRejectedValue(new Error("db down"));
    const out = await executePrReviewJob(input(), deps);
    expect(out).toEqual({ skipped: null, runId: "run_1" });
    expect(m.runPrReview).toHaveBeenCalledTimes(1);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record).toHaveBeenCalledWith(KEY, expect.objectContaining({ status: "reviewed" }));
    expect(m.warn).toHaveBeenCalledWith(
      "pr_review.bookkeeping_failed",
      expect.objectContaining({ prNumber: 7, step: "record_step", error: "db down" }),
    );
  });

  it("a failed review whose run bookkeeping fails still resolves the job", async () => {
    m.runPrReview.mockRejectedValue(new Error("422 from GitHub"));
    m.recordStep.mockRejectedValue(new Error("db down"));
    m.finishRun.mockRejectedValue(new Error("db down"));
    const out = await executePrReviewJob(input(), deps);
    expect(out).toEqual({ skipped: null, runId: "run_1" });
    expect(m.record).toHaveBeenCalledWith(KEY, { status: "failed", runId: "run_1" });
    expect(m.warn).toHaveBeenCalledWith(
      "pr_review.bookkeeping_failed",
      expect.objectContaining({ step: "finish_run", error: "db down" }),
    );
  });

  it("through the queue: the model is called and the review posted once, never retried", async () => {
    m.recordStep.mockRejectedValue(new Error("db down"));
    m.finishRun.mockRejectedValue(new Error("db down"));
    const timers: Array<() => void> = [];
    const q = createPrReviewQueue({
      processor: async (job) => {
        await executePrReviewJob(input({ job }), deps);
      },
      maxAttempts: 3,
      backoffMs: [10, 10],
      setTimer: (cb) => {
        timers.push(cb);
        return 0;
      },
    });
    q.enqueue({
      deliveryId: "d1",
      projectId: "p1",
      owner: "acme",
      repo: "site",
      prNumber: 7,
      context: { action: "opened", headSha: "head-sha" },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(m.runPrReview).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
    expect(q.deadLetters()).toHaveLength(0);
  });
});

describe("recordPrReviewJobSkip (#1471)", () => {
  it.each(["budget_exceeded", "budget_unpriced"] as const)(
    "records %s on the row and in the audit, reviewing nothing",
    async (reason) => {
      const out = await recordPrReviewJobSkip(input(), reason, { capCents: 100 });
      expect(out).toEqual({ skipped: "budget_preflight", runId: null });
      expect(m.record).toHaveBeenCalledWith(KEY, { status: "skipped", reason });
      expect(m.auditSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ reason, projectId: "p1", details: { capCents: 100 } }),
      );
      expect(m.runPrReview).not.toHaveBeenCalled();
    },
  );

  it("records nothing without a project", async () => {
    const out = await recordPrReviewJobSkip(input({ project: null }), "budget_unpriced", {});
    expect(out.skipped).toBe("no_project_or_auto_review_disabled");
    expect(m.record).not.toHaveBeenCalled();
  });
});
