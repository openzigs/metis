/**
 * Issue #1095 — the pre-flight estimate must move with its inputs.
 *
 * These tests are written to FAIL if the constant-estimate bug is reintroduced.
 * The old endpoint classified the fixed string "Analyze project documents and
 * codebase" and therefore always answered 16 tokens / "simple" / $0.0000. A test
 * that merely asserted "an estimate is present" passed against that bug, so every
 * assertion here is differential: same code, two different inputs, different
 * outputs — plus an explicit guard that no answer is the literal 16.
 */
import { describe, it, expect } from "vitest";
import {
  estimateAnalysisRunTokens,
  readAgentCountFromMetadata,
  profileAnalysisRun,
  HEAVY_RUN_TOKEN_THRESHOLD,
  type PriorRunSample,
} from "./analysis-run-estimate.js";
import { TaskProfiler } from "./task-profiler.js";

/** The measured shape from the #1095 report: 185,167 tokens over 4 agents. */
const REPORTED_RUN: PriorRunSample = { totalTokens: 185_167, agentCount: 4 };

describe("estimateAnalysisRunTokens (#1095)", () => {
  it("scales with the number of agents the user selected", () => {
    const two = estimateAnalysisRunTokens([REPORTED_RUN], 2);
    const four = estimateAnalysisRunTokens([REPORTED_RUN], 4);

    // Differential: the SAME history under a different run shape must not
    // produce the same number. A constant estimator fails this line.
    expect(four.tokens).not.toBe(two.tokens);
    expect(four.tokens).toBe((two.tokens as number) * 2);
    // 185,167 / 4 = 46,291.75 → 46,292 per agent (rounded) × 4 = 185,168.
    expect(four.tokens).toBe(185_168);
  });

  it("moves when the project's own history moves", () => {
    const cheap = estimateAnalysisRunTokens([{ totalTokens: 8_000, agentCount: 4 }], 4);
    const expensive = estimateAnalysisRunTokens([REPORTED_RUN], 4);

    expect(cheap.tokens).not.toBe(expensive.tokens);
    expect(cheap.tokens as number).toBeLessThan(expensive.tokens as number);
  });

  it("never answers the old hardcoded 16 for a real project", () => {
    for (const agents of [1, 2, 3, 4, 8]) {
      const est = estimateAnalysisRunTokens([REPORTED_RUN], agents);
      expect(est.tokens).not.toBe(16);
      expect(est.tokens as number).toBeGreaterThan(10_000);
    }
  });

  it("uses the median so one outlier run cannot dominate", () => {
    const withOutlier = estimateAnalysisRunTokens(
      [
        { totalTokens: 40_000, agentCount: 4 },
        { totalTokens: 44_000, agentCount: 4 },
        { totalTokens: 4_000_000, agentCount: 4 }, // runaway run
      ],
      4,
    );
    // Median per-agent is 11,000 → 44,000 for 4 agents. A mean would report ~1.36M.
    expect(withOutlier.tokens).toBe(44_000);
    expect(withOutlier.sampleSize).toBe(3);
  });

  it("reports nothing rather than a fabricated number with no history", () => {
    const est = estimateAnalysisRunTokens([], 4);
    expect(est.tokens).toBeNull();
    expect(est.perAgentTokens).toBeNull();
    expect(est.basis).toBe("no-history");
    expect(est.sampleSize).toBe(0);
  });

  it("skips runs it cannot attribute instead of imputing an agent count", () => {
    const est = estimateAnalysisRunTokens(
      [
        { totalTokens: 185_167, agentCount: null }, // metadata lost the agent list
        { totalTokens: 0, agentCount: 4 }, // never produced tokens
      ],
      4,
    );
    expect(est.tokens).toBeNull();
    expect(est.basis).toBe("no-history");
  });

  it("treats a zero/negative planned agent count as one agent", () => {
    expect(estimateAnalysisRunTokens([REPORTED_RUN], 0).tokens).toBe(46_292);
    expect(estimateAnalysisRunTokens([REPORTED_RUN], -3).tokens).toBe(46_292);
  });
});

describe("readAgentCountFromMetadata (#1095)", () => {
  it("reads the agent list written by createAnalysis", () => {
    const metadata = JSON.stringify({
      agentKeys: ["document", "code", "database", "web"],
      documentIds: [],
    });
    expect(readAgentCountFromMetadata(metadata)).toBe(4);
  });

  it("returns null for absent, empty or unparseable metadata", () => {
    expect(readAgentCountFromMetadata(null)).toBeNull();
    expect(readAgentCountFromMetadata(undefined)).toBeNull();
    expect(readAgentCountFromMetadata("not json")).toBeNull();
    expect(readAgentCountFromMetadata(JSON.stringify({ agentKeys: [] }))).toBeNull();
    expect(readAgentCountFromMetadata(JSON.stringify({ documentIds: [] }))).toBeNull();
  });
});

describe("profileAnalysisRun (#1095)", () => {
  const CHECKOUT_REQ =
    "Enforce inventory availability at checkout, not after it. Evaluate the trade-offs of " +
    "validating available quantity inside the same transaction that writes the order.";

  it("classifies the real requirement text, not a placeholder sentence", () => {
    const placeholder = new TaskProfiler().classify("Analyze project documents and codebase");
    const real = profileAnalysisRun({
      requirementText: CHECKOUT_REQ,
      agentKeys: ["code", "database"],
      estimatedTokens: 185_167,
    });

    // The placeholder path is exactly the bug: 16 tokens / simple / general.
    expect(placeholder.tokenEstimate).toBe(16);
    expect(real.tokenEstimate).toBe(185_167);
    expect(real.reasoningDepth).not.toBe(placeholder.reasoningDepth);
  });

  it("profiles a multi-agent run by its deepest leg", () => {
    const docOnly = profileAnalysisRun({
      requirementText: "List the tables used by checkout.",
      agentKeys: ["document"],
      estimatedTokens: 1_000,
    });
    const withCode = profileAnalysisRun({
      requirementText: "List the tables used by checkout.",
      agentKeys: ["document", "code"],
      estimatedTokens: 1_000,
    });

    expect(docOnly.reasoningDepth).toBe("simple");
    expect(withCode.reasoningDepth).toBe("moderate");
  });

  it("promotes depth on measured heavy history even when the prompt is short", () => {
    const light = profileAnalysisRun({
      requirementText: "Summarize the order flow.",
      agentKeys: ["document"],
      estimatedTokens: HEAVY_RUN_TOKEN_THRESHOLD,
    });
    const heavy = profileAnalysisRun({
      requirementText: "Summarize the order flow.",
      agentKeys: ["document"],
      estimatedTokens: HEAVY_RUN_TOKEN_THRESHOLD + 1,
    });

    expect(light.reasoningDepth).toBe("simple");
    expect(heavy.reasoningDepth).toBe("complex");
  });

  it("carries an unknown estimate through instead of substituting a number", () => {
    const profile = profileAnalysisRun({
      requirementText: CHECKOUT_REQ,
      agentKeys: ["code"],
      estimatedTokens: null,
    });
    expect(profile.tokenEstimate).toBeNull();
    // Never "interactive" on an unknown workload.
    expect(profile.latencySLA).not.toBe("interactive");
  });

  it("falls back to text-only classification when no agent is selected", () => {
    const profile = profileAnalysisRun({
      requirementText: "Synthesize the cross-cutting security requirements.",
      agentKeys: [],
      estimatedTokens: 12_000,
    });
    expect(profile.taskType).toBe("synthesis");
    expect(profile.reasoningDepth).toBe("complex");
  });
});
