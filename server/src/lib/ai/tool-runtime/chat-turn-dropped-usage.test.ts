/**
 * #1238 — a chat model call retried after its stream dropped (#1139) used to
 * leave the dropped attempt's tokens out of the usage ledger: the attempt threw
 * before `onUsage` ran. What the provider reported for it is now metered —
 * once — and a dropped attempt with nothing reported is said to be unmetered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: {
    aIToolApproval: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findFirst: vi.fn(async () => null),
    },
  },
}));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));

const streamSpy = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: vi.fn(), stream: streamSpy };
    models = { list: vi.fn() };
  }
  return { default: FakeAnthropic };
});

import { ApprovalGateService } from "../approval-policy.js";
import { AnthropicProvider } from "../providers/anthropic-provider.js";
import { attachPartialUsage } from "../partial-usage.js";
import type { ChatMessage, ChatOptions, ChatResponse, TokenUsage } from "../types.js";
import { runChatToolTurn, type UnmeteredAttempt } from "./chat-turn.js";
import { collectStream } from "./stream-collect.js";
import { makeToolset } from "./toolset.js";

const CTX = { sessionId: "s1", userId: "alice", projectId: "p1" };
const noWait = async () => undefined;

function gate(): ApprovalGateService {
  return new ApprovalGateService({
    sessionId: CTX.sessionId,
    userId: CTX.userId,
    policy: { low: "auto", medium: "auto", high: "auto" },
    persist: false,
  });
}

const textDelta = (text: string) => ({
  type: "content_block_delta",
  delta: { type: "text_delta", text },
});

/** The SDK handle of an attempt that drops after `message_start` (or before it). */
function dropping(afterMessageStart: boolean) {
  return {
    controller: { abort: vi.fn() },
    finalMessage: vi.fn(),
    async *[Symbol.asyncIterator]() {
      if (afterMessageStart) {
        yield {
          type: "message_start",
          message: {
            usage: { input_tokens: 20_633, output_tokens: 1, cache_read_input_tokens: 0 },
          },
        };
      }
      yield textDelta("The answer");
      throw new Error("terminated");
    },
  };
}

/** The SDK handle of an attempt that completes. */
function completing() {
  return {
    controller: { abort: vi.fn() },
    finalMessage: vi.fn(async () => ({
      content: [{ type: "text", text: "The answer is 42." }],
      model: "claude-x",
      stop_reason: "end_turn",
      usage: { input_tokens: 20_633, output_tokens: 9 },
    })),
    async *[Symbol.asyncIterator]() {
      yield textDelta("The answer is 42.");
    },
  };
}

/** The /stream route's native model call: the real adapter, collected. */
function streamingCaller() {
  const provider = new AnthropicProvider({ apiKey: "k" });
  return {
    provider,
    callModel: (m: ChatMessage[], o: ChatOptions): Promise<ChatResponse> =>
      collectStream(provider.stream(m, o), { provider: "anthropic", model: "claude-x" }),
  };
}

async function turn(opts: {
  onUsage: (u: TokenUsage) => void;
  onUnmeteredAttempt?: (a: UnmeteredAttempt) => void;
}) {
  const { provider, callModel } = streamingCaller();
  return runChatToolTurn(
    provider,
    {
      messages: [{ role: "user", content: "what is the answer?" }],
      toolset: makeToolset([]),
      native: true,
      ctx: CTX,
      gate: gate(),
    },
    { callModel, retrySleep: noWait, ...opts },
  );
}

beforeEach(() => streamSpy.mockReset());

describe("runChatToolTurn — #1238 the dropped attempt's tokens", () => {
  it("meters an Anthropic stream that dropped after message_start, then the retry", async () => {
    streamSpy.mockReturnValueOnce(dropping(true)).mockReturnValueOnce(completing());
    const metered: TokenUsage[] = [];
    const unmetered = vi.fn();
    const out = await turn({ onUsage: (u) => metered.push(u), onUnmeteredAttempt: unmetered });

    expect(out.finalResponse).toBe("The answer is 42.");
    expect(streamSpy).toHaveBeenCalledTimes(2);
    // Each attempt once, in order: the dropped one, then the retry.
    expect(metered.map((u) => [u.promptTokens, u.completionTokens])).toEqual([
      [20_633, 1],
      [20_633, 9],
    ]);
    expect(unmetered).not.toHaveBeenCalled();
    // The turn's usage is the sum of what was metered — never counted twice.
    expect(out.usage).toMatchObject({
      promptTokens: 41_266,
      completionTokens: 10,
      totalTokens: 41_276,
    });
    expect(out.droppedUsage).toMatchObject({ promptTokens: 20_633, completionTokens: 1 });
  });

  it("says a dropped attempt could not be metered when the provider reported nothing", async () => {
    streamSpy.mockReturnValueOnce(dropping(false)).mockReturnValueOnce(completing());
    const metered: TokenUsage[] = [];
    const unmetered: UnmeteredAttempt[] = [];
    const out = await turn({
      onUsage: (u) => metered.push(u),
      onUnmeteredAttempt: (a) => unmetered.push(a),
    });

    // Nothing invented: only the retry's reported usage is metered.
    expect(metered).toHaveLength(1);
    expect(out.usage).toMatchObject({ promptTokens: 20_633, completionTokens: 9 });
    expect(out.droppedUsage).toBeUndefined();
    expect(unmetered).toEqual([{ attempt: 1, errorClass: "stream-terminated" }]);
  });

  it("meters both dropped attempts when the retry drops too (the turn fails)", async () => {
    streamSpy.mockReturnValueOnce(dropping(true)).mockReturnValueOnce(dropping(true));
    const metered: TokenUsage[] = [];
    await expect(turn({ onUsage: (u) => metered.push(u) })).rejects.toThrow(/terminated/);
    expect(metered.map((u) => u.promptTokens)).toEqual([20_633, 20_633]);
  });

  it("a throwing listener does not change the turn's outcome", async () => {
    streamSpy.mockReturnValueOnce(dropping(false)).mockReturnValueOnce(completing());
    const out = await turn({
      onUsage: () => {
        throw new Error("listener");
      },
      onUnmeteredAttempt: () => {
        throw new Error("listener");
      },
    });
    expect(out.finalResponse).toBe("The answer is 42.");
  });

  it("does not report a failure that never reached the provider as unmetered", async () => {
    const unmetered = vi.fn();
    const err = Object.assign(new Error("anthropic stream failed (BadRequestError): 400"), {
      status: 400,
    });
    await expect(
      runChatToolTurn(
        streamingCaller().provider,
        {
          messages: [{ role: "user", content: "q" }],
          toolset: makeToolset([]),
          native: true,
          ctx: CTX,
          gate: gate(),
        },
        {
          callModel: async () => {
            throw err;
          },
          retrySleep: noWait,
          onUnmeteredAttempt: unmetered,
        },
      ),
    ).rejects.toBe(err);
    expect(unmetered).not.toHaveBeenCalled();
  });
});

/** An attempt that drops after `message_start` and then a `message_delta` carrying `delta`. */
function droppingAfterDelta(start: Record<string, unknown>, delta: Record<string, unknown>) {
  return {
    controller: { abort: vi.fn() },
    finalMessage: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { usage: start } };
      yield textDelta("The answer");
      yield { type: "message_delta", usage: delta };
      throw new Error("terminated");
    },
  };
}

describe("runChatToolTurn — #1273 the #1238 review's untested guards", () => {
  it("a message_delta whose usage fields are null keeps message_start's counts", async () => {
    // The SDK types allow `input_tokens: null` in a message_delta; spread
    // as-is it would zero the prompt count message_start reported.
    streamSpy
      .mockReturnValueOnce(
        droppingAfterDelta(
          { input_tokens: 20_633, output_tokens: 1, cache_read_input_tokens: 300 },
          { input_tokens: null, cache_read_input_tokens: null, output_tokens: 7 },
        ),
      )
      .mockReturnValueOnce(completing());
    const metered: TokenUsage[] = [];
    await turn({ onUsage: (u) => metered.push(u) });
    expect(metered[0]).toMatchObject({
      promptTokens: 20_633,
      completionTokens: 7,
      cacheReadTokens: 300,
    });
  });

  it("a dropped attempt that reported only cache tokens is metered, not called unmetered", async () => {
    // Every prompt token served from the cache: totalTokens is 0, yet the
    // provider billed the cache read.
    streamSpy
      .mockReturnValueOnce(
        droppingAfterDelta(
          { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 18_000 },
          { output_tokens: 0 },
        ),
      )
      .mockReturnValueOnce(completing());
    const metered: TokenUsage[] = [];
    const unmetered = vi.fn();
    const out = await turn({ onUsage: (u) => metered.push(u), onUnmeteredAttempt: unmetered });
    expect(metered).toHaveLength(2);
    expect(metered[0]).toMatchObject({ totalTokens: 0, cacheReadTokens: 18_000 });
    expect(unmetered).not.toHaveBeenCalled();
    expect(out.droppedUsage).toMatchObject({ cacheReadTokens: 18_000 });
  });
});

describe("runChatToolTurn — #1273 attempts the adapter retried inside one chat() call", () => {
  /** A model call whose adapter retried each of `retried` (dropped attempts) before answering. */
  function adapterRetrying(retried: unknown[]) {
    return async (_m: ChatMessage[], o: ChatOptions): Promise<ChatResponse> => {
      retried.forEach((error, i) =>
        o.onRetriedAttempt?.({
          attempt: i + 1,
          errorClass: "stream-terminated",
          error,
          provider: "openai",
          model: "gpt-4.1",
        }),
      );
      return {
        content: "The answer is 42.",
        usage: { promptTokens: 100, completionTokens: 9, totalTokens: 109 },
        model: "gpt-4.1",
        provider: "openai",
      };
    };
  }

  function adapterTurn(
    retried: unknown[],
    opts: { onUsage: (u: TokenUsage) => void; onUnmeteredAttempt?: (a: UnmeteredAttempt) => void },
  ) {
    return runChatToolTurn(
      streamingCaller().provider,
      {
        messages: [{ role: "user", content: "what is the answer?" }],
        toolset: makeToolset([]),
        native: true,
        ctx: CTX,
        gate: gate(),
      },
      { callModel: adapterRetrying(retried), retrySleep: noWait, ...opts },
    );
  }

  it("records each retried attempt that reported no usage as unmetered, once", async () => {
    const metered: TokenUsage[] = [];
    const unmetered: UnmeteredAttempt[] = [];
    const out = await adapterTurn([new TypeError("terminated"), new TypeError("terminated")], {
      onUsage: (u) => metered.push(u),
      onUnmeteredAttempt: (a) => unmetered.push(a),
    });
    expect(unmetered).toEqual([
      { attempt: 1, errorClass: "stream-terminated", retriedBy: "adapter" },
      { attempt: 2, errorClass: "stream-terminated", retriedBy: "adapter" },
    ]);
    // Nothing estimated: only the completed attempt is metered.
    expect(metered).toHaveLength(1);
    expect(out.usage).toMatchObject({ promptTokens: 100, completionTokens: 9 });
    expect(out.droppedUsage).toBeUndefined();
  });

  it("meters a retried attempt on the usage its provider reported, once, into the turn's usage", async () => {
    const dropped = attachPartialUsage(new TypeError("terminated"), {
      promptTokens: 100,
      completionTokens: 3,
      totalTokens: 103,
    });
    const metered: TokenUsage[] = [];
    const unmetered = vi.fn();
    const out = await adapterTurn([dropped], {
      onUsage: (u) => metered.push(u),
      onUnmeteredAttempt: unmetered,
    });
    expect(metered.map((u) => u.totalTokens)).toEqual([103, 109]);
    expect(unmetered).not.toHaveBeenCalled();
    expect(out.usage).toMatchObject({ promptTokens: 200, completionTokens: 12, totalTokens: 212 });
    expect(out.droppedUsage).toMatchObject({ totalTokens: 103 });
  });
});
