/**
 * #1077 — DeepSeek through the OpenAI-compatible provider gets JSON mode.
 *
 * METIS reached DeepSeek through its Anthropic-format endpoint, where no
 * structured-output field is honoured, and prompt-only JSON was valid 5 times in
 * 24 (#706 run 7). DeepSeek's OpenAI-format endpoint documents
 * `response_format: { type: "json_object" }` and nothing else
 * (api-docs.deepseek.com/api/create-chat-completion), so a caller's
 * `json_schema` must go out as `json_object` — not be rejected, retried without
 * `response_format` (#336) and land back on prompt-only JSON.
 *
 * Everything here runs against a stubbed `fetch`. No request leaves the
 * process and the key is a placeholder: whether DeepSeek behaves as documented
 * is exactly what the A/B in #1077 still has to measure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { supportsResponseFormat } from "../capabilities.js";
import { MODEL_CATALOG_OVERRIDES_ENV } from "../model-catalog.js";
import type { ChatChunk, JsonSchemaResponseFormat } from "../types.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

type CapturedInit = RequestInit & { dispatcher?: unknown };
const originalFetch = globalThis.fetch;
const originalOverrides = process.env[MODEL_CATALOG_OVERRIDES_ENV];

const SCHEMA: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "requirements",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["requirements"],
      properties: { requirements: { type: "array", items: { type: "string" } } },
    },
  },
};

const DEEPSEEK_URL = "https://api.deepseek.com";

function makeProvider(baseUrl: string, model = "deepseek-chat") {
  return new OpenAICompatibleProvider({
    baseUrl,
    apiKey: "placeholder-not-a-key",
    model,
    providerKey: "openai",
    retryBaseDelayMs: 1,
    sleepFn: async () => undefined,
  });
}

function jsonOk(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"requirements":[]}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      model: "deepseek-chat",
    }),
    text: async () => "",
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => `simulated ${status}`,
  } as unknown as Response;
}

function sseOk(): Response {
  const frames = ['data: {"choices":[{"delta":{"content":"{}"}}]}\n\n', "data: [DONE]\n\n"];
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () =>
          i < frames.length
            ? { value: enc.encode(frames[i++]), done: false }
            : { value: undefined, done: true },
        cancel: async () => undefined,
      }),
    },
    text: async () => "",
  } as unknown as Response;
}

/** Stub `fetch` with `responses` in order; returns the captured request bodies. */
function stubFetch(...responses: Response[]): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  }) as unknown as typeof fetch;
  return bodies;
}

async function drain(gen: AsyncGenerator<ChatChunk>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

const USER = [{ role: "user" as const, content: "Reply in JSON." }];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOverrides === undefined) delete process.env[MODEL_CATALOG_OVERRIDES_ENV];
  else process.env[MODEL_CATALOG_OVERRIDES_ENV] = originalOverrides;
  vi.restoreAllMocks();
});

describe("#1077 DeepSeek's OpenAI-format endpoint — request shape", () => {
  it("sends a json_schema request as json_object, in one request", async () => {
    const bodies = stubFetch(jsonOk());

    await makeProvider(DEEPSEEK_URL).chat(USER, { responseFormat: SCHEMA });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.response_format).toEqual({ type: "json_object" });
  });

  it("does the same on the streaming path", async () => {
    const bodies = stubFetch(sseOk());

    await drain(makeProvider(DEEPSEEK_URL).stream(USER, { responseFormat: SCHEMA }));

    expect(bodies[0]!.response_format).toEqual({ type: "json_object" });
  });

  it("passes a json_object request through unchanged", async () => {
    const bodies = stubFetch(jsonOk());

    await makeProvider(DEEPSEEK_URL).chat(USER, { responseFormat: { type: "json_object" } });

    expect(bodies[0]!.response_format).toEqual({ type: "json_object" });
  });

  it("adds no response_format when the caller asked for none", async () => {
    const bodies = stubFetch(jsonOk());

    await makeProvider(DEEPSEEK_URL).chat(USER);

    expect(bodies[0]).not.toHaveProperty("response_format");
  });

  it("caps output with max_tokens, the only name DeepSeek documents", async () => {
    const bodies = stubFetch(jsonOk());

    await makeProvider(DEEPSEEK_URL).chat(USER, { maxTokens: 1234 });

    expect(bodies[0]!.max_tokens).toBe(1234);
    expect(bodies[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("recognises the host however the URL is written", async () => {
    for (const url of ["https://api.deepseek.com/v1", "https://API.DeepSeek.com/", DEEPSEEK_URL]) {
      const bodies = stubFetch(jsonOk());
      await makeProvider(url).chat(USER, { responseFormat: SCHEMA });
      expect(bodies[0]!.response_format).toEqual({ type: "json_object" });
    }
  });

  it("still degrades to no response_format if the endpoint rejects json_object (#336)", async () => {
    const bodies = stubFetch(errorResponse(400), jsonOk());

    const res = await makeProvider(DEEPSEEK_URL).chat(USER, { responseFormat: SCHEMA });

    expect(res.content).toBe('{"requirements":[]}');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.response_format).toEqual({ type: "json_object" });
    expect(bodies[1]).not.toHaveProperty("response_format");
  });
});

describe("#1077 every other OpenAI-compatible endpoint is unchanged", () => {
  it.each(["https://api.openai.com/v1", "https://deepseek.com.example.org/v1"])(
    "sends json_schema verbatim and max_completion_tokens to %s",
    async (url) => {
      const bodies = stubFetch(jsonOk());

      await makeProvider(url, "gpt-4.1").chat(USER, { responseFormat: SCHEMA, maxTokens: 99 });

      expect(bodies[0]!.response_format).toEqual(SCHEMA);
      expect(bodies[0]!.max_completion_tokens).toBe(99);
      expect(bodies[0]).not.toHaveProperty("max_tokens");
    },
  );

  it("declares both modes on a non-DeepSeek host", () => {
    const provider = makeProvider("https://api.openai.com/v1", "gpt-4.1");
    expect(provider.capabilities).toEqual({ responseFormat: true, nativeToolCalls: true });
    expect(supportsResponseFormat(provider, "gpt-4.1", "json_schema")).toBe(true);
  });
});

describe("#1077 capabilities on DeepSeek's OpenAI-format endpoint", () => {
  it("declares json_object and not json_schema, statically and per model", () => {
    const provider = makeProvider(DEEPSEEK_URL);

    expect(provider.capabilities).toMatchObject({
      responseFormat: true,
      jsonSchema: false,
      jsonObject: true,
    });
    for (const model of [undefined, "deepseek-chat", "deepseek-reasoner"]) {
      expect(supportsResponseFormat(provider, model)).toBe(true);
      expect(supportsResponseFormat(provider, model, "json_object")).toBe(true);
      expect(supportsResponseFormat(provider, model, "json_schema")).toBe(false);
    }
  });

  it("reports no structured output at all for a model the operator marks as taking neither", () => {
    // Only `jsonObject` is overridden: the catalog still says `jsonSchema: true`
    // for an `openai` model, so it is the ENDPOINT limit that removes the schema
    // mode and must then report that nothing is left.
    process.env[MODEL_CATALOG_OVERRIDES_ENV] = JSON.stringify({
      "openai:deepseek-odd": { capabilities: { jsonObject: false } },
    });
    const provider = makeProvider(DEEPSEEK_URL, "deepseek-odd");

    expect(provider.capabilitiesFor("deepseek-odd")).toMatchObject({
      responseFormat: false,
      jsonSchema: false,
      jsonObject: false,
    });
  });
});

describe("#1077 the same downgrade for any runtime, by catalog override", () => {
  it("sends json_object when the operator declares a model takes no schema", async () => {
    process.env[MODEL_CATALOG_OVERRIDES_ENV] = JSON.stringify({
      "openai:proxy-model": { capabilities: { jsonSchema: false } },
    });
    const bodies = stubFetch(jsonOk(), jsonOk());
    const provider = makeProvider("https://llm-proxy.example.org/v1", "proxy-model");

    await provider.chat(USER, { responseFormat: SCHEMA });
    // A model on the same host without the override keeps its schema.
    await provider.chat(USER, { responseFormat: SCHEMA, model: "other-model" });

    expect(bodies[0]!.response_format).toEqual({ type: "json_object" });
    expect(bodies[1]!.response_format).toEqual(SCHEMA);
  });

  it("leaves the schema alone when the model takes neither mode (the #336 retry decides)", async () => {
    process.env[MODEL_CATALOG_OVERRIDES_ENV] = JSON.stringify({
      "openai:plain-model": { capabilities: { jsonSchema: false, jsonObject: false } },
    });
    const bodies = stubFetch(jsonOk());

    await makeProvider("https://llm-proxy.example.org/v1", "plain-model").chat(USER, {
      responseFormat: SCHEMA,
    });

    expect(bodies[0]!.response_format).toEqual(SCHEMA);
  });
});
