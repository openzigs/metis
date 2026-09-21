/**
 * Epic #647 — Token optimization helpers unit tests.
 *
 * Tests for:
 * - #654: windowHistory helper
 * - #653: estimateBreakdown helper
 * - #651: semantic cache integration in chat
 *
 * Note: supportsCaching was removed in #657 — prompt caching for chat/stream
 * routes is handled at the bedrock-access-gateway level via
 * ENABLE_PROMPT_CACHING=true (see #656). The BedrockDirectProvider path
 * (analysis, docs-gen) still honours ChatOptions.promptCaching directly.
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/ai/types.js";
import { windowHistory, estimateBreakdown, CHAT_CACHE_OPTS } from "./ai.js";

describe("windowHistory (#654)", () => {
  const system: ChatMessage = { role: "system", content: "You are a helpful assistant." };
  const user1: ChatMessage = { role: "user", content: "Hello" };
  const asst1: ChatMessage = { role: "assistant", content: "Hi there!" };
  const user2: ChatMessage = { role: "user", content: "How are you?" };
  const asst2: ChatMessage = { role: "assistant", content: "I'm well!" };
  const user3: ChatMessage = { role: "user", content: "Tell me a joke" };
  const asst3: ChatMessage = { role: "assistant", content: "Why did..." };

  it("preserves all messages when within maxTurns", () => {
    const msgs = [system, user1, asst1, user2, asst2];
    const result = windowHistory(msgs, 5);
    expect(result).toEqual(msgs);
  });

  it("windows to last N turns while keeping system messages", () => {
    const msgs = [system, user1, asst1, user2, asst2, user3, asst3];
    const result = windowHistory(msgs, 2);
    expect(result).toEqual([system, user2, asst2, user3, asst3]);
  });

  it("keeps system messages when all user/assistant messages are windowed out", () => {
    const msgs = [system, user1, asst1, user2, asst2, user3, asst3];
    const result = windowHistory(msgs, 1);
    expect(result).toContain(system);
    expect(result).toContain(user3);
    expect(result).toContain(asst3);
    expect(result).not.toContain(user1);
    expect(result).not.toContain(asst1);
  });

  it("returns all messages when maxTurns is 0 (disabled)", () => {
    const msgs = [system, user1, asst1, user2, asst2];
    const result = windowHistory(msgs, 0);
    expect(result).toEqual(msgs);
  });

  it("handles empty messages", () => {
    expect(windowHistory([], 5)).toEqual([]);
  });

  it("handles multiple system messages", () => {
    const sys2: ChatMessage = { role: "system", content: "Extra context" };
    const msgs = [system, sys2, user1, asst1, user2, asst2];
    const result = windowHistory(msgs, 1);
    expect(result).toContain(system);
    expect(result).toContain(sys2);
    expect(result).toContain(user2);
    expect(result).toContain(asst2);
    expect(result).not.toContain(user1);
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
