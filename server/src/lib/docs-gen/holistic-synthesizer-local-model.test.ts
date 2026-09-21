/**
 * Local docs-gen phase-model resolution (local provider model fix).
 *
 * Guards the rule that an operator who sets LOCAL_GEMMA_MODEL (or the explicit
 * DOCS_GEN_LOCAL_PHASE2_MODEL) gets THAT model for phase-2 synthesis, and that
 * the silent fallback is a NON-reasoning model — never the old `gemma4:12b`
 * reasoning default, which returns empty content via the OpenAI `/v1` path.
 *
 * `docsGenTuning` reads phase models from env at call time, so each test sets/
 * clears the relevant vars and asserts the resolved `phase1Model`/`phase2Model`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsGenTuning } from "./holistic-synthesizer.js";

const LOCAL_ENV_KEYS = [
  "DOCS_GEN_LOCAL_PHASE1_MODEL",
  "DOCS_GEN_LOCAL_PHASE2_MODEL",
  "LOCAL_GEMMA_MODEL",
  "DOCS_GEN_LOCAL_STRUCTURED_OUTPUT",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of LOCAL_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of LOCAL_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("docsGenTuning('local') phase-2 model resolution", () => {
  it("DOCS_GEN_LOCAL_PHASE2_MODEL wins over everything", () => {
    process.env.DOCS_GEN_LOCAL_PHASE2_MODEL = "explicit-phase2:7b";
    process.env.LOCAL_GEMMA_MODEL = "qwen2.5:14b";
    // configModel is also provided but must lose to the explicit override.
    expect(docsGenTuning("local", "configured:99b").phase2Model).toBe("explicit-phase2:7b");
  });

  it("falls back to LOCAL_GEMMA_MODEL when no explicit phase-2 override is set", () => {
    process.env.LOCAL_GEMMA_MODEL = "qwen2.5:14b";
    // This is the live-failure case: LOCAL_GEMMA_MODEL set, but the resolved
    // configModel did NOT carry it. Phase 2 must still honor LOCAL_GEMMA_MODEL.
    expect(docsGenTuning("local", "gemma4:12b").phase2Model).toBe("qwen2.5:14b");
  });

  it("LOCAL_GEMMA_MODEL beats a (different) resolved configModel for phase 2", () => {
    process.env.LOCAL_GEMMA_MODEL = "qwen2.5:14b";
    expect(docsGenTuning("local", "some-other-model:8b").phase2Model).toBe("qwen2.5:14b");
  });

  it("uses configModel when it is a real configured model and no env override is set", () => {
    // configModel carries the operator's choice (e.g. resolved correctly) and is
    // not the reasoning default — it should be used.
    expect(docsGenTuning("local", "llama3.1:8b").phase2Model).toBe("llama3.1:8b");
  });

  it("falls back to the NON-reasoning default when nothing is set", () => {
    expect(docsGenTuning("local", "").phase2Model).toBe("gemma3:12b");
  });

  it("never silently defaults phase 2 to the gemma4:12b reasoning model", () => {
    // configModel is the bare reasoning default (operator did not set
    // LOCAL_GEMMA_MODEL) — phase 2 must skip it for the non-reasoning fallback.
    const tuning = docsGenTuning("local", "gemma4:12b");
    expect(tuning.phase2Model).not.toBe("gemma4:12b");
    expect(tuning.phase2Model).toBe("gemma3:12b");
  });
});

describe("docsGenTuning('local') phase-1 model resolution", () => {
  it("defaults phase 1 to gemma3:4b (fast extraction)", () => {
    expect(docsGenTuning("local", "anything").phase1Model).toBe("gemma3:4b");
  });

  it("honors DOCS_GEN_LOCAL_PHASE1_MODEL override", () => {
    process.env.DOCS_GEN_LOCAL_PHASE1_MODEL = "phi3:mini";
    expect(docsGenTuning("local", "anything").phase1Model).toBe("phi3:mini");
  });

  it("phase 1 is independent of the phase-2 / LOCAL_GEMMA_MODEL resolution", () => {
    process.env.LOCAL_GEMMA_MODEL = "qwen2.5:14b";
    process.env.DOCS_GEN_LOCAL_PHASE2_MODEL = "explicit-phase2:7b";
    const tuning = docsGenTuning("local", "gemma4:12b");
    expect(tuning.phase1Model).toBe("gemma3:4b");
    expect(tuning.phase2Model).toBe("explicit-phase2:7b");
  });
});

describe("docsGenTuning structuredOutput flag (#336)", () => {
  it("is OFF by default on the local path (existing Ollama users unaffected)", () => {
    expect(docsGenTuning("local", "gemma3:12b").structuredOutput).toBe(false);
  });

  it("turns ON when DOCS_GEN_LOCAL_STRUCTURED_OUTPUT=1 on the local path", () => {
    process.env.DOCS_GEN_LOCAL_STRUCTURED_OUTPUT = "1";
    expect(docsGenTuning("local", "gemma3:12b").structuredOutput).toBe(true);
  });

  it("is ALWAYS off on anthropic/bedrock (capability-gated to local/vLLM only)", () => {
    process.env.DOCS_GEN_LOCAL_STRUCTURED_OUTPUT = "1";
    // The local flag must never leak onto cloud providers that ignore response_format.
    expect(docsGenTuning("anthropic", "claude-sonnet-4-6").structuredOutput).toBe(false);
    expect(docsGenTuning("bedrock", "us.anthropic.claude-sonnet-4-6").structuredOutput).toBe(false);
  });
});
