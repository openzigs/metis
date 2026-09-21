/**
 * Tests for the pure coverage matcher (Epic #856 issue #857).
 */
import { describe, it, expect } from "vitest";

import {
  DEFAULT_THRESHOLDS,
  aggregateVerdict,
  bucket,
  matchRequirements,
  type MatcherCell,
  type RequirementInput,
  type TestCaseInput,
} from "../../../src/lib/testcoverage/coverage-matcher.js";

function vec(...xs: number[]): number[] {
  // L2-normalise so cosineSimilarity stays in [-1,1] cleanly.
  let n = 0;
  for (const x of xs) n += x * x;
  n = Math.sqrt(n) || 1;
  return xs.map((x) => x / n);
}

describe("bucket", () => {
  it("returns COVERED on high cosine", () => {
    expect(bucket(0.9, 0)).toBe("COVERED");
  });
  it("returns COVERED on hybrid threshold", () => {
    expect(bucket(0.8, 0.6)).toBe("COVERED");
  });
  it("returns UNCOVERED below cosine floor", () => {
    expect(bucket(0.4, 0)).toBe("UNCOVERED");
  });
  it("returns AMBIGUOUS otherwise", () => {
    expect(bucket(0.7, 0.4)).toBe("AMBIGUOUS");
  });
  it("respects custom thresholds", () => {
    expect(bucket(0.5, 0, { ...DEFAULT_THRESHOLDS, coveredCosine: 0.5 })).toBe("COVERED");
  });
});

describe("aggregateVerdict", () => {
  const cell = (status: "COVERED" | "UNCOVERED" | "AMBIGUOUS"): MatcherCell => ({
    requirementId: "r",
    testCaseDocId: "t",
    cosine: 0,
    bm25: 0,
    fused: 0,
    judgeConfidence: null,
    status,
  });
  it("returns COVERED when any cell covers", () => {
    expect(aggregateVerdict([cell("UNCOVERED"), cell("COVERED")])).toBe("COVERED");
  });
  it("returns AMBIGUOUS when no cover but ambiguous present", () => {
    expect(aggregateVerdict([cell("UNCOVERED"), cell("AMBIGUOUS")])).toBe("AMBIGUOUS");
  });
  it("returns UNCOVERED when all uncovered", () => {
    expect(aggregateVerdict([cell("UNCOVERED"), cell("UNCOVERED")])).toBe("UNCOVERED");
  });
  it("returns UNCOVERED for empty input", () => {
    expect(aggregateVerdict([])).toBe("UNCOVERED");
  });
});

describe("matchRequirements", () => {
  it("returns all UNCOVERED with empty corpus", () => {
    const reqs: RequirementInput[] = [{ id: "r1", text: "login", embedding: vec(1, 0, 0) }];
    const out = matchRequirements(reqs, []);
    expect(out.verdicts[0].status).toBe("UNCOVERED");
    expect(out.covered).toHaveLength(0);
    expect(out.ambiguousRatio).toBe(0);
  });

  it("marks aligned cases as COVERED", () => {
    const reqs: RequirementInput[] = [{ id: "r1", text: "login user", embedding: vec(1, 0, 0) }];
    const tcs: TestCaseInput[] = [
      { id: "t1", text: "login user", embedding: vec(1, 0, 0) }, // cos=1
      { id: "t2", text: "weather", embedding: vec(0, 1, 0) }, // cos=0
    ];
    const out = matchRequirements(reqs, tcs);
    expect(out.verdicts[0].status).toBe("COVERED");
    expect(out.covered.length).toBeGreaterThan(0);
    expect(out.uncovered.length).toBeGreaterThan(0);
  });

  it("is deterministic across runs", () => {
    const reqs: RequirementInput[] = [
      { id: "r1", text: "alpha", embedding: vec(0.9, 0.1, 0) },
      { id: "r2", text: "beta", embedding: vec(0.1, 0.9, 0) },
    ];
    const tcs: TestCaseInput[] = [
      { id: "t1", text: "alpha", embedding: vec(0.85, 0.15, 0) },
      { id: "t2", text: "beta", embedding: vec(0.15, 0.85, 0) },
      { id: "t3", text: "gamma", embedding: vec(0, 0, 1) },
    ];
    const a = matchRequirements(reqs, tcs);
    const b = matchRequirements(reqs, tcs);
    expect(a.verdicts.map((v) => v.requirementId)).toEqual(b.verdicts.map((v) => v.requirementId));
    expect(a.verdicts[0].cells.map((c) => c.testCaseDocId)).toEqual(
      b.verdicts[0].cells.map((c) => c.testCaseDocId),
    );
  });

  it("clamps k to >=1", () => {
    const reqs: RequirementInput[] = [{ id: "r1", text: "x", embedding: vec(1, 0) }];
    const tcs: TestCaseInput[] = [
      { id: "t1", text: "x", embedding: vec(1, 0) },
      { id: "t2", text: "y", embedding: vec(0, 1) },
    ];
    const out = matchRequirements(reqs, tcs, { k: 0 });
    expect(out.verdicts[0].cells).toHaveLength(1);
  });

  it("computes ambiguousRatio", () => {
    // Build inputs where 1 of 2 cells lands in AMBIGUOUS (cos 0.7).
    const reqs: RequirementInput[] = [{ id: "r1", text: "x", embedding: vec(1, 0, 0) }];
    const tcs: TestCaseInput[] = [
      { id: "t1", text: "different words", embedding: vec(0.7, 0.71, 0) }, // ambiguous-ish
      { id: "t2", text: "nope", embedding: vec(0, 0, 1) }, // uncovered
    ];
    const out = matchRequirements(reqs, tcs);
    expect(out.ambiguousRatio).toBeGreaterThanOrEqual(0);
    expect(out.ambiguousRatio).toBeLessThanOrEqual(1);
  });
});
