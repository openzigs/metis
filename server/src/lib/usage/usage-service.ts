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
  /**
   * Cost of this group's PRICED usage, or `null` when none of it was priced
   * (#22 — an unpriced model is unknown spend, never $0).
   */
  estimatedCostUsd: number | null;
  /** #22 — tokens in this group recorded without a price. */
  unpricedTokens: number;
  count: number;
}

/** #22 — usage recorded while its model had no price. */
export interface UnpricedUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Number of recorded model calls. */
  count: number;
}

export interface UsageSummary {
  totalTokens: number;
  /** Cost of the PRICED usage only — see {@link unpriced}. */
  totalCostUsd: number;
  /** #22 — unpriced usage, reported separately with its token counts. */
  unpriced: UnpricedUsageTotals;
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

    // #792 — the project page's ONE ledger. The cards, budget and MTD figures
    // (`summarizeUsage`) read `token_usages`; this view used to read
    // `ai_token_usages`, which held disjoint traffic (impact spend only there,
    // chat/analysis/docs/Spec Kit spend only here), so the page showed two
    // unrelated totals and the CSV export covered 2.7% of the project's spend.
    // Reading the same table makes the analytics card and the CSV add up to
    // the cards for the same window. (Supersedes the #428 session-OR filter.)
    const ledger = await prisma.tokenUsage.findMany({
      where: { projectId, createdAt: { gte: since } },
      select: {
        provider: true,
        model: true,
        userId: true,
        agentStep: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        costCents: true,
        createdAt: true,
      },
    });

    const rawRows = ledger.map((r) => ({
      dayBucket: r.createdAt.toISOString().slice(0, 10),
      provider: r.provider,
      model: r.model,
      userId: r.userId,
      projectId,
      agentStep: r.agentStep,
      promptTokens: r.inputTokens,
      completionTokens: r.outputTokens,
      totalTokens: r.totalTokens,
      // Integer cents → USD; NULL stays NULL (unpriced, #22).
      estimatedCostUsd: r.costCents === null ? null : r.costCents / 100,
    }));

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
    // #22 — an unpriced group has an EMPTY cost cell (unknown), never 0.
    const header =
      "dayBucket,provider,model,userId,projectId,promptTokens,completionTokens,totalTokens,estimatedCostUsd,count,unpricedTokens";
    const lines = rows.map(
      (r) =>
        `${r.dayBucket},${r.provider},${r.model},${r.userId ?? ""},${r.projectId ?? ""},${r.promptTokens},${r.completionTokens},${r.totalTokens},${r.estimatedCostUsd === null ? "" : r.estimatedCostUsd.toFixed(6)},${r.count},${r.unpricedTokens}`,
    );
    return [header, ...lines].join("\n");
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private aggregate(
    rawRows: Array<{
      dayBucket: string;
      provider: string;
      model: string;
      /** NULL on a `token_usages` row whose caller knew no user (#792). */
      userId: string | null;
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
    const unpriced: UnpricedUsageTotals = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      count: 0,
    };

    for (const r of rawRows) {
      const cost = r.estimatedCostUsd;
      if (cost === null) {
        unpriced.promptTokens += r.promptTokens;
        unpriced.completionTokens += r.completionTokens;
        unpriced.totalTokens += r.totalTokens;
        unpriced.count += 1;
      }
      let key: string;
      switch (groupBy) {
        case "day":
          key = r.dayBucket;
          break;
        case "model":
          key = r.model;
          break;
        case "user":
          key = r.userId ?? "unattributed";
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
        if (cost === null) existing.unpricedTokens += r.totalTokens;
        else existing.estimatedCostUsd = (existing.estimatedCostUsd ?? 0) + cost;
        existing.count += 1;
      } else {
        map.set(key, {
          dayBucket: r.dayBucket,
          provider: r.provider,
          model: r.model,
          userId: r.userId ?? undefined,
          projectId: r.projectId ?? undefined,
          agentStep: r.agentStep ?? undefined,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          totalTokens: r.totalTokens,
          estimatedCostUsd: cost,
          unpricedTokens: cost === null ? r.totalTokens : 0,
          count: 1,
        });
      }
    }

    const rows = [...map.values()].sort((a, b) => a.dayBucket.localeCompare(b.dayBucket));
    const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
    const totalCostUsd = rows.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);

    return { totalTokens, totalCostUsd, unpriced, rows };
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
