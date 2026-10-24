/**
 * #1471 — the worker's default processor (`processorDeps`): which resolvers a
 * job calls, and what it hands `executePrReviewJob`.
 *
 *   - A project switched off resolves no judge, no GitHub client and no
 *     budget (the #1473 review's test gap at `worker.ts`).
 *   - A manual Re-run, queued with no webhook payload, reads the pull request
 *     from GitHub first: its description, URL, branch and head SHA are what
 *     the review sees and records.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ skipped: null, runId: "run-1" })),
);
vi.mock("./pr-review-job.js", () => ({ executePrReviewJob: executeMock }));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));

const { startWorker } = await import("./worker.js");
import type { PrReviewProcessorDeps } from "./worker.js";
import type { PrReviewJobPayload } from "./queue.js";

const PROJECT = {
  id: "p1",
  autoReviewPrs: true,
  prReviewMaxDiffBytes: null,
  prReviewSkipGlobs: null,
};

function harness(overrides: Partial<PrReviewProcessorDeps> = {}) {
  const prGet = vi.fn(async (_p: unknown) => ({
    data: {
      title: "Add login",
      body: "Closes #5",
      html_url: "https://github.com/acme/site/pull/7",
      head: { sha: "sha-now", ref: "feature/login" },
    },
  }));
  const octokit = { pulls: { get: prGet, createReview: vi.fn() } };
  const judge = { evaluate: vi.fn() };
  const deps: PrReviewProcessorDeps = {
    resolveProject: vi.fn(async () => PROJECT),
    resolveJudge: vi.fn(async () => judge),
    resolveOctokit: vi.fn(async () => octokit as never),
    resolveBudget: vi.fn(async () => undefined),
    ...overrides,
  };
  const w = startWorker({
    processorDeps: deps,
    maxAttempts: 1,
    setInterval: () => 0,
    clearInterval: () => undefined,
    purge: async () => 0,
    jobEvents: { started() {}, progress() {}, completed() {}, failed() {} } as never,
  });
  const run = async (payload: Partial<PrReviewJobPayload>) => {
    w.queue.enqueue({
      deliveryId: "d1",
      projectId: "p1",
      owner: "acme",
      repo: "site",
      prNumber: 7,
      context: {},
      ...payload,
    });
    await w.queue.drain();
  };
  return { deps, octokit, judge, prGet, w, run };
}

beforeEach(() => {
  executeMock.mockClear();
});

describe("#1471 worker processor", () => {
  it("a switched-off project resolves no judge, GitHub client or budget", async () => {
    const h = harness({
      resolveProject: vi.fn(async () => ({ ...PROJECT, autoReviewPrs: false })),
    });
    await h.run({ context: { prBody: "Closes #5" } });
    expect(h.deps.resolveJudge).not.toHaveBeenCalled();
    expect(h.deps.resolveOctokit).not.toHaveBeenCalled();
    expect(h.deps.resolveBudget).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][1]).toEqual({});
    await h.w.shutdown();
  });

  it("an unresolved project resolves nothing and runs nothing", async () => {
    const h = harness({ resolveProject: vi.fn(async () => null) });
    await h.run({ context: { prBody: "Closes #5" } });
    expect(h.deps.resolveJudge).not.toHaveBeenCalled();
    expect(h.deps.resolveOctokit).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    await h.w.shutdown();
  });

  it("a project with no usable judge is handed to the executor with no clients (review_not_configured)", async () => {
    const h = harness({ resolveJudge: vi.fn(async () => null) });
    await h.run({ context: { prBody: "Closes #5" } });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][1]).toEqual({});
    expect(h.prGet).not.toHaveBeenCalled();
    await h.w.shutdown();
  });

  it("a webhook job reviews its own payload without reading the PR again", async () => {
    const h = harness();
    await h.run({
      context: {
        prTitle: "From webhook",
        prBody: "Closes #9",
        prUrl: "https://github.com/acme/site/pull/7",
        headSha: "sha-hook",
      },
    });
    expect(h.prGet).not.toHaveBeenCalled();
    const [input, deps] = executeMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input).toMatchObject({ prTitle: "From webhook", prBody: "Closes #9" });
    expect((input.job as { context: { headSha: string } }).context.headSha).toBe("sha-hook");
    expect(deps).toMatchObject({ judge: h.judge, octokit: h.octokit });
    await h.w.shutdown();
  });

  it("a manual re-run reads the PR from GitHub and reviews (and records) its current head", async () => {
    const h = harness();
    await h.run({
      deliveryId: "manual-rerun-acme-site-7",
      context: { action: "manual_rerun", headSha: "sha-last-reviewed", actorUserId: "u1" },
    });
    expect(h.prGet).toHaveBeenCalledWith({ owner: "acme", repo: "site", pull_number: 7 });
    const [input] = executeMock.mock.calls[0] as [Record<string, unknown>];
    expect(input).toMatchObject({
      prTitle: "Add login",
      prBody: "Closes #5",
      prUrl: "https://github.com/acme/site/pull/7",
    });
    expect((input.job as { context: Record<string, unknown> }).context).toMatchObject({
      action: "manual_rerun",
      headSha: "sha-now",
      branchName: "feature/login",
      actorUserId: "u1",
    });
    await h.w.shutdown();
  });

  it("a manual re-run whose PR cannot be read reviews nothing (and writes no false skip)", async () => {
    const h = harness();
    h.prGet.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    await h.run({ context: { action: "manual_rerun", headSha: "sha-last" } });
    expect(executeMock).not.toHaveBeenCalled();
    expect(h.w.queue.deadLetters()).toHaveLength(1);
    await h.w.shutdown();
  });
});
