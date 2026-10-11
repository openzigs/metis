/**
 * #1077 — the JSON-producing stages ask for constrained output where the
 * provider has a mode for it, and for nothing where it does not.
 *
 * PR #1084 review — the two stages with no schema of their own (requirements
 * extraction, deep dive) send `json_object` ONLY where the backend is declared
 * json_object-only. On a generic OpenAI-compatible backend they send nothing:
 * one that rejects the field answers 400, which is not memoised, so every call
 * would otherwise pay a rejected round-trip.
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
import { jsonObjectWhereDeclared, requestStructuredVerdict } from "./structured-verdict.js";

/** What each real adapter declares (see `provider-capabilities.test.ts`). */
const CAPS = {
  "OpenAI-compatible (OpenAI, vLLM, the Bedrock gateway)": {
    caps: { responseFormat: true, nativeToolCalls: true },
    jsonObjectStage: undefined,
    schemaStage: "schema",
  },
  "OpenAI-compatible with both modes spelled out (the catalog default)": {
    caps: { responseFormat: true, nativeToolCalls: true, jsonSchema: true, jsonObject: true },
    jsonObjectStage: undefined,
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
  "a model the operator marked as taking neither mode": {
    caps: { responseFormat: true, nativeToolCalls: true, jsonSchema: false, jsonObject: false },
    jsonObjectStage: undefined,
    schemaStage: undefined,
  },
  // `responseFormat` is the master switch: a record that says the field never
  // reaches the backend wins over whatever the two mode flags claim.
  "an adapter whose record says response_format is not forwarded": {
    caps: { responseFormat: false, nativeToolCalls: true, jsonSchema: false, jsonObject: true },
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
  it("jsonObjectWhereDeclared answers for this record on its own", () => {
    // Asserted directly as well as through the stages: `requestStructuredVerdict`
    // filters an unsupported mode a second time, which would hide a helper that
    // said yes to a backend that takes neither mode.
    expect(jsonObjectWhereDeclared(fakeProvider(row.caps, "").provider)).toEqual(
      row.jsonObjectStage,
    );
  });

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

/**
 * PR #1084 review — capabilities are per MODEL, not per adapter. The fake
 * below declares both modes statically and marks ONE model json_object-only,
 * which is what an `AI_MODEL_CATALOG_OVERRIDES` entry does to a real adapter.
 */
describe("#1077 per-model capabilities decide what goes on the wire", () => {
  const STATIC: ProviderCapabilities = { responseFormat: true, nativeToolCalls: true };
  const JSON_OBJECT_ONLY: ProviderCapabilities = {
    ...STATIC,
    jsonSchema: false,
    jsonObject: true,
  };

  function perModelProvider(content: string, defaultModel = "plain-model") {
    const { provider, sentFormat } = fakeProvider(STATIC, content);
    const capabilitiesFor = vi.fn((model: string) =>
      model === "limited-model" ? JSON_OBJECT_ONLY : STATIC,
    );
    Object.assign(provider, { model: defaultModel, capabilitiesFor });
    return { provider, sentFormat, capabilitiesFor };
  }

  const verdict = (provider: AIProvider, model?: string) =>
    requestStructuredVerdict(provider, {
      label: "t",
      schema: z.object({ ok: z.boolean() }),
      schemaName: "T",
      expectedShape: '{ "ok": boolean }',
      messages: [{ role: "user", content: "json please" }],
      responseFormat: SCHEMA,
      ...(model ? { model } : {}),
    });

  it("a schema request for a json_object-only MODEL goes out as json_object", async () => {
    const { provider, sentFormat, capabilitiesFor } = perModelProvider('{"ok":true}');
    await verdict(provider, "limited-model");
    expect(capabilitiesFor).toHaveBeenCalledWith("limited-model");
    expect(sentFormat()).toEqual({ type: "json_object" });
  });

  it("a schema request for any other model on the same adapter keeps its schema", async () => {
    const { provider, sentFormat } = perModelProvider('{"ok":true}');
    await verdict(provider, "plain-model");
    expect(sentFormat()).toEqual(SCHEMA);
  });

  it("reports usedResponseFormat false for a model that takes neither mode", async () => {
    const { provider, sentFormat } = perModelProvider('{"ok":true}');
    Object.assign(provider, {
      capabilitiesFor: () => ({ responseFormat: false, nativeToolCalls: true }),
    });
    const outcome = await verdict(provider, "plain-model");
    expect(sentFormat()).toBeUndefined();
    expect(outcome.usedResponseFormat).toBe(false);
  });

  it("extraction sends json_object for the declared model and nothing for the other", async () => {
    const limited = perModelProvider('{"requirements":[]}');
    await new RequirementsExtractor({ provider: limited.provider, model: "limited-model" }).extract(
      "Users must log in",
    );
    expect(limited.sentFormat()).toEqual({ type: "json_object" });

    const plain = perModelProvider('{"requirements":[]}');
    await new RequirementsExtractor({ provider: plain.provider, model: "plain-model" }).extract(
      "Users must log in",
    );
    expect(plain.sentFormat()).toBeUndefined();
  });

  it("extraction with no model of its own asks about the provider's default model", async () => {
    const { provider, sentFormat, capabilitiesFor } = perModelProvider(
      '{"requirements":[]}',
      "limited-model",
    );
    await new RequirementsExtractor({ provider }).extract("Users must log in");
    expect(capabilitiesFor).toHaveBeenCalledWith("limited-model");
    expect(sentFormat()).toEqual({ type: "json_object" });
  });

  it("deep dive sends json_object for the declared model and nothing for the other", async () => {
    const finding = {
      title: "t",
      body: "b",
      category: "security" as const,
      severity: "high" as const,
      citations: [],
      requirementId: null,
    };
    const limited = perModelProvider(DRAFT);
    await deepDiveFinding(limited.provider, {
      projectName: "Acme",
      agentKey: "code",
      finding,
      model: "limited-model",
    });
    expect(limited.sentFormat()).toEqual({ type: "json_object" });

    const plain = perModelProvider(DRAFT);
    await deepDiveFinding(plain.provider, {
      projectName: "Acme",
      agentKey: "code",
      finding,
      model: "plain-model",
    });
    expect(plain.sentFormat()).toBeUndefined();
  });
});
