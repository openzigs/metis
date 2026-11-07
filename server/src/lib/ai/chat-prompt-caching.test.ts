/**
 * #1842 — the chat tool loop's prompt-cache posture, per provider.
 *
 * Only the native Anthropic path gains the messages breakpoint. Every
 * OpenAI-compatible key (DeepSeek, the Bedrock gateway, OpenAI, Azure, local
 * runtimes) must send exactly the request it sent before #1842: the snapshot
 * pins the bytes, and each body is also compared with the one built from the
 * pre-#1842 posture (`CHAT_PROMPT_CACHING`). `fetch` is stubbed; nothing dials out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  CHAT_PROMPT_CACHING,
  CHAT_TOOL_LOOP_PROMPT_CACHING,
  chatToolLoopPromptCaching,
  type ToolLoopCachingProvider,
} from "./chat-prompt-caching.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import type { ConfigService } from "../config/config-service.js";
import { __resetModelCatalogForTests } from "./model-catalog.js";
import type { ChatMessage, ChatOptions, ChatToolSpec, ProviderKey } from "./types.js";

/** A provider as `chatToolLoopPromptCaching` reads it. */
function provider(key: ProviderKey, servesRouterModel?: boolean): ToolLoopCachingProvider {
  return {
    key,
    model: "claude-sonnet-5-5",
    ...(servesRouterModel === undefined ? {} : { servesRouterModel: () => servesRouterModel }),
  };
}

/** `ANTHROPIC_BASE_URL_BILLS_AS` as an operator would set it. */
function billsAs(value: string | undefined): ConfigService {
  return {
    get: (k: string) => (k === "ANTHROPIC_BASE_URL_BILLS_AS" ? value : undefined),
  } as unknown as ConfigService;
}

describe("chatToolLoopPromptCaching", () => {
  it("caches the moving transcript on Anthropic's own API", () => {
    const p = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5-5" });
    expect(chatToolLoopPromptCaching(p)).toEqual({ system: true, messages: true });
    expect(
      chatToolLoopPromptCaching(
        new AnthropicProvider({ apiKey: "k", baseUrl: "https://api.anthropic.com" }),
      ),
    ).toBe(CHAT_TOOL_LOOP_PROMPT_CACHING);
    expect(CHAT_TOOL_LOOP_PROMPT_CACHING).toEqual({ system: true, messages: true });
  });

  it("caches it behind a proxy the operator declared relays to Anthropic", () => {
    const p = new AnthropicProvider({
      apiKey: "k",
      baseUrl: "https://llm-proxy.internal.example",
      config: billsAs("anthropic"),
    });
    expect(chatToolLoopPromptCaching(p)).toBe(CHAT_TOOL_LOOP_PROMPT_CACHING);
  });

  // #1863 — the `anthropic` key also covers these, whose requests must not change.
  it.each([
    ["DeepSeek's Anthropic-format endpoint", "https://api.deepseek.com/anthropic"],
    ["an undeclared Anthropic-compatible host", "https://llm-proxy.internal.example"],
  ])("keeps the system-only posture on %s", (_, baseUrl) => {
    const p = new AnthropicProvider({ apiKey: "k", baseUrl, config: billsAs(undefined) });
    expect(chatToolLoopPromptCaching(p)).toBe(CHAT_PROMPT_CACHING);
  });

  it("keeps it on an anthropic-keyed adapter that cannot say where it points", () => {
    expect(chatToolLoopPromptCaching(provider("anthropic"))).toBe(CHAT_PROMPT_CACHING);
    expect(chatToolLoopPromptCaching(provider("anthropic", false))).toBe(CHAT_PROMPT_CACHING);
  });

  it.each(["bedrock-gateway", "openai", "azure", "local-gemma", "offline-stub"] as const)(
    "keeps the system-only posture on %s, even where it serves router models",
    (key) => {
      expect(chatToolLoopPromptCaching(provider(key, true))).toBe(CHAT_PROMPT_CACHING);
      expect(CHAT_PROMPT_CACHING).toEqual({ system: true });
    },
  );
});

const TOOLS: ChatToolSpec[] = [
  { name: "search_code", description: "search", parameters: { type: "object", properties: {} } },
];

/** The three calls of a search → read → answer loop, as the agent loop sends them. */
function transcripts(): ChatMessage[][] {
  const q: ChatMessage[] = [
    { role: "system", content: "You are METIS." },
    { role: "user", content: "which files handle refunds?" },
  ];
  const r1: ChatMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "search_code", args: { query: "refund" } }],
    },
    { role: "tool", toolCallId: "c1", content: "refunds.go:10-40" },
  ];
  const r2: ChatMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c2", name: "search_code", args: { query: "approve" } }],
    },
    { role: "tool", toolCallId: "c2", content: "approvals.go:5" },
  ];
  return [q, [...q, ...r1], [...q, ...r1, ...r2]];
}

const originalFetch = globalThis.fetch;

/** The raw request bodies a three-call loop sends on `key` under `promptCaching`. */
async function loopBodies(
  key: Exclude<ProviderKey, "anthropic" | "offline-stub" | "azure">,
  promptCaching: (p: OpenAICompatibleProvider) => ChatOptions["promptCaching"],
): Promise<string[]> {
  const sent: string[] = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const p = new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKey: "k",
    model: "claude-sonnet-5-5",
    providerKey: key,
    retryBaseDelayMs: 1,
    sleepFn: async () => undefined,
  });
  for (const messages of transcripts()) {
    await p.chat(messages, { tools: TOOLS, callType: "chat", promptCaching: promptCaching(p) });
  }
  return sent;
}

describe("#1842 — OpenAI-compatible requests are byte-identical before and after", () => {
  beforeEach(() => __resetModelCatalogForTests());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetModelCatalogForTests();
  });

  for (const key of ["bedrock-gateway", "openai", "local-gemma"] as const) {
    it(`${key}: the tool loop's three requests are unchanged`, async () => {
      const before = await loopBodies(key, () => CHAT_PROMPT_CACHING);
      const after = await loopBodies(key, (p) => chatToolLoopPromptCaching(p));
      expect(after).toHaveLength(3);
      expect(after).toEqual(before);
      expect(after).toMatchSnapshot();
    });
  }
});
