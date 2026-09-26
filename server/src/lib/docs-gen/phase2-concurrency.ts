/**
 * #178 — Phase-2 (section synthesis) concurrency.
 *
 * A batched section (#157) is written as one call per batch. Those calls used
 * to run one after another, so a mid-size project's ~200–300 Phase-2 batch
 * calls took hours even on a provider that could serve them in parallel. The
 * batches of one section now run through a bounded worker pool
 * ({@link mapSettledWithConcurrency}) and are merged in PLAN order.
 *
 * The default depends on the provider kind. A local (Ollama) server serves one
 * request at a time, and the local provider's own per-base-URL limiter
 * (`LOCAL_GEMMA_MAX_CONCURRENCY`) already holds METIS to the server's real
 * parallelism, so the local default stays 1 — nothing is gained by queueing
 * more batches behind the limiter. The cloud providers named in
 * {@link CLOUD_PROVIDER_KEYS} (Bedrock gateway, native Anthropic, OpenAI,
 * Azure) serve concurrent requests, so their default is
 * {@link DEFAULT_PHASE2_CONCURRENCY_CLOUD}. Every other key — `copilot-native`
 * (no documented concurrency limit in the repo), `offline-stub`, and any
 * provider added later — defaults to 1 until someone decides otherwise, so a
 * new provider never inherits parallelism by accident (PR #181 review). An
 * explicit registry value wins for every provider kind.
 */
import { getConfigService, type ConfigService } from "../config/config-service.js";

/** Registry key for the Phase-2 batch concurrency limit. */
export const PHASE2_CONCURRENCY_KEY = "DOCS_GEN_PHASE2_CONCURRENCY";

/** Default for a local (self-hosted) provider: its limiter sets the real bound. */
export const DEFAULT_PHASE2_CONCURRENCY_LOCAL = 1;

/**
 * Default for a cloud provider. Four calls of up to ~10k output tokens each
 * stay well inside Bedrock's and Anthropic's default per-minute quotas for one
 * document, while cutting a 72-batch Rules section from 72 sequential calls to
 * 18 rounds. Raise it through the registry where the account's quota allows.
 */
export const DEFAULT_PHASE2_CONCURRENCY_CLOUD = 4;

/** Upper bound on the setting — the same ceiling as Phase 1's. */
export const MAX_PHASE2_CONCURRENCY = 64;

/** The provider keys that get {@link DEFAULT_PHASE2_CONCURRENCY_CLOUD}. */
export const CLOUD_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "bedrock-gateway",
  "anthropic",
  "openai",
  "azure",
]);

/**
 * The default Phase-2 concurrency for a provider, by its key: the cloud
 * default for a listed cloud provider, 1 for local-gemma and everything else.
 */
export function defaultPhase2Concurrency(providerKey: string): number {
  return CLOUD_PROVIDER_KEYS.has(providerKey)
    ? DEFAULT_PHASE2_CONCURRENCY_CLOUD
    : DEFAULT_PHASE2_CONCURRENCY_LOCAL;
}

/**
 * The configured Phase-2 concurrency for a provider, clamped to
 * `1..MAX_PHASE2_CONCURRENCY`. A missing, non-numeric or non-positive value
 * falls back to the provider kind's default.
 */
export function resolvePhase2Concurrency(
  providerKey: string,
  config: ConfigService = getConfigService(),
): number {
  const fallback = defaultPhase2Concurrency(providerKey);
  const raw = config.getNumber(PHASE2_CONCURRENCY_KEY, fallback);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(Math.floor(raw), MAX_PHASE2_CONCURRENCY);
}
