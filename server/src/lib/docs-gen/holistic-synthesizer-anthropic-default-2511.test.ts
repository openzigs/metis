/**
 * #2511 — docs-gen's native Anthropic default is the one shared
 * ANTHROPIC_DEFAULT_MODEL_ID, not its own literal.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANTHROPIC_DEFAULT_MODEL_ID } from "../ai/model-router.js";
import { docsGenTuning } from "./holistic-synthesizer.js";

const KEYS = [
  "ANTHROPIC_MODEL",
  "DOCS_GEN_ANTHROPIC_PHASE1_MODEL",
  "DOCS_GEN_ANTHROPIC_PHASE2_MODEL",
  "DOCS_GEN_ANTHROPIC_JUDGE_MODEL",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("docsGenTuning native Anthropic default (#2511)", () => {
  it("phase1/phase2/judge default to ANTHROPIC_DEFAULT_MODEL_ID when ANTHROPIC_MODEL is unset", () => {
    const t = docsGenTuning("anthropic", "");
    expect(ANTHROPIC_DEFAULT_MODEL_ID).toBe("claude-sonnet-5-5");
    expect(t.phase1Model).toBe(ANTHROPIC_DEFAULT_MODEL_ID);
    expect(t.phase2Model).toBe(ANTHROPIC_DEFAULT_MODEL_ID);
    expect(t.judgeModel).toBe(ANTHROPIC_DEFAULT_MODEL_ID);
  });

  it("an explicit ANTHROPIC_MODEL still wins", () => {
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-6";
    expect(docsGenTuning("anthropic", "").phase2Model).toBe("claude-sonnet-4-6");
  });
});
