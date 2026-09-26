/**
 * #138 — transcript compaction: planning, batching, persistence and the ways it
 * must refuse to lose content.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeAiMessageRow } from "../../../tests/helpers/fake-ai-message.js";

const rows = vi.hoisted(() => [] as FakeAiMessageRow[]);
const sessionUpdates = vi.hoisted(() => [] as unknown[]);
vi.mock("../prisma.js", async () => {
  const { createFakeAiMessageDelegate } = await import("../../../tests/helpers/fake-ai-message.js");
  const prisma: Record<string, unknown> = {
    aIMessage: createFakeAiMessageDelegate(rows),
    aISession: { update: vi.fn(async (a: unknown) => sessionUpdates.push(a)) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { prisma };
});
const aiRecord = vi.hoisted(() => vi.fn());
const projectRecord = vi.hoisted(() => vi.fn());
vi.mock("../ai/token-tracker.js", () => ({ getTokenTracker: () => ({ record: aiRecord }) }));
vi.mock("../finops/token-tracker.js", () => ({ recordUsage: projectRecord }));

const {
  batchForSummary,
  compactTranscript,
  CompactionError,
  COMPACTION_SYSTEM_PROMPT,
  groupTurns,
  planCompaction,
  providerSummarizer,
} = await import("./compaction.js");
const { appendMessage, listActiveMessages, listMessages } =
  await import("../ai/conversation/transcript-store.js");
import type { AIProvider, ChatMessage, ChatOptions } from "../ai/types.js";

const ratio = { charsPerToken: 1, source: "default" as const };
const build = { toolResultMaxChars: 10_000 };
const window = { tokens: 1_000, source: "catalog" as const };

async function seed(sessionId: string, turns: number, size = 100) {
  for (let i = 0; i < turns; i++) {
    await appendMessage(sessionId, {
      role: "user",
      parts: [{ type: "text", text: `q${i} ${"x".repeat(size)}` }],
      estimatedTokens: size,
    });
    await appendMessage(sessionId, {
      role: "assistant",
      parts: [{ type: "text", text: `a${i} ${"y".repeat(size)}` }],
      estimatedTokens: size,
    });
  }
  return listActiveMessages(sessionId);
}

beforeEach(() => {
  rows.length = 0;
  sessionUpdates.length = 0;
  aiRecord.mockReset();
  projectRecord.mockReset();
});

const meter = { sessionId: "s1", userId: "u1", projectId: "p1" };

describe("groupTurns / planCompaction", () => {
  it("groups a user row with the replies after it", async () => {
    const active = await seed("s", 3, 10);
    expect(groupTurns(active).map((g) => g.map((r) => r.ordinal))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("keeps whole newest turns that fit the budget and folds the rest", async () => {
    const active = await seed("s", 4, 100); // ~ (104+4)*2 = 216 tokens per turn
    const plan = planCompaction(active, { ratio, tailBudgetTokens: 450, keepMinTurns: 0 })!;
    expect(plan.keep.map((r) => r.ordinal)).toEqual([5, 6, 7, 8]);
    expect(plan.fold.map((r) => r.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it("returns null when everything fits, and forces the newest turn kept", async () => {
    const active = await seed("s", 2, 10);
    expect(planCompaction(active, { ratio, tailBudgetTokens: 10_000, keepMinTurns: 0 })).toBeNull();
    const forced = planCompaction(active, { ratio, tailBudgetTokens: 0, keepMinTurns: 1 })!;
    expect(forced.keep.map((r) => r.ordinal)).toEqual([3, 4]);
    expect(
      planCompaction(active.slice(2), { ratio, tailBudgetTokens: 0, keepMinTurns: 1 }),
    ).toBeNull();
  });
});

describe("batchForSummary", () => {
  it("never drops a line: an oversized one is split across batches", () => {
    const lines = ["a".repeat(2_500), "b".repeat(10), "c".repeat(10)];
    const batches = batchForSummary(lines, 1_000, ratio);
    expect(batches.join("").replace(/\n/g, "")).toBe(lines.join(""));
    expect(batches.every((b) => b.length <= 1_000)).toBe(true);
    expect(batchForSummary([""], 1_000, ratio)).toEqual([]);
  });
});

describe("compactTranscript", () => {
  it("folds the oldest turns into one summary row, marks — never deletes — them, and bumps the session", async () => {
    const active = await seed("s", 4, 100);
    const summarizer = vi.fn(async () => ({
      text: "SUM",
      usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
    }));
    const out = (await compactTranscript({
      sessionId: "s",
      activeRows: active,
      ratio,
      build,
      contextWindow: window,
      fixedTokens: 50,
      estimatedTokensBefore: 900,
      summarizer,
      provider: "anthropic",
      model: "m",
    }))!;
    expect(out.compactedMessages).toBeGreaterThan(0);
    const all = await listMessages("s");
    expect(all).toHaveLength(9);
    const summary = all.find((r) => r.kind === "summary")!;
    expect(summary).toMatchObject({ ordinal: 9, role: "system", inputTokens: 50, outputTokens: 5 });
    expect(summary.meta).toMatchObject({
      fromOrdinal: 1,
      messageCount: out.compactedMessages,
      contextWindow: 1000,
    });
    expect(all.filter((r) => r.compactedIntoId === summary.id)).toHaveLength(out.compactedMessages);
    expect(sessionUpdates).toHaveLength(1);
    expect(out.activeRows[0]!.id).toBe(summary.id);
  });

  it("a second compaction folds the previous summary in, and the coverage accumulates", async () => {
    let active = await seed("s", 4, 100);
    const summarizer = vi.fn(async ({ priorSummary }: { priorSummary: string | null }) => ({
      text: priorSummary ? `${priorSummary}+2` : "S1",
      usage: null,
    }));
    const base = {
      sessionId: "s",
      ratio,
      build,
      contextWindow: window,
      fixedTokens: 0,
      estimatedTokensBefore: 0,
      summarizer,
    };
    const first = (await compactTranscript({ ...base, activeRows: active, force: true }))!;
    active = await seed("s", 2, 100);
    active = await listActiveMessages("s");
    const second = (await compactTranscript({ ...base, activeRows: active, force: true }))!;
    expect(second.summary.meta).toMatchObject({
      fromOrdinal: 1,
      messageCount: first.compactedMessages + second.compactedMessages,
    });
    expect((await listActiveMessages("s")).filter((r) => r.kind === "summary")).toHaveLength(1);
    expect(second.summary.parts).toEqual([{ type: "text", text: "S1+2" }]);
  });

  it("refuses to fold rows into an empty summary", async () => {
    const active = await seed("s", 3, 100);
    await expect(
      compactTranscript({
        sessionId: "s",
        activeRows: active,
        ratio,
        build,
        contextWindow: window,
        fixedTokens: 0,
        estimatedTokensBefore: 0,
        force: true,
        summarizer: async () => ({ text: "  ", usage: null }),
      }),
    ).rejects.toBeInstanceOf(CompactionError);
    expect((await listMessages("s")).every((r) => r.compactedAt === null)).toBe(true);
  });

  it("keeps a summary that hit its output cap, flagged as truncated", async () => {
    const active = await seed("s", 3, 100);
    const out = (await compactTranscript({
      sessionId: "s",
      activeRows: active,
      ratio,
      build,
      contextWindow: window,
      fixedTokens: 0,
      estimatedTokensBefore: 0,
      force: true,
      summarizer: async () => ({ text: "cut", usage: null, finishReason: "length" }),
    }))!;
    expect(out.summary.meta.summaryTruncated).toBe(true);
    expect(out.summary.finishReason).toBe("length");
  });

  it("backs off when another request already compacted the same rows", async () => {
    const active = await seed("s", 3, 100);
    for (const r of rows) if (r.ordinal <= 2) r.compactedAt = new Date();
    const out = await compactTranscript({
      sessionId: "s",
      activeRows: active,
      ratio,
      build,
      contextWindow: window,
      fixedTokens: 0,
      estimatedTokensBefore: 0,
      force: true,
      summarizer: async () => ({ text: "S", usage: null }),
    });
    expect(out).toBeNull();
    expect(rows.filter((r) => r.kind === "summary")).toHaveLength(0);
  });

  it("returns null with nothing to fold", async () => {
    const active = await seed("s", 1, 10);
    expect(
      await compactTranscript({
        sessionId: "s",
        activeRows: active,
        ratio,
        build,
        contextWindow: window,
        fixedTokens: 0,
        estimatedTokensBefore: 0,
        summarizer: async () => ({ text: "S", usage: null }),
      }),
    ).toBeNull();
  });

  it("summarises in several calls when the folded turns exceed one call's budget", async () => {
    const active = await seed("s", 6, 400);
    const summarizer = vi.fn(async () => ({ text: "S", usage: null }));
    await compactTranscript({
      sessionId: "s",
      activeRows: active,
      ratio,
      build,
      contextWindow: { tokens: 2_048, source: "fallback" },
      fixedTokens: 0,
      estimatedTokensBefore: 0,
      force: true,
      summarizer,
    });
    expect(summarizer.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("providerSummarizer", () => {
  it("sends the compaction prompt with no session id, thinking off and a capped output", async () => {
    const seen: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];
    const provider = {
      chat: async (messages: ChatMessage[], opts?: ChatOptions) => {
        seen.push({ messages, opts });
        return {
          content: "S",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "m",
          provider: "openai",
          finishReason: "stop",
        };
      },
    } as unknown as AIProvider;
    const res = await providerSummarizer(provider, { model: "m", maxTokens: 77, meter })({
      priorSummary: null,
      transcript: "T",
    });
    expect(res).toMatchObject({ text: "S", finishReason: "stop" });
    expect(seen[0]!.messages[0]!.content).toBe(COMPACTION_SYSTEM_PROMPT);
    expect(seen[0]!.messages[1]!.content).toContain("Existing summary:\n(none)");
    expect(seen[0]!.opts).toMatchObject({ model: "m", maxTokens: 77, disableThinking: true });
    expect(seen[0]!.opts?.sessionId).toBeUndefined();
  });

  // PR #205 review — a summary is a model call: it must reach BOTH usage stores
  // (per-user AITokenUsage and the per-project TokenUsage budgets read), or every
  // compaction is invisible to cost tracking and budget enforcement.
  const usageProvider = (usage: unknown) =>
    ({
      chat: async () => ({
        content: "S",
        usage,
        model: "served-model",
        provider: "openai",
        finishReason: "stop",
      }),
    }) as unknown as AIProvider;

  it("records every summary call's usage in the per-user and per-project stores", async () => {
    const usage = { promptTokens: 120, completionTokens: 30, totalTokens: 150, cacheReadTokens: 5 };
    await providerSummarizer(usageProvider(usage), { model: "m", meter })({
      priorSummary: null,
      transcript: "T",
    });
    expect(aiRecord).toHaveBeenCalledTimes(1);
    expect(aiRecord.mock.calls[0]![0]).toMatchObject({
      sessionId: "s1",
      userId: "u1",
      projectId: "p1",
      provider: "openai",
      model: "served-model",
      usage,
      agentStep: "compaction",
    });
    expect(projectRecord).toHaveBeenCalledTimes(1);
    expect(projectRecord.mock.calls[0]![0]).toMatchObject({
      projectId: "p1",
      sessionId: "s1",
      provider: "openai",
      model: "served-model",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 5,
    });
  });

  it("records per-user usage but no project usage for a session outside a project", async () => {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    await providerSummarizer(usageProvider(usage), {
      model: "m",
      meter: { ...meter, projectId: null },
    })({ priorSummary: null, transcript: "T" });
    expect(aiRecord).toHaveBeenCalledTimes(1);
    expect(aiRecord.mock.calls[0]![0].projectId).toBeUndefined();
    expect(projectRecord).not.toHaveBeenCalled();
  });

  it("records each call of a multi-batch compaction, before the outcome is known", async () => {
    const provider = {
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          content: "partial",
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
          model: "m",
          provider: "openai",
        })
        .mockResolvedValue({
          content: "  ",
          usage: { promptTokens: 11, completionTokens: 0, totalTokens: 11 },
          model: "m",
          provider: "openai",
        }),
    } as unknown as AIProvider;
    const active = await seed("sb", 3, 3_000);
    await expect(
      compactTranscript({
        sessionId: "sb",
        activeRows: active,
        ratio,
        build,
        contextWindow: { tokens: 2_000, source: "catalog" },
        fixedTokens: 0,
        estimatedTokensBefore: 0,
        force: true,
        summarizer: providerSummarizer(provider, { model: "m", meter }),
      }),
    ).rejects.toBeInstanceOf(CompactionError);
    // The compaction failed, but both calls were paid for and both are recorded.
    const calls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(aiRecord).toHaveBeenCalledTimes(calls);
    expect(projectRecord).toHaveBeenCalledTimes(calls);
  });
});
