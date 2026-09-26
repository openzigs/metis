/**
 * Embedding service (Phase 5 / issue #41; refactored to a pluggable registry
 * in Epic #930 / issue #931).
 *
 * `Embedder` is a thin façade over a backend resolved from the registry
 * (`embedder-registry.ts`). The built-in backends are:
 *
 *   1. `xenova`         — in-process semantic embeddings via
 *      `@huggingface/transformers` (default `Alibaba-NLP/gte-modernbert-base`,
 *      768d, CLS-pooled, q8 — flipped from bge-small by #783). Honors the
 *      `HF_HUB_OFFLINE` / `TRANSFORMERS_CACHE` air-gapped bundle (#936).
 *      The registry key stays `xenova` for config compatibility (`EMBED_BACKEND`,
 *      persisted rows, admin UI) even though the runtime moved off that package
 *      in #781.
 *   2. `embeddinggemma` — Google EmbeddingGemma ONNX
 *      (`onnx-community/embeddinggemma-300m-ONNX`) via the same runtime, with
 *      Matryoshka dimension truncation (`EMBED_DIM` 768/512/256/128) (#939).
 *   3. `offline`        — deterministic hash stub (`metis-offline-hash-v1`)
 *      used by tests + `AI_OFFLINE=1`.
 *   4. `sidecar`        — the `metis-embeddings` HTTP sidecar (#935).
 *   5. `bedrock`        — Bedrock Access Gateway, OpenAI-shaped (#932).
 *   6. `bedrock-sdk`    — direct AWS SDK `InvokeModel` (#933).
 *   7. `openai`         — generic OpenAI / Azure OpenAI embeddings (#934).
 *
 * Backend selection is resolved by `resolveBackendKey` from explicit config or
 * `EMBED_BACKEND`. An unknown key fails loudly.
 *
 * ## Hash fallback — OPT-IN as of #783 (it used to be automatic, and silent)
 *
 * Until #783, a `xenova`/`sidecar` backend that failed to load (a 401, a missing
 * air-gapped weight, an unreachable sidecar) was silently swapped for the
 * deterministic {@link HashEmbedder}: the process kept serving, every subsequent
 * ingest wrote NON-SEMANTIC vectors, and the only trace was one `warn` line at
 * boot. Retrieval degrades to noise while every health check stays green — which
 * is exactly how this deployment ran for months without anyone noticing.
 *
 * Now: the hash stub is used ONLY when it was ASKED for —
 * `EMBED_BACKEND=offline`, `AI_OFFLINE=1`, `EMBED_MODEL=metis-offline-hash-v1`,
 * or the explicit `EMBED_ALLOW_HASH_FALLBACK=1` escape hatch for dev/offline
 * work. Otherwise a backend that cannot load THROWS, the failure is recorded on
 * the embedder, and it surfaces in `/readyz` and Admin → Embedding backends.
 * A production misconfiguration cannot quietly serve hash vectors.
 *
 * Every embedding result is tagged with the backend's model id; the chunk row
 * in Prisma persists that id (`KnowledgeChunk.embeddingModel`) so a later model
 * swap can backfill incrementally (see the re-index workflow in #937).
 */
import {
  DEFAULT_EMBED_DIMENSION,
  DEFAULT_EMBED_MODEL,
  DEFAULT_XENOVA_EMBED_MODEL,
  OFFLINE_EMBED_DIMENSION,
} from "@metis/shared";
import { embedTexts as offlineEmbed } from "../ai/embeddings.js";
import { createChildLogger } from "../logger.js";
import {
  declaredPoolingFromConfig,
  forwardBatches,
  isEmbedOffline,
  resolveDtype,
  resolvePooling,
  resolveRemoteHost,
  type EmbedDtype,
  type EmbedPooling,
  type PoolingSource,
} from "./embed-model-config.js";
import { formatEmbeddingIdentity, identityFromWire } from "./embedding-identity.js";
import { EmbeddingsClient, getEmbeddingsClient } from "./embeddings-client.js";
import {
  capabilitiesOf,
  createBackend,
  listBackendDescriptors,
  registerBackend,
  type EmbedBackend,
  type EmbedBackendCapabilities,
  type EmbedBackendDescriptor,
  type EmbedderConfig,
  type EmbeddingResult,
} from "./embedder-registry.js";
import { registerCloudBackends } from "./backends/index.js";
import {
  createWorkerPipeline,
  resolveInProcessRuntime,
  type InProcessEmbedRuntime,
  type WorkerTransformersEnv,
} from "./embed-worker-pipeline.js";
import { MAX_EMBED_SEQUENCE_TOKENS } from "./embed-input-budget.js";

const log = createChildLogger("rag-embedder");

export type { EmbeddingResult, EmbedderConfig, EmbedBackendCapabilities, EmbedBackendDescriptor };
export { listBackendDescriptors };

/** EmbeddingGemma's native ONNX model id + dimension (issue #939). */
export const EMBEDDING_GEMMA_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
const EMBEDDING_GEMMA_NATIVE_DIM = 768;
/** Valid Matryoshka truncation targets for EmbeddingGemma (issue #939). */
export const EMBEDDING_GEMMA_DIMENSIONS = [768, 512, 256, 128] as const;

// ---------------------------------------------------------------------------
// Hash backend (offline / test stub)
// ---------------------------------------------------------------------------

class HashEmbedder implements EmbedBackend {
  readonly key = "offline";
  readonly model: string;
  readonly dimension: number;
  readonly requiresEgress = false;
  private loaded = false;
  private loader: Promise<void> | null = null;

  constructor(model: string, dimension: number) {
    this.model = model;
    this.dimension = dimension;
  }

  async warm(): Promise<void> {
    if (this.loaded) return;
    if (!this.loader) this.loader = this.load();
    await this.loader;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], model: this.model, dimension: this.dimension };
    }
    await this.warm();
    const result = await offlineEmbed(texts, { model: this.model, dimension: this.dimension });
    return { vectors: result.vectors, model: result.model, dimension: result.dimension };
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  private async load(): Promise<void> {
    log.debug("hash embedder loaded", { model: this.model, dimension: this.dimension });
    this.loaded = true;
  }
}

// ---------------------------------------------------------------------------
// Xenova backend (real `@huggingface/transformers`, transformers.js v3)
//
// Issue #781 — the runtime moved from the unmaintained `@xenova/transformers`
// 2.17.2 to `@huggingface/transformers` v3. v2 registers neither the
// `modernbert` nor the `gemma3` architecture, so ModernBERT embedders could not
// load at all and the `embeddinggemma` backend below was dead on arrival. The
// registry KEY (`xenova`) and the class name are retained: they name a config
// surface (`EMBED_BACKEND=xenova`, `KnowledgeChunk.embeddingModel` rows), not
// the npm package.
// ---------------------------------------------------------------------------

type XenovaPipelineFactory = (
  task: "feature-extraction",
  model: string,
  opts?: { dtype?: string },
) => Promise<XenovaPipeline>;

interface XenovaPipeline {
  (
    texts: string | string[],
    opts: { pooling: EmbedPooling; normalize: boolean },
  ): Promise<XenovaTensor>;
  model?: { config?: unknown };
  /** transformers.js truncates every row to `model_max_length` tokens. */
  tokenizer?: { model_max_length?: number };
}

/**
 * Issue #189 — the longest token sequence the in-process model is ever given.
 *
 * gte-modernbert-base ACCEPTS 8,192 tokens, and transformers.js truncates at the
 * tokenizer's `model_max_length` — so before this cap an over-long chunk ran at the
 * full 8,192. Attention cost is quadratic in that length: one such row materialises
 * a 12-head × 8,192 × 8,192 fp32 score tensor (~3.2 GB) for its softmax — the
 * `onnxruntime::Softmax` → `MlasComputeSoftmaxThreaded` frame and the 4–5 GB RSS
 * seen in the hung server, fed by a 51,081-character generated-doc chunk.
 *
 * The worst-case row costs 1/16 of the full-context softmax. The chunkers are the
 * primary bound: ASCII chunks by their character windows, and (#201) any chunk
 * holding non-ASCII text by its UTF-8 byte length — see `embed-input-budget.ts`,
 * which also records why "a token covers at least one character" was not enough.
 * This cap is the backstop for a caller that forgets.
 */
export { MAX_EMBED_SEQUENCE_TOKENS };

/**
 * Issue #189 — texts per model call in the WORKER runtime. The #807 policy already
 * gives a quantized dtype one text per call; this additionally bounds an `fp32`
 * call (uncapped by that policy, and batch-invariant, so splitting it is exact),
 * so an interleaved query never waits behind one enormous forward pass.
 */
export const EMBED_WORKER_MAX_TEXTS_PER_CALL = 16;

/** Lower (never raise) a pipeline tokenizer's truncation length. */
export function capTokenizerSequenceLength(
  pipeline: Pick<XenovaPipeline, "tokenizer">,
  maxTokens: number = MAX_EMBED_SEQUENCE_TOKENS,
): number | null {
  const tokenizer = pipeline.tokenizer;
  if (!tokenizer) return null;
  const current = tokenizer.model_max_length;
  tokenizer.model_max_length =
    typeof current === "number" && Number.isFinite(current)
      ? Math.min(current, maxTokens)
      : maxTokens;
  return tokenizer.model_max_length;
}

interface XenovaTensor {
  data: Float32Array;
  dims: number[];
  tolist?(): number[][];
}

interface XenovaEnv {
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  cacheDir?: string;
  localModelPath?: string;
  /** #784 — base URL for weight downloads. Retargeted at an internal mirror by `HF_ENDPOINT`. */
  remoteHost?: string;
}

export interface XenovaBackendOptions {
  /** Registry key this instance reports (e.g. `xenova` or `embeddinggemma`). */
  key?: string;
  /**
   * The model's native output dimension. When `dimension < nativeDimension`
   * and `matryoshka` is set, vectors are truncated + renormalized (#939).
   */
  nativeDimension?: number;
  /** Enable Matryoshka truncation to the configured `dimension`. */
  matryoshka?: boolean;
  /**
   * Issue #782 — explicit pooling override. Omitted → resolved from the
   * per-model map / `EMBED_POOLING*` env (see `embed-model-config.ts`).
   */
  pooling?: EmbedPooling;
  /** Issue #782 — explicit dtype override. Omitted → `EMBED_DTYPE` / `q8`. */
  dtype?: EmbedDtype;
  /** Issue #189 — `worker` or `inline`. Omitted → `EMBED_INPROCESS_RUNTIME` / `worker`. */
  runtime?: InProcessEmbedRuntime;
  /** Issue #189 — tokenizer truncation length. Omitted → {@link MAX_EMBED_SEQUENCE_TOKENS}. */
  maxTokens?: number;
  /** Issue #189 — test seam: the module the WORKER loads in place of transformers.js. */
  workerModuleUrl?: string;
}

export class XenovaEmbedder implements EmbedBackend {
  readonly key: string;
  readonly model: string;
  readonly dimension: number;
  readonly requiresEgress: boolean;
  /** Resolved pooling for this model — CLS for gte-modernbert/Granite, mean otherwise. */
  readonly pooling: EmbedPooling;
  /** Resolved ONNX weight dtype. MUST match what an air-gapped image baked. */
  readonly dtype: EmbedDtype;
  /**
   * Issue #792 — the persisted identity for this in-process backend, derived
   * LOCALLY because the in-process backend IS the producer: it knows its own
   * pooling+dtype. `model` when they are the built-in defaults, else
   * `model|pooling|dtype`.
   */
  readonly identity: string;
  /** Issue #189 — where the model runs. */
  readonly runtime: InProcessEmbedRuntime;
  private readonly maxTokens: number;
  private readonly workerModuleUrl: string | undefined;
  private readonly poolingSource: PoolingSource;
  private readonly nativeDimension: number;
  private readonly matryoshka: boolean;
  private pipeline: XenovaPipeline | null = null;
  private loader: Promise<void> | null = null;

  constructor(model: string, dimension: number, opts: XenovaBackendOptions = {}) {
    this.key = opts.key ?? "xenova";
    this.model = model;
    this.dimension = dimension;
    this.nativeDimension = opts.nativeDimension ?? dimension;
    this.matryoshka = opts.matryoshka ?? false;
    const resolved = resolvePooling(model, opts.pooling);
    this.pooling = resolved.pooling;
    this.poolingSource = resolved.source;
    this.dtype = opts.dtype ?? resolveDtype();
    this.identity = formatEmbeddingIdentity(this.model, this.pooling, this.dtype);
    this.runtime = opts.runtime ?? resolveInProcessRuntime();
    this.maxTokens = opts.maxTokens ?? MAX_EMBED_SEQUENCE_TOKENS;
    this.workerModuleUrl = opts.workerModuleUrl;
    // When an offline bundle is configured the model is read from disk, so no
    // egress is required; otherwise the first load reaches the HF hub.
    this.requiresEgress = !isXenovaOffline();
  }

  /** Issue #792 — computed locally at construction; no I/O. */
  currentIdentity(): string {
    return this.identity;
  }

  async warm(): Promise<void> {
    if (this.pipeline) return;
    if (!this.loader) this.loader = this.load();
    await this.loader;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], model: this.model, dimension: this.dimension };
    }
    await this.warm();
    if (!this.pipeline) {
      throw new Error("xenova pipeline failed to load");
    }
    // #807 — the model forward is bounded by `forwardBatches`, NOT by `texts`.
    // At a quantized dtype the ONNX graph derives one PER-TENSOR activation scale
    // from the whole `[batch, seq, hidden]` tensor, so batch-mates change each
    // other's vectors (measured: cos(batch-1, batch-64) = 0.974). Splitting the
    // forward pass is what makes `(model, text) → vector` an actual function —
    // which #787/#792's model-tagged reuse guard already assumes it is.
    let vectors: number[][] = [];
    for (const batch of this.modelCalls(texts)) {
      const tensor = await this.pipeline(batch, { pooling: this.pooling, normalize: true });
      vectors.push(...tensorToVectors(tensor, batch.length, this.nativeDimension));
    }
    if (this.matryoshka && this.dimension < this.nativeDimension) {
      vectors = vectors.map((v) => truncateAndNormalize(v, this.dimension));
    }
    return { vectors, model: this.model, dimension: this.dimension, identity: this.identity };
  }

  async healthy(): Promise<boolean> {
    try {
      await this.warm();
      return this.pipeline !== null;
    } catch {
      return false;
    }
  }

  /** Stop the worker (no-op inline). The next embed loads the model again. */
  async close(): Promise<void> {
    const pipeline = this.pipeline as (XenovaPipeline & { close?: () => Promise<void> }) | null;
    this.pipeline = null;
    this.loader = null;
    await pipeline?.close?.();
  }

  /** #807's forward batches; in the worker, further bounded (exact for fp32). */
  private modelCalls(texts: string[]): string[][] {
    const batches = forwardBatches(texts, this.dtype);
    if (this.runtime === "inline") return batches;
    return batches.flatMap((batch) => {
      const out: string[][] = [];
      for (let i = 0; i < batch.length; i += EMBED_WORKER_MAX_TEXTS_PER_CALL) {
        out.push(batch.slice(i, i + EMBED_WORKER_MAX_TEXTS_PER_CALL));
      }
      return out;
    });
  }

  private async load(): Promise<void> {
    if (this.runtime === "worker") {
      await this.loadInWorker();
      return;
    }
    // Dynamic import keeps the heavy WASM/ONNX runtime out of the test path.
    const moduleName = "@huggingface/transformers";
    let transformers: { pipeline: XenovaPipelineFactory; env?: XenovaEnv };
    try {
      transformers = (await import(moduleName)) as {
        pipeline: XenovaPipelineFactory;
        env?: XenovaEnv;
      };
    } catch (err) {
      throw new Error(
        `Failed to import "@huggingface/transformers": ${(err as Error).message}. ` +
          "Install the dependency or run with EMBED_BACKEND=offline / AI_OFFLINE=1.",
      );
    }
    applyXenovaOfflineEnv(transformers.env);
    // #782 — the resolved pooling + dtype are logged at load so a wrong pooling
    // is at least *visible* in the logs instead of silently degrading vectors.
    log.info("loading xenova model", {
      model: this.model,
      pooling: this.pooling,
      poolingSource: this.poolingSource,
      dtype: this.dtype,
      offline: isXenovaOffline(),
      cacheDir: process.env.TRANSFORMERS_CACHE ?? null,
    });
    try {
      this.pipeline = await transformers.pipeline("feature-extraction", this.model, {
        dtype: this.dtype,
      });
    } catch (err) {
      throw this.loadError(err);
    }
    const maxTokens = capTokenizerSequenceLength(this.pipeline, this.maxTokens);
    this.afterLoad(maxTokens);
  }

  /** Issue #189 — load the model inside a worker_thread (the default runtime). */
  private async loadInWorker(): Promise<void> {
    log.info("loading xenova model", {
      model: this.model,
      pooling: this.pooling,
      poolingSource: this.poolingSource,
      dtype: this.dtype,
      runtime: this.runtime,
      offline: isXenovaOffline(),
      cacheDir: process.env.TRANSFORMERS_CACHE ?? null,
    });
    try {
      const pipeline = await createWorkerPipeline({
        model: this.model,
        dtype: this.dtype,
        maxTokens: this.maxTokens,
        transformersEnv: resolveXenovaEnvSettings(),
        moduleUrl: this.workerModuleUrl,
      });
      this.pipeline = pipeline as unknown as XenovaPipeline;
      this.afterLoad(pipeline.maxTokens);
    } catch (err) {
      throw this.loadError(err);
    }
  }

  private loadError(err: unknown): Error {
    if (isXenovaOffline()) {
      return new Error(
        `Offline embeddings model "${this.model}" was not found in the local cache ` +
          `(TRANSFORMERS_CACHE=${process.env.TRANSFORMERS_CACHE ?? "<unset>"}). ` +
          "Pre-bake the model into the image, or unset HF_HUB_OFFLINE to allow a one-time download. " +
          `Underlying error: ${(err as Error).message}`,
      );
    }
    return err as Error;
  }

  private afterLoad(maxTokens: number | null): void {
    if (!this.pipeline) return;
    const declared = declaredPoolingFromConfig(this.pipeline.model?.config);
    if (declared && declared !== this.pooling) {
      log.warn(
        "POOLING MISMATCH — the model config declares a different pooling than METIS resolved. " +
          "Vectors will be valid-looking but semantically degraded (hybrid retrieval collapses to " +
          "BM25-only quality). Fix the per-model map or set EMBED_POOLING_MAP.",
        { model: this.model, declared, resolved: this.pooling, source: this.poolingSource },
      );
    }
    log.info("xenova model loaded", {
      model: this.model,
      pooling: this.pooling,
      dtype: this.dtype,
      runtime: this.runtime,
      maxTokens,
    });
  }
}

/**
 * True when the air-gapped offline bundle is configured (issue #936).
 *
 * #784 — delegates to the shared `isEmbedOffline`, so the in-process backend and
 * the sidecar agree on which variables mean "offline" (`HF_HUB_OFFLINE`,
 * `TRANSFORMERS_OFFLINE`, `EMBEDDINGS_OFFLINE`). They previously disagreed,
 * which made any single documented answer to "how do I air-gap this?" wrong for
 * one of the two paths.
 */
function isXenovaOffline(): boolean {
  return isEmbedOffline(process.env);
}

/**
 * Point `@huggingface/transformers` at the right place for weights.
 *
 * Cache dir: `TRANSFORMERS_CACHE` (the in-process variable — the sidecar's
 * `EMBEDDINGS_CACHE_DIR` is deliberately NOT read here; the two run in different
 * containers with different mounts, and conflating them would silently redirect
 * a dev's in-process cache at the sidecar's volume path).
 *
 * Remote host: `HF_ENDPOINT` retargets downloads at an internal mirror (#784).
 * Skipped when offline — an air-gapped process must not fetch from anywhere.
 */
function applyXenovaOfflineEnv(env: XenovaEnv | undefined): void {
  if (!env) return;
  Object.assign(env, resolveXenovaEnvSettings());
}

/**
 * The transformers.js `env` fields to set — computed once here so the inline
 * runtime and the worker (#189, which has its own transformers.js instance) apply
 * the same values. Only resolved fields are present.
 */
export function resolveXenovaEnvSettings(): WorkerTransformersEnv {
  const settings: WorkerTransformersEnv = {};
  if (process.env.TRANSFORMERS_CACHE) {
    settings.cacheDir = process.env.TRANSFORMERS_CACHE;
  }
  if (isXenovaOffline()) {
    settings.allowRemoteModels = false;
    settings.allowLocalModels = true;
    return settings;
  }
  const remoteHost = resolveRemoteHost(process.env);
  if (remoteHost) {
    settings.remoteHost = remoteHost;
  }
  return settings;
}

function truncateAndNormalize(vec: number[], dim: number): number[] {
  const sliced = vec.slice(0, dim);
  let norm = 0;
  for (const x of sliced) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return sliced;
  return sliced.map((x) => x / norm);
}

function tensorToVectors(tensor: XenovaTensor, rowCount: number, expectedDim: number): number[][] {
  if (typeof tensor.tolist === "function") {
    const list = tensor.tolist();
    if (Array.isArray(list) && list.length === rowCount) return list;
  }
  // Fallback: read the flat Float32Array and slice into rows.
  const total = tensor.data.length;
  if (total === 0 || total % rowCount !== 0) {
    throw new Error(
      `unexpected tensor shape: data.length=${total}, rows=${rowCount}, dims=${tensor.dims.join("x")}`,
    );
  }
  const dim = total / rowCount;
  if (dim !== expectedDim) {
    log.warn("embedding dim mismatch", { got: dim, expected: expectedDim });
  }
  const out: number[][] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const slice = tensor.data.slice(i * dim, (i + 1) * dim);
    out.push(Array.from(slice));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remote backend (sidecar HTTP)
// ---------------------------------------------------------------------------

/**
 * Delegates embedding to the `metis-embeddings` sidecar over HTTP (#935). This
 * is a first-class registry backend with `requiresEgress: false` — the sidecar
 * runs inside the cluster so no public internet access is needed.
 */
class RemoteEmbedder implements EmbedBackend {
  readonly key = "sidecar";
  readonly model: string;
  readonly dimension: number;
  readonly requiresEgress = false;
  /**
   * Issue #782 — the server resolves pooling from the SAME per-model map the
   * sidecar uses and sends it explicitly on every `/embed` call. Sending it
   * (rather than letting the sidecar default) means a server/sidecar version
   * skew can never silently mean-pool a CLS model.
   */
  readonly pooling: EmbedPooling;
  private readonly client: EmbeddingsClient;
  /**
   * Issue #792 — the identity from the sidecar's LAST wire response, cached so
   * `currentIdentity()` need not probe every call. `null` until the first embed
   * (or probe). This is the SIDECAR's truth, not a server-side guess — see
   * {@link identityFromWire}.
   */
  private wireIdentity: string | null = null;

  constructor(model: string, dimension: number, client: EmbeddingsClient, pooling?: EmbedPooling) {
    this.model = model;
    this.dimension = dimension;
    this.client = client;
    this.pooling = resolvePooling(model, pooling).pooling;
    log.info("sidecar embed backend configured", { model, pooling: this.pooling });
  }

  async warm(): Promise<void> {
    // Cheap probe — confirms the sidecar is up and the token is configured.
    await this.client.healthz();
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], model: this.model, dimension: this.dimension };
    }
    const res = await this.client.embed(texts, this.model, this.pooling);
    const model = res.model || this.model;
    // #792 — the identity is built from the pooling+dtype the SIDECAR ECHOES it
    // used, never from `this.pooling` (which is only a request hint). Persisting
    // the wire value is what makes a server/sidecar env skew show up as an
    // identity change instead of being silently mislabelled with the server's guess.
    const identity = identityFromWire(model, res.pooling, res.dtype);
    this.wireIdentity = identity;
    return {
      vectors: res.vectors,
      model,
      dimension: res.dimension || this.dimension,
      identity,
    };
  }

  /**
   * Issue #792 — the identity the sidecar produces NOW, from its OWN resolved
   * pooling+dtype. Cached from the last embed; probes with a one-character embed
   * when nothing has been sent yet. Never returns a server-side guess: coverage
   * and reindex must compare the corpus against what the sidecar actually does,
   * so that a reindex CONVERGES (a run that re-embeds via the sidecar persists the
   * sidecar's identity, which this then matches) and a genuine env mismatch is
   * surfaced rather than papered over.
   */
  async currentIdentity(): Promise<string> {
    if (this.wireIdentity !== null) return this.wireIdentity;
    const res = await this.client.embed([" "], this.model, this.pooling);
    const model = res.model || this.model;
    this.wireIdentity = identityFromWire(model, res.pooling, res.dtype);
    return this.wireIdentity;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.healthz();
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Built-in backend registration
// ---------------------------------------------------------------------------

registerBackend(
  "offline",
  (cfg) =>
    new HashEmbedder(
      cfg.model ?? process.env.EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
      // #783 — the hash stub's width is pinned to OFFLINE_EMBED_DIMENSION, NOT to
      // the (now 768-dim) default model's. Vectors are model-TAGGED: if the stub
      // ever emitted 768-dim rows they would still carry `metis-offline-hash-v1`,
      // and that one model id would then span two incompatible vector spaces —
      // rows that can never be compared, distinguished by nothing persisted.
      cfg.dimension ?? OFFLINE_EMBED_DIMENSION,
    ),
  {
    label: "Offline hash stub",
    description:
      "Deterministic non-semantic hash embeddings. Zero dependencies, fully air-gapped. For tests + AI_OFFLINE=1.",
    requiresEgress: false,
    defaultModel: DEFAULT_EMBED_MODEL,
    defaultDimension: OFFLINE_EMBED_DIMENSION,
    offlineCapable: true,
  },
);

registerBackend(
  "xenova",
  (cfg) =>
    new XenovaEmbedder(
      cfg.model ?? process.env.EMBED_MODEL ?? DEFAULT_XENOVA_EMBED_MODEL,
      cfg.dimension ?? DEFAULT_EMBED_DIMENSION,
      { pooling: cfg.pooling, dtype: cfg.dtype, runtime: cfg.inProcessRuntime },
    ),
  {
    label: "Xenova (in-process)",
    description:
      "Semantic embeddings via @huggingface/transformers ONNX, default gte-modernbert-base (768d, CLS-pooled, q8). Supports an air-gapped offline bundle (HF_HUB_OFFLINE).",
    requiresEgress: true,
    defaultModel: DEFAULT_XENOVA_EMBED_MODEL,
    defaultDimension: DEFAULT_EMBED_DIMENSION,
    offlineCapable: true,
  },
);

registerBackend(
  "embeddinggemma",
  (cfg) => {
    const dimension = resolveGemmaDimension(cfg.dimension);
    return new XenovaEmbedder(
      cfg.model ?? process.env.EMBED_MODEL ?? EMBEDDING_GEMMA_MODEL,
      dimension,
      {
        key: "embeddinggemma",
        nativeDimension: EMBEDDING_GEMMA_NATIVE_DIM,
        matryoshka: true,
        pooling: cfg.pooling,
        dtype: cfg.dtype,
        runtime: cfg.inProcessRuntime,
      },
    );
  },
  {
    label: "Google EmbeddingGemma (ONNX)",
    description:
      "EmbeddingGemma 300M ONNX via the transformers.js v3 runtime with Matryoshka truncation (EMBED_DIM 768/512/256/128). Offline-capable; review Gemma Terms of Use.",
    requiresEgress: true,
    defaultModel: EMBEDDING_GEMMA_MODEL,
    defaultDimension: EMBEDDING_GEMMA_NATIVE_DIM,
    offlineCapable: true,
  },
);

registerBackend(
  "sidecar",
  (cfg) =>
    new RemoteEmbedder(
      cfg.model ?? process.env.EMBED_MODEL ?? DEFAULT_XENOVA_EMBED_MODEL,
      cfg.dimension ?? DEFAULT_EMBED_DIMENSION,
      cfg.client ?? getEmbeddingsClient(),
      cfg.pooling,
    ),
  {
    label: "Embeddings sidecar (HTTP)",
    description:
      "Delegates to the in-cluster metis-embeddings sidecar over HTTP. No public egress; keeps the server image small.",
    requiresEgress: false,
    defaultModel: DEFAULT_XENOVA_EMBED_MODEL,
    defaultDimension: DEFAULT_EMBED_DIMENSION,
    offlineCapable: true,
  },
);

// Cloud backends (bedrock, bedrock-sdk, openai) self-register via this call.
registerCloudBackends();

/**
 * Resolve + validate an EmbeddingGemma Matryoshka dimension. Honors the
 * `EMBED_DIM` env var, defaults to the native 768, and rejects values outside
 * the supported truncation set.
 */
export function resolveGemmaDimension(explicit?: number): number {
  const raw = explicit ?? (process.env.EMBED_DIM ? Number(process.env.EMBED_DIM) : undefined);
  if (raw === undefined) return EMBEDDING_GEMMA_NATIVE_DIM;
  if (!EMBEDDING_GEMMA_DIMENSIONS.includes(raw as (typeof EMBEDDING_GEMMA_DIMENSIONS)[number])) {
    throw new Error(
      `Invalid EmbeddingGemma dimension ${raw}. Supported Matryoshka targets: ${EMBEDDING_GEMMA_DIMENSIONS.join(", ")}.`,
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Public façade
// ---------------------------------------------------------------------------

/** Health/diagnostic snapshot of the active embedder (#783). */
export interface EmbedderHealth {
  /** False until the backend has been warmed (or has failed to warm). */
  loaded: boolean;
  /**
   * True only when the embedder is serving REAL semantic vectors. An active hash
   * fallback is NOT `ok` — it can embed, but what it produces is noise, and a
   * boolean that says "healthy" while the corpus fills with hash vectors is the
   * bug this issue exists to kill.
   */
  ok: boolean;
  status: "ok" | "degraded" | "error";
  /** Registry key currently serving (`offline` after a fallback, not the configured one). */
  backend: string;
  /** The model actually loaded — `metis-offline-hash-v1` after a fallback. */
  model: string;
  dimension: number;
  /** True when a real backend failed to load and the opt-in hash stub took over. */
  fellBack: boolean;
  /** Whether `EMBED_ALLOW_HASH_FALLBACK` / `AI_OFFLINE` permit a fallback at all. */
  hashFallbackAllowed: boolean;
  error: string | null;
}

/** Truthy check for `1`/`true`/`yes`/`on` (case-insensitive) flags. */
function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * May a failing real backend silently degrade to the hash stub? (#783)
 *
 * `EMBED_ALLOW_HASH_FALLBACK` is the deliberate escape hatch — for local dev with
 * no HF egress, and for the air-gapped/offline case where an operator has decided
 * that "still serving, with useless vectors" beats "not serving". `AI_OFFLINE=1`
 * keeps its historical meaning and implies it (it already pins the `offline`
 * backend outright, so it only matters when a caller passes an explicit
 * `cfg.backend`).
 *
 * Everything else — an unset variable, a typo, a production pod whose sidecar is
 * down — gets a hard failure. That asymmetry is the whole point: the cost of a
 * loud failure is a crashed request; the cost of a silent one is a corpus of
 * meaningless vectors that no metric reports and that only a reindex can undo.
 */
export function isHashFallbackAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isTruthyFlag(env.EMBED_ALLOW_HASH_FALLBACK) || isTruthyFlag(env.AI_OFFLINE);
}

/**
 * The ONLY backends `EMBED_ALLOW_HASH_FALLBACK` may relax (#783).
 *
 * These are the in-process / in-cluster ones, whose load failure means "the model
 * weights are not here" — the exact situation the flag was written for. Every
 * other backend (bedrock, bedrock-sdk, openai, and anything registered later)
 * fails LOUD regardless of the flag: their warm() is a live network call, so their
 * failure mode is a rotated credential or a sick gateway, and the honest answer to
 * that is an error — never a corpus of hash vectors. Keep this list closed: a new
 * backend must opt IN explicitly rather than inherit a silent degradation path.
 */
const HASH_FALLBACK_BACKENDS: ReadonlySet<string> = new Set(["xenova", "sidecar"]);

export class Embedder {
  private backend: EmbedBackend;
  /** Single in-flight loader promise — guarantees the model only loads once. */
  private loader: Promise<void> | null = null;
  private loaded = false;
  /** Track whether we fell back from a real backend to hash. */
  public fellBack = false;
  /**
   * The load failure, kept after the throw so `/readyz` and the admin panel can
   * report WHY the embedder is unusable instead of just that it is.
   */
  public lastError: string | null = null;
  /** The backend key the deployment CONFIGURED — survives a fallback swap. */
  private readonly configuredKey: string;

  constructor(cfg: EmbedderConfig = {}) {
    this.backend = createBackend(cfg);
    this.configuredKey = this.backend.key;
  }

  get key(): string {
    return this.backend.key;
  }

  get model(): string {
    return this.backend.model;
  }

  get dimension(): number {
    return this.backend.dimension;
  }

  get requiresEgress(): boolean {
    return this.backend.requiresEgress;
  }

  /**
   * Issue #792 — the persisted embedding identity the active backend produces
   * now (`model` at built-in defaults, else `model|pooling|dtype`). Coverage and
   * reindex compare the stored corpus against THIS so a pooling/dtype flip is
   * caught by the existing model-change reindex path. Backends that do not
   * implement `currentIdentity` (the hash stub, cloud APIs) fall back to their
   * bare model id — the back-compatible reading.
   */
  async currentIdentity(): Promise<string> {
    if (typeof this.backend.currentIdentity === "function") {
      return this.backend.currentIdentity();
    }
    return this.backend.model;
  }

  capabilities(): EmbedBackendCapabilities {
    return capabilitiesOf(this.backend);
  }

  async warm(): Promise<void> {
    if (this.loaded) return;
    if (!this.loader) {
      this.loader = this.load();
    }
    await this.loader;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (!Array.isArray(texts)) {
      throw new TypeError("texts must be an array of strings");
    }
    if (texts.length === 0) {
      return { vectors: [], model: this.backend.model, dimension: this.backend.dimension };
    }
    await this.warm();
    return this.backend.embed(texts);
  }

  /**
   * The CURRENT state, with no I/O: no warm, no upstream ping (#783).
   *
   * This is what `/readyz` reads. A readiness probe must not be the thing that
   * triggers a 150 MB model download, and it must not be able to hang on a wedged
   * sidecar's socket timeout. It reports what the process already knows — which,
   * after the boot-time warm in `server.ts`, is the real answer.
   */
  snapshot(): EmbedderHealth {
    const base = {
      loaded: this.loaded,
      backend: this.backend.key,
      model: this.backend.model,
      dimension: this.backend.dimension,
      hashFallbackAllowed: isHashFallbackAllowed(),
    };
    if (this.lastError && !this.fellBack) {
      return { ...base, ok: false, status: "error", fellBack: false, error: this.lastError };
    }
    if (this.fellBack) {
      return {
        ...base,
        ok: false,
        status: "degraded",
        fellBack: true,
        error: this.lastError ?? "hash fallback active — vectors are NOT semantic",
      };
    }
    return { ...base, ok: true, status: "ok", fellBack: false, error: null };
  }

  /**
   * Active health probe for Admin → Embedding backends (#783). Never throws — a
   * load failure is REPORTED, not raised, so the panel can render it.
   *
   * Goes through `this.warm()` (not straight to `backend.healthy()`) on purpose:
   * warm() is where the fail-loud / opt-in-fallback decision lives, so the panel
   * reports exactly the state a real `embed()` call would hit. It is therefore an
   * ACTIVE probe (it can load the model); that is fine for an authenticated admin
   * asking "is my embedder working", and wrong for a kubelet readiness probe —
   * which is why `/readyz` reads {@link snapshot} instead.
   */
  async health(): Promise<EmbedderHealth> {
    const hashFallbackAllowed = isHashFallbackAllowed();
    try {
      await this.warm();
    } catch (err) {
      return {
        loaded: false,
        ok: false,
        status: "error",
        backend: this.configuredKey,
        model: this.backend.model,
        dimension: this.backend.dimension,
        fellBack: false,
        hashFallbackAllowed,
        error: this.lastError ?? (err as Error).message,
      };
    }

    let backendOk = true;
    let error: string | null = null;
    if (this.backend.healthy) {
      try {
        backendOk = await this.backend.healthy();
        if (!backendOk) error = "backend reported unhealthy";
      } catch (err) {
        backendOk = false;
        error = (err as Error).message;
      }
    }

    const base = {
      loaded: this.loaded,
      backend: this.backend.key,
      model: this.backend.model,
      dimension: this.backend.dimension,
      hashFallbackAllowed,
    };
    if (!backendOk) {
      return { ...base, ok: false, status: "error", fellBack: this.fellBack, error };
    }
    if (this.fellBack) {
      // Serving, but with NON-SEMANTIC vectors. Reported as not-ok on purpose:
      // an operator must never see a green tick over a hash-filled index.
      return {
        ...base,
        ok: false,
        status: "degraded",
        fellBack: true,
        error:
          this.lastError ??
          "hash fallback active (EMBED_ALLOW_HASH_FALLBACK) — vectors are NOT semantic",
      };
    }
    return { ...base, ok: true, status: "ok", fellBack: false, error: null };
  }

  private async load(): Promise<void> {
    try {
      await this.backend.warm();
      this.loaded = true;
      return;
    } catch (err) {
      const message = (err as Error).message;
      this.lastError = message;

      // #783 — the hash stub is a DELIBERATE choice, never a consolation prize.
      // Before this, any xenova/sidecar load failure was quietly swapped for it;
      // the pod stayed up, every health check stayed green, and the corpus filled
      // with vectors that carry no meaning. Cloud backends already failed loud
      // here — this extends the same honesty to the local ones.
      //
      // TWO conditions gate the fallback, and BOTH are load-bearing:
      //
      //  1. the backend must be a LOCAL one. EMBED_ALLOW_HASH_FALLBACK exists for
      //     "local dev, no HF egress" — a state a cloud backend is never in. A
      //     cloud backend's warm() is a live network call (OpenAiEmbedder.warm →
      //     embed(["healthcheck"])), so a rotated key, an expired token, a gateway
      //     5xx or a timeout all land HERE, at runtime, on a deployment that was
      //     working a minute ago. If the flag reached them, a Bedrock/OpenAI pod
      //     that merely has the flag inherited from a dev profile or a base Helm
      //     values file would answer a 401 by silently writing hash vectors. The
      //     flag must only ever RELAX the local backends, never a cloud one.
      //  2. the operator must have asked for it.
      const localBackend = HASH_FALLBACK_BACKENDS.has(this.backend.key);
      if (!localBackend || !isHashFallbackAllowed()) {
        throw new Error(
          `Embeddings backend "${this.backend.key}" failed to load, and the hash fallback is ` +
            `not ${localBackend ? "enabled" : "available for this backend"}. REFUSING to embed: ` +
            `the fallback writes non-semantic vectors tagged "${DEFAULT_EMBED_MODEL}", which look ` +
            `fine, pass every health check, and silently destroy retrieval quality until someone ` +
            `reindexes.\n` +
            (localBackend
              ? `Fix the backend (model "${this.backend.model}"), or — only if you genuinely want ` +
                `non-semantic vectors (local dev, no HF egress) — set EMBED_ALLOW_HASH_FALLBACK=1, ` +
                `or select the stub outright with EMBED_BACKEND=offline / AI_OFFLINE=1.\n`
              : `"${this.backend.key}" is a CLOUD backend: EMBED_ALLOW_HASH_FALLBACK does not ` +
                `relax it (a credential or gateway failure is never an invitation to write ` +
                `non-semantic vectors). Fix the credentials/endpoint, or switch to a local ` +
                `backend — EMBED_BACKEND=xenova, or EMBED_BACKEND=offline / AI_OFFLINE=1 to ` +
                `select the stub outright.\n`) +
            `Underlying error: ${message}`,
        );
      }

      log.warn(
        `${this.backend.key} backend failed to load; EMBED_ALLOW_HASH_FALLBACK is set, so ` +
          "falling back to the deterministic hash embedder. Vectors written are NOT SEMANTIC — " +
          "they are tagged with the offline model id and retrieval over them is noise. " +
          "This is reported as DEGRADED in /readyz and Admin → Embedding backends.",
        { error: message },
      );
      // The stub keeps ITS OWN dimension (see the `offline` registration): a hash
      // vector must never be written at the real model's width under the hash
      // model's id, or one model id would span two incompatible vector spaces.
      this.backend = new HashEmbedder(DEFAULT_EMBED_MODEL, OFFLINE_EMBED_DIMENSION);
      this.fellBack = true;
      await this.backend.warm();
      this.loaded = true;
    }
  }
}

let singleton: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (!singleton) singleton = new Embedder();
  return singleton;
}

/** Test seam — drop the singleton between tests. */
export function __resetEmbedderSingleton(): void {
  singleton = null;
}
