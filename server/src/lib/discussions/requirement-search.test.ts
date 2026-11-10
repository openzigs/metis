/**
 * #2209 — the requirement picker's search, with Prisma mocked: what each layer
 * scopes on, on whichever client is generated. The behaviour against a real
 * database is pinned by tests/discussion-requirement-picker.sqlite.test.ts and
 * tests/discussion-requirement-search-2209-postgres.integration.test.ts; this
 * pins that the SQL and the read-back each filter on the project on their own,
 * which neither real-database suite can tell apart (each layer hides the other).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
const findMany = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => queryRaw(strings, values),
    requirement: { findMany: (...a: unknown[]) => findMany(...a) },
  },
}));

const { escapeLike, searchProjectRequirements, REQUIREMENT_PICKER_LIMIT } =
  await import("./requirement-search.js");

/** The SQL text of the last `$queryRaw`, with `?` for each bound value. */
function lastSql(): { sql: string; values: unknown[] } {
  const [strings, values] = queryRaw.mock.calls.at(-1) as [TemplateStringsArray, unknown[]];
  return { sql: strings.join("?").replace(/\s+/g, " "), values };
}

beforeEach(() => {
  queryRaw.mockReset();
  findMany.mockReset();
});

describe("escapeLike (#2209)", () => {
  it("escapes the LIKE wildcards and the escape character, nothing else", () => {
    expect(escapeLike("100%_done!")).toBe("100!%!_done!!");
    expect(escapeLike("read at")).toBe("read at");
  });
});

describe("searchProjectRequirements (#2209)", () => {
  it("lists the newest live requirements for a blank term, with no SQL match", async () => {
    findMany.mockResolvedValue([{ id: "r-1" }]);
    expect(await searchProjectRequirements("p-1", "   ")).toEqual([{ id: "r-1" }]);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p-1", deletedAt: null, analysis: { deletedAt: null } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: REQUIREMENT_PICKER_LIMIT,
      }),
    );
  });

  it("matches in SQL on the project, live rows only, the trimmed term escaped and bound", async () => {
    queryRaw.mockResolvedValue([{ id: "r-2" }, { id: "r-1" }]);
    findMany.mockResolvedValue([{ id: "r-2" }, { id: "r-1" }]);
    await searchProjectRequirements("p-1", "  50%_off ");

    const { sql, values } = lastSql();
    expect(sql).toContain(`WHERE r."projectId" = ?`);
    expect(sql).toContain(`AND r."deletedAt" IS NULL AND a."deletedAt" IS NULL`);
    expect(sql).toContain(`LOWER(r."title") LIKE LOWER(?) ESCAPE '!'`);
    expect(sql).toContain(`ORDER BY r."createdAt" DESC, r."id" DESC LIMIT ?`);
    expect(values).toEqual(["p-1", "%50!%!_off%", REQUIREMENT_PICKER_LIMIT]);
  });

  it("reads the matched rows back scoped to the project as well as by id", async () => {
    queryRaw.mockResolvedValue([{ id: "r-2" }, { id: "r-1" }]);
    findMany.mockResolvedValue([{ id: "r-2" }, { id: "r-1" }]);
    const rows = await searchProjectRequirements("p-1", "feeds");
    expect(rows).toEqual([{ id: "r-2" }, { id: "r-1" }]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p-1", id: { in: ["r-2", "r-1"] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
  });

  it("answers no rows without a second read when nothing matches", async () => {
    queryRaw.mockResolvedValue([]);
    expect(await searchProjectRequirements("p-1", "zz")).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
