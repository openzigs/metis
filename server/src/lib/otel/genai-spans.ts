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
import {
  context,
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
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
  // #144 — current GenAI semantic conventions (open-telemetry/semantic-conventions-genai).
  PROVIDER_NAME: "gen_ai.provider.name",
  USAGE_CACHE_READ: "gen_ai.usage.cache_read.input_tokens",
  USAGE_CACHE_WRITE: "gen_ai.usage.cache_write.input_tokens",
  FINISH_REASONS: "gen_ai.response.finish_reasons",
  TIME_TO_FIRST_CHUNK: "gen_ai.response.time_to_first_chunk",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
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

// ── #144 — one span per model call, on every direct provider ──────────────

/** The minimum of a model call's outcome a span records (structural, no ai/ import). */
interface ModelCallUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ModelCallMeta {
  provider: string;
  model: string;
  callType?: string;
  /** Last user message — recorded ONLY when content capture is opted in. */
  prompt?: () => string;
}

function startModelSpan(meta: ModelCallMeta): Span {
  const span = getTracer().startSpan(
    `chat ${meta.model}`,
    { kind: SpanKind.CLIENT },
    context.active(),
  );
  span.setAttribute(GEN_AI_ATTR.OPERATION_NAME, "chat");
  span.setAttribute(GEN_AI_ATTR.PROVIDER_NAME, meta.provider);
  span.setAttribute(GEN_AI_ATTR.SYSTEM, meta.provider);
  span.setAttribute(GEN_AI_ATTR.REQUEST_MODEL, meta.model);
  if (meta.callType) span.setAttribute("metis.gen_ai.call_type", meta.callType);
  if (isContentCaptureEnabled() && meta.prompt) {
    span.setAttribute(GEN_AI_ATTR.PROMPT, truncate(meta.prompt()));
  }
  return span;
}

function recordUsage(span: Span, usage: ModelCallUsage | undefined): void {
  if (!usage) return;
  if (typeof usage.promptTokens === "number") {
    span.setAttribute(GEN_AI_ATTR.USAGE_INPUT_TOKENS, usage.promptTokens);
  }
  if (typeof usage.completionTokens === "number") {
    span.setAttribute(GEN_AI_ATTR.USAGE_OUTPUT_TOKENS, usage.completionTokens);
  }
  if (typeof usage.cacheReadTokens === "number") {
    span.setAttribute(GEN_AI_ATTR.USAGE_CACHE_READ, usage.cacheReadTokens);
  }
  if (typeof usage.cacheWriteTokens === "number") {
    span.setAttribute(GEN_AI_ATTR.USAGE_CACHE_WRITE, usage.cacheWriteTokens);
  }
}

function recordError(span: Span, err: unknown): void {
  // The error TYPE only: a provider message can quote the prompt back.
  const type = err instanceof Error ? err.name : "Error";
  span.setAttribute("error.type", type);
  span.setStatus({ code: SpanStatusCode.ERROR, message: type });
}

/**
 * #144 — wrap one NON-streaming model call. Latency and usage are recorded;
 * prompt/response content only when `OTEL_GENAI_CAPTURE_CONTENT=true`.
 */
export async function traceModelChat<
  T extends {
    content: string;
    usage?: ModelCallUsage;
    model?: string;
    finishReason?: string;
    toolCalls?: unknown[];
  },
>(meta: ModelCallMeta, fn: () => Promise<T>): Promise<T> {
  const span = startModelSpan(meta);
  const started = Date.now();
  try {
    const out = await context.with(trace.setSpan(context.active(), span), fn);
    recordUsage(span, out.usage);
    if (out.model) span.setAttribute(GEN_AI_ATTR.RESPONSE_MODEL, out.model);
    if (out.finishReason) span.setAttribute(GEN_AI_ATTR.FINISH_REASONS, [out.finishReason]);
    if (out.toolCalls) span.setAttribute("metis.gen_ai.tool_calls", out.toolCalls.length);
    if (isContentCaptureEnabled() && out.content) {
      span.setAttribute(GEN_AI_ATTR.COMPLETION, truncate(out.content));
    }
    span.setStatus({ code: SpanStatusCode.OK });
    return out;
  } catch (err) {
    recordError(span, err);
    throw err;
  } finally {
    span.setAttribute("metis.gen_ai.latency_ms", Date.now() - started);
    span.end();
  }
}

/**
 * #144 — wrap one STREAMING model call. Records time-to-first-chunk (the metric
 * that diagnosed #111's local timeouts): from the moment the provider's local
 * concurrency slot was acquired when it queues (`onSlotAcquired`), otherwise
 * from the call — the queue wait is recorded separately, so a slow queue is
 * never mistaken for a slow model.
 */
export async function* traceModelStream<
  C extends {
    type: string;
    usage?: ModelCallUsage;
    finishReason?: string;
  },
>(
  meta: ModelCallMeta,
  run: (hooks: { onSlotAcquired: () => void }) => AsyncGenerator<C>,
): AsyncGenerator<C> {
  const span = startModelSpan(meta);
  const started = Date.now();
  let clockFrom = started;
  let firstChunkAt: number | null = null;
  let completion = "";
  const capture = isContentCaptureEnabled();
  const onSlotAcquired = (): void => {
    clockFrom = Date.now();
    span.setAttribute("metis.gen_ai.queue_wait_ms", clockFrom - started);
  };
  try {
    const source = context.with(trace.setSpan(context.active(), span), () =>
      run({ onSlotAcquired }),
    );
    for await (const chunk of source) {
      if (firstChunkAt === null && (chunk.type === "delta" || chunk.type === "tool_call")) {
        firstChunkAt = Date.now();
        span.setAttribute(GEN_AI_ATTR.TIME_TO_FIRST_CHUNK, (firstChunkAt - clockFrom) / 1000);
      }
      if (chunk.type === "usage") recordUsage(span, chunk.usage);
      if (chunk.type === "done" && chunk.finishReason) {
        span.setAttribute(GEN_AI_ATTR.FINISH_REASONS, [chunk.finishReason]);
      }
      if (capture && chunk.type === "delta") {
        completion += (chunk as unknown as { content?: string }).content ?? "";
      }
      yield chunk;
    }
    if (capture && completion) span.setAttribute(GEN_AI_ATTR.COMPLETION, truncate(completion));
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    recordError(span, err);
    throw err;
  } finally {
    span.setAttribute("metis.gen_ai.latency_ms", Date.now() - started);
    span.end();
  }
}

/** The last user turn's text, for opt-in content capture (structural). */
export function lastUserText(
  messages: ReadonlyArray<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    return typeof m.content === "string"
      ? m.content
      : m.content
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n");
  }
  return "";
}
