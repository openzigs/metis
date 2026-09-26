/**
 * Per-adapter capability declarations (#1115).
 *
 * The point of the capability seam is that a caller can ask "will this provider
 * actually honour `responseFormat`?" and get a truthful answer. That is only
 * worth anything if every adapter's answer is pinned by a test, so this file
 * asserts the declaration for ALL five adapters plus the two fixture wrappers,
 * and — for the two that matter — cross-checks the declaration against
 * observable request behaviour rather than trusting the flag.
 *
 * Adapters are constructed with stubs; no network call is made.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture adapter log lines so we can assert the dropped-option warning.
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: vi.fn(),
  }),
}));

// The Anthropic SDK is mocked so `new AnthropicProvider(...)` never dials out.
const createSpy = vi.fn();
const streamSpy = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: streamSpy };
    models = { list: vi.fn() };
    constructor(_opts: unknown) {
      /* no-op */
    }
  }
  return { default: FakeAnthropic };
});

const { AnthropicProvider } = await import("./anthropic-provider.js");
const { CopilotProvider } = await import("./copilot-provider.js");
const { OfflineStubProvider } = await import("./offline-stub-provider.js");
const { OpenAICompatibleProvider, BedrockDirectProvider } =
  await import("./openai-compatible-provider.js");
const { CopilotWrapper } = await import("../copilot-wrapper.js");
const { ReplayProvider } = await import("../fixtures/replay-provider.js");
const { RecordingProvider } = await import("../fixtures/recording-provider.js");
const { FixtureStore } = await import("../fixtures/fixture-store.js");
const { providerSupports, supportsResponseFormat } = await import("../capabilities.js");
const { __resetCacheHitAggregatorSingleton } = await import("../cache-hit-telemetry.js");

import type { AIProvider, JsonSchemaResponseFormat } from "../types.js";

const SCHEMA: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: { name: "verdict", schema: { type: "object" } },
};

const makeOpenAICompatible = () =>
  new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "k",
    model: "test-model",
    providerKey: "local-gemma",
    retryBaseDelayMs: 1,
    sleepFn: async () => undefined,
  });

const makeCopilot = () =>
  new CopilotProvider({
    wrapper: new CopilotWrapper({ client: {} as never }),
    key: "copilot-native",
  });

const makeAnthropic = () => new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-6" });
// #133 — DeepSeek's Anthropic-compatible endpoint accepts only `effort` inside
// `output_config`, so this is the Anthropic-client configuration that still
// DROPS a response format (and must say so).
const makeDeepSeek = () =>
  new AnthropicProvider({
    apiKey: "k",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/anthropic",
  });

/**
 * The declaration table. Every adapter METIS can hand to calling code appears
 * here — a new adapter that forgets `capabilities` fails this suite rather than
 * silently reporting "supports nothing" forever.
 */
const ADAPTERS: Array<{
  name: string;
  build: () => AIProvider;
  responseFormat: boolean;
  nativeToolCalls: boolean;
}> = [
  {
    // Same class as BedrockDirectProvider — forwards `response_format` (with a
    // one-shot degrade retry, #336) and, since #132, native `tools`.
    name: "OpenAICompatibleProvider",
    build: makeOpenAICompatible,
    responseFormat: true,
    nativeToolCalls: true,
  },
  {
    name: "BedrockDirectProvider",
    build: () =>
      new BedrockDirectProvider({
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "k",
        model: "us.anthropic.claude-sonnet-4-6",
        providerKey: "bedrock-gateway",
        retryBaseDelayMs: 1,
        sleepFn: async () => undefined,
      }),
    responseFormat: true,
    nativeToolCalls: true,
  },
  {
    // #133 — `json_schema` rides `output_config.format`; `tools` are sent and
    // `tool_use` blocks come back as typed calls.
    name: "AnthropicProvider",
    build: makeAnthropic,
    responseFormat: true,
    nativeToolCalls: true,
  },
  {
    name: "AnthropicProvider (DeepSeek endpoint)",
    build: makeDeepSeek,
    responseFormat: false,
    nativeToolCalls: true,
  },
  {
    // copilot-sdk exposes no structured output in 0.3.0 OR 1.0.8, but it does
    // emit native `toolCall` session events which this adapter forwards.
    name: "CopilotProvider",
    build: makeCopilot,
    responseFormat: false,
    nativeToolCalls: true,
  },
  {
    name: "OfflineStubProvider",
    build: () => new OfflineStubProvider(),
    responseFormat: false,
    nativeToolCalls: false,
  },
  {
    name: "ReplayProvider",
    build: () => new ReplayProvider({ store: new FixtureStore("/tmp/metis-fixtures-unused") }),
    responseFormat: false,
    nativeToolCalls: false,
  },
];

describe.each(ADAPTERS)(
  "$name capability declaration",
  ({ build, responseFormat, nativeToolCalls }) => {
    it("declares a capability record (never left undefined)", () => {
      expect(build().capabilities).toBeDefined();
    });

    it(`reports responseFormat === ${responseFormat}`, () => {
      const provider = build();
      expect(provider.capabilities?.responseFormat).toBe(responseFormat);
      expect(supportsResponseFormat(provider)).toBe(responseFormat);
      expect(providerSupports(provider, "responseFormat")).toBe(responseFormat);
    });

    it(`reports nativeToolCalls === ${nativeToolCalls}`, () => {
      expect(providerSupports(build(), "nativeToolCalls")).toBe(nativeToolCalls);
    });
  },
);

describe("RecordingProvider capability declaration", () => {
  it("forwards the wrapped provider's capabilities rather than inventing its own", () => {
    const store = new FixtureStore("/tmp/metis-fixtures-unused");
    const supporting = new RecordingProvider({ inner: makeOpenAICompatible(), store });
    const nonSupporting = new RecordingProvider({ inner: new OfflineStubProvider(), store });

    expect(supportsResponseFormat(supporting)).toBe(true);
    expect(supportsResponseFormat(nonSupporting)).toBe(false);
  });
});

describe("declaration matches observable behaviour", () => {
  it("OpenAICompatibleProvider declares true AND puts response_format on the wire", async () => {
    const originalFetch = globalThis.fetch;
    let body: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "test-model",
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      const provider = makeOpenAICompatible();
      expect(supportsResponseFormat(provider)).toBe(true);
      await provider.chat([{ role: "user", content: "hi" }], { responseFormat: SCHEMA });
      expect(body.response_format).toEqual(SCHEMA);
    } finally {
      globalThis.fetch = originalFetch;
      __resetCacheHitAggregatorSingleton();
    }
  });

  it("AnthropicProvider (DeepSeek) declares false AND sends no response_format to the SDK", async () => {
    createSpy.mockResolvedValue({
      content: [{ type: "text", text: "hi" }],
      model: "deepseek-v4-pro",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = makeDeepSeek();
    expect(supportsResponseFormat(provider)).toBe(false);

    await provider.chat([{ role: "user", content: "hi" }], { responseFormat: SCHEMA });

    const params = createSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("response_format");
    expect(params).not.toHaveProperty("responseFormat");
    expect(JSON.stringify(params)).not.toContain("json_schema");
  });

  it("AnthropicProvider (native) declares true AND sends the schema as output_config.format", async () => {
    createSpy.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = makeAnthropic();
    expect(supportsResponseFormat(provider)).toBe(true);
    await provider.chat([{ role: "user", content: "hi" }], { responseFormat: SCHEMA });
    const params = createSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(params.output_config).toEqual({
      // Fitted to the Messages API subset by the SDK's transformJSONSchema.
      format: {
        type: "json_schema",
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
    });
  });
});

describe("a dropped responseFormat is audible, not silent", () => {
  const dropWarnings = () =>
    logWarn.mock.calls.filter(([msg]) => String(msg).includes("responseFormat"));

  beforeEach(() => {
    logWarn.mockClear();
    createSpy.mockResolvedValue({
      content: [{ type: "text", text: "hi" }],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it("AnthropicProvider warns once — not per call — when it drops a schema", async () => {
    // The DeepSeek endpoint is where the Anthropic client still drops a schema.
    const provider = makeDeepSeek();

    await provider.chat([{ role: "user", content: "hi" }], { responseFormat: SCHEMA });
    await provider.chat([{ role: "user", content: "hi" }], { responseFormat: SCHEMA });

    expect(dropWarnings()).toHaveLength(1);
    expect(dropWarnings()[0][1]).toMatchObject({
      provider: "anthropic",
      capability: "responseFormat",
    });
  });

  it("AnthropicProvider stays silent when no schema is supplied", async () => {
    await makeDeepSeek().chat([{ role: "user", content: "hi" }]);

    expect(dropWarnings()).toHaveLength(0);
  });

  it("CopilotProvider warns once when it drops a schema", () => {
    const provider = makeCopilot();
    const drop = (
      provider as unknown as { unsupportedResponseFormat: (rf: unknown) => void }
    ).unsupportedResponseFormat.bind(provider);

    drop(SCHEMA);
    drop(SCHEMA);
    drop(undefined);

    expect(dropWarnings()).toHaveLength(1);
    expect(dropWarnings()[0][1]).toMatchObject({ provider: "copilot-native" });
  });
});
