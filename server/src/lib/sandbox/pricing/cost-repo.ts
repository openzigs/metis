/**
 * Project-level sandbox cost rollup (Epic #395 #418).
 *
 * Read-only repository over `SandboxSession` — sums `costMicroUsd`
 * grouped by provider for a given project + time window. Used by the
 * UI cost-meter widget and any future budget-cap enforcement.
 */
import { prisma } from "../../prisma.js";

export interface ProjectSandboxCostRange {
  /** Lower bound (inclusive) on `SandboxSession.createdAt`. Optional. */
  from?: Date;
  /** Upper bound (exclusive) on `SandboxSession.createdAt`. Optional. */
  to?: Date;
}

export interface ProjectSandboxCost {
  /** Total micro-USD across the window. */
  totalMicroUsd: number;
  /** `totalMicroUsd` / 1e6 (informational). */
  totalUsd: number;
  /** Number of `SandboxSession` rows included. */
  sessionCount: number;
  /** Per-provider breakdown, ordered by `totalMicroUsd` desc. */
  providerBreakdown: Array<{
    provider: string;
    totalMicroUsd: number;
    sessionCount: number;
  }>;
}

const MICRO_PER_USD = 1_000_000;

export class SandboxCostRepo {
  async getProjectSandboxCost(
    projectId: string,
    range: ProjectSandboxCostRange = {},
  ): Promise<ProjectSandboxCost> {
    const where = {
      projectId,
      ...(range.from || range.to
        ? {
            createdAt: {
              ...(range.from ? { gte: range.from } : {}),
              ...(range.to ? { lt: range.to } : {}),
            },
          }
        : {}),
    };

    // Single grouped query — O(log n) with the (projectId, createdAt) index.
    const grouped = await prisma.sandboxSession.groupBy({
      by: ["provider"],
      where,
      _sum: { costMicroUsd: true },
      _count: { _all: true },
    });

    let totalMicroUsd = 0;
    let sessionCount = 0;
    const providerBreakdown = grouped.map((g) => {
      const sum = g._sum.costMicroUsd ?? 0;
      totalMicroUsd += sum;
      sessionCount += g._count._all;
      return {
        provider: g.provider,
        totalMicroUsd: sum,
        sessionCount: g._count._all,
      };
    });
    providerBreakdown.sort((a, b) => b.totalMicroUsd - a.totalMicroUsd);

    return {
      totalMicroUsd,
      totalUsd: totalMicroUsd / MICRO_PER_USD,
      sessionCount,
      providerBreakdown,
    };
  }
}

let singleton: SandboxCostRepo | null = null;
export function getSandboxCostRepo(): SandboxCostRepo {
  if (!singleton) singleton = new SandboxCostRepo();
  return singleton;
}

/** Test helper. */
export function __resetSandboxCostRepoSingleton(): void {
  singleton = null;
}

/**
 * Convenience export — single function many call sites prefer over
 * spinning up a repo instance.
 */
export async function getProjectSandboxCost(
  projectId: string,
  range: ProjectSandboxCostRange = {},
): Promise<ProjectSandboxCost> {
  return getSandboxCostRepo().getProjectSandboxCost(projectId, range);
}
