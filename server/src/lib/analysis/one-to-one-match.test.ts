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
        // #1204 — the reported options are keyed by exactly the refused lefts.
        expect([...out.refusedLeftOptions.keys()].sort()).toEqual([...tc.refusedLefts].sort());
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

/**
 * Replay `candidates` level by level by brute force and check every decision
 * `matchOneToOneRefusingTies` made. A repeated pair is read at its best score,
 * levels are the classes `compareTiersDescending` calls equal, and lefts and
 * rights are tracked apart, since one id may name both.
 *
 * Returns whether some level was a PERFECT graph (every live vertex matched)
 * with more than one maximum matching: there only an even alternating cycle can
 * unforce a pair, so a corpus with such levels exercises the cycle (SCC) half
 * of the proof.
 */
function expectMatchesBruteForce(
  candidates: ReadonlyArray<OneToOneCandidate<string, string, number[]>>,
  label: string,
): { cycleOnlyLevel: boolean } {
  const out = matchOneToOneRefusingTies(candidates, {
    compare: compareTiersDescending,
  });

  const best = new Map<string, { left: string; right: string; score: number[] }>();
  for (const c of candidates) {
    const key = `${c.left}\u0000${c.right}`;
    const seen = best.get(key);
    if (!seen || compareTiersDescending(c.score, seen.score) < 0) best.set(key, c);
  }
  const pairs = [...best.values()].sort((a, b) => compareTiersDescending(a.score, b.score));
  const levels: Array<typeof pairs> = [];
  for (const p of pairs) {
    const level = levels.at(-1);
    if (level && compareTiersDescending(level[0]!.score, p.score) === 0) level.push(p);
    else levels.push([p]);
  }

  let cycleOnlyLevel = false;
  const matchedL = new Set<string>();
  const matchedR = new Set<string>();
  const refusedL = new Set<string>();
  const refusedR = new Set<string>();
  const refusedAmong = new Map<string, string[]>();
  const expectedMatches = new Map<string, string>();
  for (const [index, level] of levels.entries()) {
    const live: Edge[] = level
      .filter((c) => !matchedL.has(c.left) && !refusedL.has(c.left))
      .filter((c) => !matchedR.has(c.right) && !refusedR.has(c.right))
      .map((c) => [c.left, c.right]);
    if (live.length === 0) continue;
    const maxima = allMaximumMatchings(live);
    const inEvery = maxima[0]!.filter(([l, r]) =>
      maxima.every((m) => m.some(([l2, r2]) => l2 === l && r2 === r)),
    );
    const vertices = new Set(live.map(([l]) => l)).size + new Set(live.map(([, r]) => r)).size;
    if (maxima.length > 1 && maxima[0]!.length * 2 === vertices) cycleOnlyLevel = true;
    for (const [l, r] of live) {
      const takenHere = out.matches.get(l) === r;
      const forced = inEvery.some(([l2, r2]) => l2 === l && r2 === r);
      // No matched pair is missing from any maximum matching of its level,
      // and no pair in all of them is left out.
      expect(takenHere, `${label}: ${l}–${r} at level ${index}`).toBe(forced);
    }
    for (const [l, r] of inEvery) {
      matchedL.add(l);
      matchedR.add(r);
      expectedMatches.set(l, r);
    }
    for (const [l, r] of live) {
      if (!matchedL.has(l)) {
        refusedL.add(l);
        // A right a forced pair took at this same level is not an option
        // the refused left was "too close to call" on (#1204 review): it
        // went to another left. Collecting it here would agree with an
        // overcounting matcher and prove nothing.
        const options = refusedAmong.get(l) ?? [];
        refusedAmong.set(l, matchedR.has(r) ? options : [...options, r]);
      }
      if (!matchedR.has(r)) refusedR.add(r);
    }
  }
  expect(Object.fromEntries(out.matches), `${label}: matches`).toEqual(
    Object.fromEntries(expectedMatches),
  );
  // #1204 — each refused left reports exactly its live options at the
  // level that refused it: no fewer, and none from another level.
  expect(
    Object.fromEntries([...out.refusedLeftOptions].map(([l, rs]) => [l, [...rs].sort()])),
    `${label}: refused options`,
  ).toEqual(Object.fromEntries([...refusedAmong].map(([l, rs]) => [l, [...rs].sort()])));
  // Every refused left has at least one option, and none of them is a
  // right that any left was given.
  const givenRights = new Set(out.matches.values());
  for (const [l, rs] of out.refusedLeftOptions) {
    expect(rs.size, `${label}: ${l} has no options`).toBeGreaterThan(0);
    for (const r of rs) expect(givenRights.has(r), `${label}: ${l} lists ${r}`).toBe(false);
  }
  // Nothing refused at a better level is matched at a weaker one.
  for (const l of refusedL) expect(out.matches.has(l), `${label}: ${l} fell back`).toBe(false);
  for (const r of refusedR) expect(givenRights.has(r), `${label}: ${r} fell back`).toBe(false);
  expect([...out.refusedLefts].sort(), `${label}: refused lefts`).toEqual([...refusedL].sort());
  expect([...out.refusedRights].sort(), `${label}: refused rights`).toEqual([...refusedR].sort());
  return { cycleOnlyLevel };
}

/**
 * Tier tuples for the random corpus. Some are equal under
 * `compareTiersDescending` though written differently ([1] and [1, 0];
 * [1, 0.5] and [1, 0.5, 0]), so a level is a class of scores, not one value.
 */
const ONE_LEVEL_SCORES: number[][] = [[1], [1, 0]];
const MANY_LEVEL_SCORES: number[][] = [[1], [1, 0], [1, 0.5], [1, 0.5, 0], [0.5], [0.5, 1], [0, 1]];

/**
 * Random candidates on 0 … `maxSide` lefts and 0 … `maxSide` rights (so a side
 * may be empty), shuffled. Sometimes lefts and rights share their ids; some
 * pairs are repeated with another score, to be read at the best of them.
 */
function randomCandidates(
  random: () => number,
  maxSide: number,
  scores: readonly number[][],
): Array<OneToOneCandidate<string, string, number[]>> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const shared = random() < 0.3;
  const lefts = Array.from({ length: Math.floor(random() * (maxSide + 1)) }, (_, i) =>
    shared ? `V${i + 1}` : `R${i + 1}`,
  );
  const rights = Array.from({ length: Math.floor(random() * (maxSide + 1)) }, (_, i) =>
    shared ? `V${i + 1}` : `S${i + 1}`,
  );
  const density = 0.15 + random() * 0.6;
  const candidates: Array<OneToOneCandidate<string, string, number[]>> = [];
  for (const left of lefts) {
    for (const right of rights) {
      if (random() < density) candidates.push({ left, right, score: pick(scores) });
    }
  }
  const unique = candidates.length;
  for (let i = 0; i < unique; i++) {
    if (random() < 0.2) candidates.push({ ...candidates[i]!, score: pick(scores) });
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }
  return candidates;
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
            candidates.push({
              left: l,
              right: r,
              score: [random() < 0.6 ? 1 : 0.5],
            });
        }
      }
      expectMatchesBruteForce(candidates, `trial ${trial}`);
    }
  });

  // #1208 — the proof is one maximum matching read Dulmage–Mendelsohn style,
  // not a re-match per edge. Cross-check it against brute force on thousands
  // of seeded graphs up to 6 × 6: half at one level, half over several tiered
  // levels, with empty sides, repeated pairs and ids shared across sides.
  it("agrees with brute force on 6,000 seeded random graphs up to 6 × 6 (#1208)", () => {
    const random = rng(1208);
    let cycleOnly = 0;
    let noCandidates = 0;
    let repeated = 0;
    let sharedIds = 0;
    for (let trial = 0; trial < 6_000; trial++) {
      const scores = trial % 2 === 0 ? ONE_LEVEL_SCORES : MANY_LEVEL_SCORES;
      const candidates = randomCandidates(random, 6, scores);
      if (candidates.length === 0) noCandidates++; // an empty side, or no edge drawn
      const keys = candidates.map((c) => `${c.left}\u0000${c.right}`);
      if (new Set(keys).size < keys.length) repeated++;
      if (candidates.some((c) => c.left.startsWith("V"))) sharedIds++;
      if (expectMatchesBruteForce(candidates, `#1208 trial ${trial}`).cycleOnlyLevel) cycleOnly++;
    }
    // The corpus must reach the cycle half of the proof: levels where every
    // vertex is matched yet the matching is not unique, so only an even
    // alternating cycle can unforce a pair. Without them, a matcher with a
    // wrong SCC test could pass. And it must reach each input shape it claims.
    expect(cycleOnly).toBeGreaterThan(100);
    expect(noCandidates).toBeGreaterThan(100);
    expect(repeated).toBeGreaterThan(500);
    expect(sharedIds).toBeGreaterThan(500);
  });
});

// ── Size: the proof is near-linear (#1208) ──────────────────────────────────

/**
 * A CI-safe ceiling, not the target. #1208 asks for K300,300 under 200 ms,
 * measured locally (the PR records the figures); the per-edge re-match this
 * replaced took 7.3 s for K300,300 and 31 s for the 2,499-edge chain. One
 * second keeps a contended CI runner from flaking and still fails on any
 * return to a per-edge proof.
 */
const CI_SAFE_MS = 1_000;

type Candidates = Array<OneToOneCandidate<string, string, number[]>>;

function timedMatch(candidates: Candidates) {
  const start = performance.now();
  const out = matchOneToOneRefusingTies(candidates, { compare: compareTiersDescending });
  return { out, ms: performance.now() - start };
}

describe("matchOneToOneRefusingTies — size (#1208)", () => {
  const orders: Array<[string, (c: Candidates) => Candidates]> = [
    ["forward", (c) => c],
    ["reversed", (c) => [...c].reverse()],
  ];

  for (const [name, order] of orders) {
    it(`K300,300 at one level refuses every vertex, quickly (${name} order)`, () => {
      const complete: Candidates = [];
      for (let l = 0; l < 300; l++)
        for (let r = 0; r < 300; r++) complete.push({ left: `L${l}`, right: `R${r}`, score: [1] });
      const { out, ms } = timedMatch(order(complete));
      expect(out.matches.size).toBe(0);
      expect(out.refusedLefts.size).toBe(300);
      expect(out.refusedRights.size).toBe(300);
      expect(ms).toBeLessThan(CI_SAFE_MS);
    });

    it(`a closed 2,499-edge chain L0:{R0}, Li:{R(i-1), Ri} is forced pair by pair, quickly (${name} order)`, () => {
      // The only maximum matching is Li–Ri. #1186's review measured 31 s here.
      const chain: Candidates = [{ left: "L0", right: "R0", score: [1] }];
      for (let i = 1; i < 1_250; i++) {
        chain.push({ left: `L${i}`, right: `R${i - 1}`, score: [1] });
        chain.push({ left: `L${i}`, right: `R${i}`, score: [1] });
      }
      expect(chain).toHaveLength(2_499);
      const { out, ms } = timedMatch(order(chain));
      expect(out.matches.size).toBe(1_250);
      for (let i = 0; i < 1_250; i++) expect(out.matches.get(`L${i}`)).toBe(`R${i}`);
      expect(ms).toBeLessThan(CI_SAFE_MS);
    });

    it(`an open 2,500-edge chain Li:{Ri, R(i+1)} refuses everything, quickly (${name} order)`, () => {
      // One spare right: every pair lies on an even alternating path from a
      // free right, so nothing is forced.
      const chain: Candidates = [];
      for (let i = 0; i < 1_250; i++) {
        chain.push({ left: `L${i}`, right: `R${i}`, score: [1] });
        chain.push({ left: `L${i}`, right: `R${i + 1}`, score: [1] });
      }
      const { out, ms } = timedMatch(order(chain));
      expect(out.matches.size).toBe(0);
      expect(out.refusedLefts.size).toBe(1_250);
      expect(out.refusedRights.size).toBe(1_251);
      expect(ms).toBeLessThan(CI_SAFE_MS);
    });
  }
});

describe("matchOneToOneRefusingTies — refused options (#1204)", () => {
  it("never lists a right a forced pair took at the same level", () => {
    // Lb reaches only R, so Lb–R is in every maximum matching and is taken.
    // La and Lc then tie on X1 and X2. La also had R live at this level, but R
    // went to Lb: offering it as one of La's options would invite copying
    // Lb's criteria onto La — the wrong-requirement bug.
    const candidates: Array<OneToOneCandidate<string, string, number[]>> = [
      { left: "Lb", right: "R", score: [1] },
      { left: "La", right: "R", score: [1] },
      { left: "La", right: "X1", score: [1] },
      { left: "La", right: "X2", score: [1] },
      { left: "Lc", right: "X1", score: [1] },
      { left: "Lc", right: "X2", score: [1] },
    ];
    for (const order of permutations(candidates)) {
      const out = matchOneToOneRefusingTies(order, { compare: compareTiersDescending });
      expect(Object.fromEntries(out.matches)).toEqual({ Lb: "R" });
      expect(out.refusedLeftOptions.get("La")).toEqual(new Set(["X1", "X2"]));
      expect(out.refusedLeftOptions.get("Lc")).toEqual(new Set(["X1", "X2"]));
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
