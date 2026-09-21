/**
 * Where the local embedding weights live — the ONE place that answers it (#785).
 *
 * `@huggingface/transformers` v3 reads **no** environment variables (see #784).
 * METIS maps `TRANSFORMERS_CACHE` onto the library's `env.cacheDir` in
 * `applyXenovaOfflineEnv` (`embedder.ts`). Anything that wants to *report* the
 * cache directory — the prefetch script, the smoke check, a Windows dev staring
 * at a MAX_PATH error — must derive it the same way, or it will confidently
 * print a path that nothing ever writes to. That divergence is exactly the bug
 * #784 fixed in the prefetch helper; this module exists so it cannot come back
 * by being re-implemented a third time.
 *
 * Extracted from `scripts/prefetch-embeddings-model.ts` (which re-exports it for
 * backwards compatibility) so it sits under `src/` and is coverage-measured.
 */
import path from "node:path";

/**
 * Reported when nothing pinned the cache dir. Deliberately not a path: printing
 * a plausible-looking directory that the runtime never writes to is how #941's
 * helper came to disagree with the runtime in the first place.
 */
export const UNPINNED_CACHE =
  "<transformers.js default cache inside node_modules — set TRANSFORMERS_CACHE to pin it>";

/** Reads the cache dir `@huggingface/transformers` actually resolved. */
export type CacheDirReader = () => Promise<string | null>;

export const readRuntimeCacheDir: CacheDirReader = async () => {
  try {
    const moduleName = "@huggingface/transformers";
    const mod = (await import(moduleName)) as { env?: { cacheDir?: string } };
    return mod.env?.cacheDir ?? null;
  } catch {
    // The module is a devDependency and the offline/hash backends do not need
    // it. Reporting "unpinned" beats crashing a prefetch that had nothing to do.
    return null;
  }
};

/**
 * The cache directory the weights will land in.
 *
 * `TRANSFORMERS_CACHE` is the only variable that pins it (METIS maps it onto
 * `env.cacheDir`). Otherwise we report what the module itself resolved, and fall
 * back to {@link UNPINNED_CACHE} when even that is unavailable. `HF_HOME` is NOT
 * consulted: transformers.js ignores it, and the pre-#784 version of this helper
 * printing a `~/.cache/huggingface/hub` path was simply wrong.
 */
export function resolveCachePath(
  env: NodeJS.ProcessEnv = process.env,
  runtimeCacheDir: string | null = null,
): string {
  if (env.TRANSFORMERS_CACHE) return path.resolve(env.TRANSFORMERS_CACHE);
  if (runtimeCacheDir) return path.resolve(runtimeCacheDir);
  return UNPINNED_CACHE;
}

/**
 * Windows MAX_PATH headroom check (#785).
 *
 * transformers.js composes the on-disk path as
 * `{cacheDir}/{org}/{model}/onnx/{file}`, so the deepest file METIS asks for
 * today is roughly:
 *
 *   Alibaba-NLP/gte-modernbert-base/onnx/model_quantized.onnx   → 57 chars
 *
 * Classic Win32 APIs cap a full path at **260** characters (`MAX_PATH`), and a
 * download that overruns it fails with a permission-shaped or
 * `ENOENT`/`ENAMETOOLONG` error that says nothing about path length — which is
 * why this is a *documented caveat* rather than something a dev diagnoses. A
 * default Windows dev cache under, say,
 * `C:\Users\<name>\source\repos\metis\server\node_modules\...\.cache\huggingface`
 * burns most of that budget before the model id is even appended.
 *
 * We do not guess the *exact* deepest filename (it varies by model and dtype);
 * we reserve a conservative suffix budget and report whether the configured
 * cache root leaves room. Advisory only — it never blocks a load.
 */
export const MAX_PATH_LIMIT = 260;

/**
 * Characters reserved for `{org}/{model}/onnx/{file}` beneath the cache root.
 * Sized from the longest path METIS's own default model produces, plus slack for
 * a longer model id or an `_fp16`/`_quantized` variant suffix.
 */
export const CACHE_SUFFIX_BUDGET = 96;

export interface CachePathHeadroom {
  /** The resolved cache root, or `null` when it is unpinned. */
  cacheRoot: string | null;
  /** Length of the cache root in characters. */
  rootLength: number;
  /** Characters left for the model subpath before MAX_PATH is exceeded. */
  headroom: number;
  /** True when the root leaves less than {@link CACHE_SUFFIX_BUDGET} to spare. */
  atRisk: boolean;
}

/**
 * Does the configured cache root leave room for the model subpath on Windows?
 *
 * `platform` is a parameter (not `process.platform`) so the check is unit-testable
 * off-Windows — the whole point is that nobody on this team can run it natively.
 * On non-Windows platforms the limit does not apply and `atRisk` is always false.
 */
export function checkCachePathHeadroom(
  cachePath: string,
  platform: NodeJS.Platform = process.platform,
): CachePathHeadroom {
  const pinned = cachePath !== UNPINNED_CACHE;
  const cacheRoot = pinned ? cachePath : null;
  const rootLength = pinned ? cachePath.length : 0;
  const headroom = MAX_PATH_LIMIT - rootLength;
  return {
    cacheRoot,
    rootLength,
    headroom,
    // An UNPINNED cache on Windows is the riskiest case of all — the weights land
    // inside `node_modules`, which is both the deepest path on the machine and the
    // one `pnpm install` may delete. Flag it rather than scoring it 260 headroom.
    atRisk: platform === "win32" && (!pinned || headroom < CACHE_SUFFIX_BUDGET),
  };
}
