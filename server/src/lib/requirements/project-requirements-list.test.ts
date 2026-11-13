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

const { listProjectRequirements } = await import("./project-requirements-list.js");

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
    expect(sql.values).toEqual(["p-1", "%50\\%\\_off\\\\%", 5000]);
    const where = count.mock.calls[0][0].where;
    expect(where).toMatchObject({ projectId: "p-1", deletedAt: null, id: { in: ["r-1"] } });
  });

  it("on SQLite: LIKE with an explicit escape", async () => {
    provider = "sqlite";
    await listProjectRequirements("p-1", { q: "card", page: 1, pageSize: 25 });
    const sql = queryRaw.mock.calls[0][0] as { sql: string };
    expect(sql.sql).toMatch(/"title" LIKE \? ESCAPE '\\'/);
  });

  it("runs no search query without a term", async () => {
    await listProjectRequirements("p-1", { q: "   ", page: 2, pageSize: 10 });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 10, take: 10 });
  });
});
