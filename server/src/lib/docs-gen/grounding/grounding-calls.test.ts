/**
 * #246 / #180 / #247 — what the grounding calls (claim extraction and the
 * faithfulness judge) do per provider call: retry transient failures, report
 * usage once per call that answered, and send `disableThinking` when asked.
 */
import { describe, expect, it, vi } from "vitest";
import { AIProviderError } from "../../ai/errors.js";
import type { AIProvider, ChatOptions, ChatResponse } from "../../ai/types.js";
import { ClaimExtractor } from "./claim-extractor.js";
import { FaithfulnessJudge } from "./faithfulness-judge.js";
import { buildGroundingContext } from "./grounding-context.js";
import type { GroundingUsageEvent } from "./grounding-usage.js";

const ctx = buildGroundingContext({
  factsSources: [{ moduleDir: "billing", idx: 0, label: "Billing", text: "Invoices are weekly." }],
});
const CLAIM = "Invoices are weekly.";
const claimsReply = JSON.stringify({ claims: [{ claim: CLAIM, sourceIds: [] }] });
const verdictsReply = JSON.stringify({
  verdicts: [{ claim: CLAIM, supported: true, sourceIds: [] }],
});

const reply = (content: string, over: Partial<ChatResponse> = {}): ChatResponse => ({
  content,
  usage: {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 7,
    cacheWriteTokens: 3,
  },
  model: "grounding-model",
  provider: "anthropic",
  ...over,
});

function provider(chat: (opts: ChatOptions) => Promise<ChatResponse>): AIProvider & {
  chat: ReturnType<typeof vi.fn>;
} {
  return {
    key: "anthropic",
    model: "section-model",
    offline: false,
    chat: vi.fn(async (_m: unknown, opts: ChatOptions = {}) => chat(opts)),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
  } as unknown as AIProvider & { chat: ReturnType<typeof vi.fn> };
}

const noSleep = { sleep: async () => {} };
const terminated = () => new AIProviderError("anthropic chat failed (TypeError): terminated", 502);

describe("#247 disableThinking on the grounding calls", () => {
  it("claim extraction sends disableThinking only when configured", async () => {
    const p = provider(async () => reply(claimsReply));
    await new ClaimExtractor({ provider: p, disableThinking: true }).decompose(CLAIM, ctx);
    expect(p.chat.mock.calls[0][1]).toMatchObject({ disableThinking: true, disableTools: true });
    await new ClaimExtractor({ provider: p }).decompose(CLAIM, ctx);
    expect(p.chat.mock.calls[1][1]).not.toHaveProperty("disableThinking");
  });

  it("the judge sends disableThinking only when configured", async () => {
    const p = provider(async () => reply(verdictsReply));
    await new FaithfulnessJudge({ provider: p, disableThinking: true }).judge([CLAIM], ctx);
    expect(p.chat.mock.calls[0][1]).toMatchObject({ disableThinking: true });
    await new FaithfulnessJudge({ provider: p }).judge([CLAIM], ctx);
    expect(p.chat.mock.calls[1][1]).not.toHaveProperty("disableThinking");
  });
});

describe("#246 transient failures on the grounding calls", () => {
  it("claim extraction retries a dropped stream and then parses the answer", async () => {
    let n = 0;
    const p = provider(async () => {
      if (n++ === 0) throw terminated();
      return reply(claimsReply);
    });
    const out = await new ClaimExtractor({ provider: p, retry: noSleep }).decompose(CLAIM, ctx);
    expect(out.claims).toEqual([{ claim: CLAIM, sourceIds: [] }]);
    expect(p.chat).toHaveBeenCalledTimes(2);
  });

  it("the judge retries a 529 and then scores", async () => {
    let n = 0;
    const p = provider(async () => {
      if (n++ === 0) throw new AIProviderError("overloaded", 529);
      return reply(verdictsReply);
    });
    const out = await new FaithfulnessJudge({ provider: p, retry: noSleep }).judge([CLAIM], ctx);
    expect(out).toEqual([{ claim: CLAIM, supported: true, sourceIds: [] }]);
    expect(p.chat).toHaveBeenCalledTimes(2);
  });

  it("a 4xx is thrown at once, never retried", async () => {
    const p = provider(async () => {
      throw new AIProviderError("invalid model", 400);
    });
    await expect(
      new FaithfulnessJudge({ provider: p, retry: noSleep }).judge([CLAIM], ctx),
    ).rejects.toMatchObject({ status: 400 });
    expect(p.chat).toHaveBeenCalledTimes(1);
  });

  it("a stream that keeps dropping is thrown after the bounded tries", async () => {
    const p = provider(async () => {
      throw terminated();
    });
    await expect(
      new ClaimExtractor({ provider: p, retry: { ...noSleep, attempts: 3 } }).decompose(CLAIM, ctx),
    ).rejects.toThrow("terminated");
    expect(p.chat).toHaveBeenCalledTimes(3);
  });
});

describe("#180 usage of the grounding calls", () => {
  it("reports every call that answered — once each, not the failed tries", async () => {
    const events: GroundingUsageEvent[] = [];
    let n = 0;
    const p = provider(async () => {
      if (n++ === 0) throw terminated(); // no response, nothing to bill
      return reply(claimsReply);
    });
    await new ClaimExtractor({
      provider: p,
      model: "claim-model",
      retry: noSleep,
      onUsage: (e) => events.push(e),
    }).decompose(CLAIM, ctx);
    expect(events).toEqual([
      {
        stage: "claims",
        provider: "anthropic",
        model: "grounding-model",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
      },
    ]);
  });

  it("bills a judge reply that did not parse as well as its retry", async () => {
    const events: GroundingUsageEvent[] = [];
    let n = 0;
    const p = provider(async () => reply(n++ === 0 ? "not json" : verdictsReply));
    await new FaithfulnessJudge({ provider: p, onUsage: (e) => events.push(e) }).judge(
      [CLAIM],
      ctx,
    );
    expect(p.chat).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.stage)).toEqual(["verdicts", "verdicts"]);
  });

  it("bills a claim reply cut off at the cap, and each half it was split into", async () => {
    const events: GroundingUsageEvent[] = [];
    const passage = Array.from({ length: 4 }, (_, i) => `Paragraph ${i} ${"x".repeat(300)}.`).join(
      "\n\n",
    );
    let n = 0;
    const p = provider(async () =>
      n++ === 0 ? reply('{"claims":[', { finishReason: "length" }) : reply(claimsReply),
    );
    await new ClaimExtractor({ provider: p, onUsage: (e) => events.push(e) }).decompose(
      passage,
      ctx,
    );
    expect(p.chat.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(events).toHaveLength(p.chat.mock.calls.length);
  });

  it("falls back to the requested model and the provider key when the reply names none", async () => {
    const events: GroundingUsageEvent[] = [];
    const p = provider(async () =>
      reply(claimsReply, { model: "", provider: "" as ChatResponse["provider"] }),
    );
    await new ClaimExtractor({
      provider: p,
      model: "claim-model",
      onUsage: (e) => events.push(e),
    }).decompose(CLAIM, ctx);
    expect(events[0]).toMatchObject({ provider: "anthropic", model: "claim-model" });
  });

  it("reports nothing for a reply that carries no tokens", async () => {
    const onUsage = vi.fn();
    const p = provider(async () =>
      reply(claimsReply, { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
    );
    await new ClaimExtractor({ provider: p, onUsage }).decompose(CLAIM, ctx);
    expect(onUsage).not.toHaveBeenCalled();
  });
});
