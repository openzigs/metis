/**
 * Monthly + per-agent token cap enforcement for the analysis pipeline.
 *
 * Reads aggregated token usage from `Analysis.totalTokens` for the current
 * UTC month and refuses to start a new run when the cap would be exceeded.
 * The cap is configured via `ANALYSIS_MONTHLY_TOKEN_CAP` (default
 * {@link DEFAULT_ANALYSIS_MONTHLY_TOKEN_CAP}). Set to 0 to disable.
 *
 * Important: enforcement lives at the *service layer* so callers cannot
 * bypass it by writing directly to Prisma — see issue #58 security focus.
 *
 * Phase 2 (#258): caps are now resolved through {@link ConfigService} on
 * every read, so an admin write to `runtime_config` takes effect on the
 * next analysis without a server restart.
 */
import {
  DEFAULT_ANALYSIS_AGENT_TOKEN_CAP,
  DEFAULT_ANALYSIS_MONTHLY_TOKEN_CAP,
} from "@metis/shared";
import { getConfigService } from "../config/index.js";
import { prisma } from "../prisma.js";

const intCfg = (raw: string | undefined, fallback: number): number => {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export interface CostCapStatus {
  monthlyCap: number;
  agentCap: number;
  monthBucket: string;
  monthlyUsed: number;
  monthlyRemaining: number;
  exceeded: boolean;
}

export class CostCapExceededError extends Error {
  readonly status = 429;
  readonly code = "ANALYSIS_MONTHLY_CAP_EXCEEDED";
  readonly status2: number = 429; // duplicate retained for downstream pattern matching
  readonly cap: number;
  readonly used: number;
  constructor(cap: number, used: number) {
    super(`Monthly analysis token cap exceeded: ${used}/${cap}`);
    this.name = "CostCapExceededError";
    this.cap = cap;
    this.used = used;
  }
}

const monthBucketUTC = (date: Date): string => date.toISOString().slice(0, 7);

export function getMonthlyTokenCap(): number {
  return intCfg(
    getConfigService().get("ANALYSIS_MONTHLY_TOKEN_CAP"),
    DEFAULT_ANALYSIS_MONTHLY_TOKEN_CAP,
  );
}

export function getAgentTokenCap(): number {
  return intCfg(
    getConfigService().get("ANALYSIS_AGENT_TOKEN_CAP"),
    DEFAULT_ANALYSIS_AGENT_TOKEN_CAP,
  );
}

/**
 * Sum `totalTokens` across all `Analysis` rows started in the current UTC
 * month. We use `startedAt` (immutable) so cancelled / failed runs still count
 * towards the cap \u2014 the goal is provider-cost containment.
 */
export async function getMonthlyTokenUsage(now = new Date()): Promise<number> {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const rows = await prisma.analysis.findMany({
    where: {
      startedAt: { gte: startOfMonth, lt: startOfNextMonth },
      deletedAt: null,
    },
    select: { totalTokens: true },
  });
  return rows.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
}

/**
 * Issue #1095 — the same month-to-date accounting as {@link getMonthlyTokenUsage},
 * scoped to one project.
 *
 * Budget-aware model routing previously summed `TokenUsage` rows for the project,
 * but the analysis pipeline writes its token accounting to `Analysis.totalTokens`
 * (only FinOps and the PR reviewer write `TokenUsage`). The routing therefore read
 * 0 for every project, the downgrade threshold could never trip, and the
 * pre-flight response contradicted the cost-cap header on the same screen.
 * Reading the same table with the same month boundary keeps the two consistent.
 */
export async function getProjectMonthlyAnalysisTokens(
  projectId: string,
  now = new Date(),
): Promise<number> {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const rows = await prisma.analysis.findMany({
    where: {
      projectId,
      startedAt: { gte: startOfMonth, lt: startOfNextMonth },
      deletedAt: null,
    },
    select: { totalTokens: true },
  });
  return rows.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
}

export async function getCostCapStatus(now = new Date()): Promise<CostCapStatus> {
  const cap = getMonthlyTokenCap();
  const used = await getMonthlyTokenUsage(now);
  return {
    monthlyCap: cap,
    agentCap: getAgentTokenCap(),
    monthBucket: monthBucketUTC(now),
    monthlyUsed: used,
    monthlyRemaining: cap === 0 ? Number.POSITIVE_INFINITY : Math.max(cap - used, 0),
    exceeded: cap > 0 && used >= cap,
  };
}

/**
 * Throws {@link CostCapExceededError} if a new analysis cannot start. Cap of
 * 0 disables enforcement entirely.
 */
export async function assertCanStartAnalysis(now = new Date()): Promise<void> {
  const cap = getMonthlyTokenCap();
  if (cap <= 0) return;
  const used = await getMonthlyTokenUsage(now);
  if (used >= cap) {
    throw new CostCapExceededError(cap, used);
  }
}
