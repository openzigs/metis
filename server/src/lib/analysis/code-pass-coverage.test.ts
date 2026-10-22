/**
 * #1388 — the code pass's continuation policy and its shallow-pass verdict.
 */
import { describe, expect, it } from "vitest";
import { AGENT_DEGRADED_NOTE_PREFIX, type AnalysisRetrievalHealth } from "@metis/shared";
import {
  assessShallowCodePass,
  buildCodePassContinuation,
  COVERAGE_NUDGE_MAX_BUDGET_SHARE,
  COVERAGE_NUDGE_MIN_TURNS_LEFT,
  MAX_CONTINUATION_NUDGES,
} from "./code-pass-coverage.js";
import { isSchemaValidFinalAnswer } from "./agentic-degradation.js";
import type { AgentLoopContinuationState } from "./agent-loop.js";

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `REQ-${String(i + 1).padStart(3, "0")}`);

const finding = (requirementId: string, verdict: string) => ({
  category: "other",
  severity: "info",
  title: `t ${requirementId}`,
  body: "b",
  tags: [],
  citations: [],
  requirementId,
  verdict,
});

const answer = (findings: unknown[]) =>
  JSON.stringify({ agentKey: "code", summary: "s", findings, notes: [] });

const state = (over: Partial<AgentLoopContinuationState> = {}): AgentLoopContinuationState => ({
  turnsUsed: 3,
  turnsLeft: 57,
  budgetUsed: 6_000,
  budgetTotal: 100_000,
  nudgesSent: 0,
  ...over,
});

const health = (over: Partial<AnalysisRetrievalHealth> = {}): AnalysisRetrievalHealth => ({
  successfulSearches: 6,
  failedSearches: 1,
  erroredCalls: 0,
  totalCalls: 7,
  requirementCount: 32,
  starved: false,
  degraded: false,
  searchedScope: [],
  ...over,
});

describe("buildCodePassContinuation", () => {
  const requirementIds = ids(4);
  const policy = () =>
    buildCodePassContinuation({ requirementIds, isValidFinalAnswer: isSchemaValidFinalAnswer });

  it("is bounded", () => {
    expect(policy().maxNudges).toBe(MAX_CONTINUATION_NUDGES);
  });

  it("sends back a reply that is neither a call nor a usable answer", () => {
    const text = policy().nudge("Let me keep reading cli.go.", state({ turnsLeft: 1 }));
    expect(text).toContain("neither a tool call nor the final JSON answer");
    expect(text).toContain("you have 1 turn and token budget left");
  });

  it("accepts an answer that covers most requirements", () => {
    const reply = answer([
      finding("REQ-001", "implemented"),
      finding("REQ-002", "implemented"),
      finding("REQ-003", "gap-confirmed"),
    ]);
    expect(policy().nudge(reply, state())).toBeNull();
  });

  it("sends back, once, an answer leaving most requirements unverified far under budget", () => {
    const p = policy();
    const reply = answer([
      finding("REQ-001", "implemented"),
      finding("REQ-002", "could-not-verify"),
    ]);
    const text = p.nudge(reply, state());
    expect(text).toContain("leaves 3 of 4 requirements without");
    expect(text).toContain("(REQ-002, REQ-003, REQ-004)");
    expect(text).toContain("about 6% of your token budget");
    expect(text).toContain("57 turns left");
    expect(p.nudge(reply, state({ nudgesSent: 1 }))).toBeNull();
  });

  it("names at most fifteen requirements", () => {
    const many = buildCodePassContinuation({
      requirementIds: ids(32),
      isValidFinalAnswer: isSchemaValidFinalAnswer,
    });
    const text = many.nudge(answer([]), state())!;
    expect(text).toContain("REQ-015, and 17 more)");
    expect(text).not.toContain("REQ-016");
  });

  it("accepts a thin answer with too few turns left to investigate", () => {
    expect(
      policy().nudge(answer([]), state({ turnsLeft: COVERAGE_NUDGE_MIN_TURNS_LEFT - 1 })),
    ).toBeNull();
    expect(
      policy().nudge(answer([]), state({ turnsLeft: COVERAGE_NUDGE_MIN_TURNS_LEFT })),
    ).not.toBeNull();
  });

  it("accepts a thin answer once half the budget is spent", () => {
    const budgetUsed = COVERAGE_NUDGE_MAX_BUDGET_SHARE * 100_000;
    expect(policy().nudge(answer([]), state({ budgetUsed }))).toBeNull();
  });

  it("accepts a thin answer when the loop has no budget to measure", () => {
    expect(
      policy().nudge(answer([]), state({ budgetUsed: undefined, budgetTotal: undefined })),
    ).toBeNull();
  });

  it("accepts any answer on a pass with no requirements", () => {
    const none = buildCodePassContinuation({
      requirementIds: [],
      isValidFinalAnswer: isSchemaValidFinalAnswer,
    });
    expect(none.nudge(answer([]), state())).toBeNull();
  });

  it("accepts a valid answer it cannot read findings from", () => {
    const p = buildCodePassContinuation({ requirementIds, isValidFinalAnswer: () => true });
    expect(p.nudge("not json", state())).toBeNull();
    expect(p.nudge('{"summary":"s"}', state())).toBeNull();
  });
});

describe("assessShallowCodePass", () => {
  const base = { turnsUsed: 3, toolCalls: 7, loopTokens: 6_000, budget: 100_000 };

  it("flags the incident: most requirements unverified, far under budget", () => {
    const verdict = assessShallowCodePass({
      ...base,
      health: health({ starved: true, degraded: true, unverifiedRequirements: 22 }),
    });
    expect(verdict.shallow).toBe(true);
    expect(verdict.note).toBe(
      `${AGENT_DEGRADED_NOTE_PREFIX} the code agent stopped after 3 turns and 7 look-ups in the code, ` +
        "using about 6% of its token budget, and 22 of 32 requirements were not checked against the code. " +
        "They are marked “Could not verify”. Re-run the code investigation before relying on its results.",
    );
  });

  it("flags starved retrieval far under budget even when most requirements were answered", () => {
    const verdict = assessShallowCodePass({
      ...base,
      health: health({ starved: true, degraded: true, unverifiedRequirements: 4 }),
    });
    expect(verdict.shallow).toBe(true);
    expect(verdict.note).toContain("which is too few to check 32 requirements against the code");
  });

  it("does not flag starved retrieval that spent most of the budget", () => {
    const verdict = assessShallowCodePass({
      ...base,
      loopTokens: 80_000,
      health: health({ starved: true, degraded: true, unverifiedRequirements: 4 }),
    });
    expect(verdict.shallow).toBe(false);
  });

  it("does not flag starvation when the loop's spend is unknown", () => {
    const verdict = assessShallowCodePass({
      ...base,
      loopTokens: undefined,
      health: health({ starved: true, unverifiedRequirements: 2 }),
    });
    expect(verdict.shallow).toBe(false);
  });

  it("leaves a pass its budget cut off to the cut-short reason", () => {
    const verdict = assessShallowCodePass({
      ...base,
      loopTokens: 100_000,
      health: health({ exhausted: true, unverifiedRequirements: 20 }),
    });
    expect(verdict.shallow).toBe(false);
  });

  it("names a single turn and look-up in the singular", () => {
    const verdict = assessShallowCodePass({
      ...base,
      turnsUsed: 1,
      toolCalls: 1,
      health: health({ unverifiedRequirements: 20 }),
    });
    expect(verdict.note).toContain("stopped after 1 turn and 1 look-up in the code");
  });

  it("omits the budget share when the spend is unknown", () => {
    const verdict = assessShallowCodePass({
      ...base,
      loopTokens: undefined,
      health: health({ unverifiedRequirements: 20 }),
    });
    expect(verdict.note).toContain(
      "stopped after 3 turns and 7 look-ups in the code, and 20 of 32",
    );
  });

  it("does not flag a pass that covered its requirements", () => {
    expect(
      assessShallowCodePass({ ...base, health: health({ unverifiedRequirements: 16 }) }).shallow,
    ).toBe(false);
    expect(assessShallowCodePass({ ...base, health: health() }).shallow).toBe(false);
  });

  it("does not flag a pass with no requirements", () => {
    expect(
      assessShallowCodePass({ ...base, health: health({ requirementCount: 0 }) }).shallow,
    ).toBe(false);
  });

  it("keeps the note within the schema's 512 characters", () => {
    const verdict = assessShallowCodePass({
      ...base,
      turnsUsed: 1e12,
      toolCalls: 1e12,
      health: health({ requirementCount: 1e12, unverifiedRequirements: 1e12 }),
    });
    expect(verdict.note!.length).toBeLessThanOrEqual(512);
  });
});
