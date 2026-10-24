/**
 * #1471 — the worker's default processor (`processorDeps`): which resolvers a
 * job calls, in which order, and what it hands `executePrReviewJob`.
 *
 *   - A project switched off resolves no judge, no GitHub client and no
 *     budget (the #1473 review's test gap at `worker.ts`).
 *   - The judge, then the budget, then the GitHub client (whose resolver
 *     decrypts the vault secret) — each only when the one before allows it.
 *   - With a monthly limit set, an unpriced judge is refused before any call
 *     (`budget_unpriced`); with no limit it reviews.
 *   - A manual Re-run, queued with no webhook payload, reads the pull request
 *     from GitHub first and reviews the `base...head` diff at exactly the head
 *     it read, which is the SHA recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ skipped: null, runId: "run-1" })),
);
const skipMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ skipped: "budget_preflight", runId: null })),
);
vi.mock("./pr-review-job.js", () => ({
  executePrReviewJob: executeMock,
  recordPrReviewJobSkip: skipMock,
}));
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

function budgetOf(status: { allowed?: boolean; capCents?: number | null } = {}) {
  return {
    check: vi.fn(async () => ({
      allowed: status.allowed ?? true,
      capCents: status.capCents ?? null,
      spentCents: 0,
      resetAt: "2026-11-01T00:00:00.000Z",
    })),
    record: vi.fn(async () => undefined),
  };
}

function harness(
  overrides: Partial<PrReviewProcessorDeps> = {},
  opts: { priced?: boolean; budget?: ReturnType<typeof budgetOf> } = {},
) {
  const order: string[] = [];
  const prGet = vi.fn(async (_p: unknown) => ({
    data: {
      title: "Add login",
      body: "Closes #5",
      html_url: "https://github.com/acme/site/pull/7",
      head: { sha: "sha-now", ref: "feature/login" },
      base: { sha: "sha-base" },
    },
  }));
  const compareDiff = vi.fn(async (_p: unknown) => "diff --git a/a b/a");
  const octokit = { pulls: { get: prGet, createReview: vi.fn() }, compareDiff };
  const judge = { evaluate: vi.fn(), priced: opts.priced ?? true };
  const budget = opts.budget ?? budgetOf();
  const deps: PrReviewProcessorDeps = {
    resolveProject: vi.fn(async () => PROJECT),
    resolveJudge: vi.fn(async () => {
      order.push("judge");
      return judge;
    }),
    resolveOctokit: vi.fn(async () => {
      order.push("octokit");
      return octokit as never;
    }),
    resolveBudget: vi.fn(async () => {
      order.push("budget");
      return budget;
    }),
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
  return { deps, octokit, judge, budget, prGet, compareDiff, order, w, run };
}

beforeEach(() => {
  executeMock.mockClear();
  skipMock.mockClear();
});

const WEBHOOK = { context: { prBody: "Closes #5", headSha: "sha-hook" } };
const RERUN = {
  context: { action: "manual_rerun", headSha: "sha-last-reviewed", actorUserId: "u1" },
};

describe("#1471 worker processor", () => {
  it("a switched-off project resolves no judge, GitHub client or budget", async () => {
    const h = harness({
      resolveProject: vi.fn(async () => ({ ...PROJECT, autoReviewPrs: false })),
    });
    await h.run(WEBHOOK);
    expect(h.deps.resolveJudge).not.toHaveBeenCalled();
    expect(h.deps.resolveOctokit).not.toHaveBeenCalled();
    expect(h.deps.resolveBudget).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][1]).toEqual({});
    await h.w.shutdown();
  });

  it("an unresolved project resolves nothing and runs nothing", async () => {
    const h = harness({ resolveProject: vi.fn(async () => null) });
    await h.run(WEBHOOK);
    expect(h.deps.resolveJudge).not.toHaveBeenCalled();
    expect(h.deps.resolveOctokit).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    await h.w.shutdown();
  });

  it("resolves the judge, then the budget, then the GitHub client", async () => {
    const h = harness();
    await h.run(WEBHOOK);
    expect(h.order).toEqual(["judge", "budget", "octokit"]);
    const [, deps] = executeMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(deps).toMatchObject({ judge: h.judge, octokit: h.octokit, budget: h.budget });
    await h.w.shutdown();
  });

  it("with no usable judge, decrypts no secret and records review_not_configured", async () => {
    const h = harness({ resolveJudge: vi.fn(async () => null) });
    await h.run(WEBHOOK);
    expect(h.deps.resolveOctokit).not.toHaveBeenCalled();
    expect(h.deps.resolveBudget).not.toHaveBeenCalled();
    expect(executeMock.mock.calls[0][1]).toEqual({});
    await h.w.shutdown();
  });

  it("with no GitHub client, records review_not_configured", async () => {
    const h = harness({ resolveOctokit: vi.fn(async () => null) });
    await h.run(WEBHOOK);
    expect(executeMock.mock.calls[0][1]).toEqual({});
    await h.w.shutdown();
  });

  it("past the monthly limit, decrypts no secret and records budget_exceeded", async () => {
    const h = harness({}, { budget: budgetOf({ allowed: false, capCents: 100 }) });
    await h.run(WEBHOOK);
    expect(h.deps.resolveOctokit).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(skipMock).toHaveBeenCalledTimes(1);
    expect(skipMock.mock.calls[0][1]).toBe("budget_exceeded");
    await h.w.shutdown();
  });

  it.each([
    ["a webhook delivery", WEBHOOK],
    ["a manual re-run", RERUN],
  ])(
    "%s for an unpriced model under a limit is refused before any call (budget_unpriced)",
    async (_label, payload) => {
      const h = harness({}, { priced: false, budget: budgetOf({ capCents: 100 }) });
      await h.run(payload);
      expect(h.judge.evaluate).not.toHaveBeenCalled();
      expect(h.deps.resolveOctokit).not.toHaveBeenCalled();
      expect(h.prGet).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
      expect(skipMock.mock.calls[0][1]).toBe("budget_unpriced");
      expect(skipMock.mock.calls[0][2]).toMatchObject({ capCents: 100 });
      await h.w.shutdown();
    },
  );

  it("an unpriced model with no limit still reviews", async () => {
    const h = harness({}, { priced: false, budget: budgetOf({ capCents: null }) });
    await h.run(WEBHOOK);
    expect(skipMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][1]).toMatchObject({ judge: h.judge });
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

  it("a manual re-run reads the PR and reviews the diff at exactly the head it read", async () => {
    const h = harness();
    await h.run({ deliveryId: "manual-rerun-acme-site-7", ...RERUN });
    expect(h.prGet).toHaveBeenCalledWith({ owner: "acme", repo: "site", pull_number: 7 });
    const [input, deps] = executeMock.mock.calls[0] as [
      Record<string, unknown>,
      { octokit: { pulls: { get: (p: unknown) => Promise<{ data: unknown }> } } },
    ];
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
    // The executor's diff read goes to base...head at the head just read.
    const diff = await deps.octokit.pulls.get({
      owner: "acme",
      repo: "site",
      pull_number: 7,
      mediaType: { format: "diff" },
    });
    expect(diff.data).toBe("diff --git a/a b/a");
    expect(h.compareDiff).toHaveBeenCalledWith({
      owner: "acme",
      repo: "site",
      base: "sha-base",
      head: "sha-now",
    });
    await h.w.shutdown();
  });

  it.each([
    [
      "cannot be read",
      () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })),
    ],
    ["names no head commit", () => Promise.resolve({ data: { title: "T", body: "Closes #5" } })],
    [
      "names no base commit",
      () => Promise.resolve({ data: { title: "T", body: "Closes #5", head: { sha: "s" } } }),
    ],
  ])(
    "a manual re-run whose PR %s reviews nothing (and writes no false skip)",
    async (_label, answer) => {
      const h = harness();
      h.prGet.mockImplementationOnce(answer as never);
      await h.run(RERUN);
      expect(executeMock).not.toHaveBeenCalled();
      expect(skipMock).not.toHaveBeenCalled();
      expect(h.w.queue.deadLetters()).toHaveLength(1);
      await h.w.shutdown();
    },
  );
});
