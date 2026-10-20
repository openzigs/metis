/**
 * Issue #389 — scope `promptCaching.messages` to MULTI-CALL pipelines only.
 *
 * Bedrock/Anthropic prompt caching charges a WRITE premium to populate a
 * message-level cache entry. That premium only pays off when the SAME message
 * payload is replayed across MULTIPLE provider calls (a later cache READ
 * amortises the write). For genuinely single-shot calls — one unique user
 * payload, one response, never reused — the message cache write is wasted
 * spend.
 *
 * This suite locks the contract on both sides of that line:
 *   • SINGLE-SHOT doc-gen calls (Phase-1 fact extraction, Phase-2 section
 *     generation) request `system` caching ONLY — never `messages`. Both call
 *     sites now route their directive through `singleShotPromptCaching`, so
 *     asserting that helper's output IS asserting the wire shape.
 *   • The grounding claim-extractor + faithfulness-judge (#1277) request
 *     `system` caching ONLY as well. Each call's user turn is unique — the
 *     claim extractor's passage, and since #171 the judge's per-batch
 *     evidence — so a `messages` breakpoint cached the whole prompt and was
 *     never read back: the dev ledger had 553k Haiku and 321k Sonnet
 *     grounding cache-write tokens against 0 and 8k read.
 *
 * The agentic analysis loop (also multi-call) is covered separately by
 * `../analysis/agent-loop-caching.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { singleShotPromptCaching } from "./holistic-synthesizer.js";
import { ClaimExtractor } from "./grounding/claim-extractor.js";
import { FaithfulnessJudge } from "./grounding/faithfulness-judge.js";
import { buildGroundingContext } from "./grounding/grounding-context.js";
import type { AIProvider, ChatOptions, ChatResponse } from "../ai/types.js";

/** Provider stub that captures the options of the most recent `chat` call. */
function mockProvider(content: string): AIProvider {
  const response: ChatResponse = {
    content,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "mock",
    provider: "offline-stub",
  };
  return {
    key: "offline-stub",
    model: "mock",
    offline: false,
    chat: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
  } as unknown as AIProvider;
}

function lastChatOptions(provider: AIProvider): ChatOptions | undefined {
  const calls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
  return calls.at(-1)?.[1];
}

describe("singleShotPromptCaching (#389)", () => {
  it("requests system caching ONLY — no message-level cache write — when supported", () => {
    const directive = singleShotPromptCaching(true);
    expect(directive).toEqual({ system: true });
    // The whole point of #389: a single-shot call must NOT emit `messages`.
    expect(directive).not.toHaveProperty("messages");
    // System caching is preserved everywhere it exists today.
    expect(directive?.system).toBe(true);
  });

  it("is a no-op (undefined) when the provider does not support caching", () => {
    // Matches the previous `... : undefined` call shape so non-caching
    // providers (e.g. local Gemma) send no caching directive at all.
    expect(singleShotPromptCaching(false)).toBeUndefined();
  });

  it("never sets messages:true under any input (the regression #389 guards)", () => {
    for (const supported of [true, false]) {
      // Widened on purpose: the runtime check guards a field the type already excludes.
      const directive: { system?: true; messages?: unknown } | undefined =
        singleShotPromptCaching(supported);
      expect(directive?.messages).toBeUndefined();
    }
  });
});

describe("grounding pipeline caches the system prompt only (#1277)", () => {
  const ctx = buildGroundingContext({
    factsSources: [
      {
        moduleDir: "billing",
        idx: 0,
        label: "Billing",
        text: "Invoices over 1000 require manager approval. Refunds are processed weekly.",
      },
    ],
  });

  it("ClaimExtractor never asks for a message-level cache write", async () => {
    // Every passage is decomposed once, so the user turn never repeats: a
    // `messages` breakpoint paid the write surcharge on all of it, unread.
    const provider = mockProvider(JSON.stringify({ claims: [] }));
    const extractor = new ClaimExtractor({ provider, promptCaching: true });

    await extractor.decompose("Invoices over 1000 require approval.", ctx);

    expect(lastChatOptions(provider)?.promptCaching).toEqual({ system: true });
  });

  it("FaithfulnessJudge never asks for a message-level cache write", async () => {
    const provider = mockProvider(
      JSON.stringify({ verdicts: [{ claim: "c", supported: true, sourceIds: [] }] }),
    );
    const judge = new FaithfulnessJudge({ provider, promptCaching: true });

    await judge.judge(["Invoices over 1000 require approval."], ctx);

    expect(lastChatOptions(provider)?.promptCaching).toEqual({ system: true });
  });
});
