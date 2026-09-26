/**
 * Embeddings backend registry (Epic #930 / issue #931).
 *
 * The registry is the single seam through which every embeddings backend is
 * declared, discovered, and instantiated. Instead of an `if/else` ladder in
 * the `Embedder` constructor, each backend registers a factory keyed by a
 * stable string (`offline`, `xenova`, `sidecar`, `bedrock`, `bedrock-sdk`,
 * `openai`, `embeddinggemma`, …). Selection is resolved from explicit config
 * or the `EMBED_BACKEND` env var, and an unknown key fails LOUDLY with the
 * list of registered keys so a typo never silently degrades to a wrong model.
 *
 * Backends also surface a small capabilities descriptor so an ops/health
 * endpoint and the admin UI can answer "which backend is active, does it need
 * network egress, what model + dimension does it produce, and is it healthy?"
 * without constructing or warming the model.
 *
 * NOTE: this module deliberately imports NO runtime code from `embedder.ts`
 * (only `embeddings-client.ts` for the sidecar client type + mode helper) so
 * there is no import cycle. `embedder.ts` imports from here and registers the
 * built-in backends on load.
 */
import { DEFAULT_EMBED_MODEL } from "@metis/shared";
import type { EmbedDtype, EmbedPooling } from "./embed-model-config.js";
import type { EmbeddingsClient } from "./embeddings-client.js";
import type { InProcessEmbedRuntime } from "./embed-worker-pipeline.js";
import { resolveEmbeddingsMode } from "./embeddings-client.js";

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimension: number;
  /**
   * Issue #792 — the persisted embedding IDENTITY (`model` when pooling+dtype are
   * the built-in defaults, else `model|pooling|dtype`). Set by backends whose
   * vectors depend on pooling/dtype (xenova, sidecar); OMITTED by backends where
   * the model id alone is the identity (hash stub, cloud APIs). Consumers persist
   * `identity ?? model`, so an absent field means "bare model id" — the
   * back-compatible reading.
   */
  identity?: string;
}

/**
 * Contract every backend must satisfy. `key` and `requiresEgress` were added
 * in #931 so the registry can describe an instance without reaching into its
 * internals. `healthy()` is optional — backends that can cheaply probe their
 * upstream (sidecar `/healthz`, a remote ping) implement it; offline backends
 * omit it and are treated as always-healthy.
 */
export interface EmbedBackend {
  /** Stable registry key, e.g. `"xenova"`. */
  readonly key: string;
  readonly model: string;
  readonly dimension: number;
  /** True when producing embeddings requires outbound network access. */
  readonly requiresEgress: boolean;
  warm(): Promise<void>;
  embed(texts: string[]): Promise<EmbeddingResult>;
  /** Optional liveness probe. Resolves true when the backend is usable. */
  healthy?(): Promise<boolean>;
  /**
   * Issue #792 — the identity the backend produces RIGHT NOW, without ingesting a
   * corpus. Backends whose vectors depend on pooling/dtype implement it (xenova
   * computes it locally; the sidecar probes its wire response so the value is the
   * SIDECAR's truth, not a server guess). Omitted by backends where the model id
   * alone is the identity — callers fall back to `model`. Used by coverage /
   * reindex to decide "does the persisted corpus match what we'd produce now?".
   */
  currentIdentity?(): Promise<string> | string;
}

export interface EmbedderConfig {
  /** Override the model id (defaults vary by backend). */
  model?: string;
  /** Override the output dimension. */
  dimension?: number;
  /**
   * Force a specific backend by registry key. Explicit config always wins
   * over env. Built-in keys: `xenova` | `offline` | `sidecar` | `bedrock` |
   * `bedrock-sdk` | `openai` | `embeddinggemma`.
   */
  backend?: string;
  /** Inject a custom sidecar client (for tests). */
  client?: EmbeddingsClient;
  /**
   * Issue #782 — override the pooling for the local/sidecar backends. Omitted →
   * resolved from the per-model map + `EMBED_POOLING*` env.
   */
  pooling?: EmbedPooling;
  /** Issue #782 — override the ONNX weight dtype. Omitted → `EMBED_DTYPE` / `q8`. */
  dtype?: EmbedDtype;
  /**
   * Issue #189 — where the in-process ONNX backends (`xenova`, `embeddinggemma`)
   * run the model: `worker` (a worker_thread, so inference never blocks the event
   * loop) or `inline`. Omitted → `EMBED_INPROCESS_RUNTIME`, default `worker`.
   */
  inProcessRuntime?: InProcessEmbedRuntime;
}

/** Live capabilities of a constructed backend instance. */
export interface EmbedBackendCapabilities {
  key: string;
  model: string;
  dimension: number;
  requiresEgress: boolean;
}

/**
 * Static description of a registered backend, available WITHOUT constructing
 * the backend. Powers the admin "available backends" table.
 */
export interface EmbedBackendDescriptor {
  key: string;
  label: string;
  description: string;
  requiresEgress: boolean;
  defaultModel: string;
  defaultDimension: number;
  /** True when the backend can run with no outbound network (air-gapped). */
  offlineCapable: boolean;
}

export type EmbedBackendFactory = (cfg: EmbedderConfig) => EmbedBackend;

interface RegistryEntry {
  factory: EmbedBackendFactory;
  descriptor: EmbedBackendDescriptor;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Aliases that map historical / friendly names onto the canonical registry
 * key so existing env values (`EMBED_BACKEND=hash`, `remote`) keep working.
 */
const KEY_ALIASES: Record<string, string> = {
  hash: "offline",
  local: "offline",
  remote: "sidecar",
  "embeddings-sidecar": "sidecar",
  "bedrock-gateway": "bedrock",
  gateway: "bedrock",
  "azure-openai": "openai",
  azure: "openai",
  gemma: "embeddinggemma",
  "embedding-gemma": "embeddinggemma",
};

export function normalizeBackendKey(key: string): string {
  const lower = key.trim().toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/**
 * Register a backend factory under a stable key. Re-registering an existing
 * key overwrites it (used by tests + lets a deployment override a built-in).
 */
export function registerBackend(
  key: string,
  factory: EmbedBackendFactory,
  descriptor: Omit<EmbedBackendDescriptor, "key">,
): void {
  const canonical = normalizeBackendKey(key);
  registry.set(canonical, { factory, descriptor: { key: canonical, ...descriptor } });
}

export function isBackendRegistered(key: string): boolean {
  return registry.has(normalizeBackendKey(key));
}

export function listBackendKeys(): string[] {
  return [...registry.keys()].sort();
}

export function listBackendDescriptors(): EmbedBackendDescriptor[] {
  return [...registry.values()].map((e) => e.descriptor).sort((a, b) => a.key.localeCompare(b.key));
}

export function getBackendDescriptor(key: string): EmbedBackendDescriptor | undefined {
  return registry.get(normalizeBackendKey(key))?.descriptor;
}

/** Test seam — wipe the registry (built-ins re-register on module reload). */
export function __clearBackendRegistry(): void {
  registry.clear();
}

function isOfflineEnv(): boolean {
  return process.env.AI_OFFLINE === "1" || process.env.AI_OFFLINE === "true";
}

/**
 * Is this model id the offline hash stub? (#783)
 *
 * `metis-offline-hash-v1` is not a HuggingFace repo — it is the name of the
 * deterministic stub. Asking any transformers backend to load it is a guaranteed
 * 404/401 against the hub, which (before #783) fell through to the SILENT hash
 * fallback. The net effect was that the shipped `.env` produced hash vectors via
 * an unauthorized network round-trip and a warning nobody read. Selecting the
 * `offline` backend from the model id makes that configuration mean what it
 * plainly says, with no egress and no fallback in the loop.
 */
export function isOfflineHashModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === DEFAULT_EMBED_MODEL.toLowerCase();
}

/**
 * Resolve which backend key to use from explicit config + environment.
 *
 * Precedence (first match wins):
 *   1. `cfg.backend`            — explicit override (normalized).
 *   2. `AI_OFFLINE=1`           — deterministic hash backend.
 *   3. `EMBED_BACKEND=<key>`    — operator-selected backend (normalized).
 *   4. hash model id            — `EMBED_MODEL=metis-offline-hash-v1` (#783).
 *   5. sidecar mode             — `EMBEDDINGS_MODE=sidecar` (or prod default).
 *   6. fallback                 — in-process `xenova`.
 *
 * This preserves the pre-#931 defaults exactly: with no `EMBED_BACKEND` set,
 * `AI_OFFLINE` still pins the hash backend, the sidecar still wins when its
 * mode is active, and everything else lands on Xenova.
 *
 * Rule 4 sits BELOW `EMBED_BACKEND` deliberately. An operator who writes
 * `EMBED_BACKEND=xenova` + `EMBED_MODEL=metis-offline-hash-v1` has written a
 * contradiction, and the honest answer to a contradiction is the loud load
 * failure they now get — not a backend silently chosen for them.
 */
export function resolveBackendKey(cfg: EmbedderConfig = {}): string {
  if (cfg.backend) return normalizeBackendKey(cfg.backend);
  if (isOfflineEnv()) return "offline";
  const envBackend = process.env.EMBED_BACKEND?.trim();
  if (envBackend) return normalizeBackendKey(envBackend);
  if (isOfflineHashModel(cfg.model ?? process.env.EMBED_MODEL)) return "offline";
  if (resolveEmbeddingsMode() === "sidecar") return "sidecar";
  return "xenova";
}

/**
 * Resolve + construct the configured backend. Throws loudly with the set of
 * registered keys when the resolved key is unknown.
 */
export function createBackend(cfg: EmbedderConfig = {}): EmbedBackend {
  const key = resolveBackendKey(cfg);
  const entry = registry.get(key);
  if (!entry) {
    throw new Error(
      `Unknown embeddings backend "${key}". Registered backends: ${listBackendKeys().join(", ") || "(none)"}. ` +
        `Set EMBED_BACKEND to one of these, or register a custom backend with registerBackend().`,
    );
  }
  return entry.factory(cfg);
}

export function capabilitiesOf(backend: EmbedBackend): EmbedBackendCapabilities {
  return {
    key: backend.key,
    model: backend.model,
    dimension: backend.dimension,
    requiresEgress: backend.requiresEgress,
  };
}
