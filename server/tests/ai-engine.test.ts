/**
 * Tests for AI engine: config + factory + provider/offline-stub + types.
 *
 * The Copilot/Bedrock providers are exercised via a stubbed
 * `CopilotClientLike` so the @github/copilot-sdk runtime is never invoked.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AIError,
  AIOfflineError,
  buildSdkProvider,
  buildProvider,
  CopilotProvider,
  CopilotWrapper,
  embedTexts,
  hashEmbed,
  loadAIConfig,
  OfflineStubProvider,
  __resetProviderSingleton,
} from "../src/lib/ai/index.js";
import { OpenAICompatibleProvider } from "../src/lib/ai/providers/openai-compatible-provider.js";
import type { CopilotClientLike, CopilotSessionLike } from "../src/lib/ai/copilot-wrapper.js";
import type { ChatChunk } from "../src/lib/ai/types.js";

// ── config ────────────────────────────────────────────────────────────────

describe("loadAIConfig", () => {
  it("defaults to offline-stub when nothing is configured", () => {
    const cfg = loadAIConfig({});
    expect(cfg.provider).toBe("offline-stub");
    expect(cfg.offline).toBe(true);
  });

  it("respects AI_OFFLINE=1 even when a provider is set", () => {
    const cfg = loadAIConfig({ AI_PROVIDER: "bedrock-gateway", AI_OFFLINE: "1" });
    expect(cfg.offline).toBe(true);
    expect(cfg.provider).toBe("offline-stub");
  });

  it("requires gateway URL + key when AI_PROVIDER=bedrock-gateway", () => {
    expect(() => loadAIConfig({ AI_PROVIDER: "bedrock-gateway" })).toThrow(
      /bedrock-gateway provider requires/,
    );
  });

  it("accepts a complete bedrock-gateway config", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "bedrock-gateway",
      BEDROCK_GATEWAY_URL: "http://gateway.internal:8080",
      BEDROCK_GATEWAY_API_KEY: "x",
      BEDROCK_MODEL: "anthropic.claude-sonnet-4-5",
    });
    expect(cfg.provider).toBe("bedrock-gateway");
    expect(cfg.sdkProvider?.type).toBe("openai");
    expect(cfg.sdkProvider?.baseUrl).toBe("http://gateway.internal:8080");
    expect(cfg.model).toBe("anthropic.claude-sonnet-4-5");
  });

  it("falls back to GATEWAY_BASE_URL/API_KEY when bedrock-* missing", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "bedrock-gateway",
      GATEWAY_BASE_URL: "http://legacy:8080",
      GATEWAY_API_KEY: "y",
    });
    expect(cfg.sdkProvider?.baseUrl).toBe("http://legacy:8080");
  });

  it("refuses to send credentials to public LLM hosts", () => {
    expect(() =>
      loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "https://api.openai.com",
        BEDROCK_GATEWAY_API_KEY: "y",
      }),
    ).toThrow(/public LLM provider/);
  });

  it("supports azure/anthropic/openai BYOK env (R-SDK-14)", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "azure",
      COPILOT_PROVIDER_TYPE: "azure",
      COPILOT_PROVIDER_BASE_URL: "https://my.openai.azure.com",
      COPILOT_PROVIDER_API_KEY: "k",
      COPILOT_MODEL: "gpt-5",
    });
    expect(cfg.provider).toBe("azure");
    expect(cfg.sdkProvider?.type).toBe("azure");
    expect(cfg.model).toBe("gpt-5");
  });

  it("rejects an OpenAI-compatible BYOK provider without base URL", () => {
    // openai/azure still route through the OpenAI-compatible BYOK matrix and
    // require COPILOT_PROVIDER_BASE_URL.
    expect(() => loadAIConfig({ AI_PROVIDER: "openai" })).toThrow(/COPILOT_PROVIDER_BASE_URL/);
  });

  it("rejects the native anthropic provider without an API key/token (#285)", () => {
    // The native Anthropic provider does NOT use COPILOT_PROVIDER_BASE_URL; it
    // requires ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) instead.
    expect(() => loadAIConfig({ AI_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("fails when COPILOT_OFFLINE=true with copilot-native (R-SDK-14)", () => {
    expect(() => loadAIConfig({ AI_PROVIDER: "copilot-native", COPILOT_OFFLINE: "true" })).toThrow(
      /COPILOT_OFFLINE/,
    );
  });

  it("buildSdkProvider returns undefined for native/offline", () => {
    expect(buildSdkProvider({ AI_PROVIDER: "copilot-native" } as never)).toBeUndefined();
    expect(buildSdkProvider({ AI_PROVIDER: "offline-stub" } as never)).toBeUndefined();
  });

  it("parses rate limit + ping timeout overrides", () => {
    const cfg = loadAIConfig({
      AI_RATE_LIMIT_WINDOW_MS: "30000",
      AI_RATE_LIMIT_MAX: "5",
      AI_PING_TIMEOUT_MS: "250",
    });
    expect(cfg.rateLimit.windowMs).toBe(30000);
    expect(cfg.rateLimit.max).toBe(5);
    expect(cfg.pingTimeoutMs).toBe(250);
  });

  it("falls back to defaults for invalid integers", () => {
    const cfg = loadAIConfig({
      AI_RATE_LIMIT_MAX: "abc",
      AI_PING_TIMEOUT_MS: "0",
    });
    expect(cfg.rateLimit.max).toBe(60);
    expect(cfg.pingTimeoutMs).toBe(1500);
  });

  // ── M5 — Bedrock gateway URL allow-list ─────────────────────────────────
  describe("BEDROCK_ALLOWED_HOSTS allow-list", () => {
    it("accepts a host explicitly listed in BEDROCK_ALLOWED_HOSTS", () => {
      const cfg = loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "https://bedrock.internal.example.com",
        BEDROCK_GATEWAY_API_KEY: "k",
        BEDROCK_ALLOWED_HOSTS: "bedrock.internal.example.com,backup.internal.example.com",
      });
      expect(cfg.sdkProvider?.baseUrl).toBe("https://bedrock.internal.example.com");
    });

    it("rejects a host not in BEDROCK_ALLOWED_HOSTS", () => {
      expect(() =>
        loadAIConfig({
          AI_PROVIDER: "bedrock-gateway",
          BEDROCK_GATEWAY_URL: "https://attacker.example.com",
          BEDROCK_GATEWAY_API_KEY: "k",
          BEDROCK_ALLOWED_HOSTS: "bedrock.internal.example.com",
        }),
      ).toThrow(/not in BEDROCK_ALLOWED_HOSTS/);
    });

    it("rejects http in production even when host is allow-listed", () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        expect(() =>
          loadAIConfig({
            AI_PROVIDER: "bedrock-gateway",
            BEDROCK_GATEWAY_URL: "http://bedrock.internal.example.com",
            BEDROCK_GATEWAY_API_KEY: "k",
            BEDROCK_ALLOWED_HOSTS: "bedrock.internal.example.com",
          }),
        ).toThrow(/must use https in production/);
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    it("falls back to legacy public-host deny-list when no allow-list set", () => {
      expect(() =>
        loadAIConfig({
          AI_PROVIDER: "bedrock-gateway",
          BEDROCK_GATEWAY_URL: "https://api.openai.com/v1",
          BEDROCK_GATEWAY_API_KEY: "k",
        }),
      ).toThrow(/public LLM provider/);
    });
  });

  // ── defaultModel priority (#234) ────────────────────────────────────────
  describe("defaultModel priority", () => {
    it("bedrock-gateway ignores COPILOT_MODEL and uses BEDROCK_MODEL", () => {
      const cfg = loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "http://gw.internal:8080",
        BEDROCK_GATEWAY_API_KEY: "k",
        COPILOT_MODEL: "gpt-4.1",
        BEDROCK_MODEL: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      });
      expect(cfg.model).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    });

    it("bedrock-gateway defaults to DEFAULT_BEDROCK_MODEL when no BEDROCK_MODEL set", () => {
      const cfg = loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "http://gw.internal:8080",
        BEDROCK_GATEWAY_API_KEY: "k",
        COPILOT_MODEL: "gpt-4.1",
      });
      expect(cfg.model).toBe("us.anthropic.claude-sonnet-5");
    });

    it("copilot-native uses COPILOT_MODEL", () => {
      const cfg = loadAIConfig({
        AI_PROVIDER: "copilot-native",
        COPILOT_MODEL: "gpt-4.1",
      });
      expect(cfg.model).toBe("gpt-4.1");
    });

    it("AI_MODEL overrides everything", () => {
      const cfg = loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "http://gw.internal:8080",
        BEDROCK_GATEWAY_API_KEY: "k",
        AI_MODEL: "my-custom-model",
        COPILOT_MODEL: "gpt-4.1",
        BEDROCK_MODEL: "anthropic.claude-sonnet-4-5",
      });
      expect(cfg.model).toBe("my-custom-model");
    });
  });
});

// ── offline stub provider ─────────────────────────────────────────────────

describe("OfflineStubProvider", () => {
  it("returns deterministic content for the same input", async () => {
    const p = new OfflineStubProvider();
    const a = await p.chat([{ role: "user", content: "hello" }]);
    const b = await p.chat([{ role: "user", content: "hello" }]);
    expect(a.content).toBe(b.content);
    expect(a.provider).toBe("offline-stub");
    expect(a.offline).toBe(true);
  });

  it("counts tokens proportionally to whitespace", async () => {
    const p = new OfflineStubProvider();
    const r = await p.chat([{ role: "user", content: "a b c d e" }]);
    expect(r.usage.promptTokens).toBe(5);
    expect(r.usage.totalTokens).toBe(r.usage.promptTokens + r.usage.completionTokens);
  });

  it("streams chunks then a usage event then done", async () => {
    const p = new OfflineStubProvider();
    const chunks: ChatChunk[] = [];
    for await (const c of p.stream([{ role: "user", content: "hi" }])) {
      chunks.push(c);
    }
    expect(chunks.at(-1)?.type).toBe("done");
    expect(chunks.find((c) => c.type === "usage")).toBeDefined();
    expect(chunks.filter((c) => c.type === "delta").length).toBeGreaterThan(0);
  });

  it("aborts mid-stream when the signal is triggered", async () => {
    const p = new OfflineStubProvider();
    const ac = new AbortController();
    ac.abort();
    await expect(async () => {
      for await (const _ of p.stream([{ role: "user", content: "many words here" }], {
        signal: ac.signal,
      })) {
        void _;
      }
    }).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ping resolves true and models contains the stub id", async () => {
    const p = new OfflineStubProvider();
    expect(await p.ping()).toBe(true);
    expect(await p.models()).toEqual(["offline-stub"]);
  });

  it("embed returns vectors of the configured dimension", async () => {
    const p = new OfflineStubProvider();
    const r = await p.embed(["alpha", "beta"]);
    expect(r.vectors).toHaveLength(2);
    expect(r.dimension).toBe(384);
    expect(r.vectors[0]).toHaveLength(384);
  });
});

// ── embeddings ─────────────────────────────────────────────────────────────

describe("hashEmbed / embedTexts", () => {
  it("produces L2-normalized vectors", () => {
    const v = hashEmbed("hello world");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
  });

  it("is deterministic for the same input/model", () => {
    expect(hashEmbed("x")).toEqual(hashEmbed("x"));
  });

  it("produces different vectors for different inputs", () => {
    expect(hashEmbed("a")).not.toEqual(hashEmbed("b"));
  });

  it("rejects invalid dimensions", () => {
    expect(() => hashEmbed("x", { dimension: 7 })).toThrow(RangeError);
    expect(() => hashEmbed("x", { dimension: -8 })).toThrow(RangeError);
  });

  it("respects custom dimension and model", () => {
    const r = hashEmbed("x", { dimension: 16, model: "custom" });
    expect(r).toHaveLength(16);
  });

  it("embedTexts handles non-string entries gracefully", async () => {
    const r = await embedTexts(["alpha", null as unknown as string]);
    expect(r.vectors).toHaveLength(2);
  });

  it("embedTexts rejects non-array input", async () => {
    await expect(embedTexts("nope" as unknown as string[])).rejects.toThrow(TypeError);
  });
});

// ── error classes ──────────────────────────────────────────────────────────

describe("AI errors", () => {
  it("AIError carries code/status/details", () => {
    const e = new AIError("AI_RATE_LIMITED", "slow down", 429, { x: 1 });
    expect(e.code).toBe("AI_RATE_LIMITED");
    expect(e.status).toBe(429);
    expect(e.details).toEqual({ x: 1 });
  });

  it("AIOfflineError defaults to 503", () => {
    const e = new AIOfflineError();
    expect(e.status).toBe(503);
    expect(e.code).toBe("AI_OFFLINE");
  });
});

// ── factory ────────────────────────────────────────────────────────────────

describe("buildProvider", () => {
  it("returns an OfflineStubProvider when offline=true", () => {
    const p = buildProvider({ config: loadAIConfig({}) });
    expect(p).toBeInstanceOf(OfflineStubProvider);
  });

  it("returns an OfflineStubProvider when forceOffline is set", () => {
    const p = buildProvider({
      config: loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "http://x:1",
        BEDROCK_GATEWAY_API_KEY: "y",
      }),
      forceOffline: true,
    });
    expect(p).toBeInstanceOf(OfflineStubProvider);
  });

  // #134 — only `copilot-native` still reaches the Copilot wrapper. Before
  // #134 this test built a CopilotProvider for `bedrock-gateway` (BYOK); the
  // wrapper-construction path it pinned is now exercised through the one key
  // that still takes it, and bedrock-gateway's new routing is pinned below.
  it("constructs a CopilotProvider through the wrapper factory for copilot-native", () => {
    const seen: Array<unknown> = [];
    const p = buildProvider({
      config: loadAIConfig({ AI_PROVIDER: "copilot-native", COPILOT_MODEL: "gpt-4.1" }),
      wrapperFactory: (opts) => {
        seen.push(opts);
        return new CopilotWrapper({
          ...opts,
          client: makeClientStub(),
        });
      },
    });
    expect(p).toBeInstanceOf(CopilotProvider);
    expect((seen[0] as { model?: string }).model).toBe("gpt-4.1");
  });

  it("builds bedrock-gateway as the direct client and never calls the wrapper factory (#134)", () => {
    const wrapperFactory = vi.fn();
    const p = buildProvider({
      config: loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "http://x:1",
        BEDROCK_GATEWAY_API_KEY: "y",
      }),
      wrapperFactory,
    });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.key).toBe("bedrock-gateway");
    expect(wrapperFactory).not.toHaveBeenCalled();
  });

  it("getProvider memoizes after reset", () => {
    __resetProviderSingleton();
    const a = buildProvider({ config: loadAIConfig({}) });
    expect(a.key).toBe("offline-stub");
  });

  it("does NOT inject a remote sidecar client under the test environment", () => {
    // resolveCopilotNativeMode short-circuits to in-process when VITEST is set,
    // so even with COPILOT_NATIVE_MODE=sidecar the wrapperFactory should
    // receive opts WITHOUT a `client` injection.
    const original = process.env.COPILOT_NATIVE_MODE;
    process.env.COPILOT_NATIVE_MODE = "sidecar";
    try {
      let receivedClient: unknown;
      buildProvider({
        // #134 — the sidecar applies to the wrapper path, which only
        // copilot-native takes now (was bedrock-gateway).
        config: loadAIConfig({ AI_PROVIDER: "copilot-native" }),
        wrapperFactory: (opts) => {
          receivedClient = (opts as { client?: unknown }).client;
          return new CopilotWrapper({ ...opts, client: makeClientStub() });
        },
      });
      expect(receivedClient).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.COPILOT_NATIVE_MODE;
      else process.env.COPILOT_NATIVE_MODE = original;
    }
  });

  it("surfaces a configured AIProviderError when the sidecar token is missing", async () => {
    // Force the sidecar branch by clearing the test guards inside this test
    // only. Restore everything in finally so the rest of the suite stays
    // unaffected.
    const original = {
      mode: process.env.COPILOT_NATIVE_MODE,
      vitest: process.env.VITEST,
      nodeEnv: process.env.NODE_ENV,
      offline: process.env.AI_OFFLINE,
      token: process.env.COPILOT_NATIVE_TOKEN,
    };
    process.env.COPILOT_NATIVE_MODE = "sidecar";
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.AI_OFFLINE;
    delete process.env.COPILOT_NATIVE_TOKEN;
    try {
      expect(() =>
        buildProvider({
          // #134 — see above: copilot-native is the wrapper path now.
          config: loadAIConfig({ AI_PROVIDER: "copilot-native" }),
        }),
      ).toThrow(/copilot sidecar client/);
    } finally {
      const restore = (envKey: string, val: string | undefined): void => {
        if (val === undefined) delete process.env[envKey];
        else process.env[envKey] = val;
      };
      restore("COPILOT_NATIVE_MODE", original.mode);
      restore("VITEST", original.vitest);
      restore("NODE_ENV", original.nodeEnv);
      restore("AI_OFFLINE", original.offline);
      restore("COPILOT_NATIVE_TOKEN", original.token);
    }
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeClientStub(overrides: Partial<CopilotClientLike> = {}): CopilotClientLike {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, authType: "stub" })),
    listModels: vi.fn(async () => [{ id: "stub-model" }]),
    createSession: vi.fn(async () => makeSessionStub()),
    ...overrides,
  };
}

function makeSessionStub(): CopilotSessionLike {
  return {
    sessionId: "stub-session",
    on: () => () => undefined,
    send: async () => undefined,
    sendAndWait: async () => undefined,
    destroy: async () => undefined,
  };
}
