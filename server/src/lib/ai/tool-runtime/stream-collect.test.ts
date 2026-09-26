/**
 * #128 review — a streamed local model call must give its concurrency slot back
 * when the reader stops at `done`, through the SAME composition the /stream
 * route uses (the idle guard around the provider stream).
 *
 * Falsifiable: before the fix `withIdleTimeout` only called the source's
 * `return()` on an idle timeout, so a reader that stopped early left the
 * provider's `finally { conn.release() }` unrun and `inFlight` stuck at 1 — with
 * the default limit of 1, every later local call on that base URL then hangs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import {
  localConcurrencyLimiter,
  resetLocalConcurrencyLimitersForTests,
} from "../providers/local-concurrency-limiter.js";
import { withIdleTimeout } from "../stream-idle.js";
import type { ChatChunk } from "../types.js";
import { collectGuardedStream, collectStream } from "./stream-collect.js";

const BASE = "http://127.0.0.1:11434/v1";
const MODEL = "gemma3:12b";
const originalFetch = globalThis.fetch;

function sse(frames: unknown[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200 },
  );
}

function localProvider(): OpenAICompatibleProvider {
  globalThis.fetch = vi.fn(async () =>
    sse([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]),
  ) as unknown as typeof fetch;
  return new OpenAICompatibleProvider({
    baseUrl: BASE,
    apiKey: "ollama",
    model: MODEL,
    providerKey: "local-gemma",
    maxAttempts: 1,
    sleepFn: async () => undefined,
  });
}

/** Let the provider's `finally` (queued behind `return()`) run. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("streamed local calls release their slot (#128 review)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetLocalConcurrencyLimitersForTests();
  });

  it("collectGuardedStream (the native tool turn's model call) frees the slot", async () => {
    resetLocalConcurrencyLimitersForTests();
    const limiter = localConcurrencyLimiter(BASE);
    const provider = localProvider();
    const r = await collectGuardedStream(provider.stream([{ role: "user", content: "x" }], {}), {
      provider: provider.key,
      model: MODEL,
      idleMs: 60_000,
    });
    expect(r.content).toBe("hi");
    await settle();
    expect(limiter.inFlight).toBe(0);
  });

  it("a second call on the same base URL is not starved (default limit 1)", async () => {
    resetLocalConcurrencyLimitersForTests();
    const limiter = localConcurrencyLimiter(BASE);
    const provider = localProvider();
    const turn = () =>
      collectGuardedStream(provider.stream([{ role: "user", content: "x" }], {}), {
        provider: provider.key,
        model: MODEL,
        idleMs: 60_000,
      });
    await turn();
    const second = await Promise.race([
      turn().then((r) => r.content),
      new Promise((r) => setTimeout(() => r("starved"), 500)),
    ]);
    expect(second).toBe("hi");
    await settle();
    expect(limiter.inFlight).toBe(0);
  });

  it("the plain /stream loop (for-await, break on done) over the guard frees the slot", async () => {
    resetLocalConcurrencyLimitersForTests();
    const limiter = localConcurrencyLimiter(BASE);
    const provider = localProvider();
    const seen: string[] = [];
    for await (const chunk of withIdleTimeout(
      provider.stream([{ role: "user", content: "x" }], {}),
      60_000,
    )) {
      const c = chunk as ChatChunk;
      seen.push(c.type);
      if (c.type === "done") break;
    }
    expect(seen.at(-1)).toBe("done");
    await settle();
    expect(limiter.inFlight).toBe(0);
  });

  it("collectStream keeps only native tool calls and the done chunk's metadata", async () => {
    async function* chunks(): AsyncGenerator<ChatChunk> {
      yield { type: "delta", content: "a" };
      yield { type: "tool_call", name: "prose", arguments: {} };
      yield {
        type: "tool_call",
        name: "real",
        arguments: { q: 1 },
        native: true,
        toolCallId: "c1",
      };
      yield { type: "usage", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
      yield { type: "done", finishReason: "tool_calls" };
      yield { type: "delta", content: "never read" };
    }
    const deltas: string[] = [];
    const r = await collectStream(chunks(), {
      provider: "local-gemma",
      model: MODEL,
      onDelta: (t) => deltas.push(t),
    });
    expect(r).toMatchObject({
      content: "a",
      finishReason: "tool_calls",
      toolCalls: [{ id: "c1", name: "real", args: { q: 1 } }],
      usage: { totalTokens: 3 },
    });
    expect(deltas).toEqual(["a"]);
  });
});
