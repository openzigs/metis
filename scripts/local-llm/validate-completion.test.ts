import { describe, it, expect } from "vitest";
import {
  SMOKE_REASON,
  extractTextContent,
  hasReasoningTokens,
  validateChatCompletion,
} from "./validate-completion.mjs";

describe("extractTextContent", () => {
  it("returns a plain string content unchanged", () => {
    expect(extractTextContent("hello world")).toBe("hello world");
  });

  it("concatenates the text parts of an array content", () => {
    const content = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ];
    expect(extractTextContent(content)).toBe("Hello world");
  });

  it("tolerates bare strings inside the parts array", () => {
    expect(extractTextContent(["a", { text: "b" }, "c"])).toBe("abc");
  });

  it("returns empty string for null/undefined/number content", () => {
    expect(extractTextContent(null)).toBe("");
    expect(extractTextContent(undefined)).toBe("");
    expect(extractTextContent(42)).toBe("");
  });

  it("ignores array parts without a string text field", () => {
    expect(extractTextContent([{ type: "image" }, { text: 5 }])).toBe("");
  });
});

describe("hasReasoningTokens", () => {
  it("detects a non-empty `reasoning` field", () => {
    expect(hasReasoningTokens({ reasoning: "let me think..." })).toBe(true);
  });

  it("detects a non-empty `reasoning_content` field (vLLM/DeepSeek style)", () => {
    expect(hasReasoningTokens({ reasoning_content: "step 1..." })).toBe(true);
  });

  it("is false when reasoning fields are empty or whitespace", () => {
    expect(hasReasoningTokens({ reasoning: "   " })).toBe(false);
    expect(hasReasoningTokens({ reasoning_content: "" })).toBe(false);
  });

  it("is false when no reasoning fields are present", () => {
    expect(hasReasoningTokens({ content: "answer" })).toBe(false);
  });

  it("is false for non-object inputs", () => {
    expect(hasReasoningTokens(null)).toBe(false);
    expect(hasReasoningTokens(undefined)).toBe(false);
  });
});

describe("validateChatCompletion — success", () => {
  it("accepts a normal non-empty string completion", () => {
    const body = {
      choices: [{ message: { role: "assistant", content: "METIS is up." }, finish_reason: "stop" }],
    };
    const res = validateChatCompletion(body);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toBe("METIS is up.");
      expect(res.finishReason).toBe("stop");
      expect(res.reason).toBe(SMOKE_REASON.OK);
    }
  });

  it("accepts array-shaped content and trims surrounding whitespace", () => {
    const body = {
      choices: [
        { message: { content: [{ type: "text", text: "  hi  " }] }, finish_reason: "stop" },
      ],
    };
    const res = validateChatCompletion(body);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toBe("hi");
  });

  it("accepts a completion even when finish_reason is absent", () => {
    const body = { choices: [{ message: { content: "ok" } }] };
    const res = validateChatCompletion(body);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.finishReason).toBeNull();
  });
});

describe("validateChatCompletion — reasoning-model empty-content trap (#332)", () => {
  it("flags empty content WITH reasoning tokens as reasoning-empty-content", () => {
    const body = {
      choices: [
        {
          message: { role: "assistant", content: "", reasoning: "I should explain..." },
          finish_reason: "length",
        },
      ],
    };
    const res = validateChatCompletion(body);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe(SMOKE_REASON.REASONING_EMPTY_CONTENT);
      expect(res.hasReasoning).toBe(true);
      expect(res.finishReason).toBe("length");
      expect(res.message).toMatch(/reasoning/i);
      expect(res.message).toMatch(/gemma4:12b/);
    }
  });

  it("flags empty content truncated by length (no reasoning field) as reasoning-empty-content", () => {
    const body = { choices: [{ message: { content: "" }, finish_reason: "length" }] };
    const res = validateChatCompletion(body);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe(SMOKE_REASON.REASONING_EMPTY_CONTENT);
      expect(res.hasReasoning).toBe(false);
      expect(res.message).toMatch(/finish_reason: length/);
    }
  });

  it("flags reasoning_content present with empty visible content", () => {
    const body = {
      choices: [
        { message: { content: null, reasoning_content: "thinking" }, finish_reason: "stop" },
      ],
    };
    const res = validateChatCompletion(body);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe(SMOKE_REASON.REASONING_EMPTY_CONTENT);
  });
});

describe("validateChatCompletion — other failures", () => {
  it("rejects a non-object body", () => {
    expect(validateChatCompletion(null).reason).toBe(SMOKE_REASON.NOT_AN_OBJECT);
    expect(validateChatCompletion("nope").reason).toBe(SMOKE_REASON.NOT_AN_OBJECT);
  });

  it("rejects an API error envelope and surfaces the message", () => {
    const res = validateChatCompletion({ error: { message: "model not found" } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe(SMOKE_REASON.API_ERROR);
      expect(res.message).toMatch(/model not found/);
    }
  });

  it("rejects a string-valued error field", () => {
    const res = validateChatCompletion({ error: "boom" });
    expect(res.reason).toBe(SMOKE_REASON.API_ERROR);
    if (!res.ok) expect(res.message).toMatch(/boom/);
  });

  it("rejects a non-string/object error field by stringifying it", () => {
    const res = validateChatCompletion({ error: 500 });
    expect(res.reason).toBe(SMOKE_REASON.API_ERROR);
  });

  it("rejects a body with no choices array", () => {
    expect(validateChatCompletion({}).reason).toBe(SMOKE_REASON.NO_CHOICES);
    expect(validateChatCompletion({ choices: [] }).reason).toBe(SMOKE_REASON.NO_CHOICES);
    expect(validateChatCompletion({ choices: "x" }).reason).toBe(SMOKE_REASON.NO_CHOICES);
  });

  it("rejects a choice with no message", () => {
    const res = validateChatCompletion({ choices: [{ finish_reason: "stop" }] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe(SMOKE_REASON.NO_MESSAGE);
      expect(res.finishReason).toBe("stop");
    }
  });

  it("rejects empty content that is neither reasoning nor length-truncated", () => {
    const body = { choices: [{ message: { content: "   " }, finish_reason: "stop" }] };
    const res = validateChatCompletion(body);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe(SMOKE_REASON.EMPTY_CONTENT);
      expect(res.hasReasoning).toBe(false);
    }
  });
});
