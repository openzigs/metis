/**
 * Epic #930 / issue #941 — embeddings model prefetch. Extended by #784.
 *
 * Loads the currently-configured embedder ONCE so a downloadable backend
 * (Xenova / EmbeddingGemma ONNX) pulls its weights into the local transformers
 * cache. Run this at image-build or first-boot time so the server never blocks
 * on a cold download mid-request, and so an air-gapped deploy can bake the cache
 * ahead of `HF_HUB_OFFLINE=1`:
 *
 *   pnpm --filter @metis/server prefetch:embeddings
 *
 * ## The environment variables are METIS's, not transformers.js's (#784)
 *
 * `@huggingface/transformers` v3 reads **no** environment variables — not
 * `HF_HUB_OFFLINE`, not `TRANSFORMERS_CACHE`, not `HF_ENDPOINT`. It exposes an
 * `env` object (`allowRemoteModels` / `cacheDir` / `remoteHost`) and nothing
 * else. Every one of those variables works only because METIS maps it onto that
 * object (`applyXenovaOfflineEnv` in `src/lib/rag/embedder.ts`). Two consequences
 * this script has to honour rather than guess at:
 *
 *   1. With `TRANSFORMERS_CACHE` unset, weights land in transformers.js's own
 *      default cache — a `.cache/` directory INSIDE `node_modules`, which the
 *      next `pnpm install` may discard. So we report the cache dir the runtime
 *      actually resolved (asked of the module itself) instead of guessing a
 *      `~/.cache/huggingface/hub` path that nothing writes to, and we tell the
 *      operator to pin `TRANSFORMERS_CACHE` for anything they intend to keep.
 *   2. `HF_ENDPOINT` (internal mirror) is honoured — that is the corp-network
 *      path, where huggingface.co is blocked or 401s.
 *
 * ## Modes
 *
 *   - **download** (online, downloadable backend): warm the model, populating
 *     the cache. Honours `HF_ENDPOINT`.
 *   - **verify** (offline flag set): `HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` /
 *     `EMBEDDINGS_OFFLINE` disable remote fetches, so warming can only succeed
 *     from an already-populated cache. We warm anyway — that is precisely the
 *     "a subsequent offline run loads the model" check, and it fails LOUD (exit
 *     1) when the cache the air-gapped deploy will use is missing or was baked
 *     at the wrong `EMBED_DTYPE`.
 *   - **skip** (non-downloadable backend: hash/offline stub, sidecar, cloud
 *     APIs): nothing to cache locally; exits 0 with an explanation.
 *
 * Exits 0 on success (including graceful no-ops); exits 1 when a download or an
 * offline verification failed.
 */
import { isMainModule } from "../src/lib/main-module.js";
import { getEmbedder } from "../src/lib/rag/embedder.js";
import {
  isEmbedOffline,
  redactUrl,
  resolveDtype,
  resolveRemoteHost,
} from "../src/lib/rag/embed-model-config.js";
import {
  UNPINNED_CACHE,
  readRuntimeCacheDir,
  resolveCachePath,
  type CacheDirReader,
} from "../src/lib/rag/embed-cache.js";

/**
 * #785 — the cache-path helpers moved to `src/lib/rag/embed-cache.ts` so the
 * smoke check (`embed-smoke.ts`) reports the SAME directory this script writes
 * to. Two implementations of "where do the weights live" is how #941's helper
 * came to disagree with the runtime; one is the fix. Re-exported here because
 * this module's public surface is what the existing tests import.
 */
export { UNPINNED_CACHE, readRuntimeCacheDir, resolveCachePath, type CacheDirReader };

/** Backends whose `warm()` downloads model weights into a local cache. */
const DOWNLOADABLE_BACKENDS = new Set(["xenova", "embeddinggemma"]);

/** True when the active backend caches downloadable model weights locally. */
export function isDownloadableBackend(key: string): boolean {
  return DOWNLOADABLE_BACKENDS.has(key);
}

/**
 * True when an air-gapped offline bundle is configured (no network download).
 * Shares the runtime's definition, so this script can never disagree with the
 * embedder about whether a deploy is offline.
 */
export function isOfflineConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEmbedOffline(env);
}

export interface PrefetchOutcome {
  backendKey: string;
  model: string;
  dimension: number;
  /** Weights were fetched over the network into the cache. */
  downloaded: boolean;
  /** Weights were loaded from an existing cache with the network disabled. */
  verified: boolean;
  skippedReason?: string;
  cachePath: string;
  /** The internal mirror in use (`HF_ENDPOINT`), or `null` for the public hub. */
  mirror: string | null;
}

/**
 * Core prefetch routine. Accepts an embedder factory (and a cache-dir reader) so
 * tests can inject mocks and assert the gating logic WITHOUT hitting HuggingFace.
 */
export async function prefetchEmbeddingsModel(
  getEmbedderFn: typeof getEmbedder = getEmbedder,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
  env: NodeJS.ProcessEnv = process.env,
  cacheDirReader: CacheDirReader = readRuntimeCacheDir,
): Promise<PrefetchOutcome> {
  const embedder = getEmbedderFn();
  const backendKey = embedder.key;
  const model = embedder.model;
  const dimension = embedder.dimension;
  const mirror = resolveRemoteHost(env);
  const offline = isOfflineConfigured(env);

  // `mirror` is REDACTED before it is printed (#784 review, F5). `resolveRemoteHost`
  // already rejects an HF_ENDPOINT carrying userinfo, so this is defence in depth
  // — but this log line runs in image builds and CI, where stdout is retained,
  // and a credential printed once is a credential to rotate.
  log(
    `Embeddings prefetch — backend="${backendKey}" model="${model}" dim=${dimension} ` +
      `dtype=${resolveDtype(env)} offline=${offline} ` +
      `mirror=${mirror ? redactUrl(mirror) : "<huggingface.co>"}`,
  );

  if (!isDownloadableBackend(backendKey)) {
    const cachePath = resolveCachePath(env, null);
    const reason =
      `backend "${backendKey}" does not download model weights locally ` +
      "(offline hash stub, in-cluster sidecar, or remote API). Nothing to prefetch. " +
      "For the sidecar, weights are baked into the image at build time " +
      "(see docs/EMBEDDINGS_BACKENDS.md); to prefetch the in-process model instead, " +
      "re-run with EMBED_BACKEND=xenova.";
    log(`Skip: ${reason}`);
    return {
      backendKey,
      model,
      dimension,
      downloaded: false,
      verified: false,
      skippedReason: reason,
      cachePath,
      mirror,
    };
  }

  if (offline) {
    // Warming with the network disabled IS the air-gap check: it can only
    // succeed from an already-populated cache, and it exercises the same dtype
    // the deploy will request. A missing/wrong-dtype cache fails here — at
    // build/first-boot time — instead of on the first user request.
    log(`Offline mode — verifying "${model}" loads from the existing cache (no download)…`);
    await embedder.warm();
    const cachePath = resolveCachePath(env, await cacheDirReader());
    log(`OK. Model "${model}" loaded from the cache at: ${cachePath}`);
    return {
      backendKey,
      model,
      dimension,
      downloaded: false,
      verified: true,
      cachePath,
      mirror,
    };
  }

  log(`Downloading "${model}" into the transformers cache (this may take a while)…`);
  await embedder.warm();
  const cachePath = resolveCachePath(env, await cacheDirReader());
  log(`Done. Model "${model}" is cached at: ${cachePath}`);
  if (!env.TRANSFORMERS_CACHE) {
    log(
      "WARNING: TRANSFORMERS_CACHE is unset, so the weights landed in transformers.js's " +
        "default cache inside node_modules — the next `pnpm install` may discard them. " +
        "Set TRANSFORMERS_CACHE to a durable path (and mount it) before relying on this cache offline.",
    );
  }
  return { backendKey, model, dimension, downloaded: true, verified: false, cachePath, mirror };
}

// Only execute when run directly (not when imported by a test).
//
// #785 — this used to splice argv[1] after a literal `file://`, which mis-parses
// Windows paths containing `#`, `?` or `%` and is sensitive to drive-letter case.
// When it mis-parsed, the guard was simply FALSE: the script exited 0 having
// downloaded nothing. A Windows dev prefetching the cache before going offline
// would have seen a clean run and an empty cache. See `src/lib/main-module.ts`.
if (isMainModule(import.meta.url)) {
  prefetchEmbeddingsModel()
    .then(() => {
      // #785 — `process.exitCode`, NOT `process.exit(0)`.
      //
      // A SUCCESSFUL prefetch has just loaded the ONNX model, so onnxruntime-node
      // is holding a live inference session on a native thread pool. `process.exit()`
      // tears the process down underneath it and ORT aborts:
      //
      //   libc++abi: terminating due to uncaught exception of type
      //   std::__1::system_error: mutex lock failed: Invalid argument
      //
      // which surfaces as **SIGABRT / exit 134**. So the script printed
      // `OK. Model "…" loaded from the cache` and then exited NON-ZERO — meaning a
      // `RUN pnpm prefetch:embeddings` bake step, or any CI/setup script gating on
      // it, failed on the path where everything worked. (The failure path exits 1
      // correctly, which is why this went unnoticed: only success was broken.)
      // Reproduced on darwin/arm64, onnxruntime-node 1.21.0.
      //
      // Letting Node drain and exit naturally lets ORT release the session first.
      process.exitCode = 0;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `Embeddings prefetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
