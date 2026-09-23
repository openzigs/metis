/**
 * #156 — the maintenance path that purges fact-cache rows cut off by the
 * Phase-1 output cap. Exercised against an in-memory table that applies the
 * same `where` the real query would, so the filter itself is under test.
 */
import { describe, expect, it } from "vitest";
import {
  parsePurgeArgs,
  purgeTruncatedFactCache,
  type FactCachePurgePrisma,
} from "./fact-cache-maintenance.js";

interface Row {
  id: string;
  projectId: string;
  outputTokens: number;
  promptVersion: number;
}

interface Where {
  outputTokens: { gte: number };
  promptVersion?: { lt: number };
  projectId?: string;
}

function fakeDb(rows: Row[]): FactCachePurgePrisma & { rows: Row[] } {
  const state = { rows: [...rows] };
  const matches = (r: Row, where: Where) =>
    r.outputTokens >= where.outputTokens.gte &&
    (where.promptVersion === undefined || r.promptVersion < where.promptVersion.lt) &&
    (where.projectId === undefined || r.projectId === where.projectId);
  return {
    get rows() {
      return state.rows;
    },
    docsGenFactCache: {
      count: async ({ where }) => state.rows.filter((r) => matches(r, where)).length,
      deleteMany: async ({ where }) => {
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => !matches(r, where));
        return { count: before - state.rows.length };
      },
    },
  };
}

const CURRENT = 4;

const ROWS: Row[] = [
  { id: "a", projectId: "p1", outputTokens: 8192, promptVersion: 3 }, // stale, hit the default cap
  { id: "b", projectId: "p1", outputTokens: 3000, promptVersion: 3 }, // stale, complete
  { id: "c", projectId: "p2", outputTokens: 9000, promptVersion: 3 }, // stale, over the cap
  { id: "d", projectId: "p2", outputTokens: 8191, promptVersion: 3 }, // stale, just under
  // Current version at/over the cap: only a COMPLETE larger-cap retry can be
  // cached now (#156), so this row is good and must survive by default.
  { id: "e", projectId: "p1", outputTokens: 12000, promptVersion: CURRENT },
];

const base = { currentPromptVersion: CURRENT };

describe("purgeTruncatedFactCache (#156)", () => {
  it("deletes stale-version rows at or above the default Phase-1 cap and keeps the rest", async () => {
    const db = fakeDb(ROWS);
    const report = await purgeTruncatedFactCache(db, base);
    expect(report).toEqual({
      matched: 2,
      deleted: 2,
      minOutputTokens: 8192,
      dryRun: false,
      includeCurrentVersion: false,
    });
    expect(db.rows.map((r) => r.id).sort()).toEqual(["b", "d", "e"]);
  });

  it("keeps a current-version row at the cap (a complete retry) unless asked to include it", async () => {
    const keep = fakeDb(ROWS);
    await purgeTruncatedFactCache(keep, base);
    expect(keep.rows.map((r) => r.id)).toContain("e");

    const sweep = fakeDb(ROWS);
    const report = await purgeTruncatedFactCache(sweep, { ...base, includeCurrentVersion: true });
    expect(report.deleted).toBe(3);
    expect(sweep.rows.map((r) => r.id)).not.toContain("e");
  });

  it("dry-run counts without deleting", async () => {
    const db = fakeDb(ROWS);
    const report = await purgeTruncatedFactCache(db, { ...base, dryRun: true });
    expect(report).toMatchObject({ matched: 2, deleted: 0, dryRun: true });
    expect(db.rows).toHaveLength(5);
  });

  it("scopes to one project", async () => {
    const db = fakeDb(ROWS);
    const report = await purgeTruncatedFactCache(db, { ...base, projectId: "p2" });
    expect(report.deleted).toBe(1);
    expect(db.rows.map((r) => r.id).sort()).toEqual(["a", "b", "d", "e"]);
  });

  it("honours an operator-chosen threshold", async () => {
    const db = fakeDb(ROWS);
    const report = await purgeTruncatedFactCache(db, { ...base, minOutputTokens: 3000 });
    expect(report.deleted).toBe(4);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects a nonsensical threshold %s", async (bad) => {
    await expect(
      purgeTruncatedFactCache(fakeDb(ROWS), { ...base, minOutputTokens: bad }),
    ).rejects.toThrow(/positive integer/);
  });

  it.each([0, 1.5, Number.NaN])("rejects a nonsensical current prompt version %s", async (bad) => {
    await expect(
      purgeTruncatedFactCache(fakeDb(ROWS), { currentPromptVersion: bad }),
    ).rejects.toThrow(/currentPromptVersion/);
  });
});

describe("parsePurgeArgs (#156)", () => {
  it("parses every flag", () => {
    expect(
      parsePurgeArgs([
        "--dry-run",
        "--project",
        "p1",
        "--min-output-tokens",
        "16384",
        "--include-current",
      ]),
    ).toEqual({
      dryRun: true,
      projectId: "p1",
      minOutputTokens: 16384,
      includeCurrentVersion: true,
    });
  });

  it("defaults to a non-dry, all-project, stale-version sweep", () => {
    expect(parsePurgeArgs([])).toEqual({ dryRun: false, includeCurrentVersion: false });
  });

  it.each([
    [["--project"]],
    [["--project", "--dry-run"]],
    [["--project", ""]],
    [["--min-output-tokens"]],
    [["--min-output-tokens", "--project", "p1"]],
  ])("refuses a flag with no value instead of widening the purge: %j", (argv) => {
    expect(() => parsePurgeArgs(argv)).toThrow(/requires a value/);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parsePurgeArgs(["--projct", "p1"])).toThrow(/unknown argument/);
  });
});
