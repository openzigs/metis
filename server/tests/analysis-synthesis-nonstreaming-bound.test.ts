/**
 * #1257 — the two items #1223 declined to reach into #1221's files for
 * mid-flight, plus the transport bound synthesis now participates in.
 *
 * Every assertion is on the ARGUMENT handed to `provider.chat` or on the value
 * a resolver returns, never on what comes back: the stub providers have no
 * output cap and emit no thinking, so a behavioural assertion here would pass
 * whether or not the production numbers are right (the trap #1223 and #1224
 * each hit, warned about twice, and hit anyway).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../src/lib/config/config-service.js";
import { ConfigValidationError } from "../src/lib/config/errors.js";
import { __resetOutputCeilingWarnings } from "../src/lib/ai/model-output-limits.js";
import { __resetNonStreamingBoundWarnings } from "../src/lib/ai/nonstreaming-output-bound.js";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../src/lib/ai/types.js";
import {
  DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS,
  assertSynthesisMaxOutputTokensValid,
  resolveSynthesisMaxOutputTokens,
  runSynthesis,
  type FlatFinding,
} from "../src/lib/analysis/synthesis.js";

const finding = (): FlatFinding => ({
  agentKey: "document",
  category: "other",
  severity: "info",
  title: "Audit log retention",
  body: "Logs are not retained.",
  tags: ["audit"],
  citations: [],
});

const VALID = JSON.stringify({
  summary: "ok",
  requirements: [
    {
      type: "feature",
      title: "Retain audit logs",
      body: "Retain audit logs for 30 days.",
      priority: "high",
      labels: ["audit"],
      evidenceFindingIndexes: [0],
    },
  ],
});

/** Records every `ChatOptions` it is handed; the recording is the subject. */
function recordingProvider(key: string, model: string) {
  const calls: ChatOptions[] = [];
  const provider = {
    key,
    model,
    offline: true,
    chat: vi.fn(async (_m: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> => {
      calls.push(opts);
      return {
        content: VALID,
        usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
        model,
        provider: "offline-stub",
      };
    }),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(async () => [model]),
    ping: vi.fn(async () => true),
  } as unknown as AIProvider;
  return { provider, calls };
}

beforeEach(() => {
  delete process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS;
  __resetConfigSingleton();
  __resetOutputCeilingWarnings();
  __resetNonStreamingBoundWarnings();
});

afterEach(() => {
  delete process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS;
  __resetConfigSingleton();
});

describe("#1257 — synthesis participates in the clamp", () => {
  it("clamps an over-ceiling setting to the MODEL's ceiling", () => {
    // Before #1257 synthesis read the knob raw: 999,999 went straight to the
    // provider, which is exactly the state #1221's clamp exists to prevent.
    process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS = "999999";
    __resetConfigSingleton();
    expect(resolveSynthesisMaxOutputTokens("claude-haiku-4-5")).toBe(64_000);
  });

  it("clamps to the SDK's non-streaming bound on the anthropic provider", () => {
    process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS = "64000";
    __resetConfigSingleton();
    // The model ceiling alone would allow 64,000 here — the transport is what
    // binds, and only because the caller named the provider.
    expect(resolveSynthesisMaxOutputTokens("claude-sonnet-5", "anthropic")).toBe(21_333);
    expect(resolveSynthesisMaxOutputTokens("claude-sonnet-5", "bedrock-gateway")).toBe(64_000);
  });

  it("passes the model AND the provider key from the live call", async () => {
    process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS = "64000";
    __resetConfigSingleton();
    const { provider, calls } = recordingProvider("anthropic", "claude-sonnet-5");
    await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });
    // A LITERAL, not a second call to the resolver: deriving the expected value
    // the same way the code does asserts nothing (#1222).
    expect(calls[0]!.maxTokens).toBe(21_333);
  });

  it("leaves the default untouched on a provider with no transport bound", async () => {
    const { provider, calls } = recordingProvider("bedrock-gateway", "claude-sonnet-5");
    await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });
    expect(calls[0]!.maxTokens).toBe(21_000);
    expect(DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS).toBe(21_000);
  });

  it("the default clears the bound on the anthropic path without being clamped", async () => {
    const { provider, calls } = recordingProvider("anthropic", "claude-sonnet-5");
    await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });
    expect(calls[0]!.maxTokens).toBe(21_000);
  });
});

describe("#1257 — the synthesis knob is validated at startup", () => {
  it.each(["0", "-5", "-8192", "21000abc", "not-a-number", "12.5"])(
    "rejects %o rather than sending it as maxTokens",
    (bad) => {
      process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS = bad;
      __resetConfigSingleton();
      expect(() => assertSynthesisMaxOutputTokensValid()).toThrow(ConfigValidationError);
    },
  );

  it("treats an EMPTY value as unset, exactly as the sibling knob does", () => {
    // Pinned rather than assumed: the config service maps "" to absent, so this
    // is the default path and not a validation hole. Asserting it here means a
    // change to that mapping shows up as a failure with a reason attached.
    process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS = "";
    __resetConfigSingleton();
    expect(() => assertSynthesisMaxOutputTokensValid()).not.toThrow();
    expect(resolveSynthesisMaxOutputTokens()).toBe(21_000);
  });

  it("accepts a legal value and an absent one", () => {
    process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS = "8192";
    __resetConfigSingleton();
    expect(() => assertSynthesisMaxOutputTokensValid()).not.toThrow();
    expect(resolveSynthesisMaxOutputTokens()).toBe(8192);

    delete process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS;
    __resetConfigSingleton();
    expect(() => assertSynthesisMaxOutputTokensValid()).not.toThrow();
    expect(resolveSynthesisMaxOutputTokens()).toBe(21_000);
  });

  it("names the SYNTHESIS knob, not the sibling one, in the error", () => {
    process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS = "-5";
    __resetConfigSingleton();
    try {
      assertSynthesisMaxOutputTokensValid();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS");
      expect((err as Error).message).not.toContain("FINAL_ANSWER");
    }
  });
});
