/**
 * Epic #194 (C.3) — `score_grounding` tool tests.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createScoreGroundingTool,
  registerScoreGrounding,
  SCORE_GROUNDING_TOOL_NAME,
  scoreGroundingSchema,
} from "../src/lib/ai/tools/score-grounding.js";

const ctx = { sessionId: "s1", userId: "u1" };

describe("scoreGroundingSchema", () => {
  it("rejects payloads missing sources", () => {
    const r = scoreGroundingSchema.safeParse({ output: "hi", sources: [] });
    expect(r.success).toBe(false);
  });

  it("accepts a well-formed payload", () => {
    const r = scoreGroundingSchema.safeParse({ output: "hi", sources: ["src"] });
    expect(r.success).toBe(true);
  });
});

describe("createScoreGroundingTool", () => {
  it("invokes the underlying scorer and returns a summary string", async () => {
    const tool = createScoreGroundingTool();
    const result = await tool.exec(
      {
        output: "the quick brown fox jumps over the lazy dog",
        sources: ["the quick brown fox jumps over the lazy dog"],
      },
      ctx,
    );
    expect(result.text).toContain("grounding=1.00");
    expect(result.text).toContain("hallucination=0.00");
    expect(result.data).toMatchObject({ groundingScore: 1, hallucinationScore: 0 });
  });

  it("threads a judge through to the scorer", async () => {
    const judge = { entail: vi.fn(async () => 0.5) };
    const tool = createScoreGroundingTool({ judge });
    const r = await tool.exec(
      { output: "Some claim is here today.", sources: ["context here"] },
      ctx,
    );
    expect(judge.entail).toHaveBeenCalled();
    expect((r.data as { entailmentScore: number }).entailmentScore).toBeCloseTo(0.5);
  });

  it("declares low risk and the canonical name", () => {
    const tool = createScoreGroundingTool();
    expect(tool.risk).toBe("low");
    expect(tool.name).toBe(SCORE_GROUNDING_TOOL_NAME);
  });
});

describe("registerScoreGrounding", () => {
  it("unregisters then registers idempotently", () => {
    const registry = {
      register: vi.fn(),
      unregister: vi.fn(() => true),
    };
    const r = registerScoreGrounding(registry);
    expect(r.registered).toBe(true);
    expect(registry.unregister).toHaveBeenCalledWith(SCORE_GROUNDING_TOOL_NAME);
    expect(registry.register).toHaveBeenCalledTimes(1);
  });
});
