import { describe, expect, it } from "vitest";
import {
  compareTiersDescending,
  matchOneToOneRefusingTies,
  type OneToOneCandidate,
} from "./one-to-one-match.js";
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
        expect([...out.refusedLefts].sort()).toEqual([...tc.refusedLefts].sort());
        expect([...out.refusedRights].sort()).toEqual([...tc.refusedRights].sort());
      }
    });
  }
});

// ── Property: never a guess ─────────────────────────────────────────────────

type Edge = [string, string];

/** Every maximum matching of a small bipartite edge list, by brute force. */
function allMaximumMatchings(edges: readonly Edge[]): Edge[][] {
  let best: Edge[][] = [[]];
  const walk = (i: number, chosen: Edge[], usedL: Set<string>, usedR: Set<string>): void => {
    if (i === edges.length) {
      if (chosen.length > best[0]!.length) best = [[...chosen]];
      else if (chosen.length === best[0]!.length && chosen.length > 0) best.push([...chosen]);
      return;
    }
    walk(i + 1, chosen, usedL, usedR);
    const [l, r] = edges[i]!;
    if (!usedL.has(l) && !usedR.has(r)) {
      usedL.add(l);
      usedR.add(r);
      chosen.push([l, r]);
      walk(i + 1, chosen, usedL, usedR);
      chosen.pop();
      usedL.delete(l);
      usedR.delete(r);
    }
  };
  walk(0, [], new Set(), new Set());
  return best;
}

/** A seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("matchOneToOneRefusingTies — property: a matched pair is never a guess", () => {
  it("on random small graphs, takes exactly the pairs in every maximum matching of their level", () => {
    const random = rng(1033);
    for (let trial = 0; trial < 400; trial++) {
      const lefts = ["R1", "R2", "R3", "R4"].slice(0, 1 + Math.floor(random() * 4));
      const rights = ["S1", "S2", "S3", "S4"].slice(0, 1 + Math.floor(random() * 4));
      const candidates: Array<OneToOneCandidate<string, string, number[]>> = [];
      for (const l of lefts) {
        for (const r of rights) {
          if (random() < 0.45)
            candidates.push({ left: l, right: r, score: [random() < 0.6 ? 1 : 0.5] });
        }
      }
      const out = matchOneToOneRefusingTies(candidates, { compare: compareTiersDescending });

      // Replay the levels by brute force and check every decision.
      const matched = new Set<string>();
      const refused = new Set<string>();
      for (const level of [1, 0.5]) {
        const live: Edge[] = candidates
          .filter((c) => c.score[0] === level)
          .filter((c) => ![c.left, c.right].some((v) => matched.has(v) || refused.has(v)))
          .map((c) => [c.left, c.right]);
        if (live.length === 0) continue;
        const maxima = allMaximumMatchings(live);
        const inEvery = maxima[0]!.filter(([l, r]) =>
          maxima.every((m) => m.some(([l2, r2]) => l2 === l && r2 === r)),
        );
        for (const [l, r] of live) {
          const takenHere = out.matches.get(l) === r;
          const forced = inEvery.some(([l2, r2]) => l2 === l && r2 === r);
          // No matched pair is missing from any maximum matching of its level,
          // and no pair in all of them is left out.
          expect(takenHere, `trial ${trial}: ${l}–${r} at level ${level}`).toBe(forced);
        }
        for (const [l, r] of inEvery) {
          matched.add(l);
          matched.add(r);
        }
        for (const [l, r] of live) {
          if (!matched.has(l)) refused.add(l);
          if (!matched.has(r)) refused.add(r);
        }
      }
      // Nothing refused at a better level is matched at a weaker one.
      for (const v of refused) {
        expect(out.matches.has(v) || [...out.matches.values()].includes(v)).toBe(false);
      }
      expect([...out.refusedLefts, ...out.refusedRights].sort()).toEqual([...refused].sort());
    }
  });
});

describe("matchOneToOneRefusingTies — edges", () => {
  it("matches nothing from no candidates", () => {
    const out = matchOneToOneRefusingTies([], { compare: compareTiersDescending });
    expect(out.matches.size).toBe(0);
  });

  it("reads a repeated pair at its best level", () => {
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
