/**
 * Provider factory.
 *
 * #134 — routing: `anthropic` → {@link AnthropicProvider}; `local-gemma`,
 * `bedrock-gateway`, `openai`, `azure` → {@link OpenAICompatibleProvider};
 * `offline-stub` → {@link OfflineStubProvider}; only `copilot-native` builds a
 * {@link CopilotWrapper}-backed {@link CopilotProvider}.
 *
 * Reads the loaded {@link AIConfig} and returns the right `AIProvider`
 * implementation. Two seams exist for tests:
 *   • `wrapperFactory`  — inject a custom CopilotWrapper (lets us pass a stub
 *                         CopilotClientLike without touching the real SDK).
 *   • `offlineProvider` — inject a custom offline-stub instance.
 *
 * Anything that fails to construct in non-offline mode is surfaced as an
 * `AIProviderError` so the route layer can decide whether to fall back to
 * the offline stub.
 */
import { AIProviderError } from "../errors.js";
import { CopilotWrapper, type CopilotWrapperOptions } from "../copilot-wrapper.js";
import type { AIConfig } from "../config.js";
import type { AIProvider, ProviderKey } from "../types.js";
import { CopilotProvider } from "./copilot-provider.js";
import {
  DEFAULT_AZURE_API_VERSION,
  OpenAICompatibleProvider,
} from "./openai-compatible-provider.js";
import { OfflineStubProvider } from "./offline-stub-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { RemoteCopilotClient, resolveCopilotNativeMode } from "../remote-copilot-client.js";
import { maybeWrapProviderForFixtures } from "../fixtures/install.js";

export interface BuildProviderOptions {
  config: AIConfig;
  /** Construct the wrapper used by Copilot/BYOK providers (tests inject stubs). */
  wrapperFactory?: (opts: CopilotWrapperOptions) => CopilotWrapper;
  /** Force the offline-stub even when config wouldn't otherwise enable it. */
  forceOffline?: boolean;
  offlineProvider?: AIProvider;
  /**
   * Per-call BYOK key override — used when the caller has resolved the
   * session's `providerSecretRef` via the vault. When provided, the value
   * replaces the env-derived `sdkProvider.apiKey` so the SDK talks to the
   * gateway with the per-session key.
   */
  apiKeyOverride?: string;
}

const isCopilotKey = (key: ProviderKey): boolean => key !== "offline-stub";

/**
 * Provider keys served by the direct OpenAI-compatible HTTP client (#134).
 * Every key except `copilot-native`, `anthropic` (its own Messages client) and
 * `offline-stub` is here, so NO key but `copilot-native` ever reaches the
 * Copilot SDK wrapper. Before #134 `openai`, `azure` and `bedrock-gateway`
 * fell through to the wrapper as bring-your-own-key sessions.
 */
const DIRECT_OPENAI_COMPATIBLE_KEYS: ReadonlySet<ProviderKey> = new Set([
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
  if (!isCopilotKey(cfg.provider)) {
    return opts.offlineProvider ?? OfflineStubProvider.fromEnv();
  }

  // Native Anthropic provider (#285). Anthropic's Messages API is NOT
  // OpenAI-compatible, so `anthropic` must build the dedicated
  // `AnthropicProvider` (official SDK) here rather than falling through to the
  // Copilot wrapper / OpenAI-compatible path below. The Bedrock path
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

  const factory = opts.wrapperFactory ?? ((wrapperOpts) => new CopilotWrapper(wrapperOpts));
  const sdkProvider =
    opts.apiKeyOverride && cfg.sdkProvider
      ? { ...cfg.sdkProvider, apiKey: opts.apiKeyOverride }
      : cfg.sdkProvider;

  // When `COPILOT_NATIVE_MODE=sidecar`, replace the in-process SDK with the
  // remote shim that talks to the optional copilot-svc container (#180).
  // The remote client is constructed eagerly so config drift (missing
  // `COPILOT_NATIVE_TOKEN`) fails the provider build instead of the first
  // user request.
  let injectedClient: CopilotWrapperOptions["client"] | undefined;
  if (resolveCopilotNativeMode() === "sidecar") {
    try {
      injectedClient = new RemoteCopilotClient();
    } catch (err) {
      throw new AIProviderError(
        `failed to construct copilot sidecar client: ${(err as Error).message}`,
      );
    }
  }

  let wrapper: CopilotWrapper;
  try {
    wrapper = factory({
      ...(cfg.authDir ? { authPath: `${cfg.authDir}/auth.json` } : {}),
      model: cfg.model,
      provider: sdkProvider,
      ...(injectedClient ? { client: injectedClient } : {}),
    });
  } catch (err) {
    throw new AIProviderError(`failed to construct Copilot wrapper: ${(err as Error).message}`);
  }
  return new CopilotProvider({
    wrapper,
    key: cfg.provider,
    model: cfg.model,
    pingTimeoutMs: cfg.pingTimeoutMs,
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
