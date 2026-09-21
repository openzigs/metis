/** Epic #708 — fingerprint + evidence-line validator tests. */
import { describe, expect, it } from "vitest";
import { computeFingerprint, validateEvidenceLines } from "./validators.js";

describe("computeFingerprint", () => {
  const base = {
    projectId: "p1",
    repoConnectionId: "r1",
    qualifiedName: "src/foo.ts::Foo.bar",
    ruleId: "rule-1",
    title: "SQL injection in raw query",
  };

  it("is stable across calls", () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint(base));
  });

  it("normalises title whitespace and case", () => {
    const a = computeFingerprint(base);
    const b = computeFingerprint({ ...base, title: "  SQL  INJECTION   in   raw\tquery " });
    expect(a).toBe(b);
  });

  it("changes when project/repo/symbol/rule change", () => {
    const ref = computeFingerprint(base);
    expect(computeFingerprint({ ...base, projectId: "p2" })).not.toBe(ref);
    expect(computeFingerprint({ ...base, repoConnectionId: "r2" })).not.toBe(ref);
    expect(computeFingerprint({ ...base, qualifiedName: "x::y" })).not.toBe(ref);
    expect(computeFingerprint({ ...base, ruleId: "rule-2" })).not.toBe(ref);
    expect(computeFingerprint({ ...base, ruleId: null })).not.toBe(ref);
  });

  it("returns a 64-char hex string", () => {
    expect(computeFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("validateEvidenceLines", () => {
  it("drops out-of-range lines", () => {
    expect(validateEvidenceLines([1, 5, 10, 99], 5, 20)).toEqual([5, 10]);
  });

  it("dedupes and sorts", () => {
    expect(validateEvidenceLines([7, 5, 7, 6], 5, 10)).toEqual([5, 6, 7]);
  });

  it("handles reversed start/end", () => {
    expect(validateEvidenceLines([3, 8], 10, 1)).toEqual([3, 8]);
  });

  it("drops non-finite and negative", () => {
    expect(validateEvidenceLines([NaN, Infinity, -3, 5], 1, 10)).toEqual([5]);
  });

  it("returns [] for empty input", () => {
    expect(validateEvidenceLines([], 1, 10)).toEqual([]);
  });

  it("truncates floats to integers", () => {
    expect(validateEvidenceLines([4.9, 5.1], 1, 10)).toEqual([4, 5]);
  });
});
