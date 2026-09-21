/**
 * Epic #475 (Phase 3, #483) — LLM participation gate tests.
 *
 * `shouldAIRespond(thread, message)` is the cost-control gate that decides
 * whether a human message in a discussion thread should trigger an AI reply.
 * It must honor all three `aiResponseMode` values exactly:
 *
 *   - `off`        → ALWAYS false, even when the message @AI-mentions.
 *   - `on_mention` → true iff the message @AI-mentions (case-insensitive,
 *                    word-boundary, punctuation-robust, not inside code/URLs).
 *   - `auto`       → true on a detected clear question/request, AND on @AI.
 *
 * A plain human↔human message with no trigger returns false → no LLM call.
 */
import { describe, expect, it } from "vitest";
import {
  detectAIMention,
  detectQuestionOrRequest,
  shouldAIRespond,
  AI_RESPONSE_MODES,
  isAIResponseMode,
  type AIResponseMode,
} from "./ai-gate.js";

const msg = (body: string): { body: string } => ({ body });

describe("AI_RESPONSE_MODES / isAIResponseMode", () => {
  it("exposes the three canonical modes", () => {
    expect(AI_RESPONSE_MODES).toEqual(["off", "on_mention", "auto"]);
  });

  it("accepts each canonical mode and rejects anything else", () => {
    for (const m of AI_RESPONSE_MODES) expect(isAIResponseMode(m)).toBe(true);
    expect(isAIResponseMode("ON_MENTION")).toBe(false);
    expect(isAIResponseMode("always")).toBe(false);
    expect(isAIResponseMode("")).toBe(false);
    expect(isAIResponseMode(null)).toBe(false);
    expect(isAIResponseMode(42)).toBe(false);
  });
});

describe("detectAIMention", () => {
  it("matches a bare @AI (case-insensitive)", () => {
    expect(detectAIMention("hey @AI what do you think")).toBe(true);
    expect(detectAIMention("hey @ai what do you think")).toBe(true);
    expect(detectAIMention("hey @Ai please help")).toBe(true);
  });

  it("matches @AI at the very start and very end", () => {
    expect(detectAIMention("@AI summarize this")).toBe(true);
    expect(detectAIMention("can you help @AI")).toBe(true);
    expect(detectAIMention("@AI")).toBe(true);
  });

  it("is robust to trailing punctuation around the mention", () => {
    expect(detectAIMention("thoughts, @AI?")).toBe(true);
    expect(detectAIMention("(@AI) take a look")).toBe(true);
    expect(detectAIMention("@AI, please")).toBe(true);
    expect(detectAIMention("ping @AI.")).toBe(true);
  });

  it("does NOT match @AI embedded inside a larger word", () => {
    expect(detectAIMention("send to email@AIcorp.com")).toBe(false);
    expect(detectAIMention("the @AImazing tool")).toBe(false);
    expect(detectAIMention("xx@AIxx")).toBe(false);
  });

  it("does NOT match a literal 'AI' without the @ sigil", () => {
    expect(detectAIMention("AI is interesting")).toBe(false);
    expect(detectAIMention("the ai will respond")).toBe(false);
  });

  it("does NOT match @AI inside an inline code span", () => {
    expect(detectAIMention("use the `@AI` token literal in config")).toBe(false);
    expect(detectAIMention("the value is ```@AI```")).toBe(false);
  });

  it("does NOT match @AI inside a URL", () => {
    expect(detectAIMention("see https://example.com/@AI/docs")).toBe(false);
    expect(detectAIMention("http://host/path?u=@AI")).toBe(false);
  });

  it("still matches a real mention even when a code span is also present", () => {
    expect(detectAIMention("set `mode` then @AI please review")).toBe(true);
  });

  it("handles empty / whitespace input safely", () => {
    expect(detectAIMention("")).toBe(false);
    expect(detectAIMention("   ")).toBe(false);
  });
});

describe("detectQuestionOrRequest", () => {
  it("treats a sentence ending in a question mark as a question", () => {
    expect(detectQuestionOrRequest("what are the perf targets?")).toBe(true);
    expect(detectQuestionOrRequest("Should we cache this?")).toBe(true);
  });

  it("detects interrogative openers without a question mark", () => {
    expect(detectQuestionOrRequest("what is the latency budget")).toBe(true);
    expect(detectQuestionOrRequest("How do we handle retries")).toBe(true);
    expect(detectQuestionOrRequest("why does this fail")).toBe(true);
  });

  it("detects imperative requests directed at the assistant", () => {
    expect(detectQuestionOrRequest("please summarize the requirements")).toBe(true);
    expect(detectQuestionOrRequest("can you draft acceptance criteria")).toBe(true);
    expect(detectQuestionOrRequest("could you list the open risks")).toBe(true);
  });

  it("returns false for a plain declarative human↔human statement", () => {
    expect(detectQuestionOrRequest("I updated the spec last night")).toBe(false);
    expect(detectQuestionOrRequest("thanks, looks good")).toBe(false);
    expect(detectQuestionOrRequest("the build is green")).toBe(false);
  });

  it("ignores a question mark inside an inline code span", () => {
    expect(detectQuestionOrRequest("the regex is `a?b` here")).toBe(false);
  });

  it("handles empty input safely", () => {
    expect(detectQuestionOrRequest("")).toBe(false);
  });
});

describe("shouldAIRespond", () => {
  describe("off", () => {
    const thread = { aiResponseMode: "off" as AIResponseMode };

    it("never responds, even to an explicit @AI mention", () => {
      expect(shouldAIRespond(thread, msg("@AI please help"))).toBe(false);
    });

    it("never responds to a clear question", () => {
      expect(shouldAIRespond(thread, msg("what are the perf targets?"))).toBe(false);
    });

    it("never responds to a plain statement", () => {
      expect(shouldAIRespond(thread, msg("the build is green"))).toBe(false);
    });
  });

  describe("on_mention (default)", () => {
    const thread = { aiResponseMode: "on_mention" as AIResponseMode };

    it("responds when @AI-mentioned", () => {
      expect(shouldAIRespond(thread, msg("@AI summarize this"))).toBe(true);
    });

    it("does NOT respond to a clear question without a mention", () => {
      expect(shouldAIRespond(thread, msg("what are the perf targets?"))).toBe(false);
    });

    it("does NOT respond to a plain human↔human statement (no LLM call)", () => {
      expect(shouldAIRespond(thread, msg("I updated the spec last night"))).toBe(false);
    });

    it("does NOT respond to a code-span @AI literal", () => {
      expect(shouldAIRespond(thread, msg("use `@AI` as the literal token"))).toBe(false);
    });
  });

  describe("auto", () => {
    const thread = { aiResponseMode: "auto" as AIResponseMode };

    it("responds to a clear question without a mention", () => {
      expect(shouldAIRespond(thread, msg("what are the perf targets?"))).toBe(true);
    });

    it("responds to an explicit @AI mention even if not a question", () => {
      expect(shouldAIRespond(thread, msg("@AI here is the context"))).toBe(true);
    });

    it("does NOT respond to a plain declarative statement", () => {
      expect(shouldAIRespond(thread, msg("the build is green"))).toBe(false);
    });
  });

  it("returns false for an unknown/garbage mode (fail closed — no cost)", () => {
    // Defensive: a corrupt persisted value must never trigger an LLM call.
    const thread = { aiResponseMode: "bogus" as unknown as AIResponseMode };
    expect(shouldAIRespond(thread, msg("@AI please help"))).toBe(false);
  });
});
