/**
 * Epic #594 / Issue #606 — Token Budget Controller.
 *
 * Enforces per-project and per-user token budgets with soft/hard thresholds.
 * - Soft threshold (default 80%): auto-downgrade to Haiku + log warning.
 * - Hard limit (100%): reject with error.
 */
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("token-budget-controller");

/** Default soft threshold percentage (0-1). */
const DEFAULT_SOFT_THRESHOLD = 0.8;

export interface BudgetCheckResult {
  allowed: boolean;
  remainingTokens: number;
  percentUsed: number;
  shouldDowngrade: boolean;
  message: string | null;
}

export class TokenBudgetController {
  private softThreshold: number;

  constructor(softThreshold = DEFAULT_SOFT_THRESHOLD) {
    this.softThreshold = Math.max(0, Math.min(1, softThreshold));
  }

  /**
   * Check whether a request is allowed given the current budget.
   * Checks both project-level and user-level budgets. The more
   * restrictive one wins.
   */
  async check(projectId?: string, userId?: string): Promise<BudgetCheckResult> {
    const results: BudgetCheckResult[] = [];

    if (projectId) {
      const projectResult = await this.checkProjectBudget(projectId);
      if (projectResult) results.push(projectResult);
    }

    if (userId) {
      const userResult = await this.checkUserBudget(userId);
      if (userResult) results.push(userResult);
    }

    if (results.length === 0) {
      return {
        allowed: true,
        remainingTokens: Infinity,
        percentUsed: 0,
        shouldDowngrade: false,
        message: null,
      };
    }

    // Return the most restrictive result
    const denied = results.find((r) => !r.allowed);
    if (denied) return denied;

    const downgrade = results.find((r) => r.shouldDowngrade);
    if (downgrade) return downgrade;

    // Return the one with the highest percent used
    return results.reduce((most, r) => (r.percentUsed > most.percentUsed ? r : most));
  }

  /** Get the budget configuration for a project. */
  async getProjectBudget(projectId: string) {
    return prisma.tokenBudget.findUnique({ where: { projectId } });
  }

  /** Get budget configurations for a user (across all projects). */
  async getUserBudgets(userId: string) {
    return prisma.tokenBudget.findMany({ where: { userId } });
  }

  /** Upsert a project-level budget. */
  async setProjectBudget(
    projectId: string,
    data: {
      dailyTokenLimit?: number | null;
      monthlyTokenLimit?: number | null;
      downgradeModel?: string | null;
    },
  ) {
    return prisma.tokenBudget.upsert({
      where: { projectId },
      create: {
        projectId,
        dailyTokenLimit: data.dailyTokenLimit ?? null,
        monthlyTokenLimit: data.monthlyTokenLimit ?? null,
        downgradeModel: data.downgradeModel ?? null,
      },
      update: {
        dailyTokenLimit: data.dailyTokenLimit ?? null,
        monthlyTokenLimit: data.monthlyTokenLimit ?? null,
        downgradeModel: data.downgradeModel ?? null,
      },
    });
  }

  /** Upsert a user-level budget. */
  async setUserBudget(
    userId: string,
    data: {
      dailyTokenLimit?: number | null;
      monthlyTokenLimit?: number | null;
      downgradeModel?: string | null;
    },
  ) {
    // User budgets don't have a unique constraint on userId alone,
    // so we find-or-create.
    const existing = await prisma.tokenBudget.findFirst({ where: { userId, projectId: null } });
    if (existing) {
      return prisma.tokenBudget.update({
        where: { id: existing.id },
        data: {
          dailyTokenLimit: data.dailyTokenLimit ?? null,
          monthlyTokenLimit: data.monthlyTokenLimit ?? null,
          downgradeModel: data.downgradeModel ?? null,
        },
      });
    }
    return prisma.tokenBudget.create({
      data: {
        userId,
        dailyTokenLimit: data.dailyTokenLimit ?? null,
        monthlyTokenLimit: data.monthlyTokenLimit ?? null,
        downgradeModel: data.downgradeModel ?? null,
      },
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async checkProjectBudget(projectId: string): Promise<BudgetCheckResult | null> {
    const budget = await prisma.tokenBudget.findUnique({ where: { projectId } });
    if (!budget) return null;

    const now = new Date();
    const dayBucket = now.toISOString().slice(0, 10);

    let limit: number | null = null;
    let used = 0;
    let period = "";

    if (budget.dailyTokenLimit) {
      const daily = await this.sumTokens({ projectId, dayBucket });
      limit = budget.dailyTokenLimit;
      used = daily;
      period = "daily";
    }

    if (budget.monthlyTokenLimit) {
      const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
      const monthly = await this.sumTokens({ projectId, monthStart });
      // Use the more restrictive limit
      if (
        limit === null ||
        (budget.monthlyTokenLimit > 0 && monthly / budget.monthlyTokenLimit > used / (limit || 1))
      ) {
        limit = budget.monthlyTokenLimit;
        used = monthly;
        period = "monthly";
      }
    }

    if (limit === null) return null;

    return this.buildResult(used, limit, period, budget.downgradeModel);
  }

  private async checkUserBudget(userId: string): Promise<BudgetCheckResult | null> {
    const budget = await prisma.tokenBudget.findFirst({ where: { userId, projectId: null } });
    if (!budget) return null;

    const now = new Date();
    const dayBucket = now.toISOString().slice(0, 10);

    let limit: number | null = null;
    let used = 0;
    let period = "";

    if (budget.dailyTokenLimit) {
      const daily = await this.sumTokens({ userId, dayBucket });
      limit = budget.dailyTokenLimit;
      used = daily;
      period = "daily";
    }

    if (budget.monthlyTokenLimit) {
      const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
      const monthly = await this.sumTokens({ userId, monthStart });
      if (
        limit === null ||
        (budget.monthlyTokenLimit > 0 && monthly / budget.monthlyTokenLimit > used / (limit || 1))
      ) {
        limit = budget.monthlyTokenLimit;
        used = monthly;
        period = "monthly";
      }
    }

    if (limit === null) return null;

    return this.buildResult(used, limit, period, budget.downgradeModel);
  }

  private buildResult(
    used: number,
    limit: number,
    period: string,
    downgradeModel: string | null,
  ): BudgetCheckResult {
    const percentUsed = limit > 0 ? used / limit : 0;
    const remaining = Math.max(0, limit - used);

    if (percentUsed >= 1) {
      log.warn("Token budget exceeded (hard limit)", { used, limit, period });
      return {
        allowed: false,
        remainingTokens: 0,
        percentUsed: Math.min(percentUsed, 1),
        shouldDowngrade: false,
        message: `${period} token budget exceeded (${used.toLocaleString()} / ${limit.toLocaleString()} tokens)`,
      };
    }

    if (percentUsed >= this.softThreshold) {
      log.warn("Token budget soft threshold reached", { used, limit, period, percentUsed });
      return {
        allowed: true,
        remainingTokens: remaining,
        percentUsed,
        shouldDowngrade: Boolean(downgradeModel),
        message: `${period} token budget at ${Math.round(percentUsed * 100)}% — ${downgradeModel ? "downgrading to " + downgradeModel : "approaching limit"}`,
      };
    }

    return {
      allowed: true,
      remainingTokens: remaining,
      percentUsed,
      shouldDowngrade: false,
      message: null,
    };
  }

  private async sumTokens(filter: {
    projectId?: string;
    userId?: string;
    dayBucket?: string;
    monthStart?: string;
  }): Promise<number> {
    const where: Record<string, unknown> = {};
    if (filter.projectId) where.projectId = filter.projectId;
    if (filter.userId) where.userId = filter.userId;
    if (filter.dayBucket) where.dayBucket = filter.dayBucket;
    if (filter.monthStart) where.dayBucket = { gte: filter.monthStart };

    const result = await prisma.aITokenUsage.aggregate({
      where,
      _sum: { totalTokens: true },
    });
    return result._sum.totalTokens ?? 0;
  }
}

let singleton: TokenBudgetController | null = null;

export function getTokenBudgetController(): TokenBudgetController {
  if (!singleton) singleton = new TokenBudgetController();
  return singleton;
}

/** Test helper. */
export function __resetTokenBudgetControllerSingleton(): void {
  singleton = null;
}
