/**
 * #1077 — the JSON-producing stages ask for constrained output where the
 * provider has a mode for it, and for nothing where it does not.
 *
 * The fake providers below differ ONLY in the capability record they declare,
 * which is the whole decision: `requestStructuredVerdict` probes per mode, so
 * one configuration switch (`AI_PROVIDER=openai` at DeepSeek's OpenAI-format
 * endpoint instead of `anthropic` at its Anthropic-format one) changes what
 * these stages put on the wire without any stage knowing which vendor it is.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ProviderCapabilities } from "../ai/capabilities.js";
import type { AIProvider, ChatOptions, JsonSchemaResponseFormat } from "../ai/types.js";
import { deepDiveFinding } from "./finding-deep-dive.js";
import { RequirementsExtractor } from "./requirements-extractor.js";
import { requestStructuredVerdict } from "./structured-verdict.js";

/** What each real adapter declares (see `provider-capabilities.test.ts`). */
const CAPS = {
  "OpenAI-compatible (OpenAI, vLLM, the Bedrock gateway)": {
    caps: { responseFormat: true, nativeToolCalls: true },
    jsonObjectStage: { type: "json_object" },
    schemaStage: "schema",
  },
  "OpenAI-compatible at DeepSeek's endpoint": {
    caps: { responseFormat: true, nativeToolCalls: true, jsonSchema: false, jsonObject: true },
    jsonObjectStage: { type: "json_object" },
    schemaStage: { type: "json_object" },
  },
  "Anthropic Messages API": {
    caps: { responseFormat: true, nativeToolCalls: true, jsonSchema: true, jsonObject: false },
    jsonObjectStage: undefined,
    schemaStage: "schema",
  },
  "Anthropic adapter at DeepSeek's endpoint": {
    caps: { responseFormat: false, nativeToolCalls: true, jsonSchema: false, jsonObject: false },
    jsonObjectStage: undefined,
    schemaStage: undefined,
  },
  "an adapter that declares nothing": {
    caps: undefined,
    jsonObjectStage: undefined,
    schemaStage: undefined,
  },
} satisfies Record<
  string,
  { caps: ProviderCapabilities | undefined; jsonObjectStage: unknown; schemaStage: unknown }
>;

const SCHEMA: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: { name: "verdict", schema: { type: "object" } },
};

function fakeProvider(caps: ProviderCapabilities | undefined, content: string) {
  const chat = vi.fn(async (_messages: unknown, _opts?: ChatOptions) => ({
    content,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "fake-model",
    provider: "openai",
  }));
  const provider = {
    key: "openai",
    model: "fake-model",
    offline: false,
    chat,
    ...(caps ? { capabilities: caps } : {}),
  } as unknown as AIProvider;
  return { provider, sentFormat: () => chat.mock.calls[0]![1]?.responseFormat };
}

const DRAFT = JSON.stringify({ title: "T", problemStatement: "P" });

describe.each(Object.entries(CAPS))("#1077 on %s", (_name, row) => {
  it("requirements extraction sends the JSON mode this provider has", async () => {
    const { provider, sentFormat } = fakeProvider(row.caps, '{"requirements":[]}');
    await new RequirementsExtractor({ provider }).extract("Users must log in");
    expect(sentFormat()).toEqual(row.jsonObjectStage);
  });

  it("deep dive sends the JSON mode this provider has", async () => {
    const { provider, sentFormat } = fakeProvider(row.caps, DRAFT);
    await deepDiveFinding(provider, {
      projectName: "Acme",
      agentKey: "code",
      finding: {
        title: "t",
        body: "b",
        category: "security",
        severity: "high",
        citations: [],
        requirementId: null,
      },
    });
    expect(sentFormat()).toEqual(row.jsonObjectStage);
  });

  it("a schema-carrying verdict keeps its schema, or falls to json_object, or sends nothing", async () => {
    const { provider, sentFormat } = fakeProvider(row.caps, '{"ok":true}');
    const outcome = await requestStructuredVerdict(provider, {
      label: "t",
      schema: z.object({ ok: z.boolean() }),
      schemaName: "T",
      expectedShape: '{ "ok": boolean }',
      messages: [{ role: "user", content: "json please" }],
      responseFormat: SCHEMA,
    });

    expect(sentFormat()).toEqual(row.schemaStage === "schema" ? SCHEMA : row.schemaStage);
    // Telemetry says what actually went out, not what was asked for.
    expect(outcome.usedResponseFormat).toBe(row.schemaStage !== undefined);
  });
});
