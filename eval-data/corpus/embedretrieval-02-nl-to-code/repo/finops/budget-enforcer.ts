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
 *   • `summarizeUsage(projectId, from, to)` — full usage rollup that
 *     powers `GET /api/projects/:id/usage`.
 */
import { prisma } from "../prisma.js";

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
): Promise<{ tokens: number; cents: number }> {
  const { start } = monthBoundsUtc(now);
  const rows = await prisma.tokenUsage.findMany({
    where: { projectId, createdAt: { gte: start } },
    select: { totalTokens: true, costCents: true },
  });
  let tokens = 0;
  let cents = 0;
  for (const r of rows) {
    tokens += r.totalTokens;
    cents += r.costCents;
  }
  return { tokens, cents };
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
  costCents: number;
  projectedMonthlyCostCents: number;
  monthlyTokenBudget: number | null;
  monthToDateTokens: number;
  byProvider: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costCents: number;
  }>;
  byDay: Array<{
    day: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costCents: number;
  }>;
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
  const byProviderMap = new Map<
    string,
    {
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costCents: number;
    }
  >();
  const byDayMap = new Map<
    string,
    {
      day: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costCents: number;
    }
  >();

  for (const r of rows) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    totalTokens += r.totalTokens;
    costCents += r.costCents;
    const pkey = `${r.provider}:${r.model}`;
    const cur = byProviderMap.get(pkey) ?? {
      provider: r.provider,
      model: r.model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costCents: 0,
    };
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    cur.totalTokens += r.totalTokens;
    cur.costCents += r.costCents;
    byProviderMap.set(pkey, cur);

    const day = r.createdAt.toISOString().slice(0, 10);
    const dcur = byDayMap.get(day) ?? {
      day,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costCents: 0,
    };
    dcur.inputTokens += r.inputTokens;
    dcur.outputTokens += r.outputTokens;
    dcur.totalTokens += r.totalTokens;
    dcur.costCents += r.costCents;
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
    projectedMonthlyCostCents: projectMonthlyFromMtd(mtd.cents, now),
    monthlyTokenBudget: project?.monthlyTokenBudget ?? null,
    monthToDateTokens: mtd.tokens,
    byProvider: Array.from(byProviderMap.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    byDay: Array.from(byDayMap.values()).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
