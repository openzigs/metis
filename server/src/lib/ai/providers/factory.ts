/**
 * Provider factory.
 *
 * #134 — routing: `anthropic` → {@link AnthropicProvider}; `local-gemma`,
 * `bedrock-gateway`, `openai`, `azure` → {@link OpenAICompatibleProvider};
 * `offline-stub` → {@link OfflineStubProvider}.
 *
 * #149 — `copilot-native` was removed. A config that still names it (the
 * env/runtime-config path is refused earlier, in `loadAIConfig`; a project
 * override or a stored session can still carry it) is an `AIConfigError`
 * naming the supported providers — never a fall-through to another provider.
 * So is any other key this factory does not know.
 *
 * Reads the loaded {@link AIConfig} and returns the right `AIProvider`
 * implementation. `offlineProvider` is the test seam for the offline stub.
 */
import { AIConfigError, AIProviderError } from "../errors.js";
import type { AIConfig } from "../config.js";
import type { AIProvider } from "../types.js";
import {
  DEFAULT_AZURE_API_VERSION,
  OpenAICompatibleProvider,
} from "./openai-compatible-provider.js";
import { OfflineStubProvider } from "./offline-stub-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { maybeWrapProviderForFixtures } from "../fixtures/install.js";
import { isRetiredProviderKey, retiredProviderMessage } from "../retired-providers.js";

export interface BuildProviderOptions {
  config: AIConfig;
  /** Force the offline-stub even when config wouldn't otherwise enable it. */
  forceOffline?: boolean;
  offlineProvider?: AIProvider;
  /**
   * Per-call BYOK key override — used when the caller has resolved the
   * session's `providerSecretRef` via the vault. When provided, the value
   * replaces the env-derived `sdkProvider.apiKey` so the provider talks to its
   * endpoint with the per-session key.
   */
  apiKeyOverride?: string;
}

/**
 * Provider keys served by the direct OpenAI-compatible HTTP client (#134).
 * Every supported key except `anthropic` (its own Messages client) and
 * `offline-stub` is here.
 */
const DIRECT_OPENAI_COMPATIBLE_KEYS: ReadonlySet<string> = new Set([
  "local-gemma",
  "bedrock-gateway",
  "openai",
  "azure",
]);

/**
 * Build the base provider from config. The public {@link buildProvider}
 * wraps this result with the record/replay fixture harness (#234) when
 * `AI_RECORD`/`AI_REPLAY` are set, so the wiring lives in exactly one place.
 */
function buildBaseProvider(opts: BuildProviderOptions): AIProvider {
  const cfg = opts.config;
  if (opts.forceOffline || cfg.offline || cfg.provider === "offline-stub") {
    return opts.offlineProvider ?? OfflineStubProvider.fromEnv();
  }
  // #149 — a retired key (e.g. a project override or stored session still
  // naming `copilot-native`) is refused by name, never routed elsewhere.
  if (isRetiredProviderKey(cfg.provider)) {
    throw new AIConfigError(retiredProviderMessage(cfg.provider, "project"), {
      retiredProvider: cfg.provider,
    });
  }

  // Native Anthropic provider (#285). Anthropic's Messages API is NOT
  // OpenAI-compatible, so `anthropic` must build the dedicated
  // `AnthropicProvider` (official SDK) here rather than falling through to the
  // OpenAI-compatible path below. The Bedrock path
  // (`us.anthropic.*` model ids via the gateway) is unaffected.
  if (cfg.provider === "anthropic") {
    if (!cfg.sdkProvider) {
      throw new AIProviderError(
        "anthropic provider reached the factory without a resolved sdkProvider config",
      );
    }
    const apiKey = opts.apiKeyOverride ?? cfg.sdkProvider.apiKey;
    return new AnthropicProvider({
      ...(apiKey ? { apiKey } : {}),
      ...(cfg.sdkProvider.authToken ? { authToken: cfg.sdkProvider.authToken } : {}),
      // Empty baseUrl means "use the SDK default" — only forward a real value.
      ...(cfg.sdkProvider.baseUrl ? { baseUrl: cfg.sdkProvider.baseUrl } : {}),
      model: cfg.model,
    });
  }

  // #113 / #134 — the direct OpenAI-compatible client. `local-gemma` and
  // `bedrock-gateway` get exactly the construction `server.ts` / `analysis.ts`
  // already used for them, so the local provider keeps every behaviour it has
  // (thinking-off, the per-base-URL limiter, LOCAL_GEMMA_* timeouts, the
  // structured-output / temperature / reasoning-effort fallbacks) — none of it
  // is re-implemented here. `azure` adds its deployment URL + api-version.
  if (DIRECT_OPENAI_COMPATIBLE_KEYS.has(cfg.provider)) {
    if (!cfg.sdkProvider) {
      throw new AIProviderError(
        `${cfg.provider} reached the factory without a resolved sdkProvider config`,
      );
    }
    return new OpenAICompatibleProvider({
      baseUrl: cfg.sdkProvider.baseUrl,
      apiKey: opts.apiKeyOverride ?? cfg.sdkProvider.apiKey ?? "",
      model: cfg.model,
      providerKey: cfg.provider,
      modelProfileMap: cfg.modelProfileMap,
      ...(cfg.provider === "azure"
        ? {
            azure: {
              apiVersion: cfg.sdkProvider.apiVersion ?? DEFAULT_AZURE_API_VERSION,
              ...(cfg.sdkProvider.deployment ? { deployment: cfg.sdkProvider.deployment } : {}),
            },
          }
        : {}),
    });
  }

  throw new AIConfigError(`Unknown AI provider "${String(cfg.provider)}"`, {
    provider: cfg.provider,
  });
}

export function buildProvider(opts: BuildProviderOptions): AIProvider {
  return maybeWrapProviderForFixtures(buildBaseProvider(opts));
}

let singleton: AIProvider | null = null;
export function getProvider(opts: BuildProviderOptions): AIProvider {
  if (!singleton) singleton = buildProvider(opts);
  return singleton;
}

/** Test helper. */
export function __resetProviderSingleton(): void {
  singleton = null;
}
