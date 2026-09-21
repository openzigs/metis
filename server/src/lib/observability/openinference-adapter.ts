/**
 * Epic #194 (C.4) — OpenInference / OTel agent-trace adapter.
 *
 * Maps the METIS `gen_ai.*` span attributes (Epic #109) to the
 * OpenInference v1 semantic conventions consumed by Arize Phoenix and
 * Traceloop OpenLLMetry.
 *
 * Activated by `OTEL_SCHEMA=openinference`. The default `OTEL_SCHEMA=metis`
 * preserves the existing attribute names so this is a fully opt-in
 * additive change (per the AC).
 *
 * Reference:
 *   https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 */
import { GEN_AI_ATTR } from "../otel/genai-spans.js";

export type OtelSchema = "metis" | "openinference";

export interface MetisSpanLike {
  name?: string;
  attributes: Record<string, unknown>;
}

export interface OpenInferenceSpan {
  name?: string;
  attributes: Record<string, unknown>;
}

export const OPENINFERENCE_ATTR = {
  SPAN_KIND: "openinference.span.kind",
  LLM_MODEL_NAME: "llm.model_name",
  LLM_PROVIDER: "llm.provider",
  LLM_INPUT_MESSAGES: "llm.input_messages",
  LLM_OUTPUT_MESSAGES: "llm.output_messages",
  LLM_TOKEN_COUNT_PROMPT: "llm.token_count.prompt",
  LLM_TOKEN_COUNT_COMPLETION: "llm.token_count.completion",
  LLM_TOKEN_COUNT_TOTAL: "llm.token_count.total",
  LLM_PROMPT: "llm.prompt",
  LLM_RESPONSE: "llm.response",
  TOOL_NAME: "tool.name",
  TOOL_PARAMETERS: "tool.parameters",
  AGENT_NAME: "agent.name",
} as const;

export function getOtelSchema(env: NodeJS.ProcessEnv = process.env): OtelSchema {
  return (env.OTEL_SCHEMA ?? "").toLowerCase() === "openinference" ? "openinference" : "metis";
}

export function isOpenInferenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getOtelSchema(env) === "openinference";
}

/**
 * Translate a METIS span (with `gen_ai.*` attributes) into an OpenInference
 * span (with `llm.*`, `tool.*`, `openinference.span.kind`, etc.).
 *
 * METIS attributes are preserved on the output for forward-compatibility —
 * callers can opt to strip them before exporting if their collector
 * complains about unknown keys.
 */
export function toOpenInferenceSpan(span: MetisSpanLike): OpenInferenceSpan {
  const attrs: Record<string, unknown> = { ...span.attributes };
  const op = span.attributes[GEN_AI_ATTR.OPERATION_NAME];
  attrs[OPENINFERENCE_ATTR.SPAN_KIND] = mapSpanKind(op);

  if (span.attributes[GEN_AI_ATTR.SYSTEM] != null) {
    attrs[OPENINFERENCE_ATTR.LLM_PROVIDER] = span.attributes[GEN_AI_ATTR.SYSTEM];
  }
  const model =
    span.attributes[GEN_AI_ATTR.RESPONSE_MODEL] ?? span.attributes[GEN_AI_ATTR.REQUEST_MODEL];
  if (model != null) {
    attrs[OPENINFERENCE_ATTR.LLM_MODEL_NAME] = model;
  }
  if (typeof span.attributes[GEN_AI_ATTR.USAGE_INPUT_TOKENS] === "number") {
    const prompt = span.attributes[GEN_AI_ATTR.USAGE_INPUT_TOKENS] as number;
    attrs[OPENINFERENCE_ATTR.LLM_TOKEN_COUNT_PROMPT] = prompt;
  }
  if (typeof span.attributes[GEN_AI_ATTR.USAGE_OUTPUT_TOKENS] === "number") {
    const comp = span.attributes[GEN_AI_ATTR.USAGE_OUTPUT_TOKENS] as number;
    attrs[OPENINFERENCE_ATTR.LLM_TOKEN_COUNT_COMPLETION] = comp;
  }
  const prompt = attrs[OPENINFERENCE_ATTR.LLM_TOKEN_COUNT_PROMPT];
  const completion = attrs[OPENINFERENCE_ATTR.LLM_TOKEN_COUNT_COMPLETION];
  if (typeof prompt === "number" && typeof completion === "number") {
    attrs[OPENINFERENCE_ATTR.LLM_TOKEN_COUNT_TOTAL] = prompt + completion;
  }
  if (typeof span.attributes[GEN_AI_ATTR.PROMPT] === "string") {
    const p = span.attributes[GEN_AI_ATTR.PROMPT] as string;
    attrs[OPENINFERENCE_ATTR.LLM_PROMPT] = p;
    attrs[OPENINFERENCE_ATTR.LLM_INPUT_MESSAGES] = JSON.stringify([{ role: "user", content: p }]);
  }
  if (typeof span.attributes[GEN_AI_ATTR.COMPLETION] === "string") {
    const c = span.attributes[GEN_AI_ATTR.COMPLETION] as string;
    attrs[OPENINFERENCE_ATTR.LLM_RESPONSE] = c;
    attrs[OPENINFERENCE_ATTR.LLM_OUTPUT_MESSAGES] = JSON.stringify([
      { role: "assistant", content: c },
    ]);
  }
  if (span.attributes[GEN_AI_ATTR.TOOL_NAME] != null) {
    attrs[OPENINFERENCE_ATTR.TOOL_NAME] = span.attributes[GEN_AI_ATTR.TOOL_NAME];
  }
  if (span.attributes[GEN_AI_ATTR.AGENT_NAME] != null) {
    attrs[OPENINFERENCE_ATTR.AGENT_NAME] = span.attributes[GEN_AI_ATTR.AGENT_NAME];
  }
  return { name: span.name, attributes: attrs };
}

function mapSpanKind(op: unknown): string {
  switch (op) {
    case "chat":
      return "LLM";
    case "execute_tool":
      return "TOOL";
    case "invoke_agent":
      return "AGENT";
    default:
      return "CHAIN";
  }
}

/**
 * Apply attributes from `extra` to `target`. Used by callers that already
 * have a real OTel `Span` and want to enrich it with the OpenInference set
 * when the schema env is enabled.
 */
export function applyOpenInferenceAttributes(
  setAttribute: (key: string, value: unknown) => void,
  metisAttributes: Record<string, unknown>,
): void {
  if (!isOpenInferenceEnabled()) return;
  const oi = toOpenInferenceSpan({ attributes: metisAttributes });
  for (const [key, value] of Object.entries(oi.attributes)) {
    if (
      key.startsWith("openinference.") ||
      key.startsWith("llm.") ||
      key.startsWith("tool.") ||
      key === OPENINFERENCE_ATTR.AGENT_NAME
    ) {
      setAttribute(key, value);
    }
  }
}
