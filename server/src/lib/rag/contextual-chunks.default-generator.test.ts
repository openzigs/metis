/**
 * #2268 — the production `model` generator is project spend: each call is refused once
 * the project's monthly token budget is spent, and each reply writes a `token_usages`
 * row billed to the document. The provider and finance modules are mocked; what is
 * proven is the wiring between them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AIProvider, ChatResponse } from "../ai/types.js";

const m = vi.hoisted(() => ({
  provider: null as unknown as AIProvider,
  assertWithinBudget: vi.fn(
    async (_projectId: string): Promise<{ budget: number | null; remainingTokens: number }> => ({
      budget: null,
      remainingTokens: 0,
    }),
  ),
  recordUsage: vi.fn((_input: unknown) => ({ totalTokens: 916, persisted: Promise.resolve() })),
}));

vi.mock("../ai/project-provider.js", () => ({
  resolveProjectProvider: vi.fn(async () => m.provider),
}));
vi.mock("../finops/budget-enforcer.js", () => ({
  assertWithinBudget: m.assertWithinBudget,
}));
vi.mock("../finops/token-tracker.js", () => ({ recordUsage: m.recordUsage }));

const { CHUNK_CONTEXT_AGENT_STEP, defaultModelChunkContextGenerator } =
  await import("./contextual-chunks.js");

function reply(): ChatResponse {
  return {
    content: "Situated.",
    usage: {
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    },
    provider: "anthropic",
    model: "claude-test",
  } as ChatResponse;
}

describe("defaultModelChunkContextGenerator (#2268)", () => {
  let chat: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    chat = vi.fn(async () => reply());
    m.provider = { key: "anthropic", model: "claude-test", chat } as unknown as AIProvider;
  });

  const input = {
    projectId: "p1",
    documentId: "d1",
    document: "# Doc\n\nBody.",
    title: "Doc",
    chunks: ["a", "b"],
  };

  it("reads the project's budget once per document and writes one ledger row per reply", async () => {
    const out = await defaultModelChunkContextGenerator()(input);
    expect(out.map((c) => c?.text)).toEqual(["Situated.", "Situated."]);
    // #2355 — the budget read sums the month's ledger: once per document, not per chunk.
    expect(m.assertWithinBudget).toHaveBeenCalledTimes(1);
    expect(m.assertWithinBudget).toHaveBeenCalledWith("p1");
    expect(m.recordUsage).toHaveBeenCalledTimes(2);
    expect(m.recordUsage).toHaveBeenCalledWith({
      projectId: "p1",
      sessionId: "document:d1",
      agentStep: CHUNK_CONTEXT_AGENT_STEP,
      provider: "anthropic",
      model: "claude-test",
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
  });

  it("makes no call once the budget is spent, and the chunks keep deterministic prefixes", async () => {
    m.assertWithinBudget.mockRejectedValue(new Error("budget exceeded"));
    const out = await defaultModelChunkContextGenerator()(input);
    expect(out).toEqual([null, null]);
    expect(chat).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("stops once the ledger totals of the document's replies reach what the budget had left (#2355)", async () => {
    m.assertWithinBudget.mockResolvedValue({ budget: 10_000, remainingTokens: 900 });
    const out = await defaultModelChunkContextGenerator()({ ...input, chunks: ["a", "b", "c"] });
    // The first call runs alone; the 916 tokens its reply was billed spend the 900 left.
    expect(out.map((c) => c?.text ?? null)).toEqual(["Situated.", null, null]);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(m.assertWithinBudget).toHaveBeenCalledTimes(1);
  });
});
