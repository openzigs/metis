/**
 * Epic #647 — Token optimization helpers unit tests.
 *
 * Tests for:
 * - #654: windowHistory helper — REMOVED by #138: chat no longer drops old
 *   turns; it compacts them into a summary and keeps the originals.
 * - #653: estimateBreakdown helper
 * - #651: semantic cache integration in chat
 *
 * Note: supportsCaching was removed in #657 — prompt caching for chat/stream
 * routes is handled at the bedrock-access-gateway level via
 * ENABLE_PROMPT_CACHING=true (see #656). The BedrockDirectProvider path
 * (analysis, docs-gen) still honours ChatOptions.promptCaching directly.
 */
import { describe, expect, it } from "vitest";
import * as aiRoutes from "./ai.js";
import { estimateBreakdown, CHAT_CACHE_OPTS } from "./ai.js";

describe("windowHistory removed (#138)", () => {
  it("is no longer exported — compaction replaced the sliding window", () => {
    expect((aiRoutes as Record<string, unknown>).windowHistory).toBeUndefined();
  });
});

describe("estimateBreakdown (#653)", () => {
  it("estimates tokens from character count", () => {
    const result = estimateBreakdown({
      systemMessages: [{ role: "system", content: "a".repeat(100) }],
      libraryMessages: [{ role: "system", content: "b".repeat(200) }],
      historyMessages: [
        { role: "user", content: "c".repeat(80) },
        { role: "assistant", content: "d".repeat(120) },
      ],
      userMessage: "e".repeat(40),
      codeContext: "f".repeat(400),
      toolsJson: "g".repeat(800),
    });
    expect(result.system_prompt).toBe(25);
    expect(result.library_context).toBe(50);
    expect(result.chat_history).toBe(50);
    expect(result.user_message).toBe(10);
    expect(result.code_context).toBe(100);
    expect(result.tools).toBe(200);
  });

  it("#137 — uses the turn's calibrated chars-per-token ratio when given", () => {
    const result = estimateBreakdown(
      { systemMessages: [], libraryMessages: [], historyMessages: [], userMessage: "e".repeat(40) },
      2,
    );
    expect(result.user_message).toBe(20);
  });

  it("handles missing optional fields", () => {
    const result = estimateBreakdown({
      systemMessages: [],
      libraryMessages: [],
      historyMessages: [],
      userMessage: "hello",
    });
    expect(result.system_prompt).toBe(0);
    expect(result.library_context).toBe(0);
    expect(result.chat_history).toBe(0);
    expect(result.user_message).toBe(2);
    expect(result.code_context).toBe(0);
    expect(result.tools).toBe(0);
  });
});

describe("CHAT_CACHE_OPTS (#700)", () => {
  it("tags chat/stream calls with callType=chat and caches only the system prefix", () => {
    expect(CHAT_CACHE_OPTS.callType).toBe("chat");
    expect(CHAT_CACHE_OPTS.promptCaching).toEqual({ system: true });
    // `messages` is intentionally omitted — the final user turn is unique per
    // request, so caching it would only pay the write premium (#389).
    expect((CHAT_CACHE_OPTS.promptCaching as { messages?: boolean }).messages).toBeUndefined();
  });
});
