/**
 * Lazy-loaded `@huggingface/transformers` (transformers.js v3) pipelines.
 *
 * Each model is constructed once and reused across requests. The first call
 * pays the cold-start cost (model download + ONNX session init); subsequent
 * calls are ~milliseconds for embeddings.
 *
 * Issue #781 — migrated from the unmaintained `@xenova/transformers` 2.17.2 to
 * its maintained successor. v2's model registry knows nothing about the
 * `modernbert` or `gemma3` architectures, so ModernBERT-class embedders
 * (`Alibaba-NLP/gte-modernbert-base`) simply cannot load on it. The v3 surface
 * we depend on is unchanged: `pipeline(task, model, opts)` plus an `env` object
 * carrying `allowRemoteModels` / `allowLocalModels` / `cacheDir`.
 */

/**
 * transformers.js v2 loaded the **quantized (q8)** ONNX weights by default
 * (`quantized: true`). v3 replaced that flag with `dtype`, whose default on
 * Node is **fp32** (device resolves to `cpu`, which has no entry in v3's
 * `DEFAULT_DEVICE_DTYPE_MAPPING`). Left unset, the upgrade would silently
 * quadruple every model's download size and resident memory.
 *
 * #781 pinned q8 to preserve the pre-upgrade runtime footprint exactly. #782
 * makes it configurable via `EMBED_DTYPE` — with q8 STILL the default, because
 * both Dockerfiles bake whatever `EMBED_DTYPE` says and an image that requests a
 * dtype it never baked cannot boot air-gapped. Choosing fp32 for quality is
 * eval-gated by #788.
 */
import {
  declaredPoolingFromConfig,
  isEmbedOffline,
  poolingFromModelMap,
  resolveDtype,
  resolveRemoteHost,
  type EmbedDtype,
  type EmbedPooling,
} from "./model-config.js";

/**
 * transformers.js's own default `env.remoteHost`. Restored when offline so that
 * an air-gapped process never holds an operator's mirror URL, while still holding
 * a STRING — see `configureTransformersEnv` for why the obvious `delete` is a
 * boot-time crash rather than a stronger guarantee.
 */
export const HF_DEFAULT_REMOTE_HOST = "https://huggingface.co/";

/** A loaded feature-extraction pipeline. `model.config` is used for the pooling sanity check. */
type EmbedPipeline = ((
  texts: string[],
  opts: { pooling: EmbedPooling; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[]; tolist?(): number[][] }>) & {
  model?: { config?: unknown };
};

type RerankPipeline = (pairs: { text: string; text_pair: string }[]) => Promise<unknown>;

type TransformersModule = {
  pipeline: (task: string, model: string, opts?: { dtype?: string }) => Promise<unknown>;
  env?: {
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
    cacheDir?: string;
    remoteHost?: string;
  };
};

let transformersPromise: Promise<TransformersModule> | null = null;
const embedCache = new Map<string, Promise<EmbedPipeline>>();
const rerankCache = new Map<string, Promise<RerankPipeline>>();

/**
 * Issue #935 — air-gapped sidecar guarantee. Issue #784 — mirror support.
 *
 * Configure the `@huggingface/transformers` env in place from process env. When
 * any offline flag is set (`HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`,
 * `EMBEDDINGS_OFFLINE`) we disable remote model fetches so the sidecar serves
 * ONLY from the pre-baked cache and fails loudly instead of reaching out to
 * HuggingFace at runtime.
 *
 * When NOT offline, `HF_ENDPOINT` redirects downloads at an internal mirror
 * (`env.remoteHost`) — the corp-network path, where huggingface.co is blocked
 * or 401s. Offline still wins: an air-gapped image must not fetch from anywhere,
 * mirror included. Exported for unit testing.
 */
export function configureTransformersEnv(
  env: NonNullable<TransformersModule["env"]>,
  processEnv: NodeJS.ProcessEnv = process.env,
): void {
  const offline = isEmbedOffline(processEnv);

  if (offline) {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    // RESET the mirror rather than merely declining to set it (#784 review, F4).
    // An offline process must never be pointed at an operator's mirror, whatever
    // the env object held before.
    //
    // It is reset, NOT deleted. `delete env.remoteHost` looks stronger and is in
    // fact a hard crash: transformers.js computes
    //   remoteURL = pathJoin(env.remoteHost, env.remotePathTemplate…)
    // EAGERLY on every file load, before it ever checks `allowRemoteModels`, and
    // `pathJoin` calls `.replace()` on each part — so an undefined host throws
    // "Cannot read properties of undefined (reading 'replace')" and the
    // air-gapped image cannot load a single model. (Verified against the real
    // image; the unit tests mock transformers.js and cannot see this.)
    //
    // Keeping a host string is safe: `allowRemoteModels=false` means the URL is
    // never fetched, and the filesystem cache is keyed on the REQUEST path
    // (`{model}/{file}`), not on the host — so the baked cache still hits.
    env.remoteHost = HF_DEFAULT_REMOTE_HOST;
  } else {
    env.allowRemoteModels = env.allowRemoteModels ?? true;
    const remoteHost = resolveRemoteHost(processEnv);
    if (remoteHost) {
      env.remoteHost = remoteHost;
    }
  }

  const cacheDir = processEnv.EMBEDDINGS_CACHE_DIR ?? processEnv.TRANSFORMERS_CACHE;
  if (cacheDir) {
    env.cacheDir = cacheDir;
  }
}

function loadTransformers(): Promise<TransformersModule> {
  if (!transformersPromise) {
    const moduleName = "@huggingface/transformers";
    transformersPromise = import(moduleName).then((mod: unknown) => {
      const m = mod as TransformersModule;
      if (m.env) {
        configureTransformersEnv(m.env);
      }
      return m;
    });
  }
  return transformersPromise;
}

/**
 * Load (once per model+dtype) a feature-extraction pipeline.
 *
 * Observability (#782): the resolved dtype and the pooling the per-model map
 * will apply are logged at load time, so `docker logs` shows exactly which
 * pooling every model is being served with. If the model's own config declares
 * a pooling mode (rare — see `declaredPoolingFromConfig`) and it disagrees with
 * the map, we warn LOUDLY rather than silently emitting degraded vectors.
 */
export async function getEmbedPipeline(
  model: string,
  dtype: EmbedDtype = resolveDtype(),
): Promise<EmbedPipeline> {
  const cacheKey = `${model}::${dtype}`;
  let cached = embedCache.get(cacheKey);
  if (!cached) {
    cached = loadTransformers().then(async (mod) => {
      const pipe = (await mod.pipeline("feature-extraction", model, { dtype })) as EmbedPipeline;
      const mapped = poolingFromModelMap(model);
      const pooling = mapped ?? "mean (fallback)";
      // eslint-disable-next-line no-console
      console.info(
        `[embeddings-svc] loaded embed model=${model} dtype=${dtype} pooling=${pooling}` +
          (mapped ? "" : " (no per-model rule matched — set EMBED_POOLING_MAP if this is wrong)"),
      );
      const declared = declaredPoolingFromConfig(pipe.model?.config);
      if (declared && mapped && declared !== mapped) {
        // eslint-disable-next-line no-console
        console.warn(
          `[embeddings-svc] POOLING MISMATCH for ${model}: the model config declares "${declared}" ` +
            `but METIS resolved "${mapped}". Vectors will be semantically degraded (valid-looking but wrong). ` +
            `Fix the per-model map or set EMBED_POOLING_MAP=${model}=${declared}.`,
        );
      }
      return pipe;
    });
    embedCache.set(cacheKey, cached);
  }
  return cached;
}

export async function getRerankPipeline(
  model: string,
  dtype: EmbedDtype = resolveDtype(),
): Promise<RerankPipeline> {
  const cacheKey = `${model}::${dtype}`;
  let cached = rerankCache.get(cacheKey);
  if (!cached) {
    cached = loadTransformers().then(async (mod) => {
      const pipe = (await mod.pipeline("text-classification", model, {
        dtype,
      })) as RerankPipeline;
      // eslint-disable-next-line no-console
      console.info(`[embeddings-svc] loaded rerank model=${model} dtype=${dtype}`);
      return pipe;
    });
    rerankCache.set(cacheKey, cached);
  }
  return cached;
}

/** Test seam — drop cached pipelines so each test sees a fresh module. */
export function __resetPipelinesForTests(): void {
  transformersPromise = null;
  embedCache.clear();
  rerankCache.clear();
}
