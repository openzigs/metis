/**
 * P0 (#126) preservation — the local-model behaviours landed in #187 / #188
 * (and earlier) re-asserted at the NEW provider interface: every provider here
 * is built by the #134 factory (`buildProvider(loadAIConfig(env))`) and called
 * with the #131 contract options (tools, typed tool calls, per-model
 * capabilities) in play. The original unit suites still pin each behaviour on
 * the class itself; this file proves the new routing and the new options did
 * not route around any of them.
 *
 *   1. thinking-off / reasoning_effort (+ narrow classifier, per-model memory)
 *   2. per-base-URL FIFO limiter; timers start after the slot; slot released
 *   3. configurable local timeouts; AI_PING_TIMEOUT_MS
 *   4. structured output modes + 400/422 and body-matched 501 fallback
 *   5. per-family / per-phase local sampling, always sent explicitly
 *   6. output caps + truncation (finishReason) on chat and stream
 *   7. docs-gen grounding json_object mode; usage incl. cache tokens
 *   8. bedrock gateway + Anthropic-compatible (DeepSeek) + offline stub
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSpy, streamSpy } = vi.hoisted(() => ({ createSpy: vi.fn(), streamSpy: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: streamSpy };
    models = { list: vi.fn(async () => ({ data: [] })) };
    constructor(_opts: unknown) {
      /* no network */
    }
  }
  return { default: FakeAnthropic };
});

import { buildProvider } from "../../../src/lib/ai/providers/factory.js";
import { loadAIConfig } from "../../../src/lib/ai/config.js";
import {
  FirstTokenTimeoutError,
  isReasoningEffortUnsupportedBody,
  isStructuredOutputUnavailableBody,
  isTemperatureUnsupportedBody,
  resetLocalConcurrencyLimitersForTests,
} from "../../../src/lib/ai/providers/openai-compatible-provider.js";
import { __resetCacheHitAggregatorSingleton } from "../../../src/lib/ai/cache-hit-telemetry.js";
import { __resetModelCatalogForTests } from "../../../src/lib/ai/model-catalog.js";
import { resolveLocalSampling } from "../../../src/lib/docs-gen/local-sampling-defaults.js";
import { buildDocsGenProvider } from "../../../src/lib/docs-gen/holistic-synthesizer.js";
import { ClaimExtractor } from "../../../src/lib/docs-gen/grounding/claim-extractor.js";
import { JSON_OBJECT_RESPONSE_FORMAT } from "../../../src/lib/docs-gen/grounding/structured-output-schemas.js";
import type { AIProvider, ChatChunk, ChatToolSpec } from "../../../src/lib/ai/types.js";

const LOCAL_ENV = {
  AI_PROVIDER: "local-gemma",
  LOCAL_GEMMA_BASE_URL: "http://127.0.0.1:11434/v1",
  LOCAL_GEMMA_MODEL: "laguna-s-2.1",
};
const TOOLS: ChatToolSpec[] = [
  { name: "search_code", description: "search", parameters: { type: "object", properties: {} } },
];
const USER = [{ role: "user" as const, content: "hi" }];

const local = (env: NodeJS.ProcessEnv = {}): AIProvider =>
  buildProvider({ config: loadAIConfig({ ...LOCAL_ENV, ...env }) });

const originalFetch = globalThis.fetch;
let bodies: Array<Record<string, unknown>> = [];
let urls: string[] = [];

type Responder = (
  body: Record<string, unknown>,
  signal?: AbortSignal | null,
) => Response | Promise<Response>;
function stubFetch(...responders: Responder[]): void {
  bodies = [];
  urls = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    bodies.push(body);
    urls.push(String(url));
    return responders[Math.min(i++, responders.length - 1)](body, init?.signal);
  }) as unknown as typeof fetch;
}
const okJson = (content: string, finish = "stop", usage: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage }),
    {
      status: 200,
    },
  );
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
async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const ENV_KEYS = [
  "LOCAL_GEMMA_SEND_REASONING_EFFORT",
  "LOCAL_GEMMA_MAX_CONCURRENCY",
  "LOCAL_GEMMA_REQUEST_TIMEOUT_MS",
  "LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS",
  "LOCAL_GEMMA_IDLE_TIMEOUT_MS",
  "DOCS_GEN_LOCAL_TEMPERATURE",
  "DOCS_GEN_LOCAL_TOP_P",
  "DOCS_GEN_LOCAL_PHASE1_MODEL",
  "DOCS_GEN_LOCAL_PHASE2_MODEL",
  "AI_PROVIDER",
  "AI_OFFLINE",
  "LOCAL_GEMMA_BASE_URL",
  "LOCAL_GEMMA_MODEL",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  __resetModelCatalogForTests();
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetLocalConcurrencyLimitersForTests();
  __resetCacheHitAggregatorSingleton();
  createSpy.mockReset();
  streamSpy.mockReset();
});

describe("1 · local thinking-off and reasoning_effort, with tools in play", () => {
  it("disableThinking sends think:false AND reasoning_effort:'none' alongside the tools", async () => {
    stubFetch(() => okJson("x"));
    await local().chat(USER, { tools: TOOLS, disableThinking: true });
    expect(bodies[0]).toMatchObject({ think: false, reasoning_effort: "none" });
    expect(bodies[0].tools).toBeDefined();
  });

  it("an explicit effort is sent as reasoning_effort; mode 'never' sends none", async () => {
    stubFetch(() => okJson("x"));
    await local().chat(USER, { tools: TOOLS, reasoningEffort: "high" });
    expect(bodies[0].reasoning_effort).toBe("high");
    expect(bodies[0]).not.toHaveProperty("think");
    process.env.LOCAL_GEMMA_SEND_REASONING_EFFORT = "never";
    await local().chat(USER, { tools: TOOLS, disableThinking: true });
    expect(bodies[1]).toMatchObject({ think: false });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("a rejection retries once without it and is remembered per model; the classifier ignores model names", async () => {
    stubFetch(
      () => new Response('"gemma3:12b" does not support thinking', { status: 400 }),
      () => okJson("ok"),
    );
    const p = local();
    const opts = { tools: TOOLS, reasoningEffort: "low" as const };
    expect((await p.chat(USER, opts)).content).toBe("ok");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1].tools).toBeDefined();
    await p.chat(USER, opts);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("reasoning_effort");
    expect(
      isReasoningEffortUnsupportedBody(400, '"phi4-reasoning:14b" does not support tools'),
    ).toBe(false);
    expect(isReasoningEffortUnsupportedBody(404, 'model "qwen3:4b-thinking-2507" not found')).toBe(
      false,
    );
  });
});

describe("2 · the per-base-URL FIFO limiter", () => {
  it("serialises factory-built providers on localhost and 127.0.0.1; the timer starts after the slot", async () => {
    vi.useFakeTimers();
    process.env.LOCAL_GEMMA_REQUEST_TIMEOUT_MS = "200";
    let active = 0;
    let maxActive = 0;
    stubFetch(
      (_b, signal) =>
        new Promise<Response>((resolve, reject) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          const t = setTimeout(() => {
            active -= 1;
            resolve(okJson("done"));
          }, 120);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            active -= 1;
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const a = local({ LOCAL_GEMMA_BASE_URL: "http://localhost:11434/v1" });
    const b = local();
    const first = a.chat(USER, { tools: TOOLS });
    const second = b.chat(USER, { tools: TOOLS });
    // Queued 120 ms + ran 120 ms = 240 ms > the 200 ms budget: this passes only
    // if the second request's timer started when it got the slot.
    await vi.advanceTimersByTimeAsync(300);
    await expect(first).resolves.toMatchObject({ content: "done" });
    await expect(second).resolves.toMatchObject({ content: "done" });
    expect(maxActive).toBe(1);
  });

  it("releases the slot when a request fails", async () => {
    stubFetch(
      () => new Response("boom", { status: 500 }),
      () => okJson("after"),
    );
    const p = local();
    await expect(p.chat(USER, { tools: TOOLS })).rejects.toThrow(/500/);
    await expect(p.chat(USER, { tools: TOOLS })).resolves.toMatchObject({ content: "after" });
  });
});

describe("3 · configurable local timeouts and the /readyz ping budget", () => {
  it("LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS reaches the factory-built provider", async () => {
    vi.useFakeTimers();
    process.env.LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS = "50";
    stubFetch(
      (_b, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const run = collect(local().stream(USER, { tools: TOOLS }));
    const settled = expect(run).rejects.toBeInstanceOf(FirstTokenTimeoutError);
    await vi.advanceTimersByTimeAsync(60);
    await settled;
  });

  it("LOCAL_GEMMA_REQUEST_TIMEOUT_MS bounds a non-streamed call and names the knob", async () => {
    vi.useFakeTimers();
    process.env.LOCAL_GEMMA_REQUEST_TIMEOUT_MS = "40";
    stubFetch(
      (_b, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const run = local().chat(USER, { tools: TOOLS });
    const settled = expect(run).rejects.toThrow(
      /timed out after 40ms.*LOCAL_GEMMA_REQUEST_TIMEOUT_MS/,
    );
    await vi.advanceTimersByTimeAsync(50);
    await settled;
  });

  it("AI_PING_TIMEOUT_MS is still parsed for every key", () => {
    expect(loadAIConfig({ ...LOCAL_ENV, AI_PING_TIMEOUT_MS: "250" }).pingTimeoutMs).toBe(250);
  });
});

describe("4 · structured output modes and fallbacks", () => {
  const SCHEMA = {
    type: "json_schema" as const,
    json_schema: { name: "v", schema: { type: "object" } },
  };

  it("json_schema and json_object are forwarded verbatim next to the tools", async () => {
    stubFetch(() => okJson("{}"));
    await local().chat(USER, { tools: TOOLS, responseFormat: SCHEMA });
    await local().chat(USER, { tools: TOOLS, responseFormat: JSON_OBJECT_RESPONSE_FORMAT });
    expect(bodies[0].response_format).toEqual(SCHEMA);
    expect(bodies[1].response_format).toEqual({ type: "json_object" });
  });

  it("a 400/422 retries once without response_format (not remembered)", async () => {
    stubFetch(
      () => new Response("bad", { status: 422 }),
      () => okJson("{}"),
      () => okJson("{}"),
    );
    const p = local();
    await p.chat(USER, { tools: TOOLS, responseFormat: SCHEMA });
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(bodies[1].tools).toBeDefined();
    await p.chat(USER, { tools: TOOLS, responseFormat: SCHEMA });
    expect(bodies[2].response_format).toEqual(SCHEMA);
  });

  it("a body-matched 501 retries and is remembered per model; the classifiers ignore model names", async () => {
    stubFetch(
      () => new Response("structured output is unavailable", { status: 501 }),
      () => okJson("{}"),
    );
    const p = local();
    await p.chat(USER, { tools: TOOLS, responseFormat: SCHEMA });
    await p.chat(USER, { tools: TOOLS, responseFormat: SCHEMA });
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("response_format");
    expect(
      isStructuredOutputUnavailableBody(501, 'model "llama-structured-output:8b" is unavailable'),
    ).toBe(false);
    expect(
      isTemperatureUnsupportedBody(400, 'model "temperature-deprecated-test:7b" not found'),
    ).toBe(false);
  });
});

describe("5 · local sampling per family and per phase, always explicit", () => {
  it("family defaults and env overrides are unchanged", () => {
    expect(resolveLocalSampling("gemma4:12b", {})).toEqual({ temperature: 1.0, topP: 0.95 });
    expect(resolveLocalSampling("laguna-s-2.1", {})).toEqual({ temperature: 0.2, topP: 0.95 });
    expect(
      resolveLocalSampling("gemma4:12b", {
        DOCS_GEN_LOCAL_TEMPERATURE: "0.7",
        DOCS_GEN_LOCAL_TOP_P: "0.8",
      }),
    ).toEqual({ temperature: 0.7, topP: 0.8 });
  });

  it("each docs-gen phase's provider sends its own family's temperature and top_p, even with tools", async () => {
    Object.assign(process.env, LOCAL_ENV, {
      AI_OFFLINE: "0",
      DOCS_GEN_LOCAL_PHASE1_MODEL: "gemma4:12b",
      DOCS_GEN_LOCAL_PHASE2_MODEL: "laguna-s-2.1",
    });
    stubFetch(() => okJson("x"));
    await buildDocsGenProvider(1, 1000).provider.chat(USER, { tools: TOOLS });
    await buildDocsGenProvider(2, 1000).provider.chat(USER, { tools: TOOLS });
    expect(bodies[0]).toMatchObject({ temperature: 1.0, top_p: 0.95 });
    expect(bodies[1]).toMatchObject({ temperature: 0.2, top_p: 0.95 });
  });
});

describe("6 · output caps and truncation detection", () => {
  it("maxTokens reaches the wire and a cap hit surfaces as finishReason 'length' on chat", async () => {
    stubFetch(() => okJson("cut", "length"));
    const res = await local().chat(USER, { tools: TOOLS, maxTokens: 32_768 });
    expect(bodies[0].max_tokens).toBe(32_768);
    expect(res.finishReason).toBe("length");
  });

  it("…and on the terminal done chunk of a stream", async () => {
    stubFetch(() =>
      sse([
        { choices: [{ delta: { content: "cut" } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
    );
    const chunks = await collect(local().stream(USER, { tools: TOOLS }));
    expect(chunks.at(-1)).toEqual({ type: "done", finishReason: "length" });
  });

  it("the Anthropic non-streaming bound still clamps an oversized cap with tools present", async () => {
    createSpy.mockResolvedValue({
      content: [{ type: "text", text: "x" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const p = buildProvider({
      config: loadAIConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }),
    });
    const res = await p.chat(USER, { tools: TOOLS, maxTokens: 64_000 });
    expect(createSpy.mock.calls[0][0].max_tokens).toBeLessThan(64_000);
    expect(res.finishReason).toBe("max_tokens");
  });
});

describe("7 · docs-gen grounding and usage telemetry", () => {
  it("the claim extractor's json_object mode reaches the factory-built local provider", async () => {
    stubFetch(() => okJson('{"claims":[]}'));
    const extractor = new ClaimExtractor({
      provider: local(),
      responseFormat: JSON_OBJECT_RESPONSE_FORMAT,
    });
    await extractor.decompose("The rate is 5%.", { sources: [] } as never);
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
  });

  it("usage carries prompt-cache reads (local/gateway) and writes (Anthropic)", async () => {
    stubFetch(() =>
      okJson("x", "stop", {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 60 },
      }),
    );
    const res = await local().chat(USER, { tools: TOOLS });
    expect(res.usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 5,
      cacheReadTokens: 60,
    });
    createSpy.mockResolvedValue({
      content: [{ type: "text", text: "x" }],
      usage: {
        input_tokens: 9,
        output_tokens: 1,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 30,
      },
    });
    const a = buildProvider({
      config: loadAIConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }),
    });
    expect((await a.chat(USER, { tools: TOOLS })).usage).toMatchObject({
      cacheReadTokens: 70,
      cacheWriteTokens: 30,
    });
  });
});

describe("8 · Bedrock gateway, Anthropic-compatible and offline paths", () => {
  it("bedrock-gateway via the factory still swaps a mapped model for its profile ARN and caches via extra_body", async () => {
    stubFetch(() => okJson("x"));
    const p = buildProvider({
      config: loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "http://gateway.internal:8080/api/v1",
        BEDROCK_GATEWAY_API_KEY: "k",
        BEDROCK_MODEL: "us.anthropic.claude-sonnet-5",
        BEDROCK_SONNET_PROFILE: "arn:aws:bedrock:us-east-1:1:application-inference-profile/x",
      }),
    });
    await p.chat(USER, { tools: TOOLS, promptCaching: { system: true } });
    expect(bodies[0].model).toBe("arn:aws:bedrock:us-east-1:1:application-inference-profile/x");
    expect(bodies[0].extra_body).toEqual({ prompt_caching: { system: true } });
    // No reasoning_effort on the gateway (it would turn on Claude thinking).
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it("DeepSeek's Anthropic-compatible endpoint keeps thinking enabled/disabled semantics", async () => {
    createSpy.mockResolvedValue({ content: [{ type: "text", text: "x" }], usage: {} });
    const p = buildProvider({
      config: loadAIConfig({
        AI_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "k",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      }),
    });
    await p.chat(USER, { tools: TOOLS, reasoningEffort: "high" });
    await p.chat(USER, { tools: TOOLS, disableThinking: true });
    expect(createSpy.mock.calls[0][0].thinking).toEqual({ type: "enabled" });
    expect(createSpy.mock.calls[1][0].thinking).toEqual({ type: "disabled" });
  });

  it("the offline stub is still the deterministic default", async () => {
    const p = buildProvider({ config: loadAIConfig({}) });
    const a = await p.chat(USER);
    const b = await p.chat(USER);
    expect(a.content).toBe(b.content);
    expect(a.offline).toBe(true);
  });
});
