/**
 * #2347 — the title search's Postgres branch, hermetically: `ILIKE` with the
 * term bound and its wildcards escaped, narrowing the page to the matched ids
 * of THIS project. The SQLite branch runs for real in
 * `tests/project-requirements-2347.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
const count = vi.fn();
const findMany = vi.fn();
let provider: "postgresql" | "sqlite" = "postgresql";
vi.mock("../prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    Prisma,
    resolveDatabaseProvider: () => provider,
    prisma: {
      $queryRaw: (...a: unknown[]) => queryRaw(...a),
      requirement: {
        count: (...a: unknown[]) => count(...a),
        findMany: (...a: unknown[]) => findMany(...a),
      },
    },
  };
});

const { listProjectRequirements, selfApprovalFlagDue } =
  await import("./project-requirements-list.js");

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ id: "r-1" }]);
  count.mockResolvedValue(1);
  findMany.mockResolvedValue([]);
});

describe("listProjectRequirements title search (#2347)", () => {
  it("on Postgres: ILIKE on this project, the term bound with wildcards escaped", async () => {
    provider = "postgresql";
    await listProjectRequirements("p-1", { q: " 50%_off\\ ", page: 1, pageSize: 25 });
    const sql = queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(sql.sql).toMatch(/"title" ILIKE \?/);
    // #2347 review — the cap keeps the rows the list shows first, deterministically.
    expect(sql.sql).toMatch(/ORDER BY "updatedAt" DESC, "id" ASC\s+LIMIT \?/);
    // One past the cap, to tell "exactly the cap" from "more than it"; #2447 —
    // read a page at a time from an offset, so hidden matches are read past.
    expect(sql.values).toEqual(["p-1", "%50\\%\\_off\\\\%", 5001, 0]);
    const where = count.mock.calls[0][0].where;
    expect(where).toMatchObject({ projectId: "p-1", deletedAt: null, id: { in: ["r-1"] } });
  });

  it("past the cap: keeps the first 5,000 and says the total is a lower bound", async () => {
    provider = "postgresql";
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: `r-${i}` }));
    queryRaw.mockResolvedValue(many);
    count.mockResolvedValue(5000);
    const page = await listProjectRequirements("p-1", { q: "a", page: 1, pageSize: 25 });
    expect(page.totalIsLowerBound).toBe(true);
    const ids = count.mock.calls[0][0].where.id.in as string[];
    expect(ids).toHaveLength(5000);
    expect(ids[0]).toBe("r-0");
    expect(ids).not.toContain("r-5000");
  });

  it("exactly at the cap: the total is exact", async () => {
    provider = "sqlite";
    queryRaw.mockResolvedValue(Array.from({ length: 5000 }, (_, i) => ({ id: `r-${i}` })));
    const page = await listProjectRequirements("p-1", { q: "a", page: 1, pageSize: 25 });
    expect(page.totalIsLowerBound).toBe(false);
    expect(count.mock.calls[0][0].where.id.in).toHaveLength(5000);
  });

  it("on SQLite: LIKE with an explicit escape", async () => {
    provider = "sqlite";
    await listProjectRequirements("p-1", { q: "card", page: 1, pageSize: 25 });
    const sql = queryRaw.mock.calls[0][0] as { sql: string };
    expect(sql.sql).toMatch(/"title" LIKE \? ESCAPE '\\'/);
    // #2347 review — the same deterministic order before the cap on SQLite.
    expect(sql.sql).toMatch(/ORDER BY "updatedAt" DESC, "id" ASC\s+LIMIT \?/);
  });

  it("runs no search query without a term", async () => {
    await listProjectRequirements("p-1", { q: "   ", page: 2, pageSize: 10 });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 10, take: 10 });
  });
});

describe("selfApprovalFlagDue (#2462): no flag reads while the page polls a run in progress", () => {
  it.each(["completed", "failed", "cancelled"])("a %s run is due", (status) => {
    expect(selfApprovalFlagDue({ status, metadata: null })).toBe(true);
  });

  it("a completed run being re-run (running, completedAt kept) is due", () => {
    expect(
      selfApprovalFlagDue({
        status: "running",
        completedAt: "2026-11-13T00:00:00Z",
        metadata: null,
      }),
    ).toBe(true);
  });

  it.each(["pending", "running"])("a %s run is not, unless its checkpoint is open", (status) => {
    expect(selfApprovalFlagDue({ status, metadata: null })).toBe(false);
    expect(
      selfApprovalFlagDue({ status, metadata: { promotionBlocked: { blocked: false } } }),
    ).toBe(false);
    expect(selfApprovalFlagDue({ status, metadata: { promotionBlocked: "yes" } })).toBe(false);
    expect(selfApprovalFlagDue({ status, metadata: { promotionBlocked: { blocked: true } } })).toBe(
      true,
    );
  });
});
