/**
 * Epic #1316 (#1317/#1318) — the shared faithfulness metric.
 *
 * The assertions that matter here are the NULL ones: the whole point of this
 * module is that an unverifiable item stops being scored 1.0 and stops moving
 * the mean. A test suite that only checked the happy ratio would pass against
 * the vacuous-truth implementation this module exists to replace.
 */
import { describe, expect, it, vi } from "vitest";
import type { FaithfulnessResult } from "../docs-gen/grounding/citation-validator.js";
import {
  evidenceContext,
  meanFaithfulness,
  scoreEvidenceFaithfulness,
  toFaithfulnessMetric,
  unverifiableMetric,
} from "./faithfulness-metric.js";

const result = (over: Partial<FaithfulnessResult>): FaithfulnessResult => ({
  section: "s",
  totalClaims: 0,
  supportedClaims: 0,
  faithfulness: 1,
  verified: true,
  unsupportedClaims: [],
  supportedAttributions: [],
  ...over,
});

describe("toFaithfulnessMetric", () => {
  it("reports the real supported/total ratio for a verified result", () => {
    const m = toFaithfulnessMetric(result({ totalClaims: 4, supportedClaims: 3 }));
    expect(m.faithfulness).toBeCloseTo(0.75, 10);
    expect(m.totalClaims).toBe(4);
    expect(m.supportedClaims).toBe(3);
    expect(m.unverifiableReason).toBeUndefined();
  });

  it("maps an UNVERIFIED result to null, not to the pass-through 1.0", () => {
    const r = result({ verified: false, totalClaims: 9, supportedClaims: 9, faithfulness: 1 });
    const m = toFaithfulnessMetric(r);
    expect(m.faithfulness).toBeNull();
    expect(m.unverifiableReason).toBe("judge-unavailable");
    // The docs-gen result still says 1 — we must not be reading that field.
    expect(r.faithfulness).toBe(1);
  });

  it("maps a ZERO-CLAIM result to null — a vacuous 1.0 is not evidence of anything", () => {
    const m = toFaithfulnessMetric(result({ totalClaims: 0, supportedClaims: 0, faithfulness: 1 }));
    expect(m.faithfulness).toBeNull();
    expect(m.unverifiableReason).toBe("no-claims");
  });

  it("reports 0 for a verified result where nothing was supported", () => {
    const m = toFaithfulnessMetric(result({ totalClaims: 3, supportedClaims: 0, faithfulness: 0 }));
    expect(m.faithfulness).toBe(0);
    expect(m.unverifiableReason).toBeUndefined();
  });
});

describe("meanFaithfulness", () => {
  it("excludes unverifiable items from the denominator", () => {
    const agg = meanFaithfulness([
      toFaithfulnessMetric(result({ totalClaims: 2, supportedClaims: 1 })), // 0.5
      toFaithfulnessMetric(result({ totalClaims: 2, supportedClaims: 0 })), // 0.0
      unverifiableMetric("judge-unavailable"),
      unverifiableMetric("no-claims"),
    ]);
    // Counting the two nulls as 1.0 would give 0.625; counting them as 0 would
    // give 0.125. Excluding them gives 0.25 — this assertion distinguishes all three.
    expect(agg.mean).toBeCloseTo(0.25, 10);
    expect(agg.scored).toBe(2);
    expect(agg.unverifiable).toBe(2);
    expect(agg.totalClaims).toBe(4);
    expect(agg.supportedClaims).toBe(1);
  });

  it("returns a null mean when nothing was scored at all", () => {
    const agg = meanFaithfulness([unverifiableMetric("no-evidence")]);
    expect(agg.mean).toBeNull();
    expect(agg.scored).toBe(0);
    expect(agg.unverifiable).toBe(1);
  });

  it("returns a null mean for an empty input rather than 0", () => {
    expect(meanFaithfulness([]).mean).toBeNull();
  });
});

describe("evidenceContext", () => {
  it("admits each excerpt as a resolvable source", () => {
    const ctx = evidenceContext([
      { id: "src/a.ts", label: "a.ts", text: "alpha" },
      { id: "src/b.ts", text: "beta" },
    ]);
    expect(ctx.isEmpty).toBe(false);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[0]?.text).toBe("alpha");
    expect([...ctx.sourceIds].some((id) => id.includes("src/a.ts"))).toBe(true);
  });

  it("synthesises a locator when an excerpt carries no id, so the source is still admitted", () => {
    const ctx = evidenceContext([{ id: "", text: "alpha" }]);
    expect(ctx.isEmpty).toBe(false);
    expect([...ctx.sourceIds].some((id) => id.includes("evidence-0"))).toBe(true);
  });

  it("stops admitting excerpts once the char budget is spent", () => {
    const ctx = evidenceContext(
      [
        { id: "a", text: "x".repeat(30) },
        { id: "b", text: "y".repeat(30) },
      ],
      40,
    );
    expect(ctx.sources).toHaveLength(1);
  });

  it("is empty when every excerpt is blank", () => {
    expect(evidenceContext([{ id: "a", text: "   " }]).isEmpty).toBe(true);
  });
});

describe("scoreEvidenceFaithfulness", () => {
  const extractor = (claims: string[]) => ({
    decompose: vi.fn(async () => ({ claims: claims.map((c) => ({ claim: c, sourceIds: [] })) })),
  });

  it("scores supported/total from the judge's verdicts", async () => {
    const judge = {
      judge: vi.fn(async () => [
        { claim: "one", supported: true, sourceIds: [] },
        { claim: "two", supported: false, sourceIds: [] },
      ]),
    };
    const m = await scoreEvidenceFaithfulness(
      "finding-1",
      "one. two.",
      [{ id: "src/a.ts", text: "evidence" }],
      { extractor: extractor(["one", "two"]), judge },
    );
    expect(m.faithfulness).toBeCloseTo(0.5, 10);
    expect(judge.judge).toHaveBeenCalledOnce();
  });

  it("returns null WITHOUT calling the judge when there is no evidence", async () => {
    const judge = { judge: vi.fn(async () => []) };
    const m = await scoreEvidenceFaithfulness("finding-1", "text", [], {
      extractor: extractor(["one"]),
      judge,
    });
    expect(m.faithfulness).toBeNull();
    expect(m.unverifiableReason).toBe("no-evidence");
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it("returns null when the judge declines to verify", async () => {
    const m = await scoreEvidenceFaithfulness(
      "finding-1",
      "text",
      [{ id: "src/a.ts", text: "evidence" }],
      { extractor: extractor(["one"]), judge: { judge: vi.fn(async () => null) } },
    );
    expect(m.faithfulness).toBeNull();
    expect(m.unverifiableReason).toBe("judge-unavailable");
  });

  it("returns null for blank text without touching the extractor", async () => {
    const ex = extractor(["one"]);
    const m = await scoreEvidenceFaithfulness("finding-1", "   ", [{ id: "a", text: "e" }], {
      extractor: ex,
      judge: { judge: vi.fn(async () => []) },
    });
    expect(m.faithfulness).toBeNull();
    expect(m.unverifiableReason).toBe("no-claims");
    expect(ex.decompose).not.toHaveBeenCalled();
  });
});
