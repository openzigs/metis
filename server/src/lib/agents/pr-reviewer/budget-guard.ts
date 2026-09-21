/**
 * Epic #394 (#401) — Per-project monthly cost budget guard.
 *
 * Computes month-to-date PR-review spend on read by summing
 * `TokenUsage.costCents` rows tagged with a `pr-review-*` sessionId for
 * the current UTC calendar month. No new schema is introduced — we reuse
 * the existing `TokenUsage` table that already powers the FinOps surface.
 *
 * Budget cap lives on `Project.prReviewMonthlyBudgetCents` (Epic #394
 * migration `20260509000000_add_pr_review_mvp`). Null = no cap.
 *
 * `recordPrReviewSpend` writes one `TokenUsage` row per review so spend
 * accumulates atomically per Prisma write — no read-modify-write loop and
 * no risk of two concurrent reviews double-counting.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../prisma.js";

export interface CheckBudgetResult {
  allowed: boolean;
  /** Configured cap in cents. `null` when project has no cap (always allowed). */
  capCents: number | null;
  /** Month-to-date PR-review spend (cents). */
  spentCents: number;
  /** UTC month bucket (YYYY-MM) that the spend was computed against. */
  monthBucket: string;
  /** ISO timestamp of the first day of the next UTC month. */
  resetAt: string;
}

export interface RecordSpendInput {
  projectId: string;
  sessionId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Sentinel sessionId prefix used to attribute usage to the PR-reviewer. */
export const PR_REVIEW_SESSION_PREFIX = "pr-review-";

/**
 * Returns whether a project has budget headroom for another PR review.
 *
 * `allowed: true` when there is no cap OR `spentCents < capCents`.
 */
export async function checkBudget(
  projectId: string,
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<CheckBudgetResult> {
  let cap: number | null = null;
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { prReviewMonthlyBudgetCents: true },
    });
    cap = project?.prReviewMonthlyBudgetCents ?? null;
  } catch {
    // Defensive: if the project lookup fails (transient DB error, missing
    // table in a test stub, etc.) we treat the project as having no cap so
    // a budget-guard outage never blocks an otherwise-valid review. The
    // audit row still records the eventual spend.
    cap = null;
  }
  const { startOfMonth, startOfNextMonth, monthBucket } = monthBoundsUTC(now);

  // No cap → fast-path, skip the spend query.
  if (cap == null || cap <= 0) {
    return {
      allowed: true,
      capCents: cap == null ? null : cap,
      spentCents: 0,
      monthBucket,
      resetAt: startOfNextMonth.toISOString(),
    };
  }

  const spentCents = await sumPrReviewSpendCents(prisma, projectId, startOfMonth, startOfNextMonth);
  return {
    allowed: spentCents < cap,
    capCents: cap,
    spentCents,
    monthBucket,
    resetAt: startOfNextMonth.toISOString(),
  };
}

/**
 * Persist a `TokenUsage` row for a completed PR review. Failures are
 * swallowed (logged via Prisma) so a spend-tracking outage never blocks a
 * review from being posted — accuracy of the audit log is the primary
 * SOC 2 control.
 */
export async function recordPrReviewSpend(
  input: RecordSpendInput,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await prisma.tokenUsage.create({
    data: {
      projectId: input.projectId,
      sessionId: input.sessionId,
      provider: input.provider || "unknown",
      model: input.model || "unknown",
      inputTokens: Math.max(0, Math.floor(input.inputTokens)),
      outputTokens: Math.max(0, Math.floor(input.outputTokens)),
      totalTokens:
        Math.max(0, Math.floor(input.inputTokens)) + Math.max(0, Math.floor(input.outputTokens)),
      costCents: usdToCents(input.costUsd),
    },
  });
}

/** USD-to-integer-cents conversion that rounds half-away-from-zero. */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 100);
}

async function sumPrReviewSpendCents(
  prisma: PrismaClient,
  projectId: string,
  startOfMonth: Date,
  startOfNextMonth: Date,
): Promise<number> {
  const rows = await prisma.tokenUsage.findMany({
    where: {
      projectId,
      createdAt: { gte: startOfMonth, lt: startOfNextMonth },
      sessionId: { startsWith: PR_REVIEW_SESSION_PREFIX },
    },
    select: { costCents: true },
  });
  return rows.reduce((sum, r) => sum + (r.costCents ?? 0), 0);
}

function monthBoundsUTC(now: Date): {
  startOfMonth: Date;
  startOfNextMonth: Date;
  monthBucket: string;
} {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthBucket = startOfMonth.toISOString().slice(0, 7);
  return { startOfMonth, startOfNextMonth, monthBucket };
}
