/**
 * Provider configuration loader.
 *
 * Reads env vars, validates them with zod, and returns a fully-typed
 * `AIConfig` for one of the supported providers: `anthropic` (incl.
 * Anthropic-compatible endpoints such as DeepSeek), `openai`, `azure`,
 * `bedrock-gateway`, `local-gemma` (Ollama / vLLM / LM Studio) and
 * `offline-stub`.
 *
 * #149 — `copilot-native` was removed. Naming it (in env or in the runtime
 * configuration) is an `AIConfigError` that names the supported providers and
 * the migration note; so is relying on a retired `COPILOT_PROVIDER_*` /
 * `COPILOT_MODEL` fallback. See `retired-providers.ts`.
 *
 * Anything missing/invalid is reported as an `AIConfigError` so the caller
 * can short-circuit to offline mode or refuse to start.
 */
import { z } from "zod";
import { isLoopbackHostname, isPrivateIp } from "@metis/shared";
import { AIConfigError } from "./errors.js";
import type { ProviderKey } from "./types.js";
import { getConfigService } from "../config/config-service.js";
import { HAIKU_MODEL_ID, SONNET_MODEL_ID } from "./model-router.js";
import {
  COPILOT_MIGRATION_DOC,
  findRetiredEnvRenames,
  isRetiredProviderKey,
  retiredProviderMessage,
} from "./retired-providers.js";

/**
 * Keys whose values may be overridden at runtime via the ConfigService
 * (vault-backed secrets, Tier 2). When the vault holds a value for one of
 * these keys, it WINS over `process.env`. Issue #251 — vault → env precedence.
 */
const VAULT_BACKED_AI_KEYS = [
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "BEDROCK_GATEWAY_API_KEY",
  "LOCAL_GEMMA_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

/**
 * Tier-3 tunable keys that influence AI provider selection. When a value is
 * present in `runtime_config`, it WINS over `process.env`. Issue #258 —
 * runtime provider switching without restart. `AI_DEFAULT_MODEL` is mapped
 * onto the legacy env key `AI_MODEL` so the downstream Zod schema is
 * unchanged.
 */
const TUNABLE_AI_KEYS: ReadonlyArray<readonly [tunable: string, envKey: string]> = [
  ["AI_PROVIDER", "AI_PROVIDER"],
  ["AI_DEFAULT_MODEL", "AI_MODEL"],
  ["AI_MODE", "AI_MODE"],
  ["LOCAL_GEMMA_BASE_URL", "LOCAL_GEMMA_BASE_URL"],
  ["LOCAL_GEMMA_MODEL", "LOCAL_GEMMA_MODEL"],
];

const PROVIDER_KEYS = [
  "bedrock-gateway",
  "local-gemma",
  "openai",
  "azure",
  "anthropic",
  "offline-stub",
] as const satisfies readonly ProviderKey[];

/**
 * Re-exported for callers (e.g. `project-service`) that need to validate
 * user-supplied provider strings without hard-coding the list. Issue #134.
 */
export const SUPPORTED_PROVIDER_KEYS = PROVIDER_KEYS;

/** The wire family a resolved provider config speaks. */
type BYOKType = "openai" | "azure" | "anthropic";

const truthy = (raw: string | undefined): boolean =>
  raw != null && /^(1|true|yes|on)$/i.test(raw.trim());

const trimmed = (raw: string | undefined): string | undefined => {
  if (raw == null) return undefined;
  const t = raw.trim();
  return t.length === 0 ? undefined : t;
};

/** #134 — an empty / whitespace-only env value validates as if it were absent. */
const blankAsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (raw) => (typeof raw === "string" && raw.trim().length === 0 ? undefined : raw),
    schema.optional(),
  );

const aiEnvSchema = z
  .object({
    AI_PROVIDER: z.enum(PROVIDER_KEYS).default("offline-stub"),
    AI_MODEL: z.string().min(1).optional(),
    AI_OFFLINE: z.string().optional(),
    AI_RATE_LIMIT_WINDOW_MS: z.string().optional(),
    AI_RATE_LIMIT_MAX: z.string().optional(),
    AI_PING_TIMEOUT_MS: z.string().optional(),

    GATEWAY_BASE_URL: z.string().url().optional(),
    GATEWAY_API_KEY: z.string().min(1).optional(),
    BEDROCK_GATEWAY_URL: z.string().url().optional(),
    BEDROCK_GATEWAY_API_KEY: z.string().min(1).optional(),
    BEDROCK_ALLOWED_HOSTS: z.string().optional(),
    BEDROCK_MODEL: z.string().optional(),
    BEDROCK_SONNET_PROFILE: z.string().optional(),
    BEDROCK_HAIKU_PROFILE: z.string().optional(),
    // Generalized model-ID -> application-inference-profile-ARN JSON map.
    // Superset of BEDROCK_SONNET_PROFILE/BEDROCK_HAIKU_PROFILE — those two win
    // for the models they name so existing deployments are unaffected.
    BEDROCK_MODEL_PROFILES: z.string().optional(),

    // local-gemma (Ollama OpenAI-compatible server) — additive, never
    // overlaps the Bedrock matrix. Base URL MUST include the `/v1` suffix.
    LOCAL_GEMMA_BASE_URL: z.string().url().optional(),
    LOCAL_GEMMA_MODEL: z.string().min(1).max(200).optional(),
    LOCAL_GEMMA_API_KEY: z.string().min(1).optional(),

    // #134 — openai / azure are served by the direct OpenAI-compatible client.
    // #149 — these are the ONLY names read; the Copilot-era COPILOT_PROVIDER_*
    // fallback is gone (a set-but-unrenamed one is refused by name, see
    // `findRetiredEnvRenames`). A blank value is treated as UNSET: the schema validates every key
    // whatever AI_PROVIDER is, and OPENAI_API_KEY was already read elsewhere
    // (holistic-synthesizer) before #134, so an empty placeholder in `.env`
    // must never break config for an unrelated provider such as local-gemma.
    OPENAI_BASE_URL: blankAsUnset(z.string().url()),
    OPENAI_API_KEY: blankAsUnset(z.string().min(1)),
    AZURE_OPENAI_ENDPOINT: blankAsUnset(z.string().url()),
    AZURE_OPENAI_API_KEY: blankAsUnset(z.string().min(1)),
    AZURE_OPENAI_API_VERSION: blankAsUnset(
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/, "must look like 2024-10-21 or 2025-01-01-preview"),
    ),
    AZURE_OPENAI_DEPLOYMENT: blankAsUnset(z.string().min(1).max(200)),

    // Native Anthropic provider (#285) — talks to api.anthropic.com via the
    // official SDK. Additive; never overlaps the Bedrock matrix.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_AUTH_TOKEN: z.string().min(1).optional(),
    ANTHROPIC_BASE_URL: z.string().url().optional(),
    ANTHROPIC_MODEL: z.string().min(1).max(200).optional(),
  })
  .passthrough();

export type AIEnv = z.infer<typeof aiEnvSchema>;

export interface BYOKProviderConfig {
  type: BYOKType;
  baseUrl: string;
  apiKey?: string;
  /**
   * Optional OAuth/dev token for the native Anthropic provider
   * (`ANTHROPIC_AUTH_TOKEN`). Ignored by the OpenAI-compatible BYOK paths.
   */
  authToken?: string;
  /** #134 — Azure OpenAI data-plane `api-version` (azure only). */
  apiVersion?: string;
  /** #134 — Azure OpenAI deployment name; defaults to the model id (azure only). */
  deployment?: string;
}

export interface AIConfig {
  provider: ProviderKey;
  model: string;
  offline: boolean;
  rateLimit: { windowMs: number; max: number };
  pingTimeoutMs: number;
  /** Resolved endpoint + credentials for the chosen provider — `undefined` offline. */
  sdkProvider?: BYOKProviderConfig;
  /** Internal Bedrock gateway URL (mirrored into `sdkProvider` when chosen). */
  gatewayBaseUrl?: string;
  /** Internal Bedrock gateway API key (mirrored into `sdkProvider`). */
  gatewayApiKey?: string;
  /** Local Gemma (Ollama) OpenAI-compatible base URL (includes `/v1`). */
  localBaseUrl?: string;
  /** Local Gemma bearer token (dummy for Ollama; required header). */
  localApiKey?: string;
  /** Model ID → application inference profile ARN mapping for per-app cost tracking. */
  modelProfileMap?: Record<string, string>;
}

const DEFAULT_RATE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_MAX = 60;
const DEFAULT_PING_TIMEOUT_MS = 1500;
/** Default model for the `openai` / `azure` providers when AI_MODEL is unset. */
const DEFAULT_OPENAI_MODEL = "gpt-4.1";
/** #134 — Azure OpenAI GA data-plane version (mirrors the provider default). */
const DEFAULT_AZURE_API_VERSION = "2024-10-21";
const DEFAULT_BEDROCK_MODEL = SONNET_MODEL_ID;
const DEFAULT_LOCAL_GEMMA_MODEL = "gemma4:12b";
/** Native Anthropic default — BARE id (not the Bedrock `us.anthropic.*` form). */
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

const intOr = (raw: string | undefined, fallback: number, min = 1): number => {
  if (raw == null || raw.trim().length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/**
 * Build the {@link BYOKProviderConfig} (endpoint + credentials) for the chosen
 * provider. Returns `undefined` for the offline stub. Throws `AIConfigError`
 * if the chosen mode is missing required env vars.
 */
export function buildSdkProvider(env: AIEnv): BYOKProviderConfig | undefined {
  const provider = env.AI_PROVIDER;
  if (provider === "offline-stub") return undefined;

  if (provider === "bedrock-gateway") {
    const baseUrl = trimmed(env.BEDROCK_GATEWAY_URL) ?? trimmed(env.GATEWAY_BASE_URL);
    const apiKey = trimmed(env.BEDROCK_GATEWAY_API_KEY) ?? trimmed(env.GATEWAY_API_KEY);
    const missing: string[] = [];
    if (!baseUrl) missing.push("BEDROCK_GATEWAY_URL (or GATEWAY_BASE_URL)");
    if (!apiKey) missing.push("BEDROCK_GATEWAY_API_KEY (or GATEWAY_API_KEY)");
    if (missing.length > 0) {
      throw new AIConfigError(`bedrock-gateway provider requires: ${missing.join(", ")}`, {
        missing,
      });
    }
    validateBedrockGatewayUrl(baseUrl!, env);
    return {
      type: "openai",
      baseUrl: baseUrl!,
      apiKey: apiKey!,
    };
  }

  if (provider === "local-gemma") {
    const baseUrl = trimmed(env.LOCAL_GEMMA_BASE_URL);
    if (!baseUrl) {
      throw new AIConfigError("local-gemma provider requires: LOCAL_GEMMA_BASE_URL", {
        missing: ["LOCAL_GEMMA_BASE_URL"],
      });
    }
    // Ollama ignores the bearer value but the header is mandatory; other
    // OpenAI-compatible runtimes (vLLM/LM Studio) may enforce a real token,
    // so we surface a configured key and fall back to the dummy `ollama`.
    const apiKey = trimmed(env.LOCAL_GEMMA_API_KEY) ?? "ollama";
    validateLocalProviderUrl(baseUrl, env);
    return {
      type: "openai",
      baseUrl,
      apiKey,
    };
  }

  // Native Anthropic provider (#285) — uses the official SDK against
  // api.anthropic.com (or ANTHROPIC_BASE_URL). It does NOT require
  // a base URL: the SDK supplies its own default. The public-LLM-host guard
  // (validateBedrockGatewayUrl) is intentionally NOT applied here — reaching
  // api.anthropic.com with an Anthropic key is the intended behaviour.
  if (provider === "anthropic") {
    // Native anthropic auth is scoped to ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
    // only (#285) — never another provider's credential.
    const apiKey = trimmed(env.ANTHROPIC_API_KEY);
    const authToken = trimmed(env.ANTHROPIC_AUTH_TOKEN);
    if (!apiKey && !authToken) {
      throw new AIConfigError(
        "anthropic provider requires ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)",
        { missing: ["ANTHROPIC_API_KEY"] },
      );
    }
    // baseUrl is optional for this native provider; an empty string means
    // "use the SDK default". The factory only forwards a non-empty value.
    const baseUrl = trimmed(env.ANTHROPIC_BASE_URL) ?? "";
    return {
      type: "anthropic",
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(authToken ? { authToken } : {}),
    };
  }

  // openai/azure (#134) — the OPENAI_* / AZURE_OPENAI_* names only (#149).
  if (provider === "azure") {
    const baseUrl = trimmed(env.AZURE_OPENAI_ENDPOINT);
    const apiKey = trimmed(env.AZURE_OPENAI_API_KEY);
    if (!baseUrl) {
      throw new AIConfigError("azure provider requires AZURE_OPENAI_ENDPOINT", {
        missing: ["AZURE_OPENAI_ENDPOINT"],
      });
    }
    const deployment = trimmed(env.AZURE_OPENAI_DEPLOYMENT);
    return {
      type: "azure",
      baseUrl,
      apiKey,
      apiVersion: trimmed(env.AZURE_OPENAI_API_VERSION) ?? DEFAULT_AZURE_API_VERSION,
      ...(deployment ? { deployment } : {}),
    };
  }
  const baseUrl = trimmed(env.OPENAI_BASE_URL);
  const apiKey = trimmed(env.OPENAI_API_KEY);
  if (!baseUrl) {
    throw new AIConfigError(`${provider} provider requires OPENAI_BASE_URL`, {
      missing: ["OPENAI_BASE_URL"],
    });
  }
  return { type: provider, baseUrl, apiKey };
}

/**
 * M5 — Validate `BEDROCK_GATEWAY_URL` against an explicit allow-list.
 *
 *   • In production (`NODE_ENV=production`), `https://` is mandatory — we
 *     refuse to ship credentials over plaintext to an internal gateway.
 *   • When `BEDROCK_ALLOWED_HOSTS` is set (comma-separated host list), the
 *     URL host MUST match one of the entries (case-insensitive). Subdomain
 *     wildcards are NOT supported on purpose — operators must list every
 *     host explicitly so accidental DNS hijacking can't escalate.
 *   • When the env is unset we still preserve the legacy deny-list against
 *     known public LLM hostnames so a misconfigured deployment can't leak
 *     credentials to OpenAI / Azure / Anthropic.
 */
function validateBedrockGatewayUrl(rawUrl: string, env: AIEnv): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AIConfigError(`BEDROCK_GATEWAY_URL is not a valid URL: ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && parsed.protocol !== "https:") {
    throw new AIConfigError(
      `BEDROCK_GATEWAY_URL must use https in production (got ${parsed.protocol})`,
    );
  }
  const allowRaw = trimmed(env.BEDROCK_ALLOWED_HOSTS);
  if (allowRaw) {
    const allowed = allowRaw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0);
    if (!allowed.includes(host)) {
      throw new AIConfigError(
        `BEDROCK_GATEWAY_URL host "${host}" is not in BEDROCK_ALLOWED_HOSTS (${allowed.join(", ")})`,
      );
    }
    return;
  }
  // No explicit allow-list — fall back to the legacy deny-list.
  if (
    /^(api\.openai\.com|.*\.azure\.com|.*\.anthropic\.com)$/i.test(host) ||
    /\.openai\.com$/i.test(host)
  ) {
    throw new AIConfigError(
      `bedrock-gateway URL points at a public LLM provider (${rawUrl}); refusing to send credentials`,
    );
  }
}

/**
 * #112 — Validate `LOCAL_GEMMA_BASE_URL` for the local-gemma provider.
 *
 * Unlike {@link validateBedrockGatewayUrl}, this validator INTENTIONALLY
 * allows plaintext `http://` to loopback / RFC-1918 / link-local / ULA
 * endpoints — even in production — because the canonical Ollama target is
 * `http://localhost:11434/v1`. It still REFUSES:
 *   • public LLM hostnames (api.openai.com, *.openai.com, *.anthropic.com,
 *     *.azure.com) so a misconfiguration can never egress document content
 *     to a hosted model, and
 *   • any other public / non-private host — the endpoint MUST be a local or
 *     internal address.
 *
 * `validateBedrockGatewayUrl` is deliberately NOT reused (its prod https-only
 * rule would reject `http://localhost`).
 */
export function validateLocalProviderUrl(rawUrl: string, _env: AIEnv): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AIConfigError(`LOCAL_GEMMA_BASE_URL is not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AIConfigError(`LOCAL_GEMMA_BASE_URL must use http or https (got ${parsed.protocol})`);
  }
  const host = parsed.hostname.toLowerCase();
  // Always refuse known public LLM hosts, regardless of resolution.
  if (
    /^(api\.openai\.com|.*\.azure\.com|.*\.anthropic\.com)$/i.test(host) ||
    /\.openai\.com$/i.test(host)
  ) {
    throw new AIConfigError(
      `LOCAL_GEMMA_BASE_URL points at a public LLM provider (${rawUrl}); refusing to send credentials`,
    );
  }
  // Permit loopback hostnames and private/non-routable IP literals only. A
  // public hostname or public IP is rejected so document content cannot leave
  // the local network.
  if (isLoopbackHostname(host) || isPrivateIp(host)) return;
  throw new AIConfigError(
    `LOCAL_GEMMA_BASE_URL host "${host}" must be a loopback or private/internal address (e.g. http://localhost:11434/v1)`,
  );
}

function defaultModel(provider: ProviderKey, env: AIEnv): string {
  if (env.AI_MODEL) return env.AI_MODEL;
  if (provider === "bedrock-gateway") return env.BEDROCK_MODEL ?? DEFAULT_BEDROCK_MODEL;
  if (provider === "local-gemma")
    return trimmed(env.LOCAL_GEMMA_MODEL) ?? DEFAULT_LOCAL_GEMMA_MODEL;
  if (provider === "anthropic") return trimmed(env.ANTHROPIC_MODEL) ?? DEFAULT_ANTHROPIC_MODEL;
  if (provider === "offline-stub") return "offline-stub";
  return DEFAULT_OPENAI_MODEL;
}

/**
 * Build the effective env map by overlaying vault-backed values from the
 * `ConfigService` on top of the supplied env. Used by `loadAIConfig` so the
 * downstream Zod schema is unaware of where each value originated.
 *
 * Behaviour:
 *   - For each key in `VAULT_BACKED_AI_KEYS`, if `ConfigService.get(key)`
 *     returns a non-empty string, that value REPLACES whatever was in env.
 *   - Empty / missing vault entries leave env values untouched (back-compat).
 *   - Errors thrown by ConfigService (e.g. unregistered keys) are swallowed —
 *     this code path must never break AI config loading.
 */
function applyConfigServiceOverlay(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let svc;
  try {
    svc = getConfigService();
  } catch {
    return env;
  }
  const overlay: NodeJS.ProcessEnv = { ...env };
  for (const key of VAULT_BACKED_AI_KEYS) {
    try {
      const value = svc.get(key);
      if (value !== undefined && value !== "") {
        overlay[key] = value;
      }
    } catch {
      // Unknown key shouldn't happen here, but never crash the AI loader.
    }
  }
  for (const [tunableKey, envKey] of TUNABLE_AI_KEYS) {
    try {
      // Only overlay when the value actually originates from runtime_config
      // (`source === "db"`). Otherwise we'd clobber a test-supplied env
      // override with whatever the process-wide ConfigService happens to see
      // in `process.env`.
      const desc = svc.describeSource(tunableKey);
      if (desc.source !== "db") continue;
      const value = svc.get(tunableKey);
      if (value !== undefined && value !== "") {
        overlay[envKey] = value;
      }
    } catch {
      // Same as above — silently skip unknown keys.
    }
  }
  return overlay;
}

/**
 * Load + validate the AI configuration from a process-env-like object. Passing
 * a custom env makes the function trivially testable without mutating
 * `process.env`.
 */
export function loadAIConfig(env: NodeJS.ProcessEnv = process.env): AIConfig {
  const merged = applyConfigServiceOverlay(env);
  assertNoRetiredProviderConfig(env, merged);
  const parsed = aiEnvSchema.safeParse(merged);
  if (!parsed.success) {
    throw new AIConfigError("Invalid AI configuration", {
      issues: parsed.error.flatten(),
    });
  }
  const e = parsed.data;
  const offline = truthy(e.AI_OFFLINE) || e.AI_PROVIDER === "offline-stub";
  const sdkProvider = offline ? undefined : buildSdkProvider(e);
  const provider = offline ? ("offline-stub" as ProviderKey) : e.AI_PROVIDER;
  return {
    provider,
    model: defaultModel(provider, e),
    offline,
    rateLimit: {
      windowMs: intOr(e.AI_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_WINDOW_MS, 1000),
      max: intOr(e.AI_RATE_LIMIT_MAX, DEFAULT_RATE_MAX),
    },
    pingTimeoutMs: intOr(e.AI_PING_TIMEOUT_MS, DEFAULT_PING_TIMEOUT_MS, 100),
    sdkProvider,
    gatewayBaseUrl: trimmed(e.BEDROCK_GATEWAY_URL) ?? trimmed(e.GATEWAY_BASE_URL),
    gatewayApiKey: trimmed(e.BEDROCK_GATEWAY_API_KEY) ?? trimmed(e.GATEWAY_API_KEY),
    localBaseUrl: trimmed(e.LOCAL_GEMMA_BASE_URL),
    localApiKey:
      trimmed(e.LOCAL_GEMMA_API_KEY) ?? (provider === "local-gemma" ? "ollama" : undefined),
    modelProfileMap: buildModelProfileMap(e),
  };
}

/**
 * #149 — refuse a retired provider, and a retired Copilot-era env name the
 * chosen provider used to fall back to, BEFORE schema validation (whose
 * generic "Invalid enum value" would not say what to do). Runs over the merged
 * view, so a `runtime_config` row selecting `copilot-native` is refused exactly
 * like the env var — never silently replaced by another provider.
 *
 * `raw` is the caller's env WITHOUT the runtime-config overlay: it decides only
 * which source to name in the message.
 */
export function assertNoRetiredProviderConfig(
  raw: NodeJS.ProcessEnv,
  merged: NodeJS.ProcessEnv = raw,
): void {
  const selected = merged.AI_PROVIDER;
  if (isRetiredProviderKey(selected)) {
    const fromRuntimeConfig = raw.AI_PROVIDER !== selected;
    throw new AIConfigError(
      retiredProviderMessage(selected, fromRuntimeConfig ? "runtime-config" : "AI_PROVIDER"),
      { retiredProvider: selected.trim(), migration: COPILOT_MIGRATION_DOC },
    );
  }
  if (truthy(merged.AI_OFFLINE)) return;
  // A leftover `COPILOT_MODEL` equal to the openai/azure default (the value
  // .env.example shipped) changes nothing when dropped, so it is not refused.
  const renames = findRetiredEnvRenames((selected ?? "").trim(), merged).filter(
    (r) =>
      !(r.retired === "COPILOT_MODEL" && merged.COPILOT_MODEL?.trim() === DEFAULT_OPENAI_MODEL),
  );
  if (renames.length > 0) {
    const list = renames.map((r) => `${r.retired} → ${r.replacement}`).join(", ");
    throw new AIConfigError(
      `The ${selected!.trim()} provider no longer reads the Copilot-era variable(s) ${renames
        .map((r) => r.retired)
        .join(", ")}. Rename: ${list}. See ${COPILOT_MIGRATION_DOC}.`,
      { renames, migration: COPILOT_MIGRATION_DOC },
    );
  }
}

/**
 * The two key names that carry prototype-pollution meaning: `__proto__` is the
 * pollution vector itself, and `constructor` is the second half of the usual
 * `constructor.prototype` chain. Neither is a valid Bedrock model ID.
 *
 * This is deliberately NOT "every name inherited from `Object.prototype`".
 * `toString`, `valueOf`, `hasOwnProperty` and friends are also reachable
 * through a plain-object lookup and are NOT rejected here: shadowing one of
 * them with a string on this map is harmless, and the separate hazard — that
 * `BedrockDirectProvider.resolveModel` reads the map with a bare bracket
 * lookup and so returns an inherited function for a model ID of `toString` —
 * is pre-existing, lives in that provider, and is equally present when the map
 * is empty. Widening this list would not fix it.
 *
 * `prototype` is likewise not on the list: `({}).prototype` is `undefined`, so
 * it is an ordinary key on a plain object and rejecting it would refuse a
 * (weird but harmless) configuration for no benefit.
 */
const isPrototypePollutionKey = (key: string): boolean =>
  key === "__proto__" || key === "constructor";

/** Build a model-ID → profile-ARN map from env vars. */
function buildModelProfileMap(env: AIEnv): Record<string, string> | undefined {
  const map: Record<string, string> = {};

  const rawProfiles = trimmed(env.BEDROCK_MODEL_PROFILES);
  if (rawProfiles) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawProfiles);
    } catch {
      throw new AIConfigError("BEDROCK_MODEL_PROFILES must be valid JSON");
    }
    const result = z.record(z.string().min(1)).safeParse(parsedJson);
    if (!result.success) {
      throw new AIConfigError(
        "BEDROCK_MODEL_PROFILES must be a flat JSON object mapping model IDs to profile ARN strings",
      );
    }
    // Issue #1219. Zod validates the SHAPE of the record but says nothing
    // about its key NAMES, and the previous `Object.assign(map, result.data)`
    // copied every own enumerable key straight onto `map` — which then escapes
    // as `AIConfig.modelProfileMap` and is read by bracket lookup in
    // `BedrockDirectProvider.resolveModel`. Reject the two prototype-pollution
    // key names instead — see `isPrototypePollutionKey` for what that list does
    // and does not cover — then copy the rest explicitly.
    //
    // The check runs over the RAW `JSON.parse` output, not `result.data`:
    // `JSON.parse` yields `__proto__` as a genuine own property, but Zod
    // rebuilds the record with plain assignment, so the `__proto__` setter
    // swallows a string value and the key disappears before it can be seen
    // here. Checking `result.data` alone would miss it silently.
    for (const key of Object.getOwnPropertyNames(parsedJson as Record<string, unknown>)) {
      if (isPrototypePollutionKey(key)) {
        throw new AIConfigError(
          `BEDROCK_MODEL_PROFILES may not use "${key}" as a model ID — it is a prototype-pollution key name`,
        );
      }
    }
    for (const [modelId, profileArn] of Object.entries(result.data)) {
      map[modelId] = profileArn;
    }
  }

  // Legacy single-model vars win over BEDROCK_MODEL_PROFILES for the two
  // models they name, so existing deployments keep working unchanged.
  const sonnet = trimmed(env.BEDROCK_SONNET_PROFILE);
  const haiku = trimmed(env.BEDROCK_HAIKU_PROFILE);
  if (sonnet) map[SONNET_MODEL_ID] = sonnet;
  if (haiku) map[HAIKU_MODEL_ID] = haiku;

  return Object.keys(map).length > 0 ? map : undefined;
}
