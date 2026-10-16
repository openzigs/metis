import { describe, expect, it } from "vitest";
import { compareTiersDescending, matchOneToOneRefusingTies } from "./one-to-one-match.js";
import { ONE_TO_ONE_TIE_CASES } from "./one-to-one-match.cases.js";

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("matchOneToOneRefusingTies — the shared tie table", () => {
  for (const tc of ONE_TO_ONE_TIE_CASES) {
    it(`${tc.name} (every candidate order)`, () => {
      for (const order of permutations(tc.candidates)) {
        const out = matchOneToOneRefusingTies(order, { compare: compareTiersDescending });
        expect(Object.fromEntries(out.matches)).toEqual(tc.matches);
        expect([...out.tiedLefts].sort()).toEqual([...tc.tiedLefts].sort());
        expect([...out.tiedRights].sort()).toEqual([...tc.tiedRights].sort());
      }
    });
  }
});

describe("matchOneToOneRefusingTies — edges", () => {
  it("matches nothing from no candidates", () => {
    const out = matchOneToOneRefusingTies([], { compare: compareTiersDescending });
    expect(out.matches.size).toBe(0);
  });

  it("reads a repeated pair once, at its best level", () => {
    const out = matchOneToOneRefusingTies(
      [
        { left: "R1", right: "S1", score: [0.5] },
        { left: "R1", right: "S1", score: [1] },
        { left: "R2", right: "S1", score: [0.5] },
      ],
      { compare: compareTiersDescending },
    );
    expect(Object.fromEntries(out.matches)).toEqual({ R1: "S1" });
  });

  it("accepts any score type through its own compare", () => {
    const out = matchOneToOneRefusingTies(
      [
        { left: 1, right: "a", score: 3 },
        { left: 2, right: "a", score: 5 },
      ],
      { compare: (a: number, b: number) => b - a },
    );
    expect(Object.fromEntries(out.matches)).toEqual({ 2: "a" });
  });
});

describe("compareTiersDescending", () => {
  it("orders by the first differing tier, higher first, padding with zeros", () => {
    expect(compareTiersDescending([1, 0], [0, 1])).toBeLessThan(0);
    expect(compareTiersDescending([0, 0.5], [0, 0.8])).toBeGreaterThan(0);
    expect(compareTiersDescending([1], [1, 0])).toBe(0);
    expect(compareTiersDescending([1], [1, 0.1])).toBeGreaterThan(0);
  });
});
