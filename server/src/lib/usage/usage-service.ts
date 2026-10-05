/**
 * Epic #594 / Issue #607 — Usage aggregation service.
 *
 * Provides aggregation queries for token usage dashboards:
 *   - Per-project usage with day/model/user grouping
 *   - Admin-level cross-project usage
 *   - CSV export support
 */
import { LEDGER_COST_SELECT, ledgerRowCents } from "../finops/ledger-cost.js";
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

/** One ledger row, before grouping. */
interface AggregateInput {
  dayBucket: string;
  provider: string;
  model: string;
  /** NULL on a `token_usages` row whose caller knew no user (#792). */
  userId: string | null;
  /** NULL only for project-less chat spend (#854). */
  projectId: string | null;
  agentStep: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

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
    return this.aggregate(await this.readLedger({ projectId, createdAt: { gte: since } }), groupBy);
  }

  /**
   * Admin-level aggregation across all projects (the "All projects" scope and
   * `GET /api/admin/usage`).
   *
   * #854 — reads the same ledger as {@link projectUsage}. It used to read
   * `ai_token_usages`, which carries only chat and a few tool calls (#706 run
   * 3: 1.0M tokens / $0.50 there against 60.4M / $63.34 in `token_usages`).
   * Chat writes each call to BOTH tables with identical tokens, so the two are
   * never summed. `userId` filters the ledger's own column, which is NULL on
   * rows written before #792 and by callers that know no user.
   *
   * The one spend the ledger cannot hold is a chat session with NO project
   * (multi-project or stale-project scope): `token_usages.projectId` is
   * required, so such a call reaches `ai_token_usages` only. Those rows are
   * added, as "unassigned", via {@link readProjectlessChat}.
   */
  async adminUsage(
    opts: { range?: string; groupBy?: GroupBy; userId?: string } = {},
  ): Promise<UsageSummary> {
    const since = rangeToDate(opts.range ?? "30d");
    const groupBy = opts.groupBy ?? "project";
    const [ledger, projectless] = await Promise.all([
      this.readLedger({
        createdAt: { gte: since },
        ...(opts.userId ? { userId: opts.userId } : {}),
      }),
      this.readProjectlessChat(since, opts.userId),
    ]);
    return this.aggregate([...ledger, ...projectless], groupBy);
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

  /**
   * #854 — `ai_token_usages` rows that have no `token_usages` twin: neither the
   * row nor its session has a project. Both conditions matter. A project chat
   * call stamps the row's projectId; `apply_diff` leaves the row's projectId
   * NULL but mirrors the call into `token_usages` for its session's project, so
   * the session filter is what keeps it from being counted twice.
   */
  private async readProjectlessChat(since: Date, userId?: string): Promise<AggregateInput[]> {
    const rows = await prisma.aITokenUsage.findMany({
      where: {
        projectId: null,
        session: { projectId: null },
        ts: { gte: since },
        ...(userId ? { userId } : {}),
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
    return rows.map((r) => ({ ...r, projectId: null }));
  }

  /** `token_usages` rows in the shape {@link aggregate} groups. */
  private async readLedger(where: {
    projectId?: string;
    userId?: string;
    createdAt: { gte: Date };
  }): Promise<AggregateInput[]> {
    const ledger = await prisma.tokenUsage.findMany({
      where,
      select: {
        projectId: true,
        provider: true,
        model: true,
        userId: true,
        agentStep: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        ...LEDGER_COST_SELECT,
        createdAt: true,
      },
    });
    return ledger.map((r) => {
      // #761 — the row's unrounded cost; NULL stays NULL (unpriced, #22).
      const cents = ledgerRowCents(r);
      return {
        dayBucket: r.createdAt.toISOString().slice(0, 10),
        provider: r.provider,
        model: r.model,
        userId: r.userId,
        projectId: r.projectId,
        agentStep: r.agentStep,
        promptTokens: r.inputTokens,
        completionTokens: r.outputTokens,
        totalTokens: r.totalTokens,
        estimatedCostUsd: cents === null ? null : cents / 100,
      };
    });
  }

  private aggregate(rawRows: AggregateInput[], groupBy: GroupBy): UsageSummary {
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
