/**
 * "Is my embedder REAL, or am I silently indexing hash noise?" (#785)
 *
 * The question this answers is the whole of epic #780. Before #783, a `xenova` /
 * `sidecar` backend that failed to load was silently replaced by the deterministic
 * hash stub: the process stayed up, `/readyz` stayed green, and every ingest wrote
 * vectors that carry no meaning. #783 made that fallback opt-in and loud — but a
 * developer still has to be able to ASK, cheaply, and get an answer they can trust,
 * because the failure this guards against is invisible by construction. Hash vectors
 * are finite, unit-norm and entirely plausible-looking; nothing about a vector tells
 * you it is noise.
 *
 * So this check does not merely read the config back. It asks the embedder to prove
 * it has semantics:
 *
 *   1. **Identity** — what did we actually load? Backend, model, dims, pooling,
 *      dtype, and whether a fallback fired. Cheap, and catches the obvious cases
 *      (`AI_OFFLINE=1`, `EMBED_BACKEND=offline`, a fallback that already tripped).
 *   2. **Behaviour** — embed three probes and check the vector space DISCRIMINATES:
 *      two paraphrases of the same requirement must land closer together than either
 *      does to an unrelated sentence. A real model separates them by a wide margin.
 *      The hash stub cannot: its "similarity" is a function of the bytes, so the
 *      related and unrelated pairs score alike (chance level — #788 measured the
 *      stub at 0.032 nDCG@10 against gte-modernbert's 0.402).
 *
 * Step 2 is the load-bearing one, and it is why this is a smoke *test* rather than a
 * config dump. Config can lie by omission — a mis-mapped pooling, a mirror serving
 * the wrong weights, a sidecar that got swapped out from under you — and every one
 * of those failures produces a report that LOOKS correct in step 1. A vector space
 * that cannot tell a rate limiter from a banana-bread recipe is not a vector space,
 * whatever the config says.
 *
 * Cross-platform on purpose (the Windows caveats in #785 are the reason it exists,
 * but it must run on macOS/Linux — that is where it can actually be verified).
 */
import { DEFAULT_EMBED_MODEL } from "@metis/shared";
import {
  checkCachePathHeadroom,
  readRuntimeCacheDir,
  resolveCachePath,
  type CacheDirReader,
  type CachePathHeadroom,
} from "./embed-cache.js";
import {
  isEmbedOffline,
  redactUrl,
  resolveDtype,
  resolvePooling,
  resolveRemoteHost,
  type EmbedDtype,
  type EmbedPooling,
  type PoolingSource,
} from "./embed-model-config.js";
import { getEmbedder, type Embedder, type EmbedderHealth } from "./embedder.js";

/**
 * Three probes. `anchor` and `related` are paraphrases of one requirement — no
 * shared content words beyond "login"/"attempts" — so a lexical/BM25-shaped signal
 * cannot carry them; only semantics can. `unrelated` is from a different universe.
 *
 * Deliberately phrased as an NL requirement → the exact retrieval task #788
 * measured, so a passing smoke check and a passing eval are testing the same thing.
 */
export const SMOKE_PROBES = {
  anchor: "throttle repeated failed login attempts coming from one IP address",
  related: "rate limiter that blocks brute-force password guessing on the sign-in endpoint",
  unrelated: "a recipe for banana bread with walnuts, cinnamon and brown sugar",
} as const;

/**
 * How much closer the related pair must be than the unrelated pair.
 *
 * **Calibrated from measurement, not taste** — and the measurement matters, because
 * the obvious guess is wrong.
 *
 * The hash stub is not a bag-of-words: it SHA-256s the whole string and projects the
 * bytes (`hashEmbed`, `src/lib/ai/embeddings.ts`). Its cosines between any two
 * distinct texts are therefore ~zero-mean noise, and the *margin* between two such
 * cosines is a difference of two noisy values — so it has real spread. Measured over
 * 50,000 random text triples through the actual 384-dim stub:
 *
 *   margin ~ mean 0.0001, sd 0.0726  (min -0.306, max +0.315)
 *
 *   P(margin > 0.05) = 24.8%   ← a 0.05 bar would call NOISE "real" 1 run in 4
 *   P(margin > 0.10) =  8.5%
 *   P(margin > 0.15) =  1.9%
 *   P(margin > 0.25) =  0.026%
 *
 * And the real model, measured on these exact probes (`Alibaba-NLP/gte-modernbert-base`,
 * 768d, cls, q8, onnxruntime-node 1.21.0):
 *
 *   related 0.760, unrelated 0.379 → margin 0.381
 *
 * **0.25** therefore sits ~3.4 sd above the stub's noise (a 1-in-3,800 false "real")
 * while leaving the real model 0.13 of headroom. A lower bar is not conservative —
 * it is a coin-flip dressed up as a check.
 *
 * What this bar CAN detect: a vector space at or near chance level — a hash stub
 * reached by some path the identity check missed, an embedder returning garbage, a
 * mirror serving the wrong weights entirely. What it CANNOT detect: subtler quality
 * regressions such as a CLS model that got mean-pooled — those still discriminate
 * (#782 measured cosine(cls, mean) = 0.856 on this model) and are the job of the
 * #788 retrieval eval, not of a three-sentence smoke test. Claiming otherwise would
 * be exactly the false assurance this epic exists to remove.
 */
export const SEMANTIC_MARGIN = 0.25;

export type SmokeVerdict = "real" | "hash-stub" | "suspect" | "error";

export interface SemanticProbeResult {
  /** cosine(anchor, related) — a paraphrase of the same requirement. */
  relatedSim: number;
  /** cosine(anchor, unrelated) — an off-topic sentence. */
  unrelatedSim: number;
  /** `relatedSim - unrelatedSim`. Must exceed {@link SEMANTIC_MARGIN}. */
  margin: number;
  /** True when the vector space separates the paraphrase from the off-topic text. */
  discriminates: boolean;
}

export interface EmbedSmokeReport {
  /** Runtime, so a Windows bug report carries the platform without being asked. */
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;

  backend: string;
  model: string;
  dimension: number;
  pooling: EmbedPooling;
  poolingSource: PoolingSource;
  dtype: EmbedDtype;

  /** Offline (`HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` / `EMBEDDINGS_OFFLINE`). */
  offline: boolean;
  /** `HF_ENDPOINT` mirror, REDACTED of any userinfo, or `null` for the public hub. */
  mirror: string | null;
  /** True only for in-process backends, which read weights from `TRANSFORMERS_CACHE`. */
  weightsLocal: boolean;
  /** The local cache dir, or {@link NO_LOCAL_WEIGHTS} when `weightsLocal` is false. */
  cachePath: string;
  cacheHeadroom: CachePathHeadroom;

  /** Did a real backend fail to load and the opt-in hash stub take over? */
  fellBack: boolean;
  /** Is the stub even permitted (`EMBED_ALLOW_HASH_FALLBACK` / `AI_OFFLINE`)? */
  hashFallbackAllowed: boolean;
  health: EmbedderHealth["status"];
  error: string | null;

  /** `null` when the embedder could not be loaded or embedding threw. */
  semantic: SemanticProbeResult | null;

  verdict: SmokeVerdict;
  /** Human-readable justification for {@link verdict} — always at least one entry. */
  reasons: string[];
}

/** Cosine similarity. Does not assume the vectors are already unit-norm. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  // A zero vector has no direction; calling that "similarity 0" is the only
  // defensible answer and avoids a NaN propagating into the verdict.
  return denom === 0 ? 0 : dot / denom;
}

/** Is this backend/model the deterministic hash stub, by identity alone? */
export function isHashStub(backend: string, model: string): boolean {
  return (
    backend.trim().toLowerCase() === "offline" ||
    model.trim().toLowerCase() === DEFAULT_EMBED_MODEL.toLowerCase()
  );
}

/**
 * Backends that load ONNX weights **into this process**, from the local
 * `TRANSFORMERS_CACHE`.
 *
 * Only these are governed by the cache dir and by Windows' MAX_PATH. The `sidecar`
 * backend's weights live inside the sidecar's *container* image; the cloud backends
 * have none at all. Reporting a local cache path for those would be worse than
 * useless — it would point a Windows dev at a MAX_PATH warning for a directory that
 * has no bearing on where their vectors come from.
 */
const IN_PROCESS_BACKENDS: ReadonlySet<string> = new Set(["xenova", "embeddinggemma"]);

export function loadsWeightsLocally(backend: string): boolean {
  return IN_PROCESS_BACKENDS.has(backend.trim().toLowerCase());
}

/** Shown instead of a cache path for backends that hold no local weights. */
export const NO_LOCAL_WEIGHTS =
  "<n/a — this backend does not load weights locally (the sidecar image / a remote API holds them)>";

export interface EmbedSmokeOptions {
  getEmbedderFn?: () => Embedder;
  env?: NodeJS.ProcessEnv;
  cacheDirReader?: CacheDirReader;
  platform?: NodeJS.Platform;
}

/**
 * Run the smoke check.
 *
 * A broken **embedder** never throws — that is the thing we are here to report, so
 * it becomes a `verdict: "error"` report rather than a stack trace.
 *
 * An invalid **config** (a typo'd `EMBED_DTYPE`, an `HF_ENDPOINT` carrying
 * credentials or a query string) DOES throw, and deliberately: those already fail
 * loud at process start everywhere else in METIS (#782, #784), and a diagnostic
 * tool that quietly rendered a report around a config the server would refuse to
 * boot with would be lying about the deployment. The CLI turns it into a message
 * and exit 1.
 */
export async function runEmbedSmoke(options: EmbedSmokeOptions = {}): Promise<EmbedSmokeReport> {
  const {
    getEmbedderFn = getEmbedder,
    env = process.env,
    cacheDirReader = readRuntimeCacheDir,
    platform = process.platform,
  } = options;

  const embedder = getEmbedderFn();
  // `health()` warms the backend and REPORTS a load failure rather than raising it,
  // so the fail-loud path of #783 surfaces here as `status: "error"` + a message.
  const health = await embedder.health();

  const model = health.model;
  const resolved = resolvePooling(model, undefined, env);
  const mirror = resolveRemoteHost(env);

  // Only report a local cache (and only MAX_PATH-check it) for backends that
  // actually read one — see `loadsWeightsLocally`.
  const weightsLocal = loadsWeightsLocally(health.backend);
  const cachePath = weightsLocal ? resolveCachePath(env, await cacheDirReader()) : NO_LOCAL_WEIGHTS;

  const base = {
    platform,
    arch: process.arch,
    nodeVersion: process.version,
    backend: health.backend,
    model,
    dimension: health.dimension,
    pooling: resolved.pooling,
    poolingSource: resolved.source,
    dtype: resolveDtype(env),
    offline: isEmbedOffline(env),
    mirror: mirror ? redactUrl(mirror) : null,
    cachePath,
    weightsLocal,
    cacheHeadroom: weightsLocal
      ? checkCachePathHeadroom(cachePath, platform)
      : { cacheRoot: null, rootLength: 0, headroom: 0, atRisk: false },
    fellBack: health.fellBack,
    hashFallbackAllowed: health.hashFallbackAllowed,
    health: health.status,
    error: health.error,
  } satisfies Omit<EmbedSmokeReport, "semantic" | "verdict" | "reasons">;

  if (health.status === "error") {
    return {
      ...base,
      semantic: null,
      verdict: "error",
      reasons: [
        `The embeddings backend "${health.backend}" failed to load, so NOTHING is being embedded.`,
        health.error ?? "no error message was reported.",
      ],
    };
  }

  if (health.fellBack || isHashStub(health.backend, model)) {
    const reasons = health.fellBack
      ? [
          `The "${health.backend}" backend FELL BACK to the deterministic hash stub — the real model did not load.`,
          "Vectors are NOT semantic. Retrieval over them is noise, and only a reindex undoes it.",
          health.error ?? "no underlying error was reported.",
        ]
      : [
          `The hash stub is the SELECTED backend (model "${model}").`,
          "Vectors are deterministic and NON-SEMANTIC — this is a deliberate config, not a failure.",
          "Unset AI_OFFLINE / EMBED_BACKEND=offline / EMBED_MODEL=metis-offline-hash-v1 to embed for real.",
        ];
    // No semantic probe: we already KNOW what this is, and running it would only
    // invite reading a lucky margin as evidence of semantics.
    return { ...base, semantic: null, verdict: "hash-stub", reasons };
  }

  let semantic: SemanticProbeResult;
  try {
    const { vectors } = await embedder.embed([
      SMOKE_PROBES.anchor,
      SMOKE_PROBES.related,
      SMOKE_PROBES.unrelated,
    ]);
    if (vectors.length !== 3) {
      throw new Error(`expected 3 vectors, got ${vectors.length}`);
    }
    const relatedSim = cosine(vectors[0], vectors[1]);
    const unrelatedSim = cosine(vectors[0], vectors[2]);
    const margin = relatedSim - unrelatedSim;
    semantic = {
      relatedSim,
      unrelatedSim,
      margin,
      discriminates: margin > SEMANTIC_MARGIN,
    };
  } catch (err) {
    return {
      ...base,
      semantic: null,
      verdict: "error",
      reasons: [
        "The backend loaded but embedding the probe texts threw.",
        err instanceof Error ? err.message : String(err),
      ],
    };
  }

  if (!semantic.discriminates) {
    return {
      ...base,
      semantic,
      verdict: "suspect",
      reasons: [
        `The backend reports itself as "${health.backend}" / "${model}", but its vector space does NOT separate ` +
          "a paraphrase of the probe requirement from an unrelated sentence " +
          `(margin ${semantic.margin.toFixed(3)}, needs > ${SEMANTIC_MARGIN}).`,
        "That is at or near CHANCE LEVEL — the reference model scores 0.381 on these same probes. " +
          "The config looks right and the vectors do not, so trust the vectors: suspect weights that never " +
          "loaded (a mirror serving the wrong file), a truncated/corrupt cache, or a stub reached by some " +
          "path this check did not recognise.",
        "This bar only catches chance-level spaces. It will NOT catch subtler damage such as a CLS model " +
          "that got mean-pooled — see docs/EMBEDDINGS_BACKENDS.md § Pooling for that.",
      ],
    };
  }

  return {
    ...base,
    semantic,
    verdict: "real",
    reasons: [
      `Real semantic embeddings: "${model}" (${health.dimension}d, ${resolved.pooling}, ${resolveDtype(env)}) via the "${health.backend}" backend.`,
      `The vector space discriminates — a paraphrase scored ${semantic.relatedSim.toFixed(3)} against the anchor ` +
        `while an unrelated sentence scored ${semantic.unrelatedSim.toFixed(3)} (margin ${semantic.margin.toFixed(3)}).`,
    ],
  };
}

const VERDICT_HEADLINE: Record<SmokeVerdict, string> = {
  real: "REAL — semantic embeddings are working",
  "hash-stub": "HASH STUB — vectors are NOT semantic",
  suspect: "SUSPECT — configured as real, but the vectors do not discriminate",
  error: "ERROR — the embeddings backend did not load",
};

/** Render a report for a terminal. */
export function formatSmokeReport(report: EmbedSmokeReport): string {
  const lines: string[] = [
    "METIS embeddings smoke check",
    "============================",
    "",
    `VERDICT: ${VERDICT_HEADLINE[report.verdict]}`,
    "",
  ];
  for (const reason of report.reasons) lines.push(`  • ${reason}`);
  lines.push(
    "",
    "Embedder",
    `  backend        ${report.backend}`,
    `  model          ${report.model}`,
    `  dimension      ${report.dimension}`,
    `  pooling        ${report.pooling} (from: ${report.poolingSource})`,
    `  dtype          ${report.dtype}`,
    `  health         ${report.health}`,
    `  fell back      ${report.fellBack}`,
    `  hash fallback  ${report.hashFallbackAllowed ? "ALLOWED (EMBED_ALLOW_HASH_FALLBACK / AI_OFFLINE)" : "not allowed — a load failure throws"}`,
  );
  if (report.error) lines.push(`  error          ${report.error}`);

  lines.push(
    "",
    "Weights",
    `  offline        ${report.offline}`,
    `  mirror         ${report.weightsLocal ? (report.mirror ?? "<huggingface.co>") : "n/a"}`,
    `  cache          ${report.cachePath}`,
  );
  if (report.cacheHeadroom.atRisk) {
    lines.push(
      `  ⚠ WINDOWS MAX_PATH: this cache root leaves ${report.cacheHeadroom.headroom} of 260 characters for the`,
      "    model subpath, which may not be enough. Pin a SHORT cache dir, e.g. TRANSFORMERS_CACHE=C:\\hf-cache",
    );
  }

  if (report.semantic) {
    lines.push(
      "",
      "Semantic probe",
      `  cosine(anchor, related)    ${report.semantic.relatedSim.toFixed(4)}`,
      `  cosine(anchor, unrelated)  ${report.semantic.unrelatedSim.toFixed(4)}`,
      `  margin                     ${report.semantic.margin.toFixed(4)} (must exceed ${SEMANTIC_MARGIN})`,
      `  discriminates              ${report.semantic.discriminates}`,
    );
  }

  lines.push(
    "",
    "Runtime",
    `  platform       ${report.platform}/${report.arch}`,
    `  node           ${report.nodeVersion}`,
    "",
  );
  return lines.join("\n");
}

/** Process exit code: 0 only when the embedder is genuinely real. */
export function exitCodeFor(verdict: SmokeVerdict): number {
  return verdict === "real" ? 0 : 1;
}
