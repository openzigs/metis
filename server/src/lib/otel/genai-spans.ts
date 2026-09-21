/**
 * GenAI semantic-convention helpers (#109).
 *
 * Wraps OpenTelemetry's `tracer.startActiveSpan` with helpers that set
 * the well-known `gen_ai.*` attributes from the OTel GenAI experimental
 * conventions:
 *
 *   - gen_ai.system               (provider key)
 *   - gen_ai.request.model        (model id)
 *   - gen_ai.usage.input_tokens   (prompt tokens)
 *   - gen_ai.usage.output_tokens  (completion tokens)
 *   - gen_ai.tool.name            (tool calls)
 *   - gen_ai.operation.name       ("chat" | "invoke_agent" | "execute_tool")
 *
 * Content capture (prompts, responses) is **gated on
 * `OTEL_GENAI_CAPTURE_CONTENT=true`**. When off (the default) we set only
 * metadata; never the prompt or response text.
 */
import { trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { isContentCaptureEnabled } from "./init.js";

export const GEN_AI_ATTR = {
  SYSTEM: "gen_ai.system",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  TOOL_NAME: "gen_ai.tool.name",
  OPERATION_NAME: "gen_ai.operation.name",
  AGENT_NAME: "gen_ai.agent.name",
  PROMPT: "gen_ai.prompt",
  COMPLETION: "gen_ai.completion",
} as const;

const TRACER_NAME = "metis-genai";

function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export interface ChatSpanContext {
  provider: string;
  model: string;
  systemMessage?: string;
  prompt?: string;
}

export interface ChatSpanResult {
  inputTokens?: number;
  outputTokens?: number;
  responseModel?: string;
  responseText?: string;
}

/**
 * Wrap a chat completion call. Sets request attributes before the call,
 * captures usage attributes from the returned `ChatSpanResult`, and marks
 * the span error on throw.
 */
export async function withChatSpan<T>(
  ctx: ChatSpanContext,
  fn: (span: Span, recordResult: (r: ChatSpanResult) => void) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(`chat ${ctx.model}`, async (span) => {
    span.setAttribute(GEN_AI_ATTR.OPERATION_NAME, "chat");
    span.setAttribute(GEN_AI_ATTR.SYSTEM, ctx.provider);
    span.setAttribute(GEN_AI_ATTR.REQUEST_MODEL, ctx.model);
    if (isContentCaptureEnabled() && ctx.prompt) {
      span.setAttribute(GEN_AI_ATTR.PROMPT, truncate(ctx.prompt));
    }
    const recordResult = (r: ChatSpanResult): void => {
      if (typeof r.inputTokens === "number") {
        span.setAttribute(GEN_AI_ATTR.USAGE_INPUT_TOKENS, r.inputTokens);
      }
      if (typeof r.outputTokens === "number") {
        span.setAttribute(GEN_AI_ATTR.USAGE_OUTPUT_TOKENS, r.outputTokens);
      }
      if (r.responseModel) {
        span.setAttribute(GEN_AI_ATTR.RESPONSE_MODEL, r.responseModel);
      }
      if (isContentCaptureEnabled() && r.responseText) {
        span.setAttribute(GEN_AI_ATTR.COMPLETION, truncate(r.responseText));
      }
    };
    try {
      const out = await fn(span, recordResult);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wrap a multi-agent phase (BA / Architect / PO / QA / synthesis).
 */
export async function withInvokeAgentSpan<T>(
  agentName: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(`invoke_agent ${agentName}`, async (span) => {
    span.setAttribute(GEN_AI_ATTR.OPERATION_NAME, "invoke_agent");
    span.setAttribute(GEN_AI_ATTR.AGENT_NAME, agentName);
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wrap an MCP / built-in tool execution.
 */
export async function withExecuteToolSpan<T>(
  server: string,
  tool: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(`execute_tool ${server}/${tool}`, async (span) => {
    span.setAttribute(GEN_AI_ATTR.OPERATION_NAME, "execute_tool");
    span.setAttribute(GEN_AI_ATTR.TOOL_NAME, `${server}/${tool}`);
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Capture-content payload cap (4 KB). Prevents unbounded span size. */
const MAX_CONTENT_BYTES = 4 * 1024;

function truncate(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= MAX_CONTENT_BYTES) return s;
  return s.slice(0, MAX_CONTENT_BYTES) + "…";
}

/** Returns the active span's IDs (or empty strings). */
export function currentSpanIds(): { traceId: string; spanId: string } {
  const span = trace.getActiveSpan();
  if (!span) return { traceId: "", spanId: "" };
  const sc = span.spanContext();
  return { traceId: sc.traceId ?? "", spanId: sc.spanId ?? "" };
}
