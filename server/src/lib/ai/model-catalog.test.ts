/**
 * #135 — the model catalog: one price source, the router registry, operator
 * overrides, local discovery, and the capability flags it feeds to #131.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_MODELS,
  DISCOVERY_TTL_MS,
  MODEL_CATALOG_OVERRIDES_ENV,
  __resetModelCatalogForTests,
  catalogCapabilities,
  catalogPrice,
  discoverLocalModels,
  getModelCatalog,
  lookupCatalogEntry,
  readCatalogOverrides,
  routerCatalog,
} from "./model-catalog.js";
import { resolveRate } from "../finops/provider-rates.js";
import { MODEL_REGISTRY } from "./model-router.js";
import type { AIConfig } from "./config.js";

const cfg = (over: Partial<AIConfig>): AIConfig => ({
  provider: "offline-stub",
  model: "offline-stub",
  offline: false,
  rateLimit: { windowMs: 1, max: 1 },
  pingTimeoutMs: 1,
  ...over,
});

beforeEach(() => __resetModelCatalogForTests());
afterEach(() => __resetModelCatalogForTests());

describe("prices come from provider-rates.ts — one source", () => {
  it("every priced builtin equals resolveRate() for the same provider:model, converted to USD/MTok", () => {
    let priced = 0;
    for (const m of BUILTIN_MODELS) {
      const rate = resolveRate(m.provider, m.id);
      const entry = lookupCatalogEntry(m.provider, m.id, {})!;
      if (!rate) {
        expect(entry.price).toBeNull();
        continue;
      }
      priced += 1;
      expect(entry.price?.inputPerMTok).toBeCloseTo(rate.inputPer1k * 10, 9);
      expect(entry.price?.outputPerMTok).toBeCloseTo(rate.outputPer1k * 10, 9);
      if (rate.cacheReadPer1k !== undefined) {
        expect(entry.price?.cacheReadPerMTok).toBeCloseTo(rate.cacheReadPer1k * 10, 9);
      }
      if (rate.cacheWritePer1k !== undefined) {
        expect(entry.price?.cacheWritePerMTok).toBeCloseTo(rate.cacheWritePer1k * 10, 9);
      }
    }
    expect(priced).toBeGreaterThan(5);
  });

  it("pins two published prices end to end (Sonnet 5 direct, Sonnet 5 on Bedrock regional)", () => {
    expect(catalogPrice("anthropic", "claude-sonnet-5")).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
    });
    expect(catalogPrice("bedrock-gateway", "us.anthropic.claude-sonnet-5")).toMatchObject({
      inputPerMTok: 2.2,
      outputPerMTok: 11,
    });
  });

  it("an unpriced model is null, never zero; an internal stub is genuinely zero", () => {
    expect(catalogPrice("openai", "gpt-4.1")).toBeNull();
    expect(catalogPrice("offline-stub", "offline-stub")).toEqual({
      inputPerMTok: 0,
      outputPerMTok: 0,
    });
  });
});

describe("the router registry is catalog-described", () => {
  it("lists exactly MODEL_REGISTRY, in its order, with its names and tiers", () => {
    const entries = routerCatalog({});
    expect(entries.map((e) => e.id)).toEqual(MODEL_REGISTRY.map((m) => m.id));
    expect(entries.map((e) => e.displayName)).toEqual(MODEL_REGISTRY.map((m) => m.name));
    expect(entries.map((e) => e.routerTier)).toEqual(MODEL_REGISTRY.map((m) => m.tier));
    for (const e of entries) expect(e.price).not.toBeNull();
  });
});

describe("lookup", () => {
  it("matches dated / Bedrock spellings to the builtin row", () => {
    const e = lookupCatalogEntry("anthropic", "claude-haiku-4-5-20251001", {});
    expect(e?.id).toBe("claude-haiku-4-5");
    expect(e?.contextWindow).toBe(200_000);
    expect(e?.maxOutputTokens).toBe(64_000);
  });

  it("returns undefined for a model no source knows, and defaults its capabilities", () => {
    expect(lookupCatalogEntry("local-gemma", "mystery:1b", {})).toBeUndefined();
    expect(catalogCapabilities("local-gemma", "mystery:1b", {})).toEqual({
      responseFormat: true,
      nativeToolCalls: true,
      jsonSchema: true,
      jsonObject: true,
      vision: false,
      thinking: false,
    });
    expect(catalogCapabilities("nonsense-provider", "x", {}).nativeToolCalls).toBe(false);
  });

  it("uses the extra output ceilings for gpt-4o and a zero context as unknown", () => {
    expect(lookupCatalogEntry("openai", "gpt-4o", {})?.maxOutputTokens).toBe(16_384);
    expect(lookupCatalogEntry("offline-stub", "offline-stub", {})?.contextWindow).toBeNull();
  });
});

describe("operator overrides (AI_MODEL_CATALOG_OVERRIDES)", () => {
  const env = (value: unknown) => ({
    [MODEL_CATALOG_OVERRIDES_ENV]: typeof value === "string" ? value : JSON.stringify(value),
  });

  it("override wins for context, output, name and each capability", () => {
    const e = env({
      "local-gemma:laguna-s-2.1": {
        displayName: "Laguna",
        contextWindow: 262_144,
        maxOutputTokens: 8_192,
        capabilities: { jsonSchema: false },
      },
    });
    const entry = lookupCatalogEntry("local-gemma", "laguna-s-2.1", e)!;
    expect(entry).toMatchObject({
      displayName: "Laguna",
      contextWindow: 262_144,
      maxOutputTokens: 8_192,
      source: "override",
    });
    expect(entry.capabilities).toMatchObject({ jsonSchema: false, jsonObject: true, tools: true });
    expect(catalogCapabilities("local-gemma", "laguna-s-2.1", e)).toMatchObject({
      jsonSchema: false,
      responseFormat: true,
    });
  });

  it("ignores invalid JSON, non-objects, malformed keys and invalid entries", () => {
    expect(readCatalogOverrides(env("{nope")).size).toBe(0);
    expect(readCatalogOverrides(env("[1]")).size).toBe(0);
    const map = readCatalogOverrides(
      env({
        "no-colon": { contextWindow: 1 },
        "local-gemma:bad": { contextWindow: -1 },
        "local-gemma:extra": { surprise: true },
        "local-gemma:ok": { contextWindow: 10 },
      }),
    );
    expect([...map.keys()]).toEqual(["local-gemma:ok"]);
  });

  it("a __proto__ key is inert data — it cannot pollute any object", () => {
    const map = readCatalogOverrides(
      env('{"__proto__:x": {"contextWindow": 1}, "__proto__": {"polluted": true}}'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Neither is a `<provider>:<model>` key, so neither is read at all.
    expect(map.size).toBe(0);
  });
});

describe("local discovery", () => {
  function ollamaFetch(opts: { caps?: string[]; context?: number; listStatus?: number } = {}) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "gemma3:12b" }, { id: "laguna-s-2.1" }, { id: 7 }] }),
          { status: opts.listStatus ?? 200 },
        );
      }
      if (url.endsWith("/api/show")) {
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        if (model === "laguna-s-2.1") return new Response("nope", { status: 404 });
        return new Response(
          JSON.stringify({
            model_info: {
              "general.architecture": "gemma3",
              "gemma3.context_length": opts.context ?? 131_072,
            },
            ...(opts.caps ? { capabilities: opts.caps } : {}),
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
  }

  it("reads context length and capabilities from Ollama /api/show at the origin root", async () => {
    const f = ollamaFetch({ caps: ["completion", "vision"] });
    const models = await discoverLocalModels("http://127.0.0.1:11434/v1/", "k", f as never);
    expect(models).toEqual([
      {
        id: "gemma3:12b",
        contextWindow: 131_072,
        capabilities: { tools: false, vision: true, thinking: false },
      },
      { id: "laguna-s-2.1", contextWindow: null },
    ]);
    expect(f.mock.calls.map((c) => c[0])).toContain("http://127.0.0.1:11434/api/show");
    // The discovered "no tools" now feeds the provider-contract capability.
    expect(catalogCapabilities("local-gemma", "gemma3:12b", {}).nativeToolCalls).toBe(false);
    const entry = lookupCatalogEntry("local-gemma", "gemma3:12b", {})!;
    expect(entry).toMatchObject({ source: "discovered", contextWindow: 131_072 });
  });

  it("an operator override still beats discovery", async () => {
    await discoverLocalModels("http://127.0.0.1:11434/v1", "k", ollamaFetch() as never);
    const e = {
      [MODEL_CATALOG_OVERRIDES_ENV]: JSON.stringify({
        "local-gemma:gemma3:12b": { contextWindow: 32_768 },
      }),
    };
    expect(lookupCatalogEntry("local-gemma", "gemma3:12b", e)?.contextWindow).toBe(32_768);
  });

  it("uses vLLM's max_model_len without calling /api/show", async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "qwen", max_model_len: 32_000 }] }), {
          status: 200,
        }),
    );
    const models = await discoverLocalModels("http://10.0.0.5:8000/v1", "k", f as never);
    expect(models).toEqual([{ id: "qwen", contextWindow: 32_000 }]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("keeps at most 8 /api/show requests in flight and preserves listing order", async () => {
    let inFlight = 0;
    let peak = 0;
    const listed = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}` }));
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: listed }));
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      const id = (JSON.parse(String(init?.body)) as { model: string }).model;
      return new Response(
        JSON.stringify({ model_info: { "gemma3.context_length": Number(id.slice(1)) + 1 } }),
      );
    });
    const models = await discoverLocalModels("http://127.0.0.1:11434/v1", "k", f as never);
    expect(peak).toBe(8);
    expect(models.map((m) => m.id)).toEqual(listed.map((m) => m.id));
    expect(models.map((m) => m.contextWindow)).toEqual(listed.map((_, i) => i + 1));
  });

  it("caches for the TTL, then asks again", async () => {
    let now = 1_000;
    const f = ollamaFetch();
    await discoverLocalModels("http://127.0.0.1:11434/v1", "k", f as never, () => now);
    const calls = f.mock.calls.length;
    now += DISCOVERY_TTL_MS - 1;
    await discoverLocalModels("http://127.0.0.1:11434/v1", "k", f as never, () => now);
    expect(f.mock.calls.length).toBe(calls);
    now += 2;
    await discoverLocalModels("http://127.0.0.1:11434/v1", "k", f as never, () => now);
    expect(f.mock.calls.length).toBeGreaterThan(calls);
  });

  it("a failing runtime yields no models rather than an error", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(discoverLocalModels("http://127.0.0.1:1/v1", "k", f as never)).resolves.toEqual(
      [],
    );
    await expect(
      discoverLocalModels("http://127.0.0.1:2/v1", "k", ollamaFetch({ listStatus: 500 }) as never),
    ).resolves.toEqual([]);
  });

  it("a throwing /api/show degrades to an unknown context", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m" }] }));
      throw new Error("timeout");
    });
    await expect(discoverLocalModels("http://127.0.0.1:3/v1", "k", f as never)).resolves.toEqual([
      { id: "m", contextWindow: null },
    ]);
  });
});

describe("getModelCatalog", () => {
  it("lists the configured provider's builtins", async () => {
    const res = await getModelCatalog({
      config: cfg({ provider: "anthropic", model: "claude-sonnet-5" }),
      env: {},
    });
    expect(res.provider).toBe("anthropic");
    expect(res.defaultModel).toBe("claude-sonnet-5");
    expect(res.models.map((m) => m.id)).toContain("claude-opus-4-8");
    expect(res.models.every((m) => m.provider === "anthropic")).toBe(true);
  });

  it("marks every model json_schema-incapable behind DeepSeek's endpoint and adds the configured model", async () => {
    const res = await getModelCatalog({
      config: cfg({
        provider: "anthropic",
        model: "deepseek-v4-pro",
        sdkProvider: { type: "anthropic", baseUrl: "https://api.deepseek.com/anthropic" },
      }),
      env: {},
    });
    expect(res.models[0]).toMatchObject({
      id: "deepseek-v4-pro",
      source: "configured",
      price: null,
    });
    // PR #194 review: the configured entry is included, not skipped.
    expect(res.models.every((m) => !m.capabilities.jsonSchema)).toBe(true);
    // DeepSeek serves its own models: no built-in Claude entries at Anthropic prices.
    expect(res.models.map((m) => m.id)).toEqual(["deepseek-v4-pro"]);
  });

  it("never prices a claude-* name behind DeepSeek at Anthropic's list price", async () => {
    const res = await getModelCatalog({
      config: cfg({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        sdkProvider: { type: "anthropic", baseUrl: "https://api.deepseek.com/anthropic" },
      }),
      env: { [MODEL_CATALOG_OVERRIDES_ENV]: JSON.stringify({ "anthropic:claude-haiku-4-5": {} }) },
    });
    expect(res.models.map((m) => m.id).sort()).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);
    for (const m of res.models) {
      expect(m.price).toBeNull();
      expect(m.capabilities.jsonSchema).toBe(false);
    }
  });

  it("discovers local models and appends override-only models", async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith("/models")
        ? new Response(JSON.stringify({ data: [{ id: "gemma3:12b" }] }))
        : new Response("", { status: 404 }),
    );
    const res = await getModelCatalog({
      config: cfg({
        provider: "local-gemma",
        model: "gemma3:12b",
        sdkProvider: { type: "openai", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
      }),
      env: {
        [MODEL_CATALOG_OVERRIDES_ENV]: JSON.stringify({
          "local-gemma:laguna-s-2.1": { contextWindow: 262_144 },
          "openai:gpt-9": { contextWindow: 1 },
        }),
      },
      fetchImpl: f as never,
    });
    expect(res.models.map((m) => [m.id, m.source])).toEqual([
      ["gemma3:12b", "discovered"],
      ["laguna-s-2.1", "override"],
    ]);
  });

  it("router scope returns the router registry regardless of provider", async () => {
    const res = await getModelCatalog({ config: cfg({}), scope: "router", env: {} });
    expect(res.models.map((m) => m.id)).toEqual(MODEL_REGISTRY.map((m) => m.id));
  });
});
