/**
 * #1238 — an Anthropic stream that drops after `message_start` has already
 * been billed for its prompt. The adapter yields `usage` only after
 * `finalMessage()`, which a dropped stream never reaches, so the usage the
 * provider DID report (on `message_start`, then cumulatively on
 * `message_delta`) rides on the thrown error for the caller to meter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const streamSpy = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: vi.fn(), stream: streamSpy };
    models = { list: vi.fn() };
  }
  return { default: FakeAnthropic };
});

import { AnthropicProvider } from "./anthropic-provider.js";
import { partialUsageOf } from "../partial-usage.js";
import type { ChatChunk } from "../types.js";

const MESSAGES = [{ role: "user" as const, content: "hi" }];

const messageStart = {
  type: "message_start",
  message: {
    usage: {
      input_tokens: 20_633,
      output_tokens: 1,
      cache_read_input_tokens: 4_000,
      cache_creation_input_tokens: 120,
    },
  },
};
const textDelta = (text: string) => ({
  type: "content_block_delta",
  delta: { type: "text_delta", text },
});

/** A stream handle that yields `events`, then throws `terminated`. */
function droppingHandle(events: unknown[]) {
  return {
    controller: { abort: vi.fn() },
    finalMessage: vi.fn(async () => {
      throw new Error("finalMessage must not be reached on a dropped stream");
    }),
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
      throw new Error("terminated");
    },
  };
}

async function drain(events: unknown[]): Promise<{ chunks: ChatChunk[]; err: unknown }> {
  streamSpy.mockReturnValue(droppingHandle(events));
  return collectUntilThrow();
}

/** Drain the stream set up on `streamSpy`, expecting it to throw. */
async function collectUntilThrow(): Promise<{ chunks: ChatChunk[]; err: unknown }> {
  const chunks: ChatChunk[] = [];
  try {
    for await (const c of new AnthropicProvider({ apiKey: "k" }).stream(MESSAGES, {})) {
      chunks.push(c);
    }
  } catch (err) {
    return { chunks, err };
  }
  throw new Error("expected the stream to throw");
}

beforeEach(() => streamSpy.mockReset());

describe("AnthropicProvider.stream — #1238 usage of a stream that drops", () => {
  it("carries message_start's usage on the error when the stream drops after it", async () => {
    const { chunks, err } = await drain([messageStart, textDelta("The answer")]);
    expect((err as Error).message).toMatch(/terminated/);
    // No usage chunk was yielded: an early one would be summed by consumers
    // that meter every usage chunk they see.
    expect(chunks.some((c) => c.type === "usage")).toBe(false);
    expect(partialUsageOf(err)).toEqual({
      promptTokens: 20_633,
      completionTokens: 1,
      totalTokens: 20_634,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 120,
    });
  });

  it("takes the output count from the latest message_delta (it is cumulative)", async () => {
    const { err } = await drain([
      messageStart,
      textDelta("a"),
      { type: "message_delta", delta: {}, usage: { output_tokens: 57 } },
      textDelta("b"),
    ]);
    expect(partialUsageOf(err)).toMatchObject({
      promptTokens: 20_633,
      completionTokens: 57,
      totalTokens: 20_690,
    });
  });

  it("carries nothing when the stream drops before message_start", async () => {
    const { err } = await drain([]);
    expect((err as Error).message).toMatch(/terminated/);
    expect(partialUsageOf(err)).toBeUndefined();
  });

  it("carries nothing on a failure AFTER the final usage chunk was yielded (no double count)", async () => {
    // The final message's content fails to read only AFTER the usage chunk is
    // out (reading its reasoning blocks, which follows the usage yield), so
    // the adapter's catch runs with the call's usage already delivered.
    const content = Object.assign([{ type: "text", text: "x" }], {
      some: () => {
        throw new Error("terminated");
      },
    });
    streamSpy.mockReturnValue({
      controller: { abort: vi.fn() },
      finalMessage: vi.fn(async () => ({
        content,
        usage: { input_tokens: 5, output_tokens: 7 },
      })),
      async *[Symbol.asyncIterator]() {
        yield messageStart;
        yield textDelta("x");
      },
    });
    const { chunks, err } = await collectUntilThrow();
    expect(chunks.filter((c) => c.type === "usage")).toHaveLength(1);
    expect((err as Error).message).toMatch(/terminated/);
    expect(partialUsageOf(err)).toBeUndefined();
  });

  it("carries nothing on a stream that completed (its usage was yielded)", async () => {
    streamSpy.mockReturnValue({
      controller: { abort: vi.fn() },
      finalMessage: vi.fn(async () => ({
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: 5, output_tokens: 7 },
      })),
      async *[Symbol.asyncIterator]() {
        yield messageStart;
        yield textDelta("x");
      },
    });
    const chunks: ChatChunk[] = [];
    for await (const c of new AnthropicProvider({ apiKey: "k" }).stream(MESSAGES, {})) {
      chunks.push(c);
    }
    expect(chunks.filter((c) => c.type === "usage")).toHaveLength(1);
  });
});
