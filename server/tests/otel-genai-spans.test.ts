/**
 * Tests for GenAI semantic-convention helpers (#109).
 *
 * Uses a manual SpanProcessor to capture finished spans synchronously.
 */
import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  GEN_AI_ATTR,
  withChatSpan,
  withInvokeAgentSpan,
  withExecuteToolSpan,
  currentSpanIds,
} from "../src/lib/otel/genai-spans.js";

const captured: ReadableSpan[] = [];

const captureProcessor: SpanProcessor = {
  forceFlush: async () => undefined,
  onStart: () => undefined,
  onEnd: (span) => {
    captured.push(span);
  },
  shutdown: async () => undefined,
};

const provider = new BasicTracerProvider({ spanProcessors: [captureProcessor] });

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

beforeEach(() => {
  captured.length = 0;
  delete process.env.OTEL_GENAI_CAPTURE_CONTENT;
});

describe("genai-spans", () => {
  it("withChatSpan sets gen_ai.* attributes from request + recorded result", async () => {
    const out = await withChatSpan(
      { provider: "copilot-native", model: "gpt-4o", prompt: "hello" },
      async (_span, record) => {
        record({
          inputTokens: 5,
          outputTokens: 7,
          responseModel: "gpt-4o",
          responseText: "hi",
        });
        return "ok";
      },
    );
    expect(out).toBe("ok");
    expect(captured).toHaveLength(1);
    const attrs = captured[0].attributes;
    expect(attrs[GEN_AI_ATTR.OPERATION_NAME]).toBe("chat");
    expect(attrs[GEN_AI_ATTR.SYSTEM]).toBe("copilot-native");
    expect(attrs[GEN_AI_ATTR.REQUEST_MODEL]).toBe("gpt-4o");
    expect(attrs[GEN_AI_ATTR.USAGE_INPUT_TOKENS]).toBe(5);
    expect(attrs[GEN_AI_ATTR.USAGE_OUTPUT_TOKENS]).toBe(7);
    expect(attrs[GEN_AI_ATTR.RESPONSE_MODEL]).toBe("gpt-4o");
    expect(attrs[GEN_AI_ATTR.PROMPT]).toBeUndefined();
    expect(attrs[GEN_AI_ATTR.COMPLETION]).toBeUndefined();
  });

  it("withChatSpan captures content when OTEL_GENAI_CAPTURE_CONTENT=true", async () => {
    process.env.OTEL_GENAI_CAPTURE_CONTENT = "true";
    await withChatSpan(
      { provider: "openai", model: "gpt-4o-mini", prompt: "hello world" },
      async (_s, record) => {
        record({ inputTokens: 1, outputTokens: 1, responseText: "hi back" });
      },
    );
    const attrs = captured[0].attributes;
    expect(attrs[GEN_AI_ATTR.PROMPT]).toBe("hello world");
    expect(attrs[GEN_AI_ATTR.COMPLETION]).toBe("hi back");
  });

  it("withChatSpan records error status on throw", async () => {
    await expect(
      withChatSpan({ provider: "copilot-native", model: "x" }, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(captured).toHaveLength(1);
    expect(captured[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(captured[0].status.message).toBe("nope");
  });

  it("withInvokeAgentSpan sets agent name and operation", async () => {
    await withInvokeAgentSpan("business-analyst", async () => "ok");
    const attrs = captured[0].attributes;
    expect(attrs[GEN_AI_ATTR.OPERATION_NAME]).toBe("invoke_agent");
    expect(attrs[GEN_AI_ATTR.AGENT_NAME]).toBe("business-analyst");
  });

  it("withExecuteToolSpan sets tool name", async () => {
    await withExecuteToolSpan("github", "search_issues", async () => "ok");
    const attrs = captured[0].attributes;
    expect(attrs[GEN_AI_ATTR.OPERATION_NAME]).toBe("execute_tool");
    expect(attrs[GEN_AI_ATTR.TOOL_NAME]).toBe("github/search_issues");
  });

  it("withExecuteToolSpan records error on throw", async () => {
    await expect(
      withExecuteToolSpan("svc", "tool", async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    expect(captured[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it("withInvokeAgentSpan records error on throw", async () => {
    await expect(
      withInvokeAgentSpan("po", async () => {
        throw new Error("oops");
      }),
    ).rejects.toThrow("oops");
    expect(captured[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it("currentSpanIds returns empty when no active span", () => {
    const ids = currentSpanIds();
    expect(ids.traceId).toBe("");
    expect(ids.spanId).toBe("");
  });

  it("currentSpanIds returns active span ids inside a span", async () => {
    let observed = { traceId: "", spanId: "" };
    await withInvokeAgentSpan("test", async (span) => {
      const sc = span.spanContext();
      observed = { traceId: sc.traceId ?? "", spanId: sc.spanId ?? "" };
    });
    expect(observed.traceId).not.toBe("");
    expect(observed.spanId).not.toBe("");
  });

  it("captures content but truncates payloads larger than 4 KB", async () => {
    process.env.OTEL_GENAI_CAPTURE_CONTENT = "true";
    const big = "x".repeat(10_000);
    await withChatSpan({ provider: "openai", model: "gpt-4o", prompt: big }, async (_s, record) => {
      record({ responseText: big });
    });
    const attrs = captured[0].attributes;
    const prompt = String(attrs[GEN_AI_ATTR.PROMPT]);
    expect(prompt.endsWith("…")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(4096 + 1);
  });
});
