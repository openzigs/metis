/**
 * Epic #194 (C.3) — Hallucination scorer tests.
 */
import { describe, expect, it, vi } from "vitest";

import {
  computeCitationOverlap,
  extractClaims,
  scoreGrounding,
} from "../src/lib/judge/hallucination-scorer.js";

describe("computeCitationOverlap", () => {
  it("returns 1 when output is too short to form n-grams", () => {
    expect(computeCitationOverlap("hi", ["unrelated"], 4)).toBe(1);
  });

  it("returns 1 when output n-grams are all in the source", () => {
    const src = "the quick brown fox jumps over the lazy dog";
    const out = "the quick brown fox jumps";
    expect(computeCitationOverlap(out, [src], 4)).toBe(1);
  });

  it("returns 0 when there is no overlap", () => {
    expect(
      computeCitationOverlap(
        "alpha beta gamma delta epsilon",
        ["totally different content here"],
        4,
      ),
    ).toBe(0);
  });

  it("returns a fractional score when partially overlapping", () => {
    const src = "the quick brown fox jumps over the lazy dog";
    const out = "the quick brown fox runs in the meadow today";
    const score = computeCitationOverlap(out, [src], 4);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe("extractClaims", () => {
  it("splits on sentence boundaries and drops short fragments", () => {
    const claims = extractClaims(
      "This is a complete sentence. Hi. Another full one here. What about a question?",
    );
    expect(claims).toEqual(["This is a complete sentence.", "Another full one here."]);
  });

  it("drops imperative-style sentences", () => {
    const claims = extractClaims(
      "Please update your records soon. Note that this matters greatly.",
    );
    expect(claims).toEqual([]);
  });
});

describe("scoreGrounding", () => {
  it("returns hallucinationScore = 1 - groundingScore", async () => {
    const r = await scoreGrounding({
      output: "the quick brown fox jumps over the lazy dog",
      sources: ["the quick brown fox jumps over the lazy dog"],
    });
    expect(r.groundingScore).toBe(1);
    expect(r.hallucinationScore).toBe(0);
    expect(r.entailmentScore).toBe(1);
  });

  it("uses the judge to compute entailment when supplied", async () => {
    const judge = { entail: vi.fn(async () => 0.4) };
    const r = await scoreGrounding({
      output: "Acme posted record revenue last quarter. The CEO promised dividends.",
      sources: ["acme reported revenue numbers"],
      judge,
    });
    expect(judge.entail).toHaveBeenCalledTimes(2);
    expect(r.entailmentScore).toBeCloseTo(0.4);
    expect(r.claims).toHaveLength(2);
  });

  it("fails closed when the judge throws", async () => {
    const judge = { entail: vi.fn(async () => Promise.reject(new Error("boom"))) };
    const r = await scoreGrounding({
      output: "This is a clear factual statement here.",
      sources: ["unrelated context"],
      judge,
    });
    expect(r.entailmentScore).toBe(0);
    expect(r.hallucinationScore).toBeGreaterThanOrEqual(0.5);
  });

  it("clamps out-of-range scores from a misbehaving judge", async () => {
    const judge = { entail: vi.fn(async () => Number.NaN) };
    const r = await scoreGrounding({
      output: "Pluto is the ninth planet of the solar system.",
      sources: ["x x x x x x x"],
      judge,
    });
    expect(r.groundingScore).toBeGreaterThanOrEqual(0);
    expect(r.groundingScore).toBeLessThanOrEqual(1);
  });

  it("respects maxClaims to bound judge cost", async () => {
    const judge = { entail: vi.fn(async () => 1) };
    await scoreGrounding({
      output:
        "Sentence one is here. Sentence two is here. Sentence three is here. Sentence four is here.",
      sources: ["context"],
      judge,
      maxClaims: 2,
    });
    expect(judge.entail).toHaveBeenCalledTimes(2);
  });
});
