/**
 * #156 — the maintenance path that purges fact-cache rows cut off by the
 * Phase-1 output cap. Exercised against an in-memory table that applies the
 * same `where` the real query would, so the filter itself is under test.
 */
import { describe, expect, it } from "vitest";
import { purgeTruncatedFactCache, type FactCachePurgePrisma } from "./fact-cache-maintenance.js";

interface Row {
  id: string;
  projectId: string;
  outputTokens: number;
}

function fakeDb(rows: Row[]): FactCachePurgePrisma & { rows: Row[] } {
  const state = { rows: [...rows] };
  const matches = (r: Row, where: { outputTokens: { gte: number }; projectId?: string }) =>
    r.outputTokens >= where.outputTokens.gte &&
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

const ROWS: Row[] = [
  { id: "a", projectId: "p1", outputTokens: 8192 }, // hit the default cap
  { id: "b", projectId: "p1", outputTokens: 3000 }, // complete
  { id: "c", projectId: "p2", outputTokens: 9000 }, // over the default cap
  { id: "d", projectId: "p2", outputTokens: 8191 }, // just under
];

describe("purgeTruncatedFactCache (#156)", () => {
  it("deletes rows at or above the default Phase-1 cap and keeps the rest", async () => {
    const db = fakeDb(ROWS);
    const report = await purgeTruncatedFactCache(db);
    expect(report).toEqual({ matched: 2, deleted: 2, minOutputTokens: 8192, dryRun: false });
    expect(db.rows.map((r) => r.id).sort()).toEqual(["b", "d"]);
  });

  it("dry-run counts without deleting", async () => {
    const db = fakeDb(ROWS);
    const report = await purgeTruncatedFactCache(db, { dryRun: true });
    expect(report).toMatchObject({ matched: 2, deleted: 0, dryRun: true });
    expect(db.rows).toHaveLength(4);
  });

  it("scopes to one project", async () => {
    const db = fakeDb(ROWS);
    const report = await purgeTruncatedFactCache(db, { projectId: "p2" });
    expect(report.deleted).toBe(1);
    expect(db.rows.map((r) => r.id).sort()).toEqual(["a", "b", "d"]);
  });

  it("honours an operator-chosen threshold", async () => {
    const db = fakeDb(ROWS);
    const report = await purgeTruncatedFactCache(db, { minOutputTokens: 3000 });
    expect(report.deleted).toBe(4);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects a nonsensical threshold %s", async (bad) => {
    await expect(purgeTruncatedFactCache(fakeDb(ROWS), { minOutputTokens: bad })).rejects.toThrow(
      /positive integer/,
    );
  });
});
