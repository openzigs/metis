/**
 * Resolve the AI provider to use for a *project-scoped* (sessionless) caller,
 * honoring a per-project provider/model override.
 *
 * This mirrors the chat route's provider construction
 * (`buildProvider({ config: loadAIConfig() })`, `ai.ts:80-82`) and its
 * per-project override rule (`project.aiProviderId` / `aiModel`,
 * `ai.ts:428-443`), so surfaces with no session — e.g. Spec Kit command
 * dispatch (#381) — get the project's real configured LLM instead of silently
 * falling back to the offline stub.
 *
 * Scope note: this is the env/config + per-project override path ONLY. Session
 * BYOK keys (the vault-backed `resolveProviderKey` in `ai.ts`) are
 * session-scoped and intentionally NOT resolved here — project-scoped callers
 * have no session to read `providerSecretRef` from. Credentials therefore come
 * from the env-derived config exactly as they do for the chat surface at
 * request time.
 *
 * OWASP: provider construction failures are surfaced as a typed
 * `AIProviderError` (502). Neither this module nor the resulting error ever
 * logs the API key / secret material carried in the resolved config.
 */
import { loadAIConfig, type AIConfig } from "./config.js";
import { buildProvider } from "./providers/factory.js";
import { AIProviderError } from "./errors.js";
import type { AIProvider, ProviderKey } from "./types.js";
import { prisma } from "../prisma.js";

/** Minimal per-project override fields read from the `Project` row. */
export interface ProjectProviderOverride {
  aiProviderId: string | null;
  aiModel: string | null;
}

/**
 * Apply a per-project override onto a base {@link AIConfig}.
 *
 * Honors the same precedence as the chat route's session-bind logic
 * (`ai.ts:428-443`): a non-empty `aiProviderId` replaces the provider key, and
 * a non-empty `aiModel` replaces the model. When neither is set the base
 * env/config values are used unchanged. Exported for direct unit testing.
 */
export function applyProjectProviderOverride(
  config: AIConfig,
  override: ProjectProviderOverride | null,
): AIConfig {
  if (!override) return config;
  const next: AIConfig = { ...config };
  if (override.aiProviderId) {
    // Validated at write time in project-service against
    // SUPPORTED_PROVIDER_KEYS, so the cast is safe here (mirrors ai.ts:438).
    next.provider = override.aiProviderId as ProviderKey;
  }
  if (override.aiModel) {
    next.model = override.aiModel;
  }
  return next;
}

/**
 * Build the real AI provider for a project, honoring its per-project override.
 *
 * Looks up `aiProviderId` / `aiModel` on the project row and overlays them on
 * the env-derived {@link AIConfig} before constructing the provider via
 * {@link buildProvider}. Construction failures (e.g. a chosen provider whose
 * credentials are not configured in the environment) are re-thrown as a typed
 * `AIProviderError` (502) so the route layer can surface a clear
 * `AI_PROVIDER_KEY_UNAVAILABLE`-style error instead of silently degrading to
 * the offline stub or throwing an opaque 500.
 */
export async function resolveProjectProvider(projectId: string): Promise<AIProvider> {
  const baseConfig = loadAIConfig();
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { aiProviderId: true, aiModel: true },
  });
  const config = applyProjectProviderOverride(baseConfig, project ?? null);
  try {
    return buildProvider({ config });
  } catch (err) {
    // Re-shape any provider-construction failure into the typed 502 the route
    // maps to AI_PROVIDER_KEY_UNAVAILABLE. The message is the SDK/config
    // message (never the key itself); details are dropped to avoid leaking
    // secret-bearing context.
    const message = err instanceof Error ? err.message : String(err);
    throw new AIProviderError(`Provider credentials unavailable for project: ${message}`);
  }
}
