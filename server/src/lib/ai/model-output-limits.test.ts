/**
 * #1221 — tests for the model → max-output-tokens table and the clamp.
 *
 * EVERY assertion here is on the RETURNED number (or the returned
 * `clamped`/`ceiling` fields), never on downstream behaviour. That is
 * deliberate: the stub providers this repo tests against have no output
 * ceiling, so a wrong `maxTokens` produces byte-identical behaviour to a right
 * one and a behavioural test could not fail (#1224 hit exactly that).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_MAX_OUTPUT_TOKENS,
  __resetOutputCeilingWarnings,
  clampToModelOutputCeiling,
  lookupModelMaxOutputTokens,
  normalizeModelId,
} from "./model-output-limits.js";
import { __resetNonStreamingBoundWarnings } from "./nonstreaming-output-bound.js";

/** A ceiling the shipped table deliberately does not contain (see #1221). */
const EIGHT_K_TABLE = new Map<string, number>([["fictional-8k-model", 8192]]);

beforeEach(() => {
  __resetOutputCeilingWarnings();
  __resetNonStreamingBoundWarnings();
});

describe("normalizeModelId", () => {
  it("strips the Bedrock cross-region prefix", () => {
    expect(normalizeModelId("us.anthropic.claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModelId("eu.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModelId("apac.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeModelId("global.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("strips a dated Bedrock snapshot + version suffix", () => {
    expect(normalizeModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "claude-haiku-4-5",
    );
  });

  it("strips a bare dated snapshot suffix (native Anthropic ids)", () => {
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("leaves an id it does not recognise ALONE rather than guessing", () => {
    // The whole point of normalisation is to resolve KNOWN spellings of a known
    // model. An unrelated id must survive unchanged so it misses the table and
    // takes the loud unknown-model path — never get mangled into a table hit.
    expect(normalizeModelId("gemma4:12b")).toBe("gemma4:12b");
    expect(normalizeModelId("some-vendor.mystery-model-v9")).toBe("some-vendor.mystery-model-v9");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeModelId("  US.Anthropic.Claude-Opus-4-8 ")).toBe("claude-opus-4-8");
  });
});

describe("lookupModelMaxOutputTokens", () => {
  it("resolves every model id this repo can actually configure", () => {
    // These are the literals in server/src/lib/ai/model-router.ts and
    // server/src/lib/ai/config.ts. If one of them stops resolving, an operator
    // on that model silently loses the guard.
    const configurable = [
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "us.anthropic.claude-sonnet-5",
      "us.anthropic.claude-fable-5",
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-sonnet-4-6",
      "claude-sonnet-4-6",
      "gpt-4.1",
    ];
    for (const id of configurable) {
      expect(lookupModelMaxOutputTokens(id), `no ceiling for ${id}`).toBeGreaterThan(0);
    }
  });

  it("does NOT assume one number across providers", () => {
    // #1224 measured the inherited provider defaults as 4096 (Bedrock /
    // OpenAI-compatible) vs 16000 (Anthropic). The INHERITED DEFAULT and the
    // MODEL CEILING are different things; conflating them is how this class of
    // bug recurs. These are ceilings, and they differ per model.
    expect(lookupModelMaxOutputTokens("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(64000);
    expect(lookupModelMaxOutputTokens("us.anthropic.claude-opus-4-8")).toBe(128000);
    expect(lookupModelMaxOutputTokens("gpt-4.1")).toBe(32768);
  });

  it("returns null for an unknown model rather than guessing a ceiling", () => {
    expect(lookupModelMaxOutputTokens("gemma4:12b")).toBeNull();
    expect(lookupModelMaxOutputTokens("totally-made-up")).toBeNull();
  });

  it("returns null for an absent model id", () => {
    expect(lookupModelMaxOutputTokens(undefined)).toBeNull();
    expect(lookupModelMaxOutputTokens(null)).toBeNull();
    expect(lookupModelMaxOutputTokens("   ")).toBeNull();
  });

  it("carries a provenance note for every entry in the shipped table", () => {
    // A ceiling table goes stale silently. Requiring a non-empty source string
    // per row makes "where did this number come from" answerable at review time
    // rather than a guess — and makes an un-sourced addition fail here.
    expect(MODEL_MAX_OUTPUT_TOKENS.size).toBeGreaterThan(0);
    for (const [id, entry] of MODEL_MAX_OUTPUT_TOKENS) {
      expect(entry.maxOutputTokens, `${id} ceiling`).toBeGreaterThan(0);
      expect(Number.isInteger(entry.maxOutputTokens), `${id} ceiling is an integer`).toBe(true);
      expect(entry.source.length, `${id} has no provenance`).toBeGreaterThan(0);
      // The table is keyed by NORMALISED id, or the lookup can never hit it.
      expect(normalizeModelId(id), `${id} key is not normalised`).toBe(id);
    }
  });
});

describe("clampToModelOutputCeiling", () => {
  it("clamps 999999 against an 8192-ceiling model instead of passing it through", () => {
    // The issue's acceptance criterion, verbatim: an absurd configured value
    // against a small-ceiling model must come back clamped here, not blow up as
    // a provider 400 at request time.
    const result = clampToModelOutputCeiling(999999, "fictional-8k-model", EIGHT_K_TABLE);
    expect(result.value).toBe(8192);
    expect(result.ceiling).toBe(8192);
    expect(result.clamped).toBe(true);
  });

  it("clamps against a real shipped ceiling too", () => {
    const result = clampToModelOutputCeiling(999999, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(result.value).toBe(64000);
    expect(result.clamped).toBe(true);
  });

  it("leaves a value already under the ceiling untouched", () => {
    const result = clampToModelOutputCeiling(16384, "us.anthropic.claude-opus-4-8");
    expect(result.value).toBe(16384);
    expect(result.ceiling).toBe(128000);
    expect(result.clamped).toBe(false);
  });

  it("treats a value EQUAL to the ceiling as not clamped", () => {
    const result = clampToModelOutputCeiling(8192, "fictional-8k-model", EIGHT_K_TABLE);
    expect(result.value).toBe(8192);
    expect(result.clamped).toBe(false);
  });

  it("does not invent a ceiling for an unknown model", () => {
    const result = clampToModelOutputCeiling(999999, "gemma4:12b");
    expect(result.ceiling).toBeNull();
    expect(result.clamped).toBe(false);
    // Unclamped, but NOT silent — see the warn-once tests below.
    expect(result.value).toBe(999999);
  });
});

describe("clampToModelOutputCeiling — warnings", () => {
  it("warns ONCE naming BOTH the configured value and the ceiling", () => {
    const warn = vi.fn();
    clampToModelOutputCeiling(999999, "fictional-8k-model", EIGHT_K_TABLE, { logger: { warn } });
    clampToModelOutputCeiling(999999, "fictional-8k-model", EIGHT_K_TABLE, { logger: { warn } });
    clampToModelOutputCeiling(999999, "fictional-8k-model", EIGHT_K_TABLE, { logger: { warn } });

    expect(warn).toHaveBeenCalledTimes(1);
    const meta = warn.mock.calls[0]![1] as Record<string, unknown>;
    // BOTH numbers. A warning naming only one of them cannot be acted on.
    expect(meta.configured).toBe(999999);
    expect(meta.modelCeiling).toBe(8192);
    expect(meta.effective).toBe(8192);
    expect(meta.model).toBe("fictional-8k-model");
  });

  it("warns again when a DIFFERENT model or value is clamped", () => {
    const warn = vi.fn();
    clampToModelOutputCeiling(999999, "fictional-8k-model", EIGHT_K_TABLE, { logger: { warn } });
    clampToModelOutputCeiling(999999, "us.anthropic.claude-haiku-4-5-20251001-v1:0", undefined, {
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("warns ONCE that an unknown model's cap could not be verified", () => {
    const warn = vi.fn();
    clampToModelOutputCeiling(16384, "gemma4:12b", undefined, { logger: { warn } });
    clampToModelOutputCeiling(16384, "gemma4:12b", undefined, { logger: { warn } });

    expect(warn).toHaveBeenCalledTimes(1);
    const meta = warn.mock.calls[0]![1] as Record<string, unknown>;
    expect(meta.model).toBe("gemma4:12b");
    expect(meta.configured).toBe(16384);
    // The effective request includes the repair multiplier — the number the
    // provider can actually be asked for, which is what an operator must check.
    expect(meta.effectiveWithRepairHeadroom).toBe(20480);
  });

  it("warns about an ABSENT model rather than skipping the check silently", () => {
    // A caller that passes no model must not be a quiet way around the guard.
    const warn = vi.fn();
    clampToModelOutputCeiling(16384, undefined, undefined, { logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0]![1] as Record<string, unknown>).model).toBe("(unspecified)");
  });

  it("stays silent when the model is known and the value fits", () => {
    const warn = vi.fn();
    clampToModelOutputCeiling(16384, "us.anthropic.claude-opus-4-8", undefined, {
      logger: { warn },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * #1257 — the model ceiling and the SDK's non-streaming bound are DIFFERENT
 * quantities, and #1221's clamp only ever knew the first. `claude-sonnet-5` is
 * listed at 128,000, so for the model this repo actually runs the clamp was a
 * literal no-op on the path it read as guarding.
 */
describe("clampToModelOutputCeiling — the non-streaming transport bound (#1257)", () => {
  it("is a NO-OP for claude-sonnet-5 without a provider key — the #1257 premise", () => {
    const result = clampToModelOutputCeiling(100_000, "claude-sonnet-5");
    expect(result.clamped).toBe(false);
    expect(result.value).toBe(100_000);
    expect(result.ceiling).toBe(128_000);
    expect(result.sdkNonStreamingBound).toBeNull();
  });

  it("clamps the SAME request once told it is a non-streaming Anthropic-SDK call", () => {
    const result = clampToModelOutputCeiling(100_000, "claude-sonnet-5", undefined, {
      nonStreamingProviderKey: "anthropic",
      logger: { warn: vi.fn() },
    });
    expect(result.clamped).toBe(true);
    expect(result.value).toBe(21_333);
    // Both numbers survive, separately. Collapsing them is the defect.
    expect(result.ceiling).toBe(128_000);
    expect(result.sdkNonStreamingBound).toBe(21_333);
  });

  it("applies the transport bound even when the MODEL is unknown", () => {
    // An unverifiable ceiling is a reason not to guess about the model; it is
    // not a reason to stop knowing what the client will send.
    const result = clampToModelOutputCeiling(100_000, "gemma4:12b", undefined, {
      nonStreamingProviderKey: "anthropic",
      logger: { warn: vi.fn() },
    });
    expect(result.value).toBe(21_333);
    expect(result.ceiling).toBeNull();
    expect(result.sdkNonStreamingBound).toBe(21_333);
  });

  it("takes the LOWER of the two when the model ceiling also bites", () => {
    const result = clampToModelOutputCeiling(100_000, "gpt-4.1", undefined, {
      nonStreamingProviderKey: "anthropic",
      logger: { warn: vi.fn() },
    });
    // gpt-4.1's ceiling is 32,768; the SDK bound is lower and must win.
    expect(result.value).toBe(21_333);
  });

  it("does not bound a provider that is not the Anthropic SDK", () => {
    const result = clampToModelOutputCeiling(100_000, "claude-sonnet-5", undefined, {
      nonStreamingProviderKey: "bedrock-gateway",
      logger: { warn: vi.fn() },
    });
    expect(result.clamped).toBe(false);
    expect(result.value).toBe(100_000);
    expect(result.sdkNonStreamingBound).toBeNull();
  });

  it("names the CALLER'S knob in the warning, not a hardcoded one", () => {
    // #1223 declined to wire synthesis in precisely because the warning named
    // ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS literally, which would have sent
    // an operator to the wrong setting.
    const warn = vi.fn();
    clampToModelOutputCeiling(999999, "fictional-8k-model", EIGHT_K_TABLE, {
      logger: { warn },
      knob: "ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS",
    });
    expect(warn.mock.calls[0]![0]).toContain("ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS");
    expect(warn.mock.calls[0]![0]).not.toContain("ANALYSIS_FINAL_ANSWER");
  });

  it("still defaults to the final-answer knob for callers that name none", () => {
    const warn = vi.fn();
    clampToModelOutputCeiling(999999, "another-fictional-8k-model", EIGHT_K_TABLE, {
      logger: { warn },
    });
    expect(warn.mock.calls[0]![0]).toContain("ANALYSIS_FINAL_ANSWER_MAX_OUTPUT_TOKENS");
  });
});
