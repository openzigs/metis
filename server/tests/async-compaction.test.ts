/**
 * Epic #156 (#150) — Context compaction unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  compactMessages,
  estimateTokens,
  totalTokens,
  type ChatTurn,
} from "../src/lib/async/compaction.js";

describe("estimateTokens / totalTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(totalTokens([])).toBe(0);
  });
  it("approximates ~1 token per 4 chars", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
  it("sums across messages", () => {
    expect(
      totalTokens([
        { role: "user", content: "abcd" },
        { role: "assistant", content: "efgh" },
      ]),
    ).toBe(2);
  });
});

describe("compactMessages", () => {
  function bigTurn(role: ChatTurn["role"], n: number): ChatTurn {
    return { role, content: "x".repeat(n) };
  }

  it("returns input unchanged when below threshold", async () => {
    const messages: ChatTurn[] = [bigTurn("user", 80), bigTurn("assistant", 80)];
    const r = await compactMessages(messages, { thresholdTokens: 1_000 });
    expect(r.summarizedTurns).toBe(0);
    expect(r.after).toEqual(messages);
  });

  it("summarizes the oldest 70% when above threshold", async () => {
    const summarizer = vi.fn(async (turns: ChatTurn[]) => `[summary of ${turns.length}]`);
    const messages: ChatTurn[] = [];
    for (let i = 0; i < 10; i++) messages.push(bigTurn(i % 2 === 0 ? "user" : "assistant", 800));
    const r = await compactMessages(messages, { thresholdTokens: 100, summarizer });
    // 70% of 10 = 7 summarized, 3 verbatim, plus a system summary.
    expect(r.summarizedTurns).toBe(7);
    expect(r.after.length).toBe(1 + 3);
    expect(r.after[0]!.role).toBe("system");
    expect(r.after[0]!.content).toContain("[Compacted summary of 7 prior turns]");
    expect(r.afterTokens).toBeLessThan(r.beforeTokens);
    expect(summarizer).toHaveBeenCalledOnce();
  });

  it("preserves leading system messages verbatim", async () => {
    const summarizer = vi.fn(async () => "summary");
    const messages: ChatTurn[] = [
      { role: "system", content: "you are an architect" },
      ...Array.from({ length: 6 }, (_, i) => bigTurn(i % 2 === 0 ? "user" : "assistant", 1_000)),
    ];
    const r = await compactMessages(messages, { thresholdTokens: 100, summarizer });
    expect(r.after[0]).toEqual({ role: "system", content: "you are an architect" });
    expect(r.after[1]!.role).toBe("system");
    expect(r.after[1]!.content).toContain("Compacted summary");
  });

  it("preserves order: head → summary → tail", async () => {
    const summarizer = vi.fn(async () => "S");
    const messages: ChatTurn[] = Array.from({ length: 10 }, (_, i) => bigTurn("user", 800 + i));
    const r = await compactMessages(messages, { thresholdTokens: 100, summarizer });
    // Last (verbatim) message must equal the original last message.
    expect(r.after[r.after.length - 1]).toEqual(messages[messages.length - 1]);
    expect(r.after[0]!.role).toBe("system");
  });

  it("uses the default summarizer when none supplied", async () => {
    const messages: ChatTurn[] = Array.from({ length: 10 }, (_, i) => bigTurn("user", 1_000 + i));
    const r = await compactMessages(messages, { thresholdTokens: 100 });
    expect(r.summarizedTurns).toBeGreaterThan(0);
    expect(r.after[0]!.content).toContain("Compacted summary");
  });
});
