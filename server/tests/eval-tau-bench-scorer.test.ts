/**
 * Epic #194 (C.2) — TAU-bench scorer tests.
 */
import { describe, expect, it } from "vitest";
import {
  scoreFinalState,
  scoreScenario,
  scoreToolCalls,
} from "../src/lib/eval/tau-bench/scorer.js";

describe("scoreToolCalls", () => {
  it("scores 1 when the sequences match", () => {
    expect(
      scoreToolCalls(
        [
          { name: "a", args: { x: 1 } },
          { name: "b", args: {} },
        ],
        [
          { name: "a", args: { x: 1, extra: 9 } },
          { name: "b", args: {} },
        ],
      ),
    ).toBe(1);
  });

  it("scores 0 when names differ", () => {
    expect(scoreToolCalls([{ name: "a", args: {} }], [{ name: "b", args: {} }])).toBe(0);
  });

  it("scores 0 when expected args don't match", () => {
    expect(scoreToolCalls([{ name: "a", args: { x: 1 } }], [{ name: "a", args: { x: 2 } }])).toBe(
      0,
    );
  });

  it("returns partial credit when half the calls match", () => {
    expect(
      scoreToolCalls(
        [
          { name: "a", args: {} },
          { name: "b", args: {} },
        ],
        [
          { name: "a", args: {} },
          { name: "wrong", args: {} },
        ],
      ),
    ).toBe(0.5);
  });

  it("expected empty + actual empty scores 1", () => {
    expect(scoreToolCalls([], [])).toBe(1);
    expect(scoreToolCalls([], [{ name: "x", args: {} }])).toBe(0);
  });
});

describe("scoreFinalState", () => {
  it("scores 1 when every expected key matches", () => {
    expect(scoreFinalState({ a: 1, b: "two" }, { a: 1, b: "two", c: "extra" })).toBe(1);
  });

  it("returns 1 when expected is empty", () => {
    expect(scoreFinalState({}, { whatever: 1 })).toBe(1);
  });

  it("returns 0 on full mismatch", () => {
    expect(scoreFinalState({ a: 1 }, { a: 2 })).toBe(0);
  });

  it("supports nested deep equality", () => {
    expect(scoreFinalState({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(1);
    expect(scoreFinalState({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(0);
  });
});

describe("scoreScenario", () => {
  it("passed=true only when both components are 1", () => {
    const r = scoreScenario({
      expectedToolCalls: [{ name: "a", args: {} }],
      actualToolCalls: [{ name: "a", args: {} }],
      expectedFinalState: { ok: true },
      actualFinalState: { ok: true },
    });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.reason).toBe("ok");
  });

  it("blends partial scores", () => {
    const r = scoreScenario({
      expectedToolCalls: [{ name: "a", args: {} }],
      actualToolCalls: [{ name: "wrong", args: {} }],
      expectedFinalState: { ok: true },
      actualFinalState: { ok: true },
    });
    expect(r.passed).toBe(false);
    expect(r.toolCallScore).toBe(0);
    expect(r.stateScore).toBe(1);
    expect(r.score).toBe(0.5);
    expect(r.reason).toContain("tool-call mismatch");
  });
});
