/**
 * Epic #594 / Issue #607 — Usage aggregation service.
 *
 * Provides aggregation queries for token usage dashboards:
 *   - Per-project usage with day/model/user grouping
 *   - Admin-level cross-project usage
 *   - CSV export support
 */
import { prisma } from "../prisma.js";

export interface UsageRow {
  dayBucket: string;
  provider: string;
  model: string;
  userId?: string;
  projectId?: string;
  agentStep?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  count: number;
}

export interface UsageSummary {
  totalTokens: number;
  totalCostUsd: number;
  rows: UsageRow[];
}

type GroupBy = "day" | "model" | "user" | "project" | "agentStep";

function rangeToDate(range: string): Date {
  const now = new Date();
  const days = range === "90d" ? 90 : range === "30d" ? 30 : 7;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export class UsageService {
  /**
   * Aggregate usage for a specific project.
   */
  async projectUsage(
    projectId: string,
    opts: { range?: string; groupBy?: GroupBy } = {},
  ): Promise<UsageSummary> {
    const since = rangeToDate(opts.range ?? "7d");
    const groupBy = opts.groupBy ?? "day";

    // Issue #428 — AITokenUsage rows are associated with a project EITHER via
    // the direct (nullable) `projectId` column OR via the session relation
    // (`session.projectId`). The chat write path persists projectId=null and
    // relies solely on the session link, so filtering on the direct column
    // alone dropped those rows and the "Detailed Usage" / "by Agent Step"
    // views showed "No data" while the KPI/by-provider aggregates (sourced
    // from TokenUsage) showed data. Match on either association so the detail
    // and aggregate views agree for the same window. Mirrors the working
    // /token-breakdown route which already filters by `session.projectId`.
    const rawRows = await prisma.aITokenUsage.findMany({
      where: {
        OR: [{ projectId }, { session: { projectId } }],
        ts: { gte: since },
      },
      select: {
        dayBucket: true,
        provider: true,
        model: true,
        userId: true,
        agentStep: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        estimatedCostUsd: true,
      },
    });

    return this.aggregate(rawRows, groupBy);
  }

  /**
   * Admin-level aggregation across all projects.
   */
  async adminUsage(
    opts: { range?: string; groupBy?: GroupBy; userId?: string } = {},
  ): Promise<UsageSummary> {
    const since = rangeToDate(opts.range ?? "30d");
    const groupBy = opts.groupBy ?? "project";

    const where: Record<string, unknown> = { ts: { gte: since } };
    if (opts.userId) where.userId = opts.userId;

    const rawRows = await prisma.aITokenUsage.findMany({
      where,
      select: {
        dayBucket: true,
        provider: true,
        model: true,
        userId: true,
        projectId: true,
        agentStep: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        estimatedCostUsd: true,
      },
    });

    return this.aggregate(rawRows, groupBy);
  }

  /**
   * Generate CSV string for usage data.
   */
  toCSV(rows: UsageRow[]): string {
    const header =
      "dayBucket,provider,model,userId,projectId,promptTokens,completionTokens,totalTokens,estimatedCostUsd,count";
    const lines = rows.map(
      (r) =>
        `${r.dayBucket},${r.provider},${r.model},${r.userId ?? ""},${r.projectId ?? ""},${r.promptTokens},${r.completionTokens},${r.totalTokens},${r.estimatedCostUsd.toFixed(6)},${r.count}`,
    );
    return [header, ...lines].join("\n");
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private aggregate(
    rawRows: Array<{
      dayBucket: string;
      provider: string;
      model: string;
      userId: string;
      projectId?: string | null;
      agentStep?: string | null;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      estimatedCostUsd: number | null;
    }>,
    groupBy: GroupBy,
  ): UsageSummary {
    const map = new Map<string, UsageRow>();

    for (const r of rawRows) {
      let key: string;
      switch (groupBy) {
        case "day":
          key = r.dayBucket;
          break;
        case "model":
          key = r.model;
          break;
        case "user":
          key = r.userId;
          break;
        case "project":
          key = r.projectId ?? "unassigned";
          break;
        case "agentStep":
          key = r.agentStep ?? "unknown";
          break;
        default:
          key = r.dayBucket;
      }

      const existing = map.get(key);
      if (existing) {
        existing.promptTokens += r.promptTokens;
        existing.completionTokens += r.completionTokens;
        existing.totalTokens += r.totalTokens;
        existing.estimatedCostUsd += r.estimatedCostUsd ?? 0;
        existing.count += 1;
      } else {
        map.set(key, {
          dayBucket: r.dayBucket,
          provider: r.provider,
          model: r.model,
          userId: r.userId,
          projectId: r.projectId ?? undefined,
          agentStep: r.agentStep ?? undefined,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          totalTokens: r.totalTokens,
          estimatedCostUsd: r.estimatedCostUsd ?? 0,
          count: 1,
        });
      }
    }

    const rows = [...map.values()].sort((a, b) => a.dayBucket.localeCompare(b.dayBucket));
    const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
    const totalCostUsd = rows.reduce((s, r) => s + r.estimatedCostUsd, 0);

    return { totalTokens, totalCostUsd, rows };
  }
}

let singleton: UsageService | null = null;

export function getUsageService(): UsageService {
  if (!singleton) singleton = new UsageService();
  return singleton;
}

/** Test helper. */
export function __resetUsageServiceSingleton(): void {
  singleton = null;
}
