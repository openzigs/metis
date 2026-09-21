/**
 * Tests for the dedup helpers (Epic #856 issue #870).
 */
import { describe, it, expect } from "vitest";

import {
  DUPLICATE_COSINE_THRESHOLD,
  dedupeWithinBatch,
  isDuplicateOfExisting,
  type ExistingCaseVector,
  type SuggestionVector,
} from "../../../src/lib/testcoverage/dedup.js";

function norm(xs: number[]): number[] {
  let n = 0;
  for (const x of xs) n += x * x;
  n = Math.sqrt(n) || 1;
  return xs.map((x) => x / n);
}

describe("isDuplicateOfExisting", () => {
  it("detects duplicate above threshold", () => {
    const existing: ExistingCaseVector[] = [{ testCaseDocId: "t1", embedding: norm([1, 0.01, 0]) }];
    const out = isDuplicateOfExisting(norm([1, 0, 0]), existing);
    expect(out.duplicate).toBe(true);
    expect(out.testCaseDocId).toBe("t1");
    expect(out.cosine).toBeGreaterThanOrEqual(DUPLICATE_COSINE_THRESHOLD);
  });

  it("rejects below threshold", () => {
    const existing: ExistingCaseVector[] = [{ testCaseDocId: "t1", embedding: norm([0, 1, 0]) }];
    const out = isDuplicateOfExisting(norm([1, 0, 0]), existing);
    expect(out.duplicate).toBe(false);
  });

  it("returns no duplicate for empty existing list", () => {
    const out = isDuplicateOfExisting([1, 0, 0], []);
    expect(out.duplicate).toBe(false);
    expect(out.cosine).toBeUndefined();
  });

  it("respects custom threshold", () => {
    const existing: ExistingCaseVector[] = [{ testCaseDocId: "t1", embedding: norm([1, 1, 0]) }];
    const out = isDuplicateOfExisting(norm([1, 0, 0]), existing, 0.6);
    expect(out.duplicate).toBe(true);
  });
});

describe("dedupeWithinBatch", () => {
  it("keeps unique suggestions", () => {
    const sugs: SuggestionVector<string>[] = [
      { suggestion: "a", embedding: norm([1, 0, 0]), confidence: 0.5 },
      { suggestion: "b", embedding: norm([0, 1, 0]), confidence: 0.5 },
    ];
    expect(dedupeWithinBatch(sugs)).toHaveLength(2);
  });

  it("keeps higher confidence on collision", () => {
    const sugs: SuggestionVector<string>[] = [
      { suggestion: "low", embedding: norm([1, 0.01, 0]), confidence: 0.3 },
      { suggestion: "high", embedding: norm([1, 0, 0]), confidence: 0.9 },
    ];
    const out = dedupeWithinBatch(sugs);
    expect(out).toHaveLength(1);
    expect(out[0].suggestion).toBe("high");
  });

  it("keeps first on tie", () => {
    const sugs: SuggestionVector<string>[] = [
      { suggestion: "first", embedding: norm([1, 0, 0]), confidence: 0.7 },
      { suggestion: "second", embedding: norm([1, 0.01, 0]), confidence: 0.7 },
    ];
    const out = dedupeWithinBatch(sugs);
    expect(out).toHaveLength(1);
    expect(out[0].suggestion).toBe("first");
  });

  it("returns empty on empty input", () => {
    expect(dedupeWithinBatch([])).toEqual([]);
  });
});
