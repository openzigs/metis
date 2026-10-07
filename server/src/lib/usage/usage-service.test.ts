/**
 * Epic #594 / Issue #607 — UsageService unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    aITokenUsage: {
      findMany: vi.fn(),
    },
    tokenUsage: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

import { prisma } from "../prisma.js";
import { UsageService, getUsageService, __resetUsageServiceSingleton } from "./usage-service.js";

const mockFindMany = prisma.aITokenUsage.findMany as ReturnType<typeof vi.fn>;
const mockLedgerFindMany = prisma.tokenUsage.findMany as ReturnType<typeof vi.fn>;
const mockLedgerGroupBy = prisma.tokenUsage.groupBy as unknown as ReturnType<typeof vi.fn>;

type Row = Record<string, unknown>;
/** Prisma's filter for a nullable column: `null`, `{ not: null }`, or a value. */
function matches(value: unknown, filter: unknown): boolean {
  const v = value ?? null;
  if (filter === null) return v === null;
  if (filter && typeof filter === "object" && "not" in filter) {
    return (filter as { not: unknown }).not === null ? v !== null : v !== filter.not;
  }
  return v === filter;
}

/**
 * #868 review — `adminUsage` groups in the database. This double implements
 * Prisma `groupBy` semantics (`_sum` skips NULLs and is `null` for an all-NULL
 * group; `_count._all` counts rows; `_min`) over the SAME fixture each test
 * hands `findMany`, and reads it through `findMany` with the query's `where`,
 * so every existing assertion on the ledger query still holds.
 */
async function emulateGroupBy(args: {
  by: string[];
  where: Row;
  _sum?: Record<string, true>;
  _count?: { _all: true };
  _min?: Record<string, true>;
}): Promise<Row[]> {
  const readRows = mockLedgerFindMany as unknown as (q: {
    where: Row;
  }) => Promise<Row[] | undefined>;
  const rows = (await readRows({ where: args.where })) ?? [];
  const costFilters = ["costUsd", "costCents"].filter((k) => k in args.where);
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (!costFilters.every((k) => matches(r[k], args.where[k]))) continue;
    const key = JSON.stringify(args.by.map((k) => r[k] ?? null));
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const out: Row = Object.fromEntries(args.by.map((k) => [k, g[0]![k] ?? null]));
    if (args._sum) {
      out._sum = Object.fromEntries(
        Object.keys(args._sum).map((k) => {
          const vals = g.map((r) => r[k]).filter((v): v is number => typeof v === "number");
          return [k, vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0)];
        }),
      );
    }
    if (args._count) out._count = { _all: g.length };
    if (args._min) {
      out._min = Object.fromEntries(
        Object.keys(args._min).map((k) => [
          k,
          g.map((r) => r[k] as Date).reduce((a, b) => (b < a ? b : a)),
        ]),
      );
    }
    return out;
  });
}

/** #792 — a `token_usages` row, the ledger the project usage page reads. */
function ledgerRow(
  overrides: Partial<{
    projectId: string;
    costUsd: number | null;
    provider: string;
    model: string;
    userId: string | null;
    agentStep: string | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costCents: number | null;
    createdAt: Date;
  }> = {},
) {
  return {
    projectId: "proj-1",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    userId: "user-1",
    agentStep: "chat",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costCents: 1,
    createdAt: new Date("2025-01-15T10:00:00.000Z"),
    ...overrides,
  };
}

describe("UsageService", () => {
  let svc: UsageService;

  beforeEach(() => {
    __resetUsageServiceSingleton();
    svc = new UsageService();
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockLedgerGroupBy.mockImplementation(emulateGroupBy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("projectUsage (#792 — reads the token_usages ledger)", () => {
    it("aggregates ledger rows by UTC day, converting integer cents to USD", async () => {
      mockLedgerFindMany.mockResolvedValue([
        ledgerRow({ totalTokens: 100, costCents: 1 }),
        ledgerRow({ totalTokens: 200, costCents: 2 }),
        ledgerRow({
          totalTokens: 300,
          costCents: 3,
          createdAt: new Date("2025-01-16T23:59:00.000Z"),
        }),
      ]);

      const result = await svc.projectUsage("proj-1", { range: "7d", groupBy: "day" });
      expect(result.totalTokens).toBe(600);
      expect(result.totalCostUsd).toBeCloseTo(0.06, 10);
      expect(result.rows.map((r) => r.dayBucket)).toEqual(["2025-01-15", "2025-01-16"]);
      expect(result.rows[0].estimatedCostUsd).toBeCloseTo(0.03, 10);
    });

    it("queries ONLY the project's ledger rows inside the range, never ai_token_usages", async () => {
      mockLedgerFindMany.mockResolvedValue([]);
      const before = Date.now();
      await svc.projectUsage("proj-1", { range: "30d" });
      expect(mockFindMany).not.toHaveBeenCalled();
      const where = mockLedgerFindMany.mock.calls[0][0].where;
      expect(where.projectId).toBe("proj-1");
      const since = (where.createdAt.gte as Date).getTime();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      expect(Math.abs(before - thirtyDays - since)).toBeLessThan(5_000);
    });

    it("fills projectId on every row, so a project-scoped CSV export names its project", async () => {
      mockLedgerFindMany.mockResolvedValue([ledgerRow()]);
      const result = await svc.projectUsage("proj-1", { groupBy: "day" });
      expect(result.rows[0].projectId).toBe("proj-1");
      expect(svc.toCSV(result.rows).split("\n")[1]).toBe(
        "2025-01-15,anthropic,claude-sonnet-4-6,user-1,proj-1,100,50,150,0.010000,1,0",
      );
    });

    it("an unpriced ledger row (costCents NULL) is unpriced, never $0 (#22)", async () => {
      mockLedgerFindMany.mockResolvedValue([
        ledgerRow({ costCents: 4 }),
        ledgerRow({ costCents: null, totalTokens: 70 }),
      ]);
      const result = await svc.projectUsage("proj-1", { groupBy: "model" });
      expect(result.totalCostUsd).toBeCloseTo(0.04, 10);
      expect(result.unpriced.totalTokens).toBe(70);
      expect(result.rows[0].unpricedTokens).toBe(70);
    });

    it("returns empty when no data", async () => {
      mockLedgerFindMany.mockResolvedValue([]);
      const result = await svc.projectUsage("proj-1");
      expect(result.totalTokens).toBe(0);
      expect(result.rows).toHaveLength(0);
    });

    it("groups by the ledger's agentStep; a row with none is 'unknown'", async () => {
      mockLedgerFindMany.mockResolvedValue([
        ledgerRow({ agentStep: "impact.table-filter", totalTokens: 10 }),
        ledgerRow({ agentStep: "impact.table-filter", totalTokens: 15 }),
        ledgerRow({ agentStep: null, totalTokens: 40 }),
      ]);
      const result = await svc.projectUsage("proj-1", { groupBy: "agentStep" });
      expect(result.rows).toHaveLength(2);
      expect(result.rows.find((r) => r.agentStep === "impact.table-filter")!.totalTokens).toBe(25);
      expect(result.rows.find((r) => r.agentStep === undefined)!.totalTokens).toBe(40);
    });

    it("groups by the ledger's userId; a row with none is grouped apart, not dropped", async () => {
      mockLedgerFindMany.mockResolvedValue([
        ledgerRow({ userId: "user-a", totalTokens: 40 }),
        ledgerRow({ userId: "user-b", totalTokens: 60 }),
        ledgerRow({ userId: "user-a", totalTokens: 10 }),
        ledgerRow({ userId: null, totalTokens: 5 }),
      ]);
      const result = await svc.projectUsage("proj-1", { groupBy: "user" });
      expect(result.rows).toHaveLength(3);
      expect(result.rows.find((r) => r.userId === "user-a")!.totalTokens).toBe(50);
      expect(result.rows.find((r) => r.userId === undefined)!.totalTokens).toBe(5);
      expect(result.totalTokens).toBe(115);
    });

    it("groups by model", async () => {
      mockLedgerFindMany.mockResolvedValue([
        ledgerRow({ model: "haiku", totalTokens: 50 }),
        ledgerRow({ model: "sonnet", totalTokens: 200 }),
        ledgerRow({ model: "haiku", totalTokens: 100 }),
      ]);

      const result = await svc.projectUsage("proj-1", { groupBy: "model" });
      expect(result.rows).toHaveLength(2);
      const haikuRow = result.rows.find((r) => r.model === "haiku");
      expect(haikuRow!.totalTokens).toBe(150);
    });
  });

  describe("adminUsage (#854 — the All projects scope reads the token_usages ledger)", () => {
    it("aggregates ledger rows across projects", async () => {
      mockLedgerFindMany.mockResolvedValue([
        ledgerRow({ projectId: "proj-1", totalTokens: 500, costCents: 3 }),
        ledgerRow({ projectId: "proj-2", totalTokens: 300, costCents: 1 }),
        ledgerRow({ projectId: "proj-2", totalTokens: 200, costCents: 1 }),
      ]);

      const result = await svc.adminUsage({ groupBy: "project" });
      expect(result.totalTokens).toBe(1_000);
      expect(result.totalCostUsd).toBeCloseTo(0.05, 10);
      expect(result.rows.map((r) => [r.projectId, r.totalTokens, r.count])).toEqual([
        ["proj-1", 500, 1],
        ["proj-2", 500, 2],
      ]);
    });

    it("queries every project's ledger rows inside the range, with no project filter", async () => {
      mockLedgerFindMany.mockResolvedValue([]);
      const before = Date.now();
      await svc.adminUsage({ range: "90d" });
      const where = mockLedgerFindMany.mock.calls[0][0].where;
      expect(where).not.toHaveProperty("projectId");
      expect(where).not.toHaveProperty("userId");
      const ninetyDays = 90 * 24 * 60 * 60 * 1000;
      expect(Math.abs(before - ninetyDays - (where.createdAt.gte as Date).getTime())).toBeLessThan(
        5_000,
      );
    });

    it("filters both sources by userId", async () => {
      mockLedgerFindMany.mockResolvedValue([]);
      await svc.adminUsage({ userId: "user-42" });
      expect(mockLedgerFindMany.mock.calls[0][0].where.userId).toBe("user-42");
      expect(mockFindMany.mock.calls[0][0].where.userId).toBe("user-42");
    });

    it("reads ai_token_usages ONLY for chat with no project on the row or its session", async () => {
      mockLedgerFindMany.mockResolvedValue([ledgerRow({ projectId: "proj-1", totalTokens: 150 })]);
      mockFindMany.mockResolvedValue([
        {
          dayBucket: "2025-01-15",
          provider: "openai",
          model: "gpt-4o",
          userId: "user-1",
          agentStep: null,
          promptTokens: 500,
          completionTokens: 200,
          totalTokens: 700,
          estimatedCostUsd: 0.003,
        },
      ]);
      const result = await svc.adminUsage({ groupBy: "project" });
      const where = mockFindMany.mock.calls[0][0].where;
      expect(where.projectId).toBeNull();
      expect(where.session).toEqual({ projectId: null });
      expect(result.totalTokens).toBe(850);
      const unassigned = result.rows.find((r) => r.projectId === undefined);
      expect(unassigned?.totalTokens).toBe(700);
    });
  });

  describe("adminUsage aggregates in the database (#868 review)", () => {
    it("groups every non-day dimension with groupBy and never reads the window's rows", async () => {
      mockLedgerFindMany.mockResolvedValue([
        ledgerRow({ model: "a", costUsd: 0.01 }),
        ledgerRow({ model: "b", costUsd: null, costCents: 3 }),
        ledgerRow({ model: "b", costUsd: null, costCents: null, totalTokens: 9 }),
      ]);
      for (const groupBy of ["project", "user", "model", "agentStep"] as const) {
        vi.clearAllMocks();
        mockLedgerGroupBy.mockImplementation(emulateGroupBy);
        mockFindMany.mockResolvedValue([]);
        const result = await svc.adminUsage({ groupBy });
        expect(mockLedgerGroupBy).toHaveBeenCalledTimes(3);
        for (const [args] of mockLedgerGroupBy.mock.calls) {
          expect(args.by).toEqual(["projectId", "userId", "provider", "model", "agentStep"]);
        }
        // Only the double's own reads (no `select`): the service fetched no rows.
        for (const [args] of mockLedgerFindMany.mock.calls)
          expect(args).not.toHaveProperty("select");
        expect(result.totalCostUsd).toBeCloseTo(0.04, 10);
        expect(result.unpriced).toEqual({
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 9,
          count: 1,
        });
      }
    });

    it("pages the window for groupBy=day instead of loading it at once", async () => {
      const page = Array.from({ length: 5_000 }, (_, i) => ({
        ...ledgerRow({ totalTokens: 1, costUsd: 0.01 }),
        id: `r${String(i).padStart(5, "0")}`,
      }));
      mockLedgerFindMany
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce([{ ...ledgerRow({ totalTokens: 1, costUsd: 0.01 }), id: "r99999" }]);
      const result = await svc.adminUsage({ groupBy: "day" });
      expect(mockLedgerFindMany).toHaveBeenCalledTimes(2);
      const [first, second] = mockLedgerFindMany.mock.calls.map((c) => c[0]);
      expect(first).toMatchObject({ take: 5_000, orderBy: { id: "asc" } });
      expect(first).not.toHaveProperty("cursor");
      expect(second).toMatchObject({ take: 5_000, cursor: { id: "r04999" }, skip: 1 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].count).toBe(5_001);
      expect(result.totalCostUsd).toBeCloseTo(50.01, 8);
    });
  });

  describe("sub-cent cost (#761)", () => {
    it("sums each row's unrounded costUsd, not its per-row-rounded costCents", async () => {
      // 67 calls at 0.075¢: costCents rounds every one to 0.
      mockLedgerFindMany.mockResolvedValue(
        Array.from({ length: 67 }, () => ledgerRow({ costCents: 0, costUsd: 0.00075 })),
      );
      const project = await svc.projectUsage("proj-1");
      expect(project.totalCostUsd).toBeCloseTo(0.05025, 10);
      const platform = await svc.adminUsage();
      expect(platform.totalCostUsd).toBeCloseTo(0.05025, 10);
      expect(platform.unpriced.count).toBe(0);
    });

    it("keeps a row with neither cost unpriced (#22)", async () => {
      mockLedgerFindMany.mockResolvedValue([ledgerRow({ costCents: null, costUsd: null })]);
      const result = await svc.adminUsage();
      expect(result.unpriced.count).toBe(1);
      expect(result.rows[0].estimatedCostUsd).toBeNull();
    });
  });

  describe("toCSV", () => {
    it("generates valid CSV string", () => {
      const rows = [
        {
          dayBucket: "2025-01-15",
          provider: "bedrock",
          model: "sonnet",
          userId: "user-1",
          projectId: "proj-1",
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          estimatedCostUsd: 0.001234,
          count: 3,
          unpricedTokens: 0,
        },
      ];

      const csv = svc.toCSV(rows);
      const lines = csv.split("\n");
      expect(lines[0]).toContain("dayBucket");
      expect(lines[0]).toContain("estimatedCostUsd");
      expect(lines[1]).toContain("2025-01-15");
      expect(lines[1]).toContain("0.001234");
    });

    it("handles empty rows", () => {
      const csv = svc.toCSV([]);
      const lines = csv.split("\n");
      expect(lines).toHaveLength(1); // header only
    });
  });

  describe("singleton", () => {
    it("returns same instance", () => {
      const a = getUsageService();
      const b = getUsageService();
      expect(a).toBe(b);
    });

    it("resets on __resetUsageServiceSingleton", () => {
      const a = getUsageService();
      __resetUsageServiceSingleton();
      const b = getUsageService();
      expect(a).not.toBe(b);
    });
  });
});
