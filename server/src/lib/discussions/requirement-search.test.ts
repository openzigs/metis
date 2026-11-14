/**
 * #2209 — the requirement picker's search, with Prisma mocked: what each layer
 * scopes on, on whichever client is generated. The behaviour against a real
 * database is pinned by tests/discussion-requirement-picker.sqlite.test.ts and
 * tests/discussion-requirement-search-2209-postgres.integration.test.ts; this
 * pins that the SQL and the read-back each filter on the project on their own,
 * which neither real-database suite can tell apart (each layer hides the other).
 *
 * #2218 — the match is built per backend (`LOWER … LIKE` on Postgres, a
 * case-folded `GLOB` on SQLite) and the term is capped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const queryRaw = vi.fn();
const findMany = vi.fn();
vi.mock("../prisma.js", async () => ({
  Prisma: (await vi.importActual<typeof import("@prisma/client")>("@prisma/client")).Prisma,
  resolveDatabaseProvider: () => "postgresql",
  prisma: {
    $queryRaw: (query: Prisma.Sql) => queryRaw(query),
    requirement: { findMany: (...a: unknown[]) => findMany(...a) },
  },
}));

const {
  caseFoldGlob,
  escapeLike,
  requirementMatchQuery,
  searchProjectRequirements,
  REQUIREMENT_PICKER_LIMIT,
  REQUIREMENT_PICKER_MAX_TERM,
} = await import("./requirement-search.js");

/** The SQL text of the last `$queryRaw`, with `?` for each bound value. */
function lastSql(): { sql: string; values: unknown[] } {
  const [query] = queryRaw.mock.calls.at(-1) as [Prisma.Sql];
  return { sql: query.sql.replace(/\s+/g, " "), values: query.values };
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

describe("caseFoldGlob (#2218)", () => {
  it("offers every case of each letter, ASCII or not", () => {
    expect(caseFoldGlob("über")).toBe("*[üÜ][bB][eE][rR]*");
    expect(caseFoldGlob("ÉTÉ")).toBe("*[Éé][Tt][Éé]*");
  });

  it("brackets GLOB's own wildcards so they match literally, and leaves the rest", () => {
    expect(caseFoldGlob("1*2?[3]")).toBe("*1[*]2[?][[]3]*");
    expect(caseFoldGlob("100%_!")).toBe("*100%_!*");
  });

  it("keeps a character whose other case is two characters out of the bracket", () => {
    // "ß".toUpperCase() is "SS": not one character, so not a bracket member;
    // its single-character capital ẞ is (#2224).
    expect(caseFoldGlob("ß")).toBe("*[ßẞ]*");
    expect(caseFoldGlob("ẞ")).toBe("*[ẞß]*");
  });

  it("offers every form of a letter with more than two (#2224)", () => {
    expect(caseFoldGlob("s")).toBe("*[sSſ]*");
    expect(caseFoldGlob("ſ")).toBe("*[ſSs]*");
    expect(caseFoldGlob("Σ")).toBe("*[Σσς]*");
    expect(caseFoldGlob("ς")).toBe("*[ςΣσ]*");
    // Dotted and dotless I read as an i, as a picker user expects.
    expect(caseFoldGlob("i")).toBe("*[iIİı]*");
    expect(caseFoldGlob("İ")).toBe("*[İIiı]*");
    // The Kelvin sign (U+212A) is a case of k.
    expect(caseFoldGlob("k")).toBe("*[kKK]*");
  });

  it("leaves a caseless character as itself", () => {
    expect(caseFoldGlob("7 – 中")).toBe("*7 – 中*");
  });
});

describe("requirementMatchQuery (#2218)", () => {
  it("folds with LOWER … LIKE on Postgres, the term escaped and bound", () => {
    const q = requirementMatchQuery("postgresql", "p-1", "50%_off");
    expect(q.sql.replace(/\s+/g, " ")).toContain(`LOWER(r."title") LIKE LOWER(?) ESCAPE '!'`);
    expect(q.sql).not.toContain("GLOB");
    expect(q.values).toEqual(["p-1", "%50!%!_off%", REQUIREMENT_PICKER_LIMIT]);
  });

  it("matches a case-folded GLOB on SQLite, bound, with no LOWER", () => {
    const q = requirementMatchQuery("sqlite", "p-1", "Über");
    expect(q.sql).toContain(`r."title" GLOB ?`);
    expect(q.sql).not.toContain("LOWER");
    expect(q.values).toEqual(["p-1", "*[Üü][bB][eE][rR]*", REQUIREMENT_PICKER_LIMIT]);
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

  it("sends the backend it is given its own match (#2218)", async () => {
    queryRaw.mockResolvedValue([]);
    await searchProjectRequirements("p-1", "über", "sqlite");
    expect(lastSql().sql).toContain(`r."title" GLOB ?`);
    expect(lastSql().values[1]).toBe("*[üÜ][bB][eE][rR]*");
  });

  it("cuts the term at the cap, by character (#2218)", async () => {
    queryRaw.mockResolvedValue([]);
    // An astral character is two UTF-16 units; the cap counts it as one.
    const term = "😀".repeat(REQUIREMENT_PICKER_MAX_TERM + 50);
    await searchProjectRequirements("p-1", term);
    expect(lastSql().values[1]).toBe(`%${"😀".repeat(REQUIREMENT_PICKER_MAX_TERM)}%`);
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
