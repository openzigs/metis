/**
 * Resolve the AI provider to use for a *project-scoped* (sessionless) caller,
 * honoring a per-project provider/model override.
 *
 * This mirrors the chat route: a session created under a project override is
 * bound to that provider, and each of its turns is built from THAT provider's
 * own config (`chatProviderForSession` → `loadAIConfig(env, { provider })`,
 * #241). Surfaces with no session — e.g. Spec Kit command dispatch (#381) — use
 * the same rule, so they get the project's real configured LLM instead of
 * silently falling back to the offline stub or to the global provider.
 *
 * The status codes differ: an override the server cannot build answers 502
 * `AI_PROVIDER_KEY_UNAVAILABLE` here (the typed error #254 asks for), while
 * chat answers 503 for an unbuildable session provider. A client handling both
 * surfaces should treat either as "this provider is not configured".
 *
 * Scope note: this is the env/config + per-project override path ONLY. Session
 * BYOK keys (the vault-backed `resolveProviderKey` in `ai.ts`) are
 * session-scoped and intentionally NOT resolved here — project-scoped callers
 * have no session to read `providerSecretRef` from. Credentials therefore come
 * from the env / Admin → Settings config of the provider being used.
 *
 * OWASP: provider construction failures are surfaced as a typed
 * `AIProviderError` (502). Neither this module nor the resulting error ever
 * carries the API key / secret material in the resolved config, and the
 * loader's reason (env names, endpoints, allowed hosts) goes to the log only.
 */
import { loadAIConfig, type AIConfig } from "./config.js";
import { buildProvider } from "./providers/factory.js";
import { AIProviderError, AIProviderRetiredError } from "./errors.js";
import {
  isRetiredProviderError,
  isRetiredProviderKey,
  retiredProviderMessage,
} from "./retired-providers.js";
import type { AIProvider } from "./types.js";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("ai.project-provider");

/** Minimal per-project override fields read from the `Project` row. */
export interface ProjectProviderOverride {
  aiProviderId: string | null;
  aiModel: string | null;
}

/**
 * The {@link AIConfig} a project's calls run on.
 *
 * #254 — an `aiProviderId` override is loaded as THAT provider's own config
 * (`loadAIConfig(env, { provider })`, the call chat makes for a session's
 * stored provider since #241): its endpoint, its credential, its default model.
 * Copying the global config and swapping only the provider key kept the global
 * provider's `sdkProvider`, so the request went to the global endpoint with the
 * global credential. A non-empty `aiModel` then replaces the model.
 *
 * "Its default model" means the override provider's own setting
 * (`ANTHROPIC_MODEL`, `LOCAL_GEMMA_MODEL`, `BEDROCK_MODEL`) or built-in default.
 * The deployment-wide `AI_MODEL` / Admin `AI_DEFAULT_MODEL` applies only when
 * the override names the deployment's own provider: it is a model of that
 * provider, and the loader drops it for any other (`loadAIConfig`).
 *
 * Throws the loader's error when the override provider is not configured on
 * this server — it never falls back to the global provider. A retired override
 * is refused by name (409, #149) before anything is loaded.
 */
export function loadProjectAIConfig(
  override: ProjectProviderOverride | null,
  env: NodeJS.ProcessEnv = process.env,
): AIConfig {
  const providerKey = override?.aiProviderId || undefined;
  if (providerKey && isRetiredProviderKey(providerKey)) {
    throw new AIProviderRetiredError(retiredProviderMessage(providerKey, "project"), {
      retiredProvider: providerKey,
    });
  }
  const config = loadAIConfig(env, providerKey ? { provider: providerKey } : {});
  return override?.aiModel ? { ...config, model: override.aiModel } : config;
}

/**
 * Build the real AI provider for a project, honoring its per-project override.
 *
 * Looks up `aiProviderId` / `aiModel` on the project row and builds the
 * provider from {@link loadProjectAIConfig}. Any failure to load or build it
 * (e.g. an override provider whose endpoint or credential is not configured)
 * is re-thrown as a typed `AIProviderError` (502) naming the provider, which
 * the route maps to `AI_PROVIDER_KEY_UNAVAILABLE` — never the offline stub,
 * never the global provider, never an opaque 500. As in chat, the loader's
 * reason is logged for the administrator and kept out of the response.
 */
export async function resolveProjectProvider(projectId: string): Promise<AIProvider> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { aiProviderId: true, aiModel: true },
  });
  const named = project?.aiProviderId || null;
  try {
    return buildProvider({ config: loadProjectAIConfig(project ?? null) });
  } catch (err) {
    // #149 — a project override naming a removed provider is not a credentials
    // problem: pass the refusal through so the route answers 409, as chat does.
    if (isRetiredProviderError(err)) throw err;
    log.warn("Project AI provider could not be built", {
      projectId,
      provider: named ?? "(deployment default)",
      reason: err instanceof Error ? err.message : String(err),
    });
    const which = named ? `AI provider "${named}"` : "the deployment's AI provider";
    throw new AIProviderError(
      `Provider credentials unavailable for project: ${which} is not configured on this server. An administrator can find the reason in the server log.`,
    );
  }
}
