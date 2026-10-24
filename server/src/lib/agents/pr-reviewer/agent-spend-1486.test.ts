/**
 * #1486 — a PR review's model spend counts toward the #1169 monthly limit on
 * every path after the model answers: a posted review, a response that does
 * not parse, and a review GitHub refuses. The judge and the GitHub client are
 * stubs (no model spend); the budget deps are the real `checkBudget` and
 * `recordPrReviewSpend` over an in-memory ledger, so "counted" means what the
 * guard itself reads.
 */
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { runPrReview, type JudgeEnvelope, type RunPrReviewDeps } from "./agent.js";
import { checkBudget, recordPrReviewSpend, type RecordSpendInput } from "./budget-guard.js";
import type { OctokitLike } from "./github-review-poster.js";

vi.mock("./pr-audit.js", () => ({
  auditPrReviewed: vi.fn(),
  auditPrReviewErrored: vi.fn(),
  auditPrReviewSkipped: vi.fn(),
}));

const PROJECT = "proj-1486";
/** One cent: a single review's $0.05 takes the project over it. */
const CAP_CENTS = 1;

interface LedgerRow {
  projectId: string;
  sessionId: string;
  costCents: number | null;
  costUsd: number | null;
  createdAt: Date;
}

/** The two Prisma models the guard touches, over one in-memory ledger. */
function ledger(): { prisma: PrismaClient; rows: LedgerRow[] } {
  const rows: LedgerRow[] = [];
  const prisma = {
    project: {
      findUnique: async () => ({ prReviewMonthlyBudgetCents: CAP_CENTS }),
    },
    tokenUsage: {
      create: async ({ data }: { data: Omit<LedgerRow, "createdAt"> }) => {
        rows.push({ ...data, createdAt: new Date() });
        return {};
      },
      findMany: async ({
        where,
      }: {
        where: {
          projectId: string;
          createdAt: { gte: Date; lt: Date };
          sessionId: { startsWith: string };
        };
      }) =>
        rows.filter(
          (r) =>
            r.projectId === where.projectId &&
            r.createdAt >= where.createdAt.gte &&
            r.createdAt < where.createdAt.lt &&
            r.sessionId.startsWith(where.sessionId.startsWith),
        ),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
}

function budgetOver(prisma: PrismaClient) {
  const record = vi.fn((i: RecordSpendInput) => recordPrReviewSpend(i, prisma));
  const budget: NonNullable<RunPrReviewDeps["budget"]> = {
    check: (projectId) => checkBudget(projectId, prisma),
    record,
  };
  return { budget, record };
}

const VALID = JSON.stringify({
  verdicts: [{ acId: "AC1", verdict: "satisfied", reasoning: "ok", evidenceFiles: [] }],
  comments: [],
  overallVerdict: "approve",
  summary: "fine",
});

function judgeAnswering(raw: string) {
  const envelope: JudgeEnvelope = {
    raw,
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    inputTokens: 1000,
    outputTokens: 200,
    costUsd: 0.05,
  };
  return { evaluate: vi.fn(async () => envelope) };
}

function octokit(post: () => Promise<{ data: { id: number; html_url: string } }>): OctokitLike {
  return { pulls: { createReview: vi.fn(post) } };
}

const posts = () =>
  octokit(async () => ({ data: { id: 9, html_url: "https://github.com/acme/site/pull/7#r9" } }));

function input(gh: OctokitLike) {
  return {
    owner: "acme",
    repo: "site",
    prNumber: 7,
    prTitle: "t",
    prBody: "Closes #5",
    diff: "@@",
    criteria: [{ id: "AC1", text: "thing" }],
    octokit: gh,
    projectId: PROJECT,
  };
}

describe("PR-review spend is counted on every path after the model answers (#1486)", () => {
  it("a posted review: recorded once, and the limit now refuses the next review", async () => {
    const { prisma, rows } = ledger();
    const { budget, record } = budgetOver(prisma);
    const out = await runPrReview(input(posts()), { judge: judgeAnswering(VALID), budget });
    expect(out.reviewId).toBe(9);
    expect(record).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    const verdict = await checkBudget(PROJECT, prisma);
    expect(verdict.spentCents).toBe(5);
    expect(verdict.allowed).toBe(false);
  });

  it("a response that does not parse: the review fails, the spend still counts", async () => {
    const { prisma } = ledger();
    const { budget, record } = budgetOver(prisma);
    const gh = posts();
    await expect(
      runPrReview(input(gh), { judge: judgeAnswering("not JSON at all"), budget }),
    ).rejects.toThrow();
    expect(gh.pulls.createReview).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    const verdict = await checkBudget(PROJECT, prisma);
    expect(verdict.spentCents).toBe(5);
    expect(verdict.allowed).toBe(false);
  });

  it("a review GitHub refuses: the review fails, the spend still counts", async () => {
    const { prisma } = ledger();
    const { budget, record } = budgetOver(prisma);
    const refused = octokit(async () => {
      throw Object.assign(new Error("Unprocessable Entity"), { status: 422 });
    });
    await expect(
      runPrReview(input(refused), { judge: judgeAnswering(VALID), budget }),
    ).rejects.toThrow("Unprocessable Entity");
    expect(record).toHaveBeenCalledTimes(1);
    const verdict = await checkBudget(PROJECT, prisma);
    expect(verdict.spentCents).toBe(5);
    expect(verdict.allowed).toBe(false);
  });

  it("a review that keeps failing is refused once the failures reach the limit", async () => {
    const { prisma } = ledger();
    const { budget } = budgetOver(prisma);
    const judge = judgeAnswering(VALID);
    const refused = octokit(async () => {
      throw new Error("Unprocessable Entity");
    });
    await expect(runPrReview(input(refused), { judge, budget })).rejects.toThrow();
    const second = await runPrReview(input(refused), { judge, budget });
    expect(second.skipped).toBe("budget_exceeded");
    expect(judge.evaluate).toHaveBeenCalledTimes(1);
  });

  it("a model call that throws has no answer and no usage, so nothing is recorded", async () => {
    const { prisma, rows } = ledger();
    const { budget, record } = budgetOver(prisma);
    const judge = {
      evaluate: vi.fn(async (): Promise<JudgeEnvelope> => {
        throw new Error("LLM unavailable");
      }),
    };
    await expect(runPrReview(input(posts()), { judge, budget })).rejects.toThrow("LLM unavailable");
    expect(record).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });
});
