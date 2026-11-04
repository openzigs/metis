import { describe, expect, it } from "vitest";
import {
  bootstrapMeanCi,
  mcnemarExact,
  minimumDetectableGap,
  minimumDetectableGapStatement,
  pairedBootstrap,
  readDifference,
  seededRandom,
} from "./stats.js";

describe("mcnemarExact", () => {
  it("is 1 with no discordant pair", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it("matches the exact binomial tail", () => {
    // 2 × P(X ≤ 0), X ~ Bin(6, ½) = 2/64.
    expect(mcnemarExact(0, 6)).toBeCloseTo(2 / 64, 12);
    // 2 × (C(10,0) + C(10,1)) / 1024.
    expect(mcnemarExact(9, 1)).toBeCloseTo(22 / 1024, 12);
    // Symmetric in b and c, capped at 1.
    expect(mcnemarExact(1, 9)).toBe(mcnemarExact(9, 1));
    expect(mcnemarExact(5, 5)).toBe(1);
  });

  it("does not overflow on large counts", () => {
    const p = mcnemarExact(400, 600);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeLessThan(1e-9);
  });
});

describe("seededRandom", () => {
  it("is reproducible and in [0, 1)", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const xs = Array.from({ length: 100 }, () => a());
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(8)()).not.toBe(xs[0]);
  });
});

describe("pairedBootstrap", () => {
  it("finds a consistent improvement and excludes 0 from its interval", () => {
    const base = Array.from({ length: 40 }, (_, i) => (i % 4) / 4);
    const arm = base.map((v) => Math.min(1, v + 0.25));
    const d = pairedBootstrap(base, arm, { iterations: 2000 });
    expect(d.meanDifference).toBeGreaterThan(0.15);
    expect(d.ci[0]).toBeGreaterThan(0);
    expect(d.p).toBeLessThan(0.05);
    expect(readDifference(d)).toBe("better");
  });

  it("calls a mixed result no measurable difference", () => {
    const base = [0, 1, 0, 1, 0, 1, 0, 1];
    const arm = [1, 0, 0, 1, 1, 0, 0, 1];
    const d = pairedBootstrap(base, arm, { iterations: 2000 });
    expect(d.meanDifference).toBe(0);
    expect(readDifference(d)).toBe("no measurable difference");
  });

  it("is reproducible for a seed", () => {
    const base = [0.1, 0.5, 0.2, 0.9, 0.4];
    const arm = [0.3, 0.4, 0.6, 0.8, 0.9];
    expect(pairedBootstrap(base, arm)).toEqual(pairedBootstrap(base, arm));
  });

  it("handles no items and refuses unpaired input", () => {
    expect(pairedBootstrap([], [])).toEqual({ meanDifference: 0, ci: [0, 0], p: 1, n: 0 });
    expect(() => pairedBootstrap([1], [1, 2])).toThrow(/equal lengths/);
  });

  it("reads a significant drop as worse", () => {
    expect(readDifference({ meanDifference: -0.3, ci: [-0.4, -0.2], p: 0.001, n: 30 })).toBe(
      "worse",
    );
    // p under α but an interval that touches 0 is still not a difference.
    expect(readDifference({ meanDifference: 0.1, ci: [0, 0.2], p: 0.04, n: 30 })).toBe(
      "no measurable difference",
    );
  });
});

describe("bootstrapMeanCi", () => {
  it("brackets the mean", () => {
    const values = [0.2, 0.4, 0.6, 0.8];
    const [lo, hi] = bootstrapMeanCi(values, { iterations: 2000 });
    expect(lo).toBeLessThanOrEqual(0.5);
    expect(hi).toBeGreaterThanOrEqual(0.5);
    expect(bootstrapMeanCi([0.7, 0.7])).toEqual([0.7, 0.7]);
  });
});

describe("minimumDetectableGap", () => {
  it("reproduces the issue's arithmetic at 45 items", () => {
    const g = minimumDetectableGap(45);
    expect(g.sePerArm).toBeCloseTo(0.0745, 3);
    expect(g.gapLow).toBeCloseTo(0.149, 3);
    expect(g.gapHigh).toBeCloseTo(0.2066, 3);
    expect(minimumDetectableGapStatement(45)).toBe(
      "At 45 items and a hit rate near 0.5 the standard error is about 7.5 points per arm, so a " +
        'gap needs roughly 15 to 21 points to be significant. A smaller difference is reported as "no ' +
        'measurable difference", not as a win.',
    );
  });

  it("is maximal with no items", () => {
    expect(minimumDetectableGap(0).sePerArm).toBe(1);
  });
});
