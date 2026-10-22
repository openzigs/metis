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
  isLengthStoppedReply,
  MAX_CONTINUATION_NUDGES,
} from "./code-pass-coverage.js";
import { FINDINGS_ANSWER_FIELD_LIMITS, isSchemaValidFinalAnswer } from "./agentic-degradation.js";
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
  it("tells a schema-invalid JSON answer the field limits and the no-fences rule", () => {
    const invalid = JSON.stringify({ summary: "s", findings: [{ severity: "high" }], notes: [] });
    const text = policy().nudge(invalid, state())!;
    expect(text).toContain("did not match the required findings schema");
    expect(text).toContain("no markdown code fences");
    for (const line of FINDINGS_ANSWER_FIELD_LIMITS) expect(text).toContain(line);
  });

  it("does not repeat the field limits for prose", () => {
    const text = policy().nudge("Let me keep reading.", state())!;
    expect(text).toContain("no markdown code fences");
    expect(text).not.toContain(FINDINGS_ANSWER_FIELD_LIMITS[0]);
  });

  it("leaves a reply its output cap cut off to the final-answer retry", () => {
    const truncated = '{"agentKey":"code","summary":"s","findings":[{"title":"cut';
    expect(policy().nudge(truncated, state())).toBeNull();
    expect(policy().nudge("Partial prose", state({ finishReason: "max_tokens" }))).toBeNull();
    expect(policy().nudge("Partial prose", state({ finishReason: "length" }))).toBeNull();
    expect(policy().nudge("Partial prose", state({ finishReason: "end_turn" }))).not.toBeNull();
  });
});

describe("isLengthStoppedReply", () => {
  it("reads the stop reason and the reply's shape", () => {
    expect(isLengthStoppedReply("x", "max_tokens")).toBe(true);
    expect(isLengthStoppedReply("x", "length")).toBe(true);
    expect(isLengthStoppedReply('{"findings":[{"a":1}', "end_turn")).toBe(true);
    expect(isLengthStoppedReply("x", "end_turn")).toBe(false);
    expect(isLengthStoppedReply("x")).toBe(false);
  });
});

describe("assessShallowCodePass", () => {
  const base = {
    turnsUsed: 3,
    toolCalls: 7,
    loopTokens: 6_000,
    budget: 100_000,
    retrievalFailed: false,
    uncheckedRequirements: 0,
  };

  it("reports the incident as an early stop: starved retrieval, far under budget", () => {
    const verdict = assessShallowCodePass({
      ...base,
      uncheckedRequirements: 22,
      health: health({ starved: true, degraded: true, unverifiedRequirements: 22 }),
    });
    expect(verdict.kind).toBe("stopped-early");
    expect(verdict.note).toBe(
      `${AGENT_DEGRADED_NOTE_PREFIX} the code agent stopped after 3 turns and 7 look-ups in the code, ` +
        "using about 6% of its token budget, and did not check 22 of 32 requirements against the code. " +
        "They are marked “Could not verify”. Re-run the code investigation to check them.",
    );
  });

  it("reports most requirements never checked as an early stop without starvation", () => {
    const verdict = assessShallowCodePass({
      ...base,
      toolCalls: 20,
      uncheckedRequirements: 20,
      health: health({ totalCalls: 20, unverifiedRequirements: 20 }),
    });
    expect(verdict.kind).toBe("stopped-early");
  });

  it("says too few look-ups when starved but nothing is left unchecked", () => {
    const verdict = assessShallowCodePass({
      ...base,
      health: health({ starved: true, degraded: true, unverifiedRequirements: 4 }),
    });
    expect(verdict.kind).toBe("stopped-early");
    expect(verdict.note).toContain("which is too few to check 32 requirements against the code");
  });

  it("reports checked-but-unverifiable requirements honestly, with no re-run advice", () => {
    const verdict = assessShallowCodePass({
      ...base,
      toolCalls: 40,
      uncheckedRequirements: 3,
      health: health({ totalCalls: 40, degraded: true, unverifiedRequirements: 20 }),
    });
    expect(verdict.kind).toBe("unverifiable");
    expect(verdict.note).toContain(
      "checked these requirements against the code but could not verify 20 of 32",
    );
    expect(verdict.note).not.toMatch(/re-run/i);
    expect(verdict.note).not.toContain("not check");
  });

  it("names failed searches instead of blaming too few look-ups", () => {
    const verdict = assessShallowCodePass({
      ...base,
      retrievalFailed: true,
      uncheckedRequirements: 30,
      health: health({
        starved: true,
        degraded: true,
        erroredCalls: 5,
        failedSearches: 2,
        unverifiedRequirements: 30,
      }),
    });
    expect(verdict.kind).toBe("retrieval-failed");
    expect(verdict.note).toContain("searches of the code did not work");
    expect(verdict.note).toContain("5 failed with an error and 2 came back empty");
    expect(verdict.note).not.toContain("too few");
    expect(verdict.note).not.toContain("stopped after");
  });

  it("does not flag starved retrieval that spent most of the budget", () => {
    const verdict = assessShallowCodePass({
      ...base,
      loopTokens: 80_000,
      health: health({ starved: true, degraded: true, unverifiedRequirements: 4 }),
    });
    expect(verdict.kind).toBeNull();
  });

  it("does not flag starvation when the loop's spend is unknown", () => {
    const verdict = assessShallowCodePass({
      ...base,
      loopTokens: undefined,
      health: health({ starved: true, unverifiedRequirements: 2 }),
    });
    expect(verdict.kind).toBeNull();
  });

  it("leaves a pass its budget cut off to the cut-short reason", () => {
    const verdict = assessShallowCodePass({
      ...base,
      loopTokens: 100_000,
      uncheckedRequirements: 20,
      health: health({ exhausted: true, unverifiedRequirements: 20 }),
    });
    expect(verdict.kind).toBeNull();
  });

  it("names a single turn and look-up in the singular, and omits an unknown spend", () => {
    const verdict = assessShallowCodePass({
      ...base,
      turnsUsed: 1,
      toolCalls: 1,
      loopTokens: undefined,
      uncheckedRequirements: 20,
      health: health({ unverifiedRequirements: 20 }),
    });
    expect(verdict.note).toContain(
      "stopped after 1 turn and 1 look-up in the code, and did not check",
    );
  });

  it("never counts more unchecked than unverified", () => {
    const verdict = assessShallowCodePass({
      ...base,
      uncheckedRequirements: 99,
      health: health({ unverifiedRequirements: 20 }),
    });
    expect(verdict.note).toContain("did not check 20 of 32");
  });

  it("does not flag a pass that covered its requirements", () => {
    expect(
      assessShallowCodePass({ ...base, health: health({ unverifiedRequirements: 16 }) }).kind,
    ).toBeNull();
    expect(assessShallowCodePass({ ...base, health: health() }).kind).toBeNull();
  });

  it("does not flag a pass with no requirements", () => {
    expect(
      assessShallowCodePass({ ...base, health: health({ requirementCount: 0 }) }).kind,
    ).toBeNull();
  });

  it("keeps the note within the schema's 512 characters", () => {
    const verdict = assessShallowCodePass({
      ...base,
      turnsUsed: 1e12,
      toolCalls: 1e12,
      retrievalFailed: true,
      health: health({
        requirementCount: 1e12,
        unverifiedRequirements: 1e12,
        erroredCalls: 1e12,
        failedSearches: 1e12,
      }),
    });
    expect(verdict.note!.length).toBeLessThanOrEqual(512);
  });
});
