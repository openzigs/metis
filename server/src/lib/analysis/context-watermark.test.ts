/**
 * Epic #515 / Issue #519 — Unit tests for ContextWatermark.
 */
import { describe, it, expect } from "vitest";
import {
  ContextWatermark,
  estimateTokens,
  totalTokens,
  getModelContextLimit,
  countNonSystemTurns,
  MODEL_CONTEXT_LIMITS,
  type ChatTurn,
} from "./context-watermark.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates at ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
  });
});

describe("totalTokens", () => {
  it("returns 0 for empty array", () => {
    expect(totalTokens([])).toBe(0);
  });

  it("sums tokens across messages", () => {
    const messages: ChatTurn[] = [
      { role: "system", content: "abcd" }, // 1 token
      { role: "user", content: "12345678" }, // 2 tokens
      { role: "assistant", content: "abcdefghijkl" }, // 3 tokens
    ];
    expect(totalTokens(messages)).toBe(6);
  });
});

describe("getModelContextLimit", () => {
  it("returns 200000 for claude-sonnet-4-20250514", () => {
    expect(getModelContextLimit("claude-sonnet-4-20250514")).toBe(200_000);
  });

  it("returns 128000 for gpt-4o", () => {
    expect(getModelContextLimit("gpt-4o")).toBe(128_000);
  });

  it("returns 128000 for gpt-4o-mini", () => {
    expect(getModelContextLimit("gpt-4o-mini")).toBe(128_000);
  });

  it("returns default for unknown model", () => {
    expect(getModelContextLimit("unknown-model-xyz")).toBe(128_000);
  });

  it("returns default when model is undefined", () => {
    expect(getModelContextLimit(undefined)).toBe(128_000);
  });

  it("has all expected models", () => {
    expect(MODEL_CONTEXT_LIMITS["gpt-4"]).toBe(8_192);
    expect(MODEL_CONTEXT_LIMITS["o3-mini"]).toBe(200_000);
  });
});

describe("countNonSystemTurns", () => {
  it("returns 0 for all-system messages", () => {
    const messages: ChatTurn[] = [
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
    ];
    expect(countNonSystemTurns(messages)).toBe(0);
  });

  it("counts user, assistant, and tool turns", () => {
    const messages: ChatTurn[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "tool", content: "result" },
    ];
    expect(countNonSystemTurns(messages)).toBe(3);
  });
});

describe("ContextWatermark", () => {
  function makeMessages(count: number, charsPerMessage: number): ChatTurn[] {
    const msgs: ChatTurn[] = [{ role: "system", content: "System prompt" }];
    for (let i = 0; i < count; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(charsPerMessage),
      });
    }
    return msgs;
  }

  describe("constructor defaults", () => {
    it("uses 80% watermark by default", () => {
      const wm = new ContextWatermark({ model: "gpt-4o" });
      expect(wm.getWatermarkPercentage()).toBe(0.8);
      expect(wm.getContextLimit()).toBe(128_000);
      expect(wm.getWatermarkTokens()).toBe(102_400);
    });

    it("accepts custom context limit", () => {
      const wm = new ContextWatermark({ contextLimit: 50_000 });
      expect(wm.getContextLimit()).toBe(50_000);
      expect(wm.getWatermarkTokens()).toBe(40_000);
    });

    it("accepts custom watermark percentage", () => {
      const wm = new ContextWatermark({ contextLimit: 100_000, watermarkPercentage: 0.9 });
      expect(wm.getWatermarkTokens()).toBe(90_000);
    });
  });

  describe("check — below watermark", () => {
    it("returns no compaction when below watermark", () => {
      const wm = new ContextWatermark({ contextLimit: 1000, watermarkPercentage: 0.8 });
      // Watermark = 800 tokens = 3200 chars
      const messages = makeMessages(10, 100); // ~250 tokens + system
      const result = wm.check(messages);

      expect(result.compactionTriggered).toBe(false);
      expect(result.currentTokens).toBeLessThan(800);
      expect(result.compactionRequest).toBeUndefined();
    });
  });

  describe("check — above watermark, too few turns", () => {
    it("skips compaction when fewer than 5 non-system turns", () => {
      const wm = new ContextWatermark({ contextLimit: 100, watermarkPercentage: 0.8 });
      // Watermark = 80 tokens = 320 chars. 3 turns of 200 chars = way over
      const messages: ChatTurn[] = [
        { role: "system", content: "x".repeat(100) },
        { role: "user", content: "y".repeat(200) },
        { role: "assistant", content: "z".repeat(200) },
        { role: "user", content: "w".repeat(200) },
      ];
      const result = wm.check(messages);

      expect(result.compactionTriggered).toBe(false);
      expect(result.skipReason).toContain("Too few turns");
    });

    it("respects custom minTurns setting", () => {
      const wm = new ContextWatermark({
        contextLimit: 100,
        watermarkPercentage: 0.8,
        minTurns: 3,
      });
      // 3 non-system turns, exactly at minTurns, so NOT skipped
      const messages: ChatTurn[] = [
        { role: "system", content: "s" },
        { role: "user", content: "a".repeat(200) },
        { role: "assistant", content: "b".repeat(200) },
        { role: "user", content: "c".repeat(200) },
      ];
      const result = wm.check(messages);

      // Should trigger because we have 3 turns >= minTurns of 3
      expect(result.compactionTriggered).toBe(true);
    });
  });

  describe("check — above watermark, compaction triggered", () => {
    it("triggers compaction when above watermark with enough turns", () => {
      const wm = new ContextWatermark({
        contextLimit: 200, // 800 chars context limit
        watermarkPercentage: 0.8, // 640 chars watermark
      });
      // 10 non-system turns of 100 chars each = 1000 chars = 250 tokens > watermark
      const messages = makeMessages(10, 100);
      const result = wm.check(messages);

      expect(result.compactionTriggered).toBe(true);
      expect(result.compactionRequest).toBeDefined();
      expect(result.compactionRequest!.turnsToSummarize).toBeGreaterThanOrEqual(1);
      expect(result.compactionRequest!.beforeTokens).toBeGreaterThan(0);
    });

    it("compaction request includes 25% of non-system turns", () => {
      const wm = new ContextWatermark({
        contextLimit: 200,
        watermarkPercentage: 0.5, // Low watermark to easily trigger
      });
      // 20 non-system turns → 25% = 5 turns to summarize
      const messages = makeMessages(20, 50);
      const result = wm.check(messages);

      expect(result.compactionTriggered).toBe(true);
      expect(result.compactionRequest!.turnsToSummarize).toBe(5);
    });

    it("reports utilization percentage", () => {
      const wm = new ContextWatermark({
        contextLimit: 100, // 400 chars
        watermarkPercentage: 0.5, // 200 chars watermark
      });
      const messages = makeMessages(8, 60); // ~120+ tokens > 50 watermark
      const result = wm.check(messages);

      expect(result.utilization).toBeGreaterThan(0.5);
      expect(result.utilization).toBeLessThanOrEqual(2); // Could be over 100% of limit
    });
  });

  describe("check — exactly at watermark", () => {
    it("does not trigger at exactly the watermark", () => {
      const wm = new ContextWatermark({
        contextLimit: 1000,
        watermarkPercentage: 0.8,
      });
      // Watermark = 800 tokens. Create messages that total exactly 800.
      // 800 tokens = 3200 chars. System + body.
      const sysContent = "s".repeat(400); // 100 tokens
      const messages: ChatTurn[] = [
        { role: "system", content: sysContent },
        ...Array.from({ length: 10 }, (_, i) => ({
          role: (i % 2 === 0 ? "user" : "assistant") as ChatTurn["role"],
          content: "x".repeat(280), // 70 tokens each, 10 * 70 = 700 tokens
        })),
      ];
      // Total = 100 + 700 = 800 = exactly at watermark
      const result = wm.check(messages);
      expect(result.compactionTriggered).toBe(false);
    });
  });

  describe("logCompactionResult", () => {
    it("does not throw", () => {
      const wm = new ContextWatermark();
      expect(() => wm.logCompactionResult(10000, 5000)).not.toThrow();
    });
  });

  describe("custom compaction fraction", () => {
    it("respects custom compactionFraction", () => {
      const wm = new ContextWatermark({
        contextLimit: 100,
        watermarkPercentage: 0.5,
        compactionFraction: 0.5, // 50% instead of default 25%
      });
      // 10 non-system turns → 50% = 5 turns to summarize
      const messages = makeMessages(10, 60);
      const result = wm.check(messages);

      expect(result.compactionTriggered).toBe(true);
      expect(result.compactionRequest!.turnsToSummarize).toBe(5);
    });
  });

  describe("edge cases", () => {
    it("handles empty messages", () => {
      const wm = new ContextWatermark({ contextLimit: 1000 });
      const result = wm.check([]);
      expect(result.compactionTriggered).toBe(false);
      expect(result.currentTokens).toBe(0);
    });

    it("handles only system messages", () => {
      const wm = new ContextWatermark({ contextLimit: 10 });
      const messages: ChatTurn[] = [{ role: "system", content: "x".repeat(200) }];
      const result = wm.check(messages);
      // Above watermark but 0 non-system turns < 5
      expect(result.compactionTriggered).toBe(false);
      expect(result.skipReason).toContain("Too few turns");
    });

    it("minimum 1 turn to summarize even with small fraction", () => {
      const wm = new ContextWatermark({
        contextLimit: 50,
        watermarkPercentage: 0.5,
        minTurns: 5,
        compactionFraction: 0.01, // Very small fraction
      });
      const messages = makeMessages(6, 100); // 6 non-system turns
      const result = wm.check(messages);

      if (result.compactionTriggered) {
        expect(result.compactionRequest!.turnsToSummarize).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
