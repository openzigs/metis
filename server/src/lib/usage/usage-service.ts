/**
 * Epic #594 / Issue #607 — Usage aggregation service.
 *
 * Provides aggregation queries for token usage dashboards:
 *   - Per-project usage with day/model/user grouping
 *   - Admin-level cross-project usage
 *   - CSV export support
 */
import {
  LEDGER_COST_SELECT,
  LEGACY_COST_ROW_WHERE,
  UNPRICED_ROW_WHERE,
  ledgerRowCents,
  sumLedgerCents,
} from "../finops/ledger-cost.js";
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

/**
 * #868 review — a pre-aggregated slice of usage, the unit {@link UsageAccumulator}
 * groups. One ledger row is a slice of `count: 1`; a database group is a slice
 * of many rows. The representative fields (day, provider, model, …) are the
 * slice's first row's.
 */
interface UsageSlice {
  dayBucket: string;
  provider: string;
  model: string;
  userId: string | null;
  projectId: string | null;
  agentStep: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  count: number;
  /** Cost of the slice's PRICED rows in USD; `null` when none was priced (#22). */
  costUsd: number | null;
  /** The slice's unpriced share. */
  unpriced: UnpricedUsageTotals;
}

const noUnpriced = (): UnpricedUsageTotals => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  count: 0,
});

function rowSlice(r: AggregateInput): UsageSlice {
  const cost = r.estimatedCostUsd;
  return {
    dayBucket: r.dayBucket,
    provider: r.provider,
    model: r.model,
    userId: r.userId,
    projectId: r.projectId,
    agentStep: r.agentStep,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    count: 1,
    costUsd: cost,
    unpriced:
      cost === null
        ? {
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            totalTokens: r.totalTokens,
            count: 1,
          }
        : noUnpriced(),
  };
}

/**
 * The ledger columns {@link adminUsage} groups by in the database. Every
 * grouping the view offers except `day` is one of them, so merging these groups
 * by the requested dimension is exact; `day` is a date expression Prisma's
 * `groupBy` cannot form portably (SQLite and Postgres store DateTime
 * differently), so it pages instead.
 */
const LEDGER_GROUP_KEYS = ["projectId", "userId", "provider", "model", "agentStep"] as const;

/** Rows per page when the `day` grouping streams the ledger. */
const LEDGER_PAGE_SIZE = 5_000;

/** Groups slices by one dimension. Memory is O(groups), not O(rows). */
class UsageAccumulator {
  private readonly map = new Map<string, UsageRow>();
  private readonly unpriced = noUnpriced();

  constructor(private readonly groupBy: GroupBy) {}

  private keyOf(r: UsageSlice): string {
    switch (this.groupBy) {
      case "day":
        return r.dayBucket;
      case "model":
        return r.model;
      case "user":
        return r.userId ?? "unattributed";
      case "project":
        return r.projectId ?? "unassigned";
      case "agentStep":
        return r.agentStep ?? "unknown";
      default:
        return r.dayBucket;
    }
  }

  add(r: UsageSlice): void {
    this.unpriced.promptTokens += r.unpriced.promptTokens;
    this.unpriced.completionTokens += r.unpriced.completionTokens;
    this.unpriced.totalTokens += r.unpriced.totalTokens;
    this.unpriced.count += r.unpriced.count;

    const key = this.keyOf(r);
    const existing = this.map.get(key);
    if (existing) {
      existing.promptTokens += r.promptTokens;
      existing.completionTokens += r.completionTokens;
      existing.totalTokens += r.totalTokens;
      existing.unpricedTokens += r.unpriced.totalTokens;
      if (r.costUsd !== null)
        existing.estimatedCostUsd = (existing.estimatedCostUsd ?? 0) + r.costUsd;
      existing.count += r.count;
    } else {
      this.map.set(key, {
        dayBucket: r.dayBucket,
        provider: r.provider,
        model: r.model,
        userId: r.userId ?? undefined,
        projectId: r.projectId ?? undefined,
        agentStep: r.agentStep ?? undefined,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        totalTokens: r.totalTokens,
        estimatedCostUsd: r.costUsd,
        unpricedTokens: r.unpriced.totalTokens,
        count: r.count,
      });
    }
  }

  summary(): UsageSummary {
    const rows = [...this.map.values()].sort((a, b) => a.dayBucket.localeCompare(b.dayBucket));
    const totalTokens = rows.reduce((s, r) => s + r.totalTokens, 0);
    const totalCostUsd = rows.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);
    return { totalTokens, totalCostUsd, unpriced: { ...this.unpriced }, rows };
  }
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
   *
   * #868 review — this scope spans every project for up to 90 days (run 3 alone
   * put 60.4M tokens in the ledger), so it no longer loads the window's rows:
   * the database groups them ({@link readLedgerGrouped}) and only the groups
   * come back. `day` streams the window in pages instead, holding O(groups).
   */
  async adminUsage(
    opts: { range?: string; groupBy?: GroupBy; userId?: string } = {},
  ): Promise<UsageSummary> {
    const since = rangeToDate(opts.range ?? "30d");
    const groupBy = opts.groupBy ?? "project";
    const where = {
      createdAt: { gte: since },
      ...(opts.userId ? { userId: opts.userId } : {}),
    };
    const acc = new UsageAccumulator(groupBy);
    const [, projectless] = await Promise.all([
      groupBy === "day"
        ? this.scanLedgerInto(acc, where)
        : this.readLedgerGrouped(where).then((slices) => slices.forEach((s) => acc.add(s))),
      this.readProjectlessChat(since, opts.userId),
    ]);
    for (const r of projectless) acc.add(rowSlice(r));
    return acc.summary();
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
    const ledger = await prisma.tokenUsage.findMany({ where, select: LEDGER_ROW_SELECT });
    return ledger.map(ledgerInput);
  }

  /**
   * #868 review — the window's ledger grouped IN THE DATABASE by every
   * dimension the view offers but `day`, one slice per group. Three grouped
   * reads over the same keys: all rows (tokens, count, priced `costUsd`, first
   * row's time), legacy rows (`costCents` with no `costUsd`, #761 fallback),
   * and unpriced rows (#22). Slices come back in first-row order, so each
   * view group takes its representative fields from its earliest row — what
   * the row-by-row reduction gives on a ledger written in time order.
   */
  private async readLedgerGrouped(where: {
    userId?: string;
    createdAt: { gte: Date };
  }): Promise<UsageSlice[]> {
    const [all, legacy, unpriced] = await Promise.all([
      prisma.tokenUsage.groupBy({
        by: [...LEDGER_GROUP_KEYS],
        where,
        _sum: { inputTokens: true, outputTokens: true, totalTokens: true, costUsd: true },
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      prisma.tokenUsage.groupBy({
        by: [...LEDGER_GROUP_KEYS],
        where: { ...where, ...LEGACY_COST_ROW_WHERE },
        _sum: { costCents: true },
      }),
      prisma.tokenUsage.groupBy({
        by: [...LEDGER_GROUP_KEYS],
        where: { ...where, ...UNPRICED_ROW_WHERE },
        _sum: { inputTokens: true, outputTokens: true, totalTokens: true },
        _count: { _all: true },
      }),
    ]);
    type Keys = Pick<(typeof all)[number], (typeof LEDGER_GROUP_KEYS)[number]>;
    const keyOf = (g: Keys): string => JSON.stringify(LEDGER_GROUP_KEYS.map((k) => g[k]));
    const legacyCents = new Map(legacy.map((g) => [keyOf(g), g._sum.costCents ?? null]));
    const unpricedBy = new Map(unpriced.map((g) => [keyOf(g), g]));

    return all
      .map((g) => {
        const k = keyOf(g);
        const u = unpricedBy.get(k);
        const count = g._count._all;
        const unpricedCount = u?._count._all ?? 0;
        const first = g._min.createdAt;
        const slice: UsageSlice = {
          dayBucket: first ? first.toISOString().slice(0, 10) : "",
          provider: g.provider,
          model: g.model,
          userId: g.userId,
          projectId: g.projectId,
          agentStep: g.agentStep,
          promptTokens: g._sum.inputTokens ?? 0,
          completionTokens: g._sum.outputTokens ?? 0,
          totalTokens: g._sum.totalTokens ?? 0,
          count,
          // #22 — NULL only when EVERY row in the group was unpriced.
          costUsd:
            count > unpricedCount ? sumLedgerCents(g._sum.costUsd, legacyCents.get(k)) / 100 : null,
          unpriced: {
            promptTokens: u?._sum.inputTokens ?? 0,
            completionTokens: u?._sum.outputTokens ?? 0,
            totalTokens: u?._sum.totalTokens ?? 0,
            count: unpricedCount,
          },
        };
        return { slice, first: first?.getTime() ?? 0, k };
      })
      .sort((a, b) => a.first - b.first || a.k.localeCompare(b.k))
      .map((x) => x.slice);
  }

  /**
   * #868 review — the `day` grouping: stream the window in keyset-paged
   * batches (by id, i.e. write order) into the accumulator, so memory holds
   * one page and the groups, never the whole window.
   */
  private async scanLedgerInto(
    acc: UsageAccumulator,
    where: { userId?: string; createdAt: { gte: Date } },
  ): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const page = await prisma.tokenUsage.findMany({
        where,
        select: { id: true, ...LEDGER_ROW_SELECT },
        orderBy: { id: "asc" },
        take: LEDGER_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const r of page) acc.add(rowSlice(ledgerInput(r)));
      if (page.length < LEDGER_PAGE_SIZE) return;
      cursor = page[page.length - 1]!.id;
    }
  }

  private aggregate(rawRows: AggregateInput[], groupBy: GroupBy): UsageSummary {
    const acc = new UsageAccumulator(groupBy);
    for (const r of rawRows) acc.add(rowSlice(r));
    return acc.summary();
  }
}

/** The ledger columns a row-level reader needs. */
const LEDGER_ROW_SELECT = {
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
} as const;

function ledgerInput(r: {
  projectId: string;
  provider: string;
  model: string;
  userId: string | null;
  agentStep: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number | null;
  costUsd: number | null;
  createdAt: Date;
}): AggregateInput {
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
