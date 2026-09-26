/**
 * The model catalog (#135) — one server-side list of the models METIS can talk
 * to, with the facts a caller or a picker needs about each: context window,
 * output ceiling, price and capabilities.
 *
 * ## Sources, in precedence order (later wins)
 *
 *   1. **builtin** — the {@link BUILTIN_MODELS} table below: the models this
 *      repo can actually select (`model-router.ts`, `config.ts` defaults), no
 *      speculative entries.
 *   2. **discovered** — local runtimes only (`local-gemma`): `GET {base}/models`
 *      lists what is served, and Ollama's `POST /api/show` supplies the context
 *      length and the model's own capability list. Discovery runs only from
 *      {@link getModelCatalog} (the `/api/ai/models` route), never from a chat
 *      call, and its result is cached for {@link DISCOVERY_TTL_MS}.
 *   3. **override** — `AI_MODEL_CATALOG_OVERRIDES`, an operator JSON map keyed
 *      `"<provider>:<model id>"`. A served context (laguna's 262,144 is only
 *      known at runtime) or a capability a model does not really honour
 *      (`laguna-s-2.1` ignores `json_schema`) is corrected here.
 *
 * ## Prices come from exactly one place
 *
 * No price is written in this file. Every entry's price is read through
 * `resolveRate()` in `finops/provider-rates.ts` — the same function usage
 * accounting bills with — so the picker can never show a price the bill will
 * not charge. `null` means UNPRICED, never free.
 *
 * ## Capabilities feed the provider contract (#131)
 *
 * {@link catalogCapabilities} is what the direct adapters' `capabilitiesFor()`
 * returns, so "is this model tool-capable?" has one answer for the provider
 * layer, the route and the UI.
 */
import { z } from "zod";
import type {
  ModelCatalogCapabilities,
  ModelCatalogEntry,
  ModelCatalogPrice,
  ModelCatalogResponse,
} from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { resolveRate } from "../finops/provider-rates.js";
import type { ProviderCapabilities } from "./capabilities.js";
import type { AIConfig } from "./config.js";
import { lookupModelMaxOutputTokens, normalizeModelId } from "./model-output-limits.js";
import { FABLE_MODEL_ID, HAIKU_MODEL_ID, OPUS_MODEL_ID, SONNET_MODEL_ID } from "./model-router.js";
import type { ProviderKey } from "./types.js";
import { isDeepSeekEndpoint } from "./providers/anthropic-endpoint.js";

export type { ModelCatalogCapabilities, ModelCatalogEntry, ModelCatalogResponse };

const log = createChildLogger("ai-model-catalog");

/** Env knob holding the operator overrides (see the module header). */
export const MODEL_CATALOG_OVERRIDES_ENV = "AI_MODEL_CATALOG_OVERRIDES";

/** How long a local discovery result is reused before the runtime is asked again. */
export const DISCOVERY_TTL_MS = 60_000;
/** Per-request budget for a discovery probe — it feeds a picker, not a chat. */
const DISCOVERY_TIMEOUT_MS = 2_000;
/** Bound on the models a single discovery asks `/api/show` about. */
const MAX_DISCOVERED_MODELS = 50;
/**
 * PR #194 review — at most this many `/api/show` requests in flight at once, so
 * discovering a runtime with many models never fires 50 requests together at a
 * host that may be serving generation with a concurrency of one.
 */
const DISCOVERY_CONCURRENCY = 8;

/**
 * Capabilities assumed for a model the catalog has no entry for, per provider.
 * These match what each adapter did before #131, so an unknown model behaves
 * exactly as it always has: the OpenAI-compatible runtimes were already sent
 * `response_format` (with a degrade-retry on rejection), and Anthropic's
 * Messages API has no `json_object` mode.
 */
const DEFAULT_CAPABILITIES: Readonly<Record<ProviderKey, ModelCatalogCapabilities>> = {
  anthropic: { tools: true, jsonSchema: true, jsonObject: false, vision: true, thinking: true },
  "bedrock-gateway": {
    tools: true,
    jsonSchema: true,
    jsonObject: true,
    vision: false,
    thinking: false,
  },
  openai: { tools: true, jsonSchema: true, jsonObject: true, vision: false, thinking: false },
  azure: { tools: true, jsonSchema: true, jsonObject: true, vision: false, thinking: false },
  "local-gemma": {
    tools: true,
    jsonSchema: true,
    jsonObject: true,
    vision: false,
    thinking: false,
  },
  "offline-stub": {
    tools: false,
    jsonSchema: false,
    jsonObject: false,
    vision: false,
    thinking: false,
  },
};

/** One hand-maintained catalog row; price and ceiling are resolved, not stored. */
interface BuiltinModel {
  provider: ProviderKey;
  id: string;
  displayName: string;
  contextWindow: number;
  capabilities: ModelCatalogCapabilities;
  routerTier?: "fast" | "balanced" | "complex";
}

// Claude facts: the claude-api model reference (cached 2026-06-24) — 1M context
// for Sonnet 5 / Sonnet 4.6 / Opus 4.8 / Fable 5, 200K for Haiku 4.5. Tool use
// and `output_config.format` structured outputs on every current model.
const CLAUDE: ModelCatalogCapabilities = {
  tools: true,
  jsonSchema: true,
  jsonObject: false,
  vision: true,
  thinking: true,
};
// The same models behind bedrock-access-gateway's OpenAI-compatible surface,
// which accepts `response_format` in both modes (see bedrock-direct-provider.ts).
const CLAUDE_VIA_GATEWAY: ModelCatalogCapabilities = { ...CLAUDE, jsonObject: true };
// OpenAI model reference: gpt-4o / gpt-4o-mini 128K context; gpt-4.1 1,047,576
// (the figure model-output-limits.ts already cites).
const GPT: ModelCatalogCapabilities = {
  tools: true,
  jsonSchema: true,
  jsonObject: true,
  vision: true,
  thinking: false,
};

/**
 * The builtin rows. Deliberately small — the models this repo can select and
 * nothing speculative. The `bedrock-gateway` rows ARE the ModelRouter registry
 * (`routerTier` set), so the analysis model picker renders from here.
 */
export const BUILTIN_MODELS: readonly BuiltinModel[] = [
  // Native Anthropic — bare ids (AnthropicProvider normalises Bedrock spellings).
  {
    provider: "anthropic",
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    capabilities: CLAUDE,
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    contextWindow: 1_000_000,
    capabilities: CLAUDE,
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    contextWindow: 1_000_000,
    capabilities: CLAUDE,
  },
  {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    contextWindow: 200_000,
    capabilities: CLAUDE,
  },
  {
    provider: "anthropic",
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    contextWindow: 1_000_000,
    capabilities: CLAUDE,
  },
  // Bedrock via the gateway — the ModelRouter registry, in its display order.
  {
    provider: "bedrock-gateway",
    id: HAIKU_MODEL_ID,
    displayName: "Claude Haiku 4.5",
    contextWindow: 200_000,
    capabilities: CLAUDE_VIA_GATEWAY,
    routerTier: "fast",
  },
  {
    provider: "bedrock-gateway",
    id: SONNET_MODEL_ID,
    displayName: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    capabilities: CLAUDE_VIA_GATEWAY,
    routerTier: "balanced",
  },
  {
    provider: "bedrock-gateway",
    id: FABLE_MODEL_ID,
    displayName: "Claude Fable 5",
    contextWindow: 1_000_000,
    capabilities: CLAUDE_VIA_GATEWAY,
    routerTier: "fast",
  },
  {
    provider: "bedrock-gateway",
    id: OPUS_MODEL_ID,
    displayName: "Claude Opus 4.8",
    contextWindow: 1_000_000,
    capabilities: CLAUDE_VIA_GATEWAY,
    routerTier: "complex",
  },
  // OpenAI / Azure OpenAI.
  {
    provider: "openai",
    id: "gpt-4.1",
    displayName: "GPT-4.1",
    contextWindow: 1_047_576,
    capabilities: GPT,
  },
  {
    provider: "openai",
    id: "gpt-4o",
    displayName: "GPT-4o",
    contextWindow: 128_000,
    capabilities: GPT,
  },
  {
    provider: "openai",
    id: "gpt-4o-mini",
    displayName: "GPT-4o mini",
    contextWindow: 128_000,
    capabilities: GPT,
  },
  {
    provider: "azure",
    id: "gpt-4o",
    displayName: "GPT-4o",
    contextWindow: 128_000,
    capabilities: GPT,
  },
  {
    provider: "azure",
    id: "gpt-4o-mini",
    displayName: "GPT-4o mini",
    contextWindow: 128_000,
    capabilities: GPT,
  },
  {
    provider: "offline-stub",
    id: "offline-stub",
    displayName: "Offline stub",
    contextWindow: 0,
    capabilities: DEFAULT_CAPABILITIES["offline-stub"],
  },
];

// ── Output ceilings not in model-output-limits.ts ─────────────────────────
// gpt-4o / gpt-4o-mini: 16,384 max output tokens (OpenAI model reference).
const EXTRA_OUTPUT_CEILINGS: ReadonlyMap<string, number> = new Map([
  ["gpt-4o", 16_384],
  ["gpt-4o-mini", 16_384],
]);

function maxOutputFor(id: string): number | null {
  return lookupModelMaxOutputTokens(id) ?? EXTRA_OUTPUT_CEILINGS.get(normalizeModelId(id)) ?? null;
}

/**
 * Price for `provider:id` in USD / MTok, read through the ONE pricing source.
 * `resolveRate` returns cents per 1k tokens; `X cents/1k === X/10 USD/MTok`,
 * so the conversion is ×10. Exported so the divergence test can compare.
 */
export function catalogPrice(
  provider: string,
  id: string,
  env?: NodeJS.ProcessEnv,
): ModelCatalogPrice | null {
  let rate;
  try {
    rate = resolveRate(provider, id, env ? { env } : {});
  } catch {
    return null;
  }
  if (!rate) return null;
  const usd = (centsPer1k: number): number => Math.round(centsPer1k * 10 * 1e9) / 1e9;
  return {
    inputPerMTok: usd(rate.inputPer1k),
    outputPerMTok: usd(rate.outputPer1k),
    ...(rate.cacheReadPer1k !== undefined ? { cacheReadPerMTok: usd(rate.cacheReadPer1k) } : {}),
    ...(rate.cacheWritePer1k !== undefined ? { cacheWritePerMTok: usd(rate.cacheWritePer1k) } : {}),
  };
}

// ── Operator overrides ────────────────────────────────────────────────────

const overrideSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    contextWindow: z.number().int().nonnegative().optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
    /**
     * #137 — characters per token for this model's tokenizer, used to estimate
     * a chat prompt's size before it is sent (until the session has reported
     * usage of its own to calibrate from). Measure it as prompt characters ÷
     * provider-reported input tokens.
     */
    charsPerToken: z.number().min(1).max(8).optional(),
    capabilities: z
      .object({
        tools: z.boolean().optional(),
        jsonSchema: z.boolean().optional(),
        jsonObject: z.boolean().optional(),
        vision: z.boolean().optional(),
        thinking: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type CatalogOverride = z.infer<typeof overrideSchema>;

let parsedOverrides: { raw: string; map: ReadonlyMap<string, CatalogOverride> } | null = null;

/**
 * Parse `AI_MODEL_CATALOG_OVERRIDES` into a Map (never a plain object, so a key
 * such as `__proto__` or `constructor` is inert data). An invalid value is
 * ignored with a warning — a bad override must never break a chat call.
 */
export function readCatalogOverrides(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, CatalogOverride> {
  const raw = env[MODEL_CATALOG_OVERRIDES_ENV]?.trim() ?? "";
  if (parsedOverrides?.raw === raw) return parsedOverrides.map;
  const map = new Map<string, CatalogOverride>();
  if (raw) {
    try {
      const json: unknown = JSON.parse(raw);
      if (json === null || typeof json !== "object" || Array.isArray(json)) {
        throw new Error("must be a JSON object");
      }
      for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
        const parsed = overrideSchema.safeParse(value);
        if (!parsed.success || !/^[a-z-]+:.+$/.test(key)) {
          log.warn("Ignoring invalid model catalog override entry", {
            env: MODEL_CATALOG_OVERRIDES_ENV,
            key: key.slice(0, 120),
          });
          continue;
        }
        map.set(key, parsed.data);
      }
    } catch (err) {
      log.warn("Ignoring invalid model catalog overrides", {
        env: MODEL_CATALOG_OVERRIDES_ENV,
        error: (err as Error).message.slice(0, 200),
      });
    }
  }
  parsedOverrides = { raw, map };
  return map;
}

// ── Local discovery ───────────────────────────────────────────────────────

/** What discovery learned about one served model. */
export interface DiscoveredModel {
  id: string;
  contextWindow: number | null;
  /** Present only when the runtime reported a capability list (Ollama ≥ 0.6). */
  capabilities?: Partial<ModelCatalogCapabilities>;
}

const discoveryCache = new Map<string, { at: number; models: DiscoveredModel[] }>();

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * List what a local OpenAI-compatible runtime serves and, where the runtime is
 * Ollama, ask `/api/show` for each model's context length and capability list.
 * vLLM reports `max_model_len` on the `/models` entries themselves. Every probe
 * is bounded by {@link DISCOVERY_TIMEOUT_MS}; any failure yields fewer facts,
 * never an error. The base URL is the operator's validated `LOCAL_GEMMA_BASE_URL`
 * and model ids travel only in a JSON body, so no caller input reaches a URL.
 */
export async function discoverLocalModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<DiscoveredModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const cached = discoveryCache.get(base);
  if (cached && now() - cached.at < DISCOVERY_TTL_MS) return cached.models;

  const headers = { Authorization: `Bearer ${apiKey}` };
  let listed: Array<{ id?: unknown; max_model_len?: unknown }> = [];
  try {
    const resp = await fetchImpl(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (resp.ok) {
      const json = (await resp.json()) as { data?: unknown };
      if (Array.isArray(json.data)) listed = json.data as typeof listed;
    }
  } catch (err) {
    log.debug("Local model listing failed", { error: (err as Error).message });
  }

  const ids = listed
    .map((m) => ({
      id: typeof m.id === "string" ? m.id : "",
      maxLen: typeof m.max_model_len === "number" ? m.max_model_len : null,
    }))
    .filter((m) => m.id.length > 0 && m.id.length <= 200)
    .slice(0, MAX_DISCOVERED_MODELS);

  // Ollama's native API lives at the origin root; `/v1` is its OpenAI shim.
  const nativeRoot = base.replace(/\/v1$/, "");
  const models: DiscoveredModel[] = new Array(ids.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const i = next++;
      const { id, maxLen } = ids[i];
      models[i] =
        maxLen !== null
          ? { id, contextWindow: maxLen }
          : { id, ...(await showOllamaModel(nativeRoot, id, headers, fetchImpl)) };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, ids.length) }, () => worker()),
  );
  discoveryCache.set(base, { at: now(), models });
  return models;
}

async function showOllamaModel(
  root: string,
  id: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<Omit<DiscoveredModel, "id">> {
  try {
    const resp = await fetchImpl(`${root}/api/show`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: id }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!resp.ok) return { contextWindow: null };
    const json = (await resp.json()) as {
      model_info?: Record<string, unknown>;
      capabilities?: unknown;
    };
    let contextWindow: number | null = null;
    for (const [key, value] of Object.entries(json.model_info ?? {})) {
      if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
        contextWindow = value;
        break;
      }
    }
    const caps = Array.isArray(json.capabilities)
      ? (json.capabilities.filter((c) => typeof c === "string") as string[])
      : null;
    return {
      contextWindow,
      ...(caps
        ? {
            capabilities: {
              tools: caps.includes("tools"),
              vision: caps.includes("vision"),
              thinking: caps.includes("thinking"),
            },
          }
        : {}),
    };
  } catch {
    return { contextWindow: null };
  }
}

// ── Lookup ────────────────────────────────────────────────────────────────

function builtinFor(provider: string, model: string): BuiltinModel | undefined {
  const exact = BUILTIN_MODELS.find((m) => m.provider === provider && m.id === model);
  if (exact) return exact;
  const norm = normalizeModelId(model);
  return BUILTIN_MODELS.find((m) => m.provider === provider && normalizeModelId(m.id) === norm);
}

function discoveredFor(provider: string, model: string): DiscoveredModel | undefined {
  if (provider !== "local-gemma") return undefined;
  for (const { models } of discoveryCache.values()) {
    const hit = models.find((m) => m.id === model);
    if (hit) return hit;
  }
  return undefined;
}

function defaultCapabilities(provider: string): ModelCatalogCapabilities {
  return (
    (DEFAULT_CAPABILITIES as Record<string, ModelCatalogCapabilities>)[provider] ??
    DEFAULT_CAPABILITIES["offline-stub"]
  );
}

/**
 * The catalog entry for `provider:model`, merged builtin → discovered →
 * override. Synchronous and network-free: discovery facts are used only once a
 * `getModelCatalog` call has populated the cache. Returns `undefined` when no
 * source knows the model.
 */
export function lookupCatalogEntry(
  provider: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelCatalogEntry | undefined {
  const builtin = builtinFor(provider, model);
  const discovered = discoveredFor(provider, model);
  const override = readCatalogOverrides(env).get(`${provider}:${model}`);
  if (!builtin && !discovered && !override) return undefined;

  const id = builtin?.id ?? model;
  const base: ModelCatalogCapabilities = builtin?.capabilities ?? defaultCapabilities(provider);
  const capabilities: ModelCatalogCapabilities = {
    ...base,
    ...(discovered?.capabilities ?? {}),
    ...(override?.capabilities ?? {}),
  };
  const source = override ? "override" : discovered ? "discovered" : "builtin";
  return {
    provider,
    id,
    displayName: override?.displayName ?? builtin?.displayName ?? model,
    contextWindow:
      override?.contextWindow ??
      discovered?.contextWindow ??
      (builtin && builtin.contextWindow > 0 ? builtin.contextWindow : null),
    maxOutputTokens: override?.maxOutputTokens ?? maxOutputFor(id),
    price: catalogPrice(provider, id),
    capabilities,
    ...(builtin?.routerTier ? { routerTier: builtin.routerTier } : {}),
    source,
  };
}

/**
 * #131 — the {@link ProviderCapabilities} a direct adapter reports for one
 * model. An unknown model gets the provider's defaults (what the adapter did
 * before #131), so a model absent from the catalog never loses a capability.
 */
export function catalogCapabilities(
  provider: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderCapabilities {
  const caps =
    lookupCatalogEntry(provider, model, env)?.capabilities ?? defaultCapabilities(provider);
  return {
    responseFormat: caps.jsonSchema || caps.jsonObject,
    nativeToolCalls: caps.tools,
    jsonSchema: caps.jsonSchema,
    jsonObject: caps.jsonObject,
    vision: caps.vision,
    thinking: caps.thinking,
  };
}

/**
 * #137 — measured characters-per-token ratios by model family, for estimating a
 * prompt's tokens before the session has reported usage to calibrate from. Only
 * families with a measurement IN THIS REPO are listed; everything else falls
 * back to the estimator's conservative default.
 *
 *   • laguna — 3.23 chars/token: prompt characters ÷ recorded input tokens over
 *     133 real Phase-1 docs-gen prompts on laguna-s-2.1 (see
 *     `PHASE1_INPUT_CHARS_PER_TOKEN` in `docs-gen/phase1-chunking.ts`).
 */
const FAMILY_CHARS_PER_TOKEN: ReadonlyArray<{ pattern: RegExp; charsPerToken: number }> = [
  { pattern: /(^|[/:])laguna/i, charsPerToken: 3.23 },
];

/**
 * #137 — the catalog's characters-per-token ratio for `provider:model`: an
 * operator override (`AI_MODEL_CATALOG_OVERRIDES` `charsPerToken`) wins over a
 * measured family ratio. `null` when the catalog has no figure.
 */
export function catalogCharsPerToken(
  provider: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const override = readCatalogOverrides(env).get(`${provider}:${model}`)?.charsPerToken;
  if (override !== undefined) return override;
  return FAMILY_CHARS_PER_TOKEN.find((f) => f.pattern.test(model))?.charsPerToken ?? null;
}

/**
 * The models the analysis ModelRouter can select, as catalog entries, in the
 * router's display order. Synchronous: these are builtin rows (plus any
 * operator override), so the model-preferences route can serve them inline.
 */
export function routerCatalog(env: NodeJS.ProcessEnv = process.env): ModelCatalogEntry[] {
  return BUILTIN_MODELS.filter((m) => m.routerTier)
    .map((m) => lookupCatalogEntry(m.provider, m.id, env))
    .filter((m): m is ModelCatalogEntry => m !== undefined);
}

export interface GetModelCatalogOptions {
  config: AIConfig;
  /** `"router"` lists only the models the analysis ModelRouter can select. */
  scope?: "provider" | "router";
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

/**
 * The catalog for the configured provider — what `GET /api/ai/models` serves.
 * Local runtimes are discovered first (bounded, cached). The configured default
 * model always appears, as a `configured` entry with unknown facts when no
 * source describes it.
 */
export async function getModelCatalog(opts: GetModelCatalogOptions): Promise<ModelCatalogResponse> {
  const env = opts.env ?? process.env;
  const { config } = opts;
  if (opts.scope === "router") {
    return { provider: config.provider, defaultModel: config.model, models: routerCatalog(env) };
  }

  const provider = config.provider;
  // PR #194 review — DeepSeek's Anthropic-compatible endpoint serves its OWN
  // models (it maps `claude-*` names onto them), so the built-in Claude entries,
  // with Anthropic's context windows and list prices, are not offered there.
  const deepSeek = provider === "anthropic" && isDeepSeekEndpoint(config.sdkProvider?.baseUrl);
  const ids: string[] = deepSeek
    ? []
    : BUILTIN_MODELS.filter((m) => m.provider === provider).map((m) => m.id);
  if (provider === "local-gemma" && config.sdkProvider?.baseUrl) {
    const discovered = await discoverLocalModels(
      config.sdkProvider.baseUrl,
      config.sdkProvider.apiKey ?? "ollama",
      opts.fetchImpl,
    );
    for (const d of discovered) if (!ids.includes(d.id)) ids.push(d.id);
  }
  for (const key of readCatalogOverrides(env).keys()) {
    const [p, ...rest] = key.split(":");
    const id = rest.join(":");
    if (p === provider && !ids.includes(id)) ids.push(id);
  }

  // Price against the endpoint actually configured, so Anthropic's list prices
  // are never applied to it (an operator's MODEL_PRICES entry still wins).
  const priceEnv: NodeJS.ProcessEnv | undefined = deepSeek
    ? { ...env, ANTHROPIC_BASE_URL: config.sdkProvider?.baseUrl }
    : undefined;
  const deepSeekEntry = (m: ModelCatalogEntry): ModelCatalogEntry =>
    withoutJsonSchema({ ...m, price: catalogPrice(provider, m.id, priceEnv) });
  const models = ids
    .map((id) => lookupCatalogEntry(provider, id, env))
    .filter((m): m is ModelCatalogEntry => m !== undefined)
    .map((m) => (deepSeek ? deepSeekEntry(m) : m));
  if (config.model && !models.some((m) => m.id === config.model)) {
    const configured: ModelCatalogEntry = {
      provider,
      id: config.model,
      displayName: config.model,
      contextWindow: null,
      maxOutputTokens: maxOutputFor(config.model),
      price: catalogPrice(provider, config.model),
      capabilities: defaultCapabilities(provider),
      source: "configured",
    };
    models.unshift(deepSeek ? deepSeekEntry(configured) : configured);
  }
  return { provider, defaultModel: config.model, models };
}

/**
 * DeepSeek's Anthropic-compatible endpoint supports only `effort` inside
 * `output_config` (api-docs.deepseek.com/guides/anthropic_api), so no model
 * served through it honours `output_config.format`.
 */
function withoutJsonSchema(entry: ModelCatalogEntry): ModelCatalogEntry {
  return { ...entry, capabilities: { ...entry.capabilities, jsonSchema: false } };
}

/** Test helper — forget discovery results and the parsed overrides. */
export function __resetModelCatalogForTests(): void {
  discoveryCache.clear();
  parsedOverrides = null;
}
