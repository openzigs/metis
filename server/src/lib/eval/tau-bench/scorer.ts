/**
 * Epic #194 (C.2) — TAU-bench scenario scorer.
 *
 * A scenario passes when both:
 *   1. Tool-call sequence matches expected (exact name + arg subset match).
 *   2. Final state matches the expected canonical end state (deep equal on
 *      every key in `expectedFinalState`; extra keys in actual are ignored).
 *
 * The numeric score in [0,1] blends the two: `0.5 * toolCallScore + 0.5 *
 * stateScore` so partial credit ranks sensibly during best-of-N.
 */
import type { ExpectedToolCall } from "./scenarios.js";

export interface ScenarioScoreInput {
  expectedToolCalls: ExpectedToolCall[];
  actualToolCalls: ExpectedToolCall[];
  expectedFinalState: Record<string, unknown>;
  actualFinalState: Record<string, unknown>;
}

export interface ScenarioScoreResult {
  passed: boolean;
  score: number;
  toolCallScore: number;
  stateScore: number;
  reason: string;
}

export function scoreScenario(input: ScenarioScoreInput): ScenarioScoreResult {
  const toolCallScore = scoreToolCalls(input.expectedToolCalls, input.actualToolCalls);
  const stateScore = scoreFinalState(input.expectedFinalState, input.actualFinalState);
  const score = 0.5 * toolCallScore + 0.5 * stateScore;
  const passed = toolCallScore === 1 && stateScore === 1;
  const reasons: string[] = [];
  if (toolCallScore < 1) reasons.push(`tool-call mismatch (${toolCallScore.toFixed(2)})`);
  if (stateScore < 1) reasons.push(`final-state mismatch (${stateScore.toFixed(2)})`);
  return {
    passed,
    score,
    toolCallScore,
    stateScore,
    reason: reasons.length === 0 ? "ok" : reasons.join("; "),
  };
}

/**
 * Per-position match score. Each expected tool call is checked in order
 * against the actual list — `name` must match exactly and every arg key
 * present in `expected.args` must equal the actual value (extras ignored).
 */
export function scoreToolCalls(expected: ExpectedToolCall[], actual: ExpectedToolCall[]): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  let matched = 0;
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]!;
    const act = actual[i];
    if (!act) continue;
    if (act.name !== exp.name) continue;
    if (!argsSubsetMatch(exp.args, act.args)) continue;
    matched += 1;
  }
  return matched / expected.length;
}

export function scoreFinalState(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): number {
  const keys = Object.keys(expected);
  if (keys.length === 0) return 1;
  let matched = 0;
  for (const key of keys) {
    if (deepEqual(expected[key], actual[key])) matched += 1;
  }
  return matched / keys.length;
}

function argsSubsetMatch(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(expected)) {
    if (!deepEqual(expected[key], actual[key])) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
