/**
 * Tests for AI engine: config + factory + provider/offline-stub + types.
 *
 * No test here dials a real model endpoint.
 */
import { describe, expect, it } from "vitest";
import {
  AIError,
  AIOfflineError,
  buildSdkProvider,
  buildProvider,
  embedTexts,
  hashEmbed,
  loadAIConfig,
  OfflineStubProvider,
  __resetProviderSingleton,
} from "../src/lib/ai/index.js";
import { OpenAICompatibleProvider } from "../src/lib/ai/providers/openai-compatible-provider.js";
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

  it("supports the azure provider from its AZURE_OPENAI_* env + AI_MODEL", () => {
    const cfg = loadAIConfig({
      AI_PROVIDER: "azure",
      AZURE_OPENAI_ENDPOINT: "https://my.openai.azure.com",
      AZURE_OPENAI_API_KEY: "k",
      AI_MODEL: "gpt-5",
    });
    expect(cfg.provider).toBe("azure");
    expect(cfg.sdkProvider?.type).toBe("azure");
    expect(cfg.model).toBe("gpt-5");
  });

  it("rejects an OpenAI-compatible provider without base URL", () => {
    expect(() => loadAIConfig({ AI_PROVIDER: "openai" })).toThrow(/requires OPENAI_BASE_URL/);
  });

  it("rejects the native anthropic provider without an API key/token (#285)", () => {
    // The native Anthropic provider requires ANTHROPIC_API_KEY (or
    // ANTHROPIC_AUTH_TOKEN); it needs no base URL.
    expect(() => loadAIConfig({ AI_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("buildSdkProvider returns undefined for the offline stub", () => {
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

  it("builds bedrock-gateway as the direct OpenAI-compatible client (#134)", () => {
    const p = buildProvider({
      config: loadAIConfig({
        AI_PROVIDER: "bedrock-gateway",
        BEDROCK_GATEWAY_URL: "http://x:1",
        BEDROCK_GATEWAY_API_KEY: "y",
      }),
    });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.key).toBe("bedrock-gateway");
  });

  it("getProvider memoizes after reset", () => {
    __resetProviderSingleton();
    const a = buildProvider({ config: loadAIConfig({}) });
    expect(a.key).toBe("offline-stub");
  });
});
