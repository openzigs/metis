/**
 * #1225 — transcript compaction unit tests.
 *
 * The agentic loop re-sends the WHOLE transcript on every turn, so cumulative
 * prompt spend is quadratic in turn count. {@link compactTranscript} bounds the
 * growing part of that transcript. These tests pin the three contracts the
 * compaction must never break:
 *
 *   1. #734 — `toolCalls[].result` stays full and untruncated (asserted in
 *      `transcript-compaction-loop.test.ts`, which drives the real loop).
 *   2. #385/#652 — the byte-stable prefix is untouched: everything before
 *      `baseLength` is left alone, and every message is rewritten AT MOST ONCE
 *      so the compacted prefix re-stabilises immediately.
 *   3. The `"Tool result for <tool>:"` header survives verbatim — the loop's
 *      own "have I already searched?" signal, which the eval offline provider
 *      and several orchestrator tests match with `startsWith`.
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../ai/types.js";
import { redact } from "../logger.js";
import {
  compactionLogMeta,
  compactTranscript,
  estimateTokens,
  TRANSCRIPT_ELISION_MARKER,
  DEFAULT_TRANSCRIPT_COMPACTION,
} from "./context-window-manager.js";

/** A tool-result message exactly as `runAgentLoop` appends it. */
function toolResult(tool: string, body: string): ChatMessage {
  return { role: "user", content: `Tool result for ${tool}:\n${body}` };
}

function assistantCall(tool: string): ChatMessage {
  return { role: "assistant", content: JSON.stringify({ tool, args: { query: tool } }) };
}

/** `turns` assistant/tool-result pairs, each result `bodyChars` long. */
function transcript(turns: number, bodyChars: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: "TASK: analyse the project." }];
  for (let i = 0; i < turns; i++) {
    messages.push(assistantCall(`search_${i}`));
    messages.push(toolResult(`search_${i}`, `hit-${i} `.repeat(Math.ceil(bodyChars / 7))));
  }
  return messages;
}

function totalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(String(m.content)), 0);
}

describe("compactTranscript (#1225)", () => {
  it("is a no-op when the transcript is under the threshold", () => {
    const messages = transcript(3, 200);
    const before = messages.map((m) => m.content);

    const result = compactTranscript(messages, 1, { maxTranscriptTokens: 10_000 });

    expect(result.compacted).toBe(false);
    expect(result.messagesCompacted).toBe(0);
    expect(messages.map((m) => m.content)).toEqual(before);
  });

  it("elides the oldest tool results once the transcript exceeds the threshold", () => {
    const messages = transcript(10, 4_000);
    const tokensBefore = totalTokens(messages);

    const result = compactTranscript(messages, 1, {
      maxTranscriptTokens: 2_000,
      preserveRecentTurns: 2,
    });

    expect(result.compacted).toBe(true);
    expect(result.messagesCompacted).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(totalTokens(messages)).toBeLessThan(tokensBefore);
  });

  it("never rewrites anything before baseLength — the byte-stable prefix (#385/#652)", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "STABLE LEAD: persona and tool schemas." },
      { role: "user", content: "Tool result for seeded_by_caller:\n" + "x".repeat(40_000) },
      ...transcript(8, 4_000).slice(1),
    ];
    const baseLength = 2;
    const seededLead = messages.slice(0, baseLength).map((m) => m.content);

    compactTranscript(messages, baseLength, {
      maxTranscriptTokens: 1_000,
      preserveRecentTurns: 1,
    });

    expect(messages.slice(0, baseLength).map((m) => m.content)).toEqual(seededLead);
  });

  it("preserves the `Tool result for <tool>:` header verbatim on an elided message", () => {
    const messages = transcript(8, 6_000);

    compactTranscript(messages, 1, { maxTranscriptTokens: 1_000, preserveRecentTurns: 1 });

    const elided = messages.filter(
      (m) => typeof m.content === "string" && m.content.includes(TRANSCRIPT_ELISION_MARKER),
    );
    expect(elided.length).toBeGreaterThan(0);
    for (const m of elided) {
      expect(String(m.content).startsWith("Tool result for ")).toBe(true);
      expect(String(m.content)).toMatch(/^Tool result for search_\d+:\n/);
    }
  });

  it("keeps a head slice of each elided body so early locators survive", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "TASK" },
      assistantCall("search_code_symbols"),
      {
        role: "user",
        content:
          "Tool result for search_code_symbols:\n" +
          "server/src/auth/session.ts:12-20 createSession\n" +
          "filler ".repeat(6_000),
      },
      ...transcript(6, 4_000).slice(1),
    ];

    compactTranscript(messages, 1, {
      maxTranscriptTokens: 1_000,
      preserveRecentTurns: 1,
      headChars: 200,
    });

    expect(String(messages[2].content)).toContain("server/src/auth/session.ts:12-20");
    expect(String(messages[2].content)).toContain(TRANSCRIPT_ELISION_MARKER);
  });

  it("preserves the most recent turns at full fidelity", () => {
    const messages = transcript(10, 4_000);
    const lastResult = String(messages[messages.length - 1].content);

    compactTranscript(messages, 1, { maxTranscriptTokens: 500, preserveRecentTurns: 3 });

    // The final three tool results are at indexes 6, 4 and 2 from the end.
    for (const offset of [1, 3, 5]) {
      expect(String(messages[messages.length - offset].content)).not.toContain(
        TRANSCRIPT_ELISION_MARKER,
      );
    }
    expect(String(messages[messages.length - 1].content)).toBe(lastResult);
  });

  it("is idempotent — a second pass rewrites nothing, so the prefix re-stabilises", () => {
    const messages = transcript(10, 4_000);

    const first = compactTranscript(messages, 1, {
      maxTranscriptTokens: 500,
      preserveRecentTurns: 1,
    });
    const afterFirst = messages.map((m) => m.content);
    const second = compactTranscript(messages, 1, {
      maxTranscriptTokens: 500,
      preserveRecentTurns: 1,
    });

    expect(first.compacted).toBe(true);
    expect(second.messagesCompacted).toBe(0);
    expect(messages.map((m) => m.content)).toEqual(afterFirst);
  });

  it("stops as soon as the transcript fits, leaving newer results whole", () => {
    const messages = transcript(10, 4_000);

    const result = compactTranscript(messages, 1, {
      maxTranscriptTokens: 6_000,
      preserveRecentTurns: 1,
      headChars: 100,
    });

    const elidedCount = messages.filter(
      (m) => typeof m.content === "string" && m.content.includes(TRANSCRIPT_ELISION_MARKER),
    ).length;
    expect(elidedCount).toBe(result.messagesCompacted);
    // It compacted some, but not every compactible result — it stopped at the
    // threshold rather than flattening the whole transcript.
    expect(elidedCount).toBeGreaterThan(0);
    expect(elidedCount).toBeLessThan(9);
  });

  it("compacts past the ceiling to the hysteresis target, not merely to the ceiling", () => {
    const atCeiling = transcript(10, 4_000);
    const withHysteresis = transcript(10, 4_000);

    const noHysteresis = compactTranscript(atCeiling, 1, {
      maxTranscriptTokens: 6_000,
      preserveRecentTurns: 1,
      targetRatio: 1,
    });
    const hysteresis = compactTranscript(withHysteresis, 1, {
      maxTranscriptTokens: 6_000,
      preserveRecentTurns: 1,
      targetRatio: 0.5,
    });

    expect(noHysteresis.tokensAfter).toBeGreaterThan(hysteresis.tokensAfter);
    expect(hysteresis.tokensAfter).toBeLessThanOrEqual(3_000);
    expect(hysteresis.messagesCompacted).toBeGreaterThan(noHysteresis.messagesCompacted);
  });

  it("clamps an out-of-range targetRatio instead of over- or under-compacting", () => {
    const high = transcript(10, 4_000);
    const low = transcript(10, 4_000);

    const clampedHigh = compactTranscript(high, 1, {
      maxTranscriptTokens: 6_000,
      preserveRecentTurns: 1,
      targetRatio: 5,
    });
    const clampedLow = compactTranscript(low, 1, {
      maxTranscriptTokens: 6_000,
      preserveRecentTurns: 1,
      targetRatio: -1,
    });

    expect(clampedHigh.tokensAfter).toBeLessThanOrEqual(6_000);
    // targetRatio 0 ⇒ compact everything eligible, never a crash or a no-op.
    expect(clampedLow.compacted).toBe(true);
    expect(clampedLow.tokensAfter).toBeLessThan(clampedHigh.tokensAfter);
  });

  it("leaves assistant tool-call turns alone — they are the record of what was run", () => {
    const messages = transcript(10, 4_000);
    const assistants = messages.filter((m) => m.role === "assistant").map((m) => m.content);

    compactTranscript(messages, 1, { maxTranscriptTokens: 500, preserveRecentTurns: 1 });

    expect(messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(
      assistants,
    );
  });

  it("ignores user messages that are not tool results", () => {
    const followUp = "A follow-up instruction, not a tool result.\n" + "y".repeat(40_000);
    const messages: ChatMessage[] = [
      { role: "user", content: "TASK" },
      { role: "assistant", content: "thinking" },
      { role: "user", content: followUp },
    ];

    const result = compactTranscript(messages, 1, {
      maxTranscriptTokens: 100,
      preserveRecentTurns: 0,
    });

    expect(result.compacted).toBe(false);
    expect(messages[2].content).toBe(followUp);
  });

  it("skips non-string (multimodal) content without throwing", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "TASK" },
      { role: "assistant", content: "call" },
      {
        role: "user",
        content: [{ type: "text", text: "Tool result for x:\n" + "z".repeat(9_000) }],
      },
      ...transcript(4, 4_000).slice(1),
    ];

    expect(() =>
      compactTranscript(messages, 1, { maxTranscriptTokens: 500, preserveRecentTurns: 0 }),
    ).not.toThrow();
    expect(Array.isArray(messages[2].content)).toBe(true);
  });

  it("does not elide a body that is already shorter than the head slice", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "TASK" },
      assistantCall("tiny"),
      toolResult("tiny", "no hits"),
      ...transcript(6, 4_000).slice(1),
    ];

    compactTranscript(messages, 1, {
      maxTranscriptTokens: 200,
      preserveRecentTurns: 0,
      headChars: 600,
    });

    expect(String(messages[2].content)).toBe("Tool result for tiny:\nno hits");
  });

  it("reports the elided character count in the marker", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "TASK" },
      assistantCall("big"),
      toolResult("big", "b".repeat(5_000)),
      ...transcript(4, 4_000).slice(1),
    ];

    compactTranscript(messages, 1, {
      maxTranscriptTokens: 200,
      preserveRecentTurns: 0,
      headChars: 100,
    });

    // 5,000 body chars minus the 100 kept = 4,900 elided.
    expect(String(messages[2].content)).toContain("4900 characters elided");
  });

  it("ships defaults that leave a short transcript untouched", () => {
    const messages = transcript(4, 1_000);
    const before = messages.map((m) => m.content);

    const result = compactTranscript(messages, 1);

    expect(DEFAULT_TRANSCRIPT_COMPACTION.maxTranscriptTokens).toBeGreaterThan(0);
    expect(result.compacted).toBe(false);
    expect(messages.map((m) => m.content)).toEqual(before);
  });

  it("tolerates a baseLength at or beyond the end of the transcript", () => {
    const messages = transcript(2, 100);
    const before = messages.map((m) => m.content);

    const result = compactTranscript(messages, messages.length, { maxTranscriptTokens: 1 });

    expect(result.compacted).toBe(false);
    expect(messages.map((m) => m.content)).toEqual(before);
  });
});

describe("compaction telemetry survives log redaction (#1225)", () => {
  /** The meta the module ACTUALLY logs, not a copy of it. */
  const meta = compactionLogMeta(
    { compacted: true, messagesCompacted: 3, tokensBefore: 40_000, tokensAfter: 9_000 },
    16_000,
    9_600,
  );

  it("reaches the log with its numbers intact", () => {
    expect(redact(meta)).toEqual(meta);
  });

  it("no longer needs to dodge `/token/i` to reach the log (#1263)", () => {
    // This assertion used to be the contrast case: `tokensBefore` was the
    // obvious naming and the redactor destroyed it, which is why the keys
    // above are named for what they measure instead. #1263 fixed the guard —
    // an enumerated token COUNT with a numeric value is now exempt — so the
    // obvious naming survives and the workaround is no longer load-bearing.
    expect((redact({ tokensBefore: 40_000 }) as Record<string, unknown>).tokensBefore).toBe(40_000);
    // The guard itself is intact: a credential-shaped token key still goes.
    expect(
      (redact({ refresh_token: "opaque-credential-value-for-tests" }) as Record<string, unknown>)
        .refresh_token,
    ).toBe("[REDACTED]");
  });
});

describe("estimateTokens", () => {
  it("approximates four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
