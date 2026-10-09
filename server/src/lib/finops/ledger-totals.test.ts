/**
 * #977 — `sumLedgerUsage`, with Prisma mocked. The real-database behaviour is
 * in `tests/usage-numbers-977.sqlite.test.ts`, which the postgres-adapter job
 * skips; this sibling holds the controls on every adapter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const aggregate = vi.hoisted(() => vi.fn());
vi.mock("../prisma.js", () => ({ prisma: { tokenUsage: { aggregate } } }));

import { sumLedgerUsage } from "./ledger-totals.js";
import { LEGACY_COST_ROW_WHERE, UNPRICED_ROW_WHERE } from "./ledger-cost.js";

type Where = { AND?: unknown[] } & Record<string, unknown>;

/** Answer each of the three reads by which filter it carries. */
function ledger(all: unknown, legacyCents: number | null, unpriced: unknown): void {
  aggregate.mockImplementation(async ({ where }: { where: Where }) => {
    const extra = where.AND?.[1];
    if (extra === LEGACY_COST_ROW_WHERE) return { _sum: { costCents: legacyCents } };
    if (extra === UNPRICED_ROW_WHERE) return unpriced;
    return all;
  });
}

describe("sumLedgerUsage (#977)", () => {
  beforeEach(() => {
    aggregate.mockReset();
  });

  it("scopes every read to the caller's filter", async () => {
    ledger({ _sum: { totalTokens: 0, costUsd: null }, _count: { _all: 0 } }, null, {
      _sum: { totalTokens: null },
      _count: { _all: 0 },
    });
    const scope = { projectId: "p1", sessionId: "an-1" };
    await sumLedgerUsage(scope);
    expect(aggregate).toHaveBeenCalledTimes(3);
    const wheres = aggregate.mock.calls.map(([a]) => (a as { where: Where }).where);
    expect(wheres[0]).toBe(scope);
    expect(wheres.slice(1).map((w) => w.AND?.[0])).toEqual([scope, scope]);
  });

  it("adds legacy costCents to the unrounded costUsd and returns USD", async () => {
    ledger({ _sum: { totalTokens: 3_000, costUsd: 0.0015 }, _count: { _all: 3 } }, 2, {
      _sum: { totalTokens: 100 },
      _count: { _all: 1 },
    });
    const t = await sumLedgerUsage({ projectId: "p1" });
    expect(t.costUsd).toBeCloseTo(0.0215, 10);
    expect(t).toMatchObject({ totalTokens: 3_000, unpricedTokens: 100, calls: 3 });
  });

  it("is null when every row was unpriced, and 0 when there are no rows", async () => {
    ledger({ _sum: { totalTokens: 900, costUsd: null }, _count: { _all: 2 } }, null, {
      _sum: { totalTokens: 900 },
      _count: { _all: 2 },
    });
    expect((await sumLedgerUsage({})).costUsd).toBeNull();

    ledger({ _sum: { totalTokens: null, costUsd: null }, _count: { _all: 0 } }, null, {
      _sum: { totalTokens: null },
      _count: { _all: 0 },
    });
    expect(await sumLedgerUsage({})).toEqual({
      totalTokens: 0,
      costUsd: 0,
      unpricedTokens: 0,
      calls: 0,
    });
  });
});
