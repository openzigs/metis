/**
 * Epic #194 (C.4) — OpenInference adapter tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyOpenInferenceAttributes,
  getOtelSchema,
  isOpenInferenceEnabled,
  OPENINFERENCE_ATTR,
  toOpenInferenceSpan,
} from "../src/lib/observability/openinference-adapter.js";
import { GEN_AI_ATTR } from "../src/lib/otel/genai-spans.js";

afterEach(() => {
  delete process.env.OTEL_SCHEMA;
});

describe("getOtelSchema", () => {
  it("defaults to metis", () => {
    expect(getOtelSchema({})).toBe("metis");
  });

  it("returns openinference when explicitly set", () => {
    expect(getOtelSchema({ OTEL_SCHEMA: "OpenInference" })).toBe("openinference");
  });

  it("treats unrecognised values as metis (no breaking change)", () => {
    expect(getOtelSchema({ OTEL_SCHEMA: "phoenix" })).toBe("metis");
  });
});

describe("isOpenInferenceEnabled", () => {
  it("matches getOtelSchema", () => {
    expect(isOpenInferenceEnabled({ OTEL_SCHEMA: "openinference" })).toBe(true);
    expect(isOpenInferenceEnabled({ OTEL_SCHEMA: "metis" })).toBe(false);
  });
});

describe("toOpenInferenceSpan", () => {
  it("maps a chat span to LLM kind with token counts and prompt/response messages", () => {
    const span = toOpenInferenceSpan({
      name: "chat gpt-5",
      attributes: {
        [GEN_AI_ATTR.OPERATION_NAME]: "chat",
        [GEN_AI_ATTR.SYSTEM]: "openai",
        [GEN_AI_ATTR.REQUEST_MODEL]: "gpt-5",
        [GEN_AI_ATTR.RESPONSE_MODEL]: "gpt-5-mini",
        [GEN_AI_ATTR.USAGE_INPUT_TOKENS]: 100,
        [GEN_AI_ATTR.USAGE_OUTPUT_TOKENS]: 50,
        [GEN_AI_ATTR.PROMPT]: "Hello",
        [GEN_AI_ATTR.COMPLETION]: "Hi there",
      },
    });
    expect(span.attributes[OPENINFERENCE_ATTR.SPAN_KIND]).toBe("LLM");
    expect(span.attributes[OPENINFERENCE_ATTR.LLM_PROVIDER]).toBe("openai");
    expect(span.attributes[OPENINFERENCE_ATTR.LLM_MODEL_NAME]).toBe("gpt-5-mini");
    expect(span.attributes[OPENINFERENCE_ATTR.LLM_TOKEN_COUNT_PROMPT]).toBe(100);
    expect(span.attributes[OPENINFERENCE_ATTR.LLM_TOKEN_COUNT_COMPLETION]).toBe(50);
    expect(span.attributes[OPENINFERENCE_ATTR.LLM_TOKEN_COUNT_TOTAL]).toBe(150);
    expect(span.attributes[OPENINFERENCE_ATTR.LLM_PROMPT]).toBe("Hello");
    expect(JSON.parse(span.attributes[OPENINFERENCE_ATTR.LLM_INPUT_MESSAGES] as string)).toEqual([
      { role: "user", content: "Hello" },
    ]);
    expect(JSON.parse(span.attributes[OPENINFERENCE_ATTR.LLM_OUTPUT_MESSAGES] as string)).toEqual([
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("falls back to request model when response model is absent", () => {
    const span = toOpenInferenceSpan({
      attributes: {
        [GEN_AI_ATTR.OPERATION_NAME]: "chat",
        [GEN_AI_ATTR.REQUEST_MODEL]: "claude-sonnet-4",
      },
    });
    expect(span.attributes[OPENINFERENCE_ATTR.LLM_MODEL_NAME]).toBe("claude-sonnet-4");
  });

  it("maps execute_tool to TOOL kind", () => {
    const span = toOpenInferenceSpan({
      attributes: {
        [GEN_AI_ATTR.OPERATION_NAME]: "execute_tool",
        [GEN_AI_ATTR.TOOL_NAME]: "github/create_issue",
      },
    });
    expect(span.attributes[OPENINFERENCE_ATTR.SPAN_KIND]).toBe("TOOL");
    expect(span.attributes[OPENINFERENCE_ATTR.TOOL_NAME]).toBe("github/create_issue");
  });

  it("maps invoke_agent to AGENT kind", () => {
    const span = toOpenInferenceSpan({
      attributes: {
        [GEN_AI_ATTR.OPERATION_NAME]: "invoke_agent",
        [GEN_AI_ATTR.AGENT_NAME]: "ba",
      },
    });
    expect(span.attributes[OPENINFERENCE_ATTR.SPAN_KIND]).toBe("AGENT");
    expect(span.attributes[OPENINFERENCE_ATTR.AGENT_NAME]).toBe("ba");
  });

  it("falls back to CHAIN for unknown operations", () => {
    const span = toOpenInferenceSpan({ attributes: {} });
    expect(span.attributes[OPENINFERENCE_ATTR.SPAN_KIND]).toBe("CHAIN");
  });
});

describe("applyOpenInferenceAttributes", () => {
  it("is a no-op when the schema env is unset", () => {
    delete process.env.OTEL_SCHEMA;
    const setAttribute = vi.fn();
    applyOpenInferenceAttributes(setAttribute, {
      [GEN_AI_ATTR.OPERATION_NAME]: "chat",
      [GEN_AI_ATTR.REQUEST_MODEL]: "x",
    });
    expect(setAttribute).not.toHaveBeenCalled();
  });

  it("applies only OpenInference attribute keys when enabled", () => {
    process.env.OTEL_SCHEMA = "openinference";
    const setAttribute = vi.fn();
    applyOpenInferenceAttributes(setAttribute, {
      [GEN_AI_ATTR.OPERATION_NAME]: "execute_tool",
      [GEN_AI_ATTR.TOOL_NAME]: "github/x",
    });
    const keys = setAttribute.mock.calls.map((c) => c[0] as string);
    expect(keys).toContain(OPENINFERENCE_ATTR.SPAN_KIND);
    expect(keys).toContain(OPENINFERENCE_ATTR.TOOL_NAME);
    // METIS keys should not be re-applied via this helper.
    expect(keys.every((k) => !k.startsWith("gen_ai."))).toBe(true);
  });
});
