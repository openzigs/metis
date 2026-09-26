/**
 * #134 — the cross-provider contract matrix. Every supported provider key is
 * built through the REAL factory (`buildProvider(loadAIConfig(env))`) and runs
 * the #131 contract suite, so "openai / azure / bedrock-gateway go through the
 * direct clients" is proven by behaviour, not by an instanceof check.
 *
 * `copilot-native` is deliberately absent: it is the one key still served by
 * the Copilot SDK and is removed entirely in P4 (#130).
 *
 * No network: the OpenAI-compatible keys answer from a mocked `fetch` in each
 * runtime's documented wire shape; the Anthropic keys from a mocked SDK.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { createSpy, streamSpy, listSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  streamSpy: vi.fn(),
  listSpy: vi.fn(async () => ({ data: [{ id: "claude-sonnet-5" }] })),
}));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: streamSpy };
    models = { list: listSpy };
    constructor(_opts: unknown) {
      /* no network */
    }
  }
  return { default: FakeAnthropic };
});

import { buildProvider } from "../../../src/lib/ai/providers/factory.js";
import { loadAIConfig } from "../../../src/lib/ai/config.js";
import { OpenAICompatibleProvider } from "../../../src/lib/ai/providers/openai-compatible-provider.js";
import { AnthropicProvider } from "../../../src/lib/ai/providers/anthropic-provider.js";
import { OfflineStubProvider } from "../../../src/lib/ai/providers/offline-stub-provider.js";
import { resetLocalConcurrencyLimitersForTests } from "../../../src/lib/ai/providers/local-concurrency-limiter.js";
import { __resetCacheHitAggregatorSingleton } from "../../../src/lib/ai/cache-hit-telemetry.js";
import { runProviderContract, type ContractHarness } from "./provider-contract/suite.js";
import {
  anthropicHarness,
  offlineStubHarness,
  openAIHarness,
  type OpenAIFlavour,
  type SeenRequest,
} from "./provider-contract/harnesses.js";
import type { AIProvider } from "../../../src/lib/ai/types.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLocalConcurrencyLimitersForTests();
  __resetCacheHitAggregatorSingleton();
});

/** One row per provider key: the env that configures it and how it is exercised. */
interface KeyCase {
  key: string;
  env: NodeJS.ProcessEnv;
  model: string;
  flavour?: OpenAIFlavour;
}

const OPENAI_COMPATIBLE: KeyCase[] = [
  {
    key: "local-gemma",
    env: {
      AI_PROVIDER: "local-gemma",
      LOCAL_GEMMA_BASE_URL: "http://127.0.0.1:11434/v1",
      LOCAL_GEMMA_MODEL: "gemma3:12b",
    },
    model: "gemma3:12b",
    flavour: "ollama",
  },
  {
    key: "bedrock-gateway",
    env: {
      AI_PROVIDER: "bedrock-gateway",
      BEDROCK_GATEWAY_URL: "http://gateway.internal:8080/api/v1",
      BEDROCK_GATEWAY_API_KEY: "gw-key",
      BEDROCK_MODEL: "us.anthropic.claude-sonnet-5",
    },
    model: "us.anthropic.claude-sonnet-5",
    flavour: "gateway",
  },
  {
    key: "openai",
    env: {
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_API_KEY: "sk-test",
      AI_MODEL: "gpt-4o",
    },
    model: "gpt-4o",
    flavour: "openai",
  },
  {
    key: "azure",
    env: {
      AI_PROVIDER: "azure",
      AZURE_OPENAI_ENDPOINT: "https://contoso.openai.azure.com",
      AZURE_OPENAI_API_KEY: "az-key",
      AZURE_OPENAI_DEPLOYMENT: "gpt4o-prod",
      AI_MODEL: "gpt-4o",
    },
    model: "gpt-4o",
    flavour: "azure",
  },
];

const build = (env: NodeJS.ProcessEnv): AIProvider => buildProvider({ config: loadAIConfig(env) });

for (const c of OPENAI_COMPATIBLE) {
  let harness: (ContractHarness & { seen: SeenRequest[] }) | undefined;
  runProviderContract(c.key, () => {
    harness = openAIHarness(c.flavour!, c.model, () => build(c.env));
    return harness;
  });

  describe(`${c.key} routing (#134)`, () => {
    it("is built as the direct OpenAI-compatible client, never the Copilot wrapper", () => {
      const p = build(c.env);
      expect(p).toBeInstanceOf(OpenAICompatibleProvider);
      expect(p.key).toBe(c.key);
    });

    it("ping() probes the models endpoint of its own base URL (/readyz)", async () => {
      const h = openAIHarness(c.flavour!, c.model, () => build(c.env));
      await expect(h.build().ping()).resolves.toBe(true);
      const url = h.seen.at(-1)?.url ?? "";
      if (c.key === "azure") {
        expect(url).toBe("https://contoso.openai.azure.com/openai/models?api-version=2024-10-21");
      } else {
        expect(url).toMatch(/\/models$/);
        expect(
          url.startsWith(String(Object.values(c.env).find((v) => v?.startsWith("http")))),
        ).toBe(true);
      }
    });
  });
}

describe("azure addressing (#132)", () => {
  it("posts to the deployment URL with api-version and authenticates with api-key", async () => {
    const env = OPENAI_COMPATIBLE.find((c) => c.key === "azure")!.env;
    const h = openAIHarness("azure", "gpt-4o", () => build(env));
    h.queueText("hi", { input: 1, output: 1 });
    await h.build().chat([{ role: "user", content: "hi" }]);
    const req = h.seen.at(-1)!;
    expect(req.url).toBe(
      "https://contoso.openai.azure.com/openai/deployments/gpt4o-prod/chat/completions?api-version=2024-10-21",
    );
    expect(req.headers["api-key"]).toBe("az-key");
    expect(req.headers.authorization).toBeUndefined();
    // OpenAI-family keys send max_completion_tokens (#134); never max_tokens.
    expect(req.body.max_completion_tokens).toBe(4096);
    expect(req.body).not.toHaveProperty("max_tokens");
  });

  it("honours AZURE_OPENAI_API_VERSION and falls back to the model as the deployment", async () => {
    const env = {
      AI_PROVIDER: "azure",
      AZURE_OPENAI_ENDPOINT: "https://contoso.openai.azure.com/",
      AZURE_OPENAI_API_KEY: "az-key",
      AZURE_OPENAI_API_VERSION: "2025-01-01-preview",
      AI_MODEL: "gpt-4o-mini",
    };
    const h = openAIHarness("azure", "gpt-4o-mini", () => build(env));
    h.queueText("hi", { input: 1, output: 1 });
    await h.build().chat([{ role: "user", content: "hi" }]);
    expect(h.seen.at(-1)!.url).toBe(
      "https://contoso.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01-preview",
    );
  });
});

describe("OpenAI-compatible bearer auth for the non-Azure keys", () => {
  it("openai sends Authorization: Bearer and max_completion_tokens", async () => {
    const env = OPENAI_COMPATIBLE.find((c) => c.key === "openai")!.env;
    const h = openAIHarness("openai", "gpt-4o", () => build(env));
    h.queueText("hi", { input: 1, output: 1 });
    await h.build().chat([{ role: "user", content: "hi" }], { maxTokens: 900 });
    const req = h.seen.at(-1)!;
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(req.body.max_completion_tokens).toBe(900);
  });

  it("local-gemma and bedrock-gateway keep max_tokens byte-for-byte", async () => {
    for (const key of ["local-gemma", "bedrock-gateway"]) {
      const c = OPENAI_COMPATIBLE.find((x) => x.key === key)!;
      const h = openAIHarness(c.flavour!, c.model, () => build(c.env));
      h.queueText("hi", { input: 1, output: 1 });
      await h.build().chat([{ role: "user", content: "hi" }], { maxTokens: 900 });
      expect(h.seen.at(-1)!.body.max_tokens).toBe(900);
      expect(h.seen.at(-1)!.body).not.toHaveProperty("max_completion_tokens");
    }
  });
});

// ── Anthropic Messages keys ───────────────────────────────────────────────

const ANTHROPIC_ENV = { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" };
const DEEPSEEK_ENV = {
  AI_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-ds-test",
  ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
  ANTHROPIC_MODEL: "deepseek-v4-pro",
};

runProviderContract("anthropic", () =>
  anthropicHarness({ createSpy, streamSpy }, "claude-sonnet-5", () => build(ANTHROPIC_ENV)),
);
runProviderContract("anthropic (DeepSeek Anthropic-compatible endpoint)", () =>
  anthropicHarness({ createSpy, streamSpy }, "deepseek-v4-pro", () => build(DEEPSEEK_ENV)),
);

describe("anthropic routing (#134)", () => {
  it("builds the Messages client for both the native and the DeepSeek endpoint", async () => {
    for (const env of [ANTHROPIC_ENV, DEEPSEEK_ENV]) {
      const p = build(env);
      expect(p).toBeInstanceOf(AnthropicProvider);
      await expect(p.ping()).resolves.toBe(true);
    }
  });
});

/**
 * #198 — contract scenario: a two-turn tool loop with `reasoningEffort` set, on
 * both Anthropic endpoints built through the real factory. The turn that
 * issued `tool_use` goes back with its thinking blocks verbatim and in order,
 * and the tool results answer it by id.
 */
describe("anthropic two-turn tool loop with reasoningEffort (#198)", () => {
  const THINK = { type: "thinking", thinking: "", signature: "sig" };
  const USE = { type: "tool_use", id: "toolu_1", name: "search_code", input: { q: "x" } };
  const reply = (content: unknown[], stop: string) => ({
    content,
    model: "claude-sonnet-5",
    stop_reason: stop,
    usage: { input_tokens: 3, output_tokens: 2 },
  });

  it.each([
    ["native endpoint", () => ANTHROPIC_ENV, "adaptive"],
    ["DeepSeek endpoint", () => DEEPSEEK_ENV, "enabled"],
  ])("%s", async (_l, env, thinking) => {
    createSpy.mockReset();
    createSpy
      .mockResolvedValueOnce(reply([THINK, USE], "tool_use"))
      .mockResolvedValueOnce(reply([{ type: "text", text: "done" }], "end_turn"));
    const p = build(env());
    const tools = [
      { name: "search_code", description: "s", parameters: { type: "object", properties: {} } },
    ];
    const first = await p.chat([{ role: "user", content: "go" }], {
      tools,
      reasoningEffort: "high",
    });
    expect(first.nativeContent).toEqual({ provider: "anthropic", blocks: [THINK, USE] });
    const second = await p.chat(
      [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: first.content,
          toolCalls: first.toolCalls,
          nativeContent: first.nativeContent,
        },
        { role: "tool", toolCallId: "toolu_1", name: "search_code", content: "hit" },
      ],
      { tools, reasoningEffort: "high" },
    );
    expect(second.content).toBe("done");
    const params = createSpy.mock.calls[1]![0] as {
      thinking: unknown;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(params.thinking).toEqual({ type: thinking });
    expect(params.messages[1]).toEqual({ role: "assistant", content: [THINK, USE] });
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hit" }],
    });
  });
});

// ── Offline stub ──────────────────────────────────────────────────────────

runProviderContract("offline-stub (scripted)", offlineStubHarness);

describe("offline-stub routing", () => {
  it("the factory's offline seam serves a scripted stub through the same contract", () => {
    const scripted = new OfflineStubProvider({ script: [] });
    const p = buildProvider({ config: loadAIConfig({}), offlineProvider: scripted });
    expect(p).toBe(scripted);
  });
});
