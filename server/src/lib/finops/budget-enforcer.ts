/**
 * Project budget enforcer + cost projection (Epic #164).
 *
 *   • `assertWithinBudget(projectId)` — throws `BudgetExceededError` (HTTP
 *     402) when the project has a `monthlyTokenBudget` set and the running
 *     month-to-date `TokenUsage.totalTokens` SUM exceeds it. Returns the
 *     usage snapshot otherwise so callers can surface remaining-quota.
 *   • `projectMonthlyCost(projectId)` — pro-rates current MTD cost over
 *     the calendar month. Used for the `projectedMonthlyCostCents` field
 *     on the usage summary endpoint and the autopilot ceiling check.
 *   • `projectMonthlyCostForCeiling(projectId)` — the projection a cost
 *     CEILING compares against. Unlike `projectMonthlyCost` it re-prices
 *     rows recorded as unpriced (#22) with today's price source and reports
 *     the tokens that are still unpriced, so a ceiling can fail closed.
 *   • `summarizeUsage(projectId, from, to)` — full usage rollup that
 *     powers `GET /api/projects/:id/usage`.
 */
import { prisma } from "../prisma.js";
import { computeCostCents, resolveRate } from "./provider-rates.js";

export class BudgetExceededError extends Error {
  readonly status = 402;
  readonly code = "BUDGET_EXCEEDED";
  readonly usedTokens: number;
  readonly budget: number;
  constructor(usedTokens: number, budget: number) {
    super(`Project monthly budget exceeded: used ${usedTokens} of ${budget} tokens`);
    this.name = "BudgetExceededError";
    this.usedTokens = usedTokens;
    this.budget = budget;
  }
}

export interface BudgetSnapshot {
  /** Tokens used so far this calendar month (UTC). */
  usedTokens: number;
  /** Hard cap from `Project.monthlyTokenBudget` — null = no cap. */
  budget: number | null;
  /** `budget - usedTokens` (clamped at 0). Always 0 when budget is null. */
  remainingTokens: number;
  /** Pro-rated month-end projection in integer cents. */
  projectedMonthlyCostCents: number;
  /** Month-to-date cost in integer cents. */
  monthToDateCostCents: number;
}

function monthBoundsUtc(now: Date = new Date()): {
  start: Date;
  end: Date;
  daysInMonth: number;
  dayOfMonth: number;
} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const daysInMonth = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const dayOfMonth = now.getUTCDate();
  return { start, end, daysInMonth, dayOfMonth };
}

async function getProjectBudget(projectId: string): Promise<number | null> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { monthlyTokenBudget: true },
  });
  return row?.monthlyTokenBudget ?? null;
}

async function getMtdAggregate(
  projectId: string,
  now: Date = new Date(),
): Promise<{ tokens: number; cents: number; unpricedTokens: number }> {
  const { start } = monthBoundsUtc(now);
  const rows = await prisma.tokenUsage.findMany({
    where: { projectId, createdAt: { gte: start } },
    select: { totalTokens: true, costCents: true },
  });
  let tokens = 0;
  let cents = 0;
  let unpricedTokens = 0;
  for (const r of rows) {
    tokens += r.totalTokens;
    // #22 — an unpriced row (null) adds tokens but no known cost.
    if (r.costCents === null) unpricedTokens += r.totalTokens;
    else cents += r.costCents;
  }
  return { tokens, cents, unpricedTokens };
}

/**
 * Throws when the project is over its monthly token budget. Always returns
 * a snapshot so admin tooling can show remaining-quota even when no budget
 * is configured.
 */
export async function assertWithinBudget(
  projectId: string,
  now: Date = new Date(),
): Promise<BudgetSnapshot> {
  const budget = await getProjectBudget(projectId);
  const mtd = await getMtdAggregate(projectId, now);
  const projected = projectMonthlyFromMtd(mtd.cents, now);
  const snapshot: BudgetSnapshot = {
    usedTokens: mtd.tokens,
    budget,
    remainingTokens: budget == null ? 0 : Math.max(0, budget - mtd.tokens),
    projectedMonthlyCostCents: projected,
    monthToDateCostCents: mtd.cents,
  };
  if (budget != null && mtd.tokens >= budget) {
    throw new BudgetExceededError(mtd.tokens, budget);
  }
  return snapshot;
}

export function projectMonthlyFromMtd(monthToDateCents: number, now: Date = new Date()): number {
  const { daysInMonth, dayOfMonth } = monthBoundsUtc(now);
  if (dayOfMonth <= 0) return monthToDateCents;
  // Pro-rate linearly. Ceil so the projection is conservative.
  return Math.ceil((monthToDateCents * daysInMonth) / dayOfMonth);
}

export async function projectMonthlyCost(
  projectId: string,
  now: Date = new Date(),
): Promise<number> {
  const mtd = await getMtdAggregate(projectId, now);
  return projectMonthlyFromMtd(mtd.cents, now);
}

/** #22 review — what a cost ceiling can and cannot see this month. */
export interface CeilingProjection {
  /** Pro-rated month-end projection of the spend METIS can price, in cents. */
  projectedCents: number;
  /**
   * Month-to-date tokens that have NO price, even after re-pricing with the
   * current price source. Non-zero means the projection is a LOWER BOUND and a
   * ceiling cannot be evaluated.
   */
  unpricedTokens: number;
}

/**
 * #22 review (PR #41) — the projection a cost CEILING compares against.
 *
 * Rows are recorded with a NULL cost when their model was unpriced at record
 * time. Summing only priced cents made the projection 0 on a deployment whose
 * every row is unpriced (DeepSeek through `ANTHROPIC_BASE_URL`), so a ceiling
 * could never fire. Here a NULL row is re-priced with {@link resolveRate} — an
 * administrator who sets `MODEL_PRICES` therefore covers the month's earlier
 * rows too — and whatever still has no price is returned as `unpricedTokens`
 * so the caller can refuse rather than treat unknown spend as zero.
 */
export async function projectMonthlyCostForCeiling(
  projectId: string,
  now: Date = new Date(),
): Promise<CeilingProjection> {
  const { start } = monthBoundsUtc(now);
  const rows = await prisma.tokenUsage.findMany({
    where: { projectId, createdAt: { gte: start } },
    select: {
      provider: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      totalTokens: true,
      costCents: true,
    },
  });
  let cents = 0;
  let unpricedTokens = 0;
  for (const r of rows) {
    const rowCents =
      r.costCents ??
      computeCostCents(resolveRate(r.provider, r.model), {
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
      });
    if (rowCents === null) unpricedTokens += r.totalTokens;
    else cents += rowCents;
  }
  return { projectedCents: projectMonthlyFromMtd(cents, now), unpricedTokens };
}

export interface UsageWindow {
  /** Inclusive start (defaults to first of current month UTC). */
  from?: Date;
  /** Exclusive end (defaults to now). */
  to?: Date;
}

export interface UsageSummaryRow {
  projectId: string;
  from: string;
  to: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cost of the PRICED usage only — unpriced usage is in {@link unpriced}. */
  costCents: number;
  /**
   * #22 — usage from models METIS had no price for (`costCents` NULL). Kept
   * apart so an unknown cost is never summed in as $0.
   */
  unpriced: UnpricedUsage;
  projectedMonthlyCostCents: number;
  monthlyTokenBudget: number | null;
  monthToDateTokens: number;
  /**
   * PR #41 review — month-to-date tokens left OUT of
   * `projectedMonthlyCostCents` because they were unpriced, so a view can say
   * the projection is incomplete instead of showing a bare $0.
   */
  monthToDateUnpricedTokens: number;
  byProvider: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** `null` when NONE of this model's usage was priced. */
    costCents: number | null;
    /** Tokens from this model's unpriced rows. */
    unpricedTokens: number;
  }>;
  byDay: Array<{
    day: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costCents: number;
    unpricedTokens: number;
  }>;
}

/** #22 — token totals for usage recorded without a price. */
export interface UnpricedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of recorded model calls. */
  calls: number;
}

/**
 * Aggregate usage across an arbitrary window. The returned rollups are
 * deterministic-ordered so the UI can render them without re-sorting.
 */
export async function summarizeUsage(
  projectId: string,
  window: UsageWindow = {},
  now: Date = new Date(),
): Promise<UsageSummaryRow> {
  const { start: monthStart } = monthBoundsUtc(now);
  const from = window.from ?? monthStart;
  const to = window.to ?? now;
  const rows = await prisma.tokenUsage.findMany({
    where: { projectId, createdAt: { gte: from, lt: to } },
    select: {
      provider: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      costCents: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costCents = 0;
  const unpriced: UnpricedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
  const byProviderMap = new Map<string, UsageSummaryRow["byProvider"][number]>();
  const byDayMap = new Map<string, UsageSummaryRow["byDay"][number]>();

  for (const r of rows) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    totalTokens += r.totalTokens;
    const rowCents = r.costCents;
    if (rowCents === null) {
      unpriced.inputTokens += r.inputTokens;
      unpriced.outputTokens += r.outputTokens;
      unpriced.totalTokens += r.totalTokens;
      unpriced.calls += 1;
    } else {
      costCents += rowCents;
    }
    const pkey = `${r.provider}:${r.model}`;
    const cur = byProviderMap.get(pkey) ?? {
      provider: r.provider,
      model: r.model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costCents: null,
      unpricedTokens: 0,
    };
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    cur.totalTokens += r.totalTokens;
    if (rowCents === null) cur.unpricedTokens += r.totalTokens;
    else cur.costCents = (cur.costCents ?? 0) + rowCents;
    byProviderMap.set(pkey, cur);

    const day = r.createdAt.toISOString().slice(0, 10);
    const dcur = byDayMap.get(day) ?? {
      day,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costCents: 0,
      unpricedTokens: 0,
    };
    dcur.inputTokens += r.inputTokens;
    dcur.outputTokens += r.outputTokens;
    dcur.totalTokens += r.totalTokens;
    if (rowCents === null) dcur.unpricedTokens += r.totalTokens;
    else dcur.costCents += rowCents;
    byDayMap.set(day, dcur);
  }

  const mtd = await getMtdAggregate(projectId, now);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { monthlyTokenBudget: true },
  });

  return {
    projectId,
    from: from.toISOString(),
    to: to.toISOString(),
    inputTokens,
    outputTokens,
    totalTokens,
    costCents,
    unpriced,
    projectedMonthlyCostCents: projectMonthlyFromMtd(mtd.cents, now),
    monthlyTokenBudget: project?.monthlyTokenBudget ?? null,
    monthToDateTokens: mtd.tokens,
    monthToDateUnpricedTokens: mtd.unpricedTokens,
    byProvider: Array.from(byProviderMap.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    byDay: Array.from(byDayMap.values()).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
