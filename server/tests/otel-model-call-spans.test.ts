/**
 * #144 — one OpenTelemetry GenAI span per model call (provider, model, token
 * usage, cache hits, latency, time-to-first-chunk) and per tool call, nested
 * under the chat turn's span; prompt and completion CONTENT only when
 * `OTEL_GENAI_CAPTURE_CONTENT=true`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    aIToolApproval: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { OpenAICompatibleProvider } from "../src/lib/ai/providers/openai-compatible-provider.js";
import { resetLocalConcurrencyLimitersForTests } from "../src/lib/ai/providers/local-concurrency-limiter.js";
import { OfflineStubProvider } from "../src/lib/ai/providers/offline-stub-provider.js";
import { ApprovalGateService } from "../src/lib/ai/approval-policy.js";
import { runChatToolTurn } from "../src/lib/ai/tool-runtime/chat-turn.js";
import { makeToolset } from "../src/lib/ai/tool-runtime/toolset.js";
import { GEN_AI_ATTR } from "../src/lib/otel/genai-spans.js";

/** The async-hooks context manager the Node SDK installs, in 20 lines. */
class AlsContextManager implements ContextManager {
  private readonly als = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.als.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.als.run(ctx, () => fn.apply(thisArg, args));
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.als.disable();
    return this;
  }
}

const captured: ReadableSpan[] = [];
const processor: SpanProcessor = {
  forceFlush: async () => undefined,
  onStart: () => undefined,
  onEnd: (s) => {
    captured.push(s);
  },
  shutdown: async () => undefined,
};

beforeAll(() => {
  context.setGlobalContextManager(new AlsContextManager());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }));
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
  captured.length = 0;
  delete process.env.OTEL_GENAI_CAPTURE_CONTENT;
  resetLocalConcurrencyLimitersForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SECRET_PROMPT = "customer ssn 123-45-6789";

function provider(key: "bedrock-gateway" | "local-gemma" = "bedrock-gateway") {
  return new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "k",
    model: "m-1",
    providerKey: key,
    maxAttempts: 1,
    sleepFn: async () => undefined,
  });
}

function jsonReply(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "the answer" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 3,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    }),
    { status: 200 },
  );
}

function sseReply(): Response {
  const enc = new TextEncoder();
  const frames = [
    { choices: [{ delta: { content: "hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    },
  ];
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

const chatSpans = () => captured.filter((s) => s.name.startsWith("chat "));

describe("#144 model-call spans", () => {
  it("chat(): one CLIENT span with provider, model, usage, cache hits, latency — no content", async () => {
    globalThis.fetch = vi.fn(async () => jsonReply()) as unknown as typeof fetch;
    await provider().chat([{ role: "user", content: SECRET_PROMPT }], { callType: "chat" });
    const [span] = chatSpans();
    expect(span!.name).toBe("chat m-1");
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(span!.attributes).toMatchObject({
      [GEN_AI_ATTR.OPERATION_NAME]: "chat",
      [GEN_AI_ATTR.PROVIDER_NAME]: "bedrock-gateway",
      [GEN_AI_ATTR.REQUEST_MODEL]: "m-1",
      [GEN_AI_ATTR.USAGE_INPUT_TOKENS]: 11,
      [GEN_AI_ATTR.USAGE_OUTPUT_TOKENS]: 3,
      [GEN_AI_ATTR.FINISH_REASONS]: ["stop"],
      "metis.gen_ai.call_type": "chat",
    });
    expect(typeof span!.attributes["metis.gen_ai.latency_ms"]).toBe("number");
    expect(JSON.stringify(span!.attributes)).not.toContain("123-45-6789");
    expect(JSON.stringify(span!.attributes)).not.toContain("the answer");
  });

  it("content is captured only when opted in", async () => {
    process.env.OTEL_GENAI_CAPTURE_CONTENT = "true";
    globalThis.fetch = vi.fn(async () => jsonReply()) as unknown as typeof fetch;
    await provider().chat([{ role: "user", content: SECRET_PROMPT }]);
    const [span] = chatSpans();
    expect(span!.attributes[GEN_AI_ATTR.PROMPT]).toBe(SECRET_PROMPT);
    expect(span!.attributes[GEN_AI_ATTR.COMPLETION]).toBe("the answer");
  });

  it("stream(): records time-to-first-chunk and the local queue wait separately", async () => {
    globalThis.fetch = vi.fn(async () => sseReply()) as unknown as typeof fetch;
    const onSlotAcquired = vi.fn();
    const text: string[] = [];
    for await (const c of provider("local-gemma").stream([{ role: "user", content: "x" }], {
      onSlotAcquired,
    })) {
      if (c.type === "delta") text.push(c.content);
    }
    expect(text.join("")).toBe("hello");
    expect(onSlotAcquired).toHaveBeenCalledTimes(1); // the caller's hook still fires
    const [span] = chatSpans();
    expect(span!.attributes[GEN_AI_ATTR.TIME_TO_FIRST_CHUNK]).toBeTypeOf("number");
    expect(span!.attributes["metis.gen_ai.queue_wait_ms"]).toBeTypeOf("number");
    expect(span!.attributes[GEN_AI_ATTR.USAGE_INPUT_TOKENS]).toBe(4);
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });

  it("a failed call marks the span with the error TYPE only", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(`{"error":"${SECRET_PROMPT}"}`, { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(provider().chat([{ role: "user", content: "x" }])).rejects.toThrow();
    const [span] = chatSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes["error.type"]).toBeTypeOf("string");
    expect(JSON.stringify(span)).not.toContain("123-45-6789");
  });
});

describe("#144 spans nest under the chat turn", () => {
  it("model calls and tool calls are children of the turn's invoke_agent span", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      return new Response(
        JSON.stringify(
          call === 1
            ? {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "c1",
                          type: "function",
                          function: { name: "lookup", arguments: "{}" },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: {},
              }
            : { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: {} },
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const lookup = {
      name: "lookup",
      wireName: "lookup",
      description: "l",
      parameters: { type: "object" },
      risk: "low" as const,
      source: "metis" as const,
      validate: (a: unknown) => ({ ok: true as const, args: a }),
      execute: async () => ({ text: "ok" }),
    };
    const outer = trace.getTracer("test").startSpan("POST /api/ai/stream");
    await context.with(trace.setSpan(context.active(), outer), () =>
      runChatToolTurn(provider(), {
        messages: [{ role: "user", content: "x" }],
        toolset: makeToolset([lookup]),
        native: true,
        ctx: { sessionId: "s1", userId: "u1", projectId: "p1" },
        gate: new ApprovalGateService({
          sessionId: "s1",
          userId: "u1",
          policy: { low: "auto", medium: "auto", high: "auto" },
        }),
      }),
    );
    outer.end();
    const agent = captured.find((s) => s.name === "invoke_agent chat")!;
    expect(agent.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(agent.attributes["metis.session.id"]).toBe("s1");
    const models = chatSpans();
    expect(models).toHaveLength(2);
    for (const m of models) expect(m.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    const tool = captured.find((s) => s.name === "execute_tool metis/lookup")!;
    expect(tool.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    expect(tool.attributes).toMatchObject({
      [GEN_AI_ATTR.TOOL_CALL_ID]: "c1",
      "metis.tool.decision": "auto-approve",
      "metis.tool.is_error": false,
    });
  });

  it("the offline stub makes no model spans (it is not a model call)", async () => {
    await new OfflineStubProvider().chat([{ role: "user", content: "x" }]);
    expect(chatSpans()).toHaveLength(0);
  });
});
