/**
 * Per-model embedding pooling + dtype resolution (issue #782).
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS DUPLICATED, BY DESIGN, IN TWO PACKAGES:
 *
 *   - `server/src/lib/rag/embed-model-config.ts`   (this file — the server)
 *   - `server/embeddings-svc/src/model-config.ts`  (the sidecar)
 *
 * The sidecar is deliberately standalone: `Dockerfile.embeddings` installs and
 * builds ONLY `@metis/embeddings-svc`, so it cannot import from `@metis/shared`
 * or `@metis/server` without dragging their sources (and their dependency
 * trees) into the sidecar image. The two copies are kept byte-identical below
 * the header comment and a parity test
 * (`server/embeddings-svc/tests/model-config-parity.test.ts`) fails CI if they
 * ever drift.
 * ---------------------------------------------------------------------------
 *
 * ## Pooling
 *
 * A feature-extraction pipeline turns a [tokens × hidden] matrix into ONE vector
 * per input. HOW it does that is a property of the MODEL, not of the caller:
 *
 *   - `cls`  — take the [CLS] token's hidden state. Required by
 *     `Alibaba-NLP/gte-modernbert-base` and IBM's `granite-embedding-*` models.
 *   - `mean` — average over the token hidden states. What `bge`/`jina`/MiniLM
 *     embedders are trained/served with in this codebase today.
 *
 * Using the wrong one does NOT error — it returns a unit-norm, finite,
 * plausible-looking vector that is semantically degraded, which silently
 * collapses hybrid retrieval to BM25-only quality. Hence the per-model map.
 *
 * ## Dtype
 *
 * transformers.js v3 resolves a DIFFERENT weights file per dtype
 * (`model_quantized.onnx` for q8 vs `model.onnx` for fp32), so the dtype the
 * runtime REQUESTS must match the dtype an air-gapped image BAKED. `q8` is the
 * shipped default (it is what #781 pinned and what both Dockerfiles bake), and
 * #788 settled the fp32-vs-q8 question in its favour: see {@link DEFAULT_DTYPE}.
 */

export type EmbedPooling = "mean" | "cls";
export type EmbedDtype = "fp32" | "q8";

export const EMBED_POOLINGS = ["mean", "cls"] as const satisfies readonly EmbedPooling[];
export const EMBED_DTYPES = ["fp32", "q8"] as const satisfies readonly EmbedDtype[];

/** Pooling used when nothing else resolves. Matches the pre-#782 hardcode. */
export const DEFAULT_POOLING: EmbedPooling = "mean";

/**
 * Shipped dtype. MUST stay in lockstep with the `ARG EMBED_DTYPE` defaults in
 * `Dockerfile.embeddings` / `Dockerfile.server` — enforced by
 * `server/tests/embeddings-dtype-lockstep.test.ts`.
 *
 * DECIDED (#788 → #783), not provisional. On the 30-query NL-requirement → code
 * corpus the default model scored HIGHER at q8 than at fp32 (0.402 vs 0.360
 * nDCG@10), so there is no measured quality reason to pay 4× the download/RAM.
 * Recorded limitation: n=30 is underpowered to CERTIFY q8 ≈ fp32 (the paired CI
 * is [−0.054, +0.137], p = 0.48) — the claim is "no evidence q8 is worse", not
 * "q8 is proven equivalent". Flipping to fp32 is a REBAKE (`--build-arg
 * EMBED_DTYPE=fp32`) plus a reindex, never a runtime config change: transformers
 * resolves a different weights FILE per dtype, and an `HF_HUB_OFFLINE=1` image
 * that requests a dtype it never baked cannot boot.
 */
export const DEFAULT_DTYPE: EmbedDtype = "q8";

/**
 * Hard cap on `texts` per `/embed` request (issue #786). Over the cap the sidecar
 * answers 400; it does not silently truncate.
 *
 * The cap exists because the default model's context is **8192 tokens**, and the
 * pipeline pads every row in a batch to the longest row. Peak resident memory is
 * therefore a function of `batch × longest-row-tokens`, NOT of the weights — the
 * weights are a fixed ~143 MiB at q8. One request carrying 256 full-context rows
 * is what turns a comfortably-provisioned pod into an OOMKill mid-embed, and an
 * OOMKill costs the whole batch, not just the oversized request.
 *
 * 64 is chosen against the measured working set (see `docs/EMBEDDINGS_BACKENDS.md`
 * §Resource profiles) so that a worst-case all-8192-token batch still fits inside
 * the shipped memory limit with headroom.
 *
 * This is an HTTP-contract constant, so the SERVER holds the same value and
 * splits oversized calls into ≤64-text requests before they reach the wire
 * (`EmbeddingsClient.embed`). Callers keep passing whole documents; nothing in
 * `knowledge-service` has to know the sidecar's limit. Both copies of this file
 * are byte-identical below the header, so the two can never drift.
 */
export const MAX_EMBED_TEXTS_PER_REQUEST = 64;

/**
 * Hard cap on the LENGTH of any one `texts[]` entry, in characters (issue #786).
 *
 * `MAX_EMBED_TEXTS_PER_REQUEST` alone bounds the batch by COUNT, which is not a
 * bound at all: 64 texts of 100 KB each is still 6.4 MB of input, accepted under
 * the 8 MB body limit and handed straight to the tokenizer. The model truncates
 * at 8192 tokens so it will not OOM — but the tokenizer still walks every byte,
 * and sidecar CPU is the scarce resource (one full-context row costs 11.5 s of
 * CPU, and the pod's CPU request is what a contended node throttles it to).
 *
 * 32,768 characters is ~16× METIS's default chunk (`DEFAULT_RAG_CHUNK_SIZE` =
 * 2048) and ~4× the model's entire 8192-token context at ~4 chars/token, so no
 * real chunk or query can reach it, while a caller that has gone wrong is
 * rejected before the tokenizer sees it. Together with the count cap, the
 * request's cost is now bounded from BOTH ends: ≤64 × 32 KiB, not ≤64 × ∞.
 */
export const MAX_EMBED_TEXT_CHARS = 32_768;

export interface PoolingRule {
  /** Human-readable glob, for docs + log lines. */
  readonly pattern: string;
  /** Applied to the lower-cased model basename (the part after the last `/`). */
  readonly match: RegExp;
  readonly pooling: EmbedPooling;
}

/**
 * First match wins. Keyed on the model basename, case-insensitive.
 *
 * ## Changing a rule here is an INDEX-CONTRACT change, not a config tweak
 *
 * Stored vectors carry the pooling they were built with, and chunk reuse is
 * keyed on the model id ALONE (`KnowledgeChunk.embeddingModel` — see
 * `knowledge-service.ts`). Nothing persists the pooling. So flipping a rule for
 * a model that is ALREADY INDEXED does not "fix" that index: it leaves the new
 * QUERY vectors searching a corpus pooled the OLD way — silently, with no
 * model-id change to trigger the existing reindex path.
 *
 * That is why `bge*` maps to `mean` here even though BAAI documents BGE as a CLS
 * model: METIS's index was built mean-pooled. Flipping `bge*` to `cls` without a
 * full reindex would leave CLS queries searching a mean-pooled corpus — strictly
 * WORSE than today's consistent-but-suboptimal state, and worse invisibly. If you
 * want to correct it, correct it TOGETHER with a reindex (see the pooling section
 * of `docs/EMBEDDINGS_BACKENDS.md`).
 */
export const POOLING_RULES: readonly PoolingRule[] = [
  { pattern: "gte-modernbert*", match: /^gte-modernbert/, pooling: "cls" },
  { pattern: "granite-embedding*", match: /^granite-embedding/, pooling: "cls" },
  // EmbeddingGemma is mean-pooled. Listed EXPLICITLY rather than left to the
  // `mean` fallback because it is a shipped, registered backend: with no rule it
  // logs "no per-model rule matched — set EMBED_POOLING_MAP if this is wrong" on
  // every single load, training operators to ignore the one warning that is
  // supposed to mean something. Behaviour is unchanged (the fallback is `mean`).
  { pattern: "embeddinggemma*", match: /^embeddinggemma/, pooling: "mean" },
  { pattern: "bge*", match: /^bge/, pooling: "mean" },
  { pattern: "jina*", match: /^jina/, pooling: "mean" },
  { pattern: "*minilm*", match: /minilm/, pooling: "mean" },
];

/** Where a resolved pooling value came from — logged so mismatches are traceable. */
export type PoolingSource = "request" | "env-map" | "model-map" | "env-default" | "fallback";

export interface ResolvedPooling {
  pooling: EmbedPooling;
  source: PoolingSource;
}

export function isEmbedPooling(value: unknown): value is EmbedPooling {
  return value === "mean" || value === "cls";
}

export function isEmbedDtype(value: unknown): value is EmbedDtype {
  return value === "fp32" || value === "q8";
}

/** `owner/Model-Name` → `model-name`. */
export function modelKey(model: string): string {
  const trimmed = model.trim();
  const basename = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return basename.toLowerCase();
}

/** The built-in per-model default, or `null` when no rule matches. */
export function poolingFromModelMap(model: string): EmbedPooling | null {
  const key = modelKey(model);
  for (const rule of POOLING_RULES) {
    if (rule.match.test(key)) return rule.pooling;
  }
  return null;
}

/**
 * Memo for `parsePoolingOverrides`. `EMBED_POOLING_MAP` cannot change within a
 * process lifetime, but `resolvePooling` runs on EVERY embed call — without this
 * the string is re-split, re-validated and a fresh `Map` allocated per request.
 * Keyed on the raw string, so a test passing a different value still re-parses.
 * An invalid value is never memoized: it throws on every call, as it must.
 */
let overridesMemo: { raw: string | undefined; parsed: ReadonlyMap<string, EmbedPooling> } | null =
  null;

/**
 * Parse `EMBED_POOLING_MAP` — a comma-separated `<model>=<pooling>` list, e.g.
 * `Alibaba-NLP/gte-modernbert-base=cls,acme/custom-embedder=mean`.
 *
 * This is the operator escape hatch for a model the built-in map does not know
 * (which would otherwise fall through to `mean` and silently degrade). Invalid
 * entries throw — a typo must not quietly become "mean". Call
 * `assertValidEmbedConfig()` at boot so that throw lands as a crashloop rather
 * than as a per-request 500.
 */
export function parsePoolingOverrides(raw: string | undefined): ReadonlyMap<string, EmbedPooling> {
  if (overridesMemo && overridesMemo.raw === raw) return overridesMemo.parsed;
  const out = new Map<string, EmbedPooling>();
  if (!raw || raw.trim().length === 0) {
    overridesMemo = { raw, parsed: out };
    return out;
  }
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.lastIndexOf("=");
    const model = eq === -1 ? "" : trimmed.slice(0, eq).trim();
    const pooling =
      eq === -1
        ? ""
        : trimmed
            .slice(eq + 1)
            .trim()
            .toLowerCase();
    if (!model || !isEmbedPooling(pooling)) {
      throw new Error(
        `Invalid EMBED_POOLING_MAP entry "${trimmed}". ` +
          `Expected "<model>=<pooling>" with pooling one of: ${EMBED_POOLINGS.join(", ")}.`,
      );
    }
    out.set(model.toLowerCase(), pooling);
  }
  overridesMemo = { raw, parsed: out };
  return out;
}

/**
 * The `EMBED_POOLING` global default, or `null` when unset. Throws on a typo —
 * a bad global default must not silently become "mean".
 */
function readGlobalPoolingDefault(env: Record<string, string | undefined>): EmbedPooling | null {
  const raw = env.EMBED_POOLING?.trim().toLowerCase();
  if (!raw) return null;
  if (!isEmbedPooling(raw)) {
    throw new Error(
      `Invalid EMBED_POOLING "${raw}". Expected one of: ${EMBED_POOLINGS.join(", ")}.`,
    );
  }
  return raw;
}

/**
 * Resolve the pooling for a model.
 *
 * Precedence (highest first):
 *   1. `requested`        — explicit per-request field on `/embed`
 *   2. `EMBED_POOLING_MAP` — operator per-model override
 *   3. built-in `POOLING_RULES` map
 *   4. `EMBED_POOLING`     — operator global default for unmapped models
 *   5. `DEFAULT_POOLING`   — "mean" (the pre-#782 hardcoded behaviour)
 */
export function resolvePooling(
  model: string,
  requested?: unknown,
  env: Record<string, string | undefined> = process.env,
): ResolvedPooling {
  if (requested !== undefined && requested !== null) {
    if (!isEmbedPooling(requested)) {
      throw new Error(
        `Invalid pooling "${String(requested)}". Expected one of: ${EMBED_POOLINGS.join(", ")}.`,
      );
    }
    return { pooling: requested, source: "request" };
  }

  const override = parsePoolingOverrides(env.EMBED_POOLING_MAP).get(model.trim().toLowerCase());
  if (override) return { pooling: override, source: "env-map" };

  const mapped = poolingFromModelMap(model);
  if (mapped) return { pooling: mapped, source: "model-map" };

  const globalDefault = readGlobalPoolingDefault(env);
  if (globalDefault) return { pooling: globalDefault, source: "env-default" };

  return { pooling: DEFAULT_POOLING, source: "fallback" };
}

/**
 * Resolve the ONNX weight dtype from `EMBED_DTYPE`. Invalid values throw rather
 * than falling back: a typo'd dtype in an air-gapped image would otherwise send
 * the runtime looking for weights that were never baked, and "helpfully"
 * defaulting would hide that until the first embed call.
 */
export function resolveDtype(env: Record<string, string | undefined> = process.env): EmbedDtype {
  const raw = env.EMBED_DTYPE?.trim().toLowerCase();
  if (!raw) return DEFAULT_DTYPE;
  if (!isEmbedDtype(raw)) {
    throw new Error(`Invalid EMBED_DTYPE "${raw}". Expected one of: ${EMBED_DTYPES.join(", ")}.`);
  }
  return raw;
}

/**
 * Issue #807 — the FORWARD-PASS batch size that keeps an embedding a *function of
 * its text*. This is the fix for a measured retrieval defect, not a tuning knob.
 *
 * ## The defect
 *
 * `q8` weights are DYNAMICALLY quantized: the exported graph carries 88
 * `DynamicQuantizeLinear` → `MatMulInteger` pairs (verified against the shipped
 * `Alibaba-NLP/gte-modernbert-base` `model_quantized.onnx`). Per the ONNX spec,
 * `DynamicQuantizeLinear` emits a **scalar** `y_scale` — a single PER-TENSOR
 * quantization scale derived from the min/max of its whole input, and that input
 * is the entire `[batch, seq, hidden]` activation tensor. So every text in a batch
 * shares one scale, and any batch-mate that widens the tensor's dynamic range
 * re-quantizes EVERY other row's activations.
 *
 * The consequence is that at `q8` an embedding is a function of `(model, text,
 * whatever else happened to be in the batch)`. Measured on the shipped model:
 *
 * ```
 *   cos(batch-1, batch-1')                      = 1.00000000   (control: not float jitter)
 *   cos(batch-1, batch-8)                       = 0.98040137
 *   cos(batch-1, batch-64)                      = 0.97384070
 * ```
 *
 * That cost ~6 places of retrieval rank on #797's acceptance target, and it makes
 * a reindex non-reproducible — which silently violates the `(model, text) → vector`
 * assumption the #787/#792 model-tagged reuse guard is built on.
 *
 * ## Why the obvious explanations are WRONG (each was tested, not reasoned about)
 *
 *   - **NOT an attention-mask bug.** `attention_mask` IS an input of the ONNX graph
 *     and transformers.js DOES pass it (`FeatureExtractionPipeline._call` tokenizes
 *     with `padding: true` and feeds the mask to the model).
 *   - **NOT padding, despite appearances.** A batch of 64 IDENTICAL texts pads to
 *     nothing and reproduces the batch-1 vector EXACTLY (cos = 1.00000000). But a
 *     batch of 8 texts of the SAME token length and different content — i.e. zero
 *     padding — still drifts (cos = 0.98766913). It is batch COMPOSITION, not
 *     padding. This is why sorting/bucketing a batch by length does NOT fix it, and
 *     any fix framed around minimising padding would have been ineffective.
 *   - **Not present at `fp32`.** With no dynamic-quantization node in the graph,
 *     batching is exact: cos(batch-1, batch-64) = 1.00000000, max |Δ| = 8.9e-8
 *     (pure float non-associativity).
 *
 * ## The policy
 *
 * A per-tensor scale is only a function of one text when the tensor HOLDS only one
 * text. So a quantized dtype gets a forward batch of exactly 1; `fp32` is provably
 * batch-invariant and keeps full batching.
 *
 * This is a bound on the MODEL CALL, not on the HTTP request: the sidecar still
 * accepts `MAX_EMBED_TEXTS_PER_REQUEST` (64) texts per POST and still amortises the
 * round-trip over them — it just runs the forward pass one row at a time. So this
 * does NOT turn ingest's ~235 sidecar posts into ~15,000 (an earlier reading of this
 * trade-off in #797 assumed it would). The real cost is CPU, and it is bounded:
 * measured on the shipped q8 model, 64 texts one-at-a-time is **1.87×** the wall
 * time of one 64-text call — not 64×, because a batched ONNX CPU run is already
 * largely serial over rows.
 */
export const QUANTIZED_FORWARD_BATCH = 1;

/**
 * Resolve the forward-pass batch cap. `null` means "no cap" — hand the whole batch
 * to the model in one call.
 *
 * `EMBED_FORWARD_BATCH` may only ever LOWER the cap, never raise it. That is
 * deliberate: raising it on a quantized dtype would silently re-introduce #807's
 * non-deterministic vectors, and no operator wants that badly enough to be handed a
 * flag for it. On `fp32` (uncapped by default) the env var is a genuine memory
 * control — peak resident memory scales with `batch × longest-row-tokens`.
 *
 * Invalid values throw, for the same reason {@link resolveDtype} does: a typo must
 * crashloop at boot rather than quietly restore a broken default.
 */
export function resolveForwardBatch(
  dtype: EmbedDtype = resolveDtype(),
  env: Record<string, string | undefined> = process.env,
): number | null {
  const dtypeCap = dtype === "fp32" ? null : QUANTIZED_FORWARD_BATCH;

  const raw = env.EMBED_FORWARD_BATCH?.trim();
  if (!raw) return dtypeCap;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Invalid EMBED_FORWARD_BATCH "${raw}". Expected a positive integer (the number of ` +
        `texts per model forward pass).`,
    );
  }
  // Lower-only. See the doc comment.
  return dtypeCap === null ? parsed : Math.min(dtypeCap, parsed);
}

/**
 * Split `texts` into the forward passes the model may be given, preserving order.
 *
 * The caller concatenates the resulting vectors, so this is the single place that
 * decides how many rows ever share a quantization scale. A `null` cap yields one
 * batch containing everything (the `fp32` path — unchanged behaviour).
 */
export function forwardBatches(
  texts: readonly string[],
  dtype: EmbedDtype = resolveDtype(),
  env: Record<string, string | undefined> = process.env,
): string[][] {
  if (texts.length === 0) return [];
  const cap = resolveForwardBatch(dtype, env);
  if (cap === null || cap >= texts.length) return [[...texts]];

  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += cap) {
    batches.push(texts.slice(i, i + cap));
  }
  return batches;
}

/**
 * BOOT-TIME validation of the embedding env config. Throws on the first bad
 * value; callers are expected to let that kill the process.
 *
 * Why this exists: `resolvePooling()` / `resolveDtype()` throw on bad config
 * (correct — a typo must never quietly become `mean`/`q8`), but they run inside
 * the request path. Without an eager check, `EMBED_POOLING_MAP=acme/m=clss`
 * yields a pod that boots fine, passes `/healthz`, is handed traffic, and then
 * 500s on EVERY embed call. A crashloop is the honest signal: instant,
 * unambiguous, and caught by the deploy rather than by retrieval quality.
 *
 * Note it also catches a bad `EMBED_POOLING` that `resolvePooling()` alone would
 * never reach — that branch only runs for a model no rule matches, so a typo'd
 * global default can lie dormant until someone configures an unmapped model.
 *
 * Validates: `EMBED_POOLING_MAP`, `EMBED_POOLING`, `EMBED_DTYPE`,
 * `EMBED_FORWARD_BATCH`, `HF_ENDPOINT`.
 */
export function assertValidEmbedConfig(
  env: Record<string, string | undefined> = process.env,
): void {
  parsePoolingOverrides(env.EMBED_POOLING_MAP);
  readGlobalPoolingDefault(env);
  const dtype = resolveDtype(env);
  // #807 — a typo'd forward-batch cap must crashloop at boot, not 500 on the first
  // embed call. Passing the resolved dtype keeps this honest for the fp32 path,
  // where the cap is the only thing bounding peak memory.
  resolveForwardBatch(dtype, env);
  // #784 — a typo'd mirror host must crashloop, not silently fall back to
  // huggingface.co (which a corp network blocks, and an air-gap forbids).
  resolveRemoteHost(env);
}

/**
 * Best-effort: read the pooling a model DECLARES for itself from its loaded
 * config.
 *
 * Honest caveat: transformers.js loads `config.json`, which for the vast
 * majority of embedders says nothing about pooling — sentence-transformers keeps
 * that in `1_Pooling/config.json`, which the feature-extraction pipeline does
 * not fetch. So this returns `null` for most models and the per-model map above
 * remains the real source of truth. When a config DOES carry the
 * `pooling_mode_*` flags, we can (and do) warn on a mismatch.
 */
export function declaredPoolingFromConfig(config: unknown): EmbedPooling | null {
  if (!config || typeof config !== "object") return null;
  const c = config as Record<string, unknown>;
  if (c.pooling_mode_cls_token === true) return "cls";
  if (c.pooling_mode_mean_tokens === true) return "mean";
  return null;
}

/* -------------------------------------------------------------------------- */
/* Weights delivery — bake / mirror / offline (issue #784)                     */
/* -------------------------------------------------------------------------- */

/**
 * The two embed model ids this repo knows, one literal each. Every other
 * reference — the runtime default, the bake list, the Dockerfile ARG, the
 * server's `DEFAULT_XENOVA_EMBED_MODEL` — is derived from these or guarded
 * against them, so each id is written down in exactly one place.
 */
export const BGE_SMALL_EMBED_MODEL = "Xenova/bge-small-en-v1.5";

/**
 * The code-capable model epic #780 migrated to (768d, CLS-pooled, q8) — as of
 * #783 this IS {@link DEFAULT_SIDECAR_EMBED_MODEL}. {@link BGE_SMALL_EMBED_MODEL}
 * is still baked ALONGSIDE it rather than dropped: chunks indexed before the flip
 * are queried BY MODEL ID, so an offline image without the old weights could not
 * serve a pre-flip corpus even to roll the default back.
 */
export const AIR_GAP_EMBED_MODEL = "Alibaba-NLP/gte-modernbert-base";

/**
 * THE model the sidecar serves when a request omits `model` and `EMBED_MODEL` is
 * unset — the SINGLE SOURCE OF TRUTH for "what does this image actually serve".
 *
 * Three consumers, one constant:
 *   - `app.ts` defaults `/embed`'s `model` from it (via {@link resolveEmbedModel});
 *   - {@link DEFAULT_BAKE_MODELS} is DERIVED from it, so the default build cannot
 *     ship an image that fails to bake its own default;
 *   - `Dockerfile.embeddings`'s `ARG EMBED_MODEL` default is pinned to it by
 *     `server/tests/embeddings-bake-lockstep.test.ts`.
 *
 * Why the ceremony: the runtime runs `HF_HUB_OFFLINE=1`, so the baked cache is
 * the COMPLETE set of models the image can ever load. "The model we serve" and
 * "the models we bake" must not be independently editable string literals. They
 * were exactly that until #784's review: three copies, with the guard comparing
 * two of them to each other while the only one that decided what the sidecar
 * actually served (`app.ts`'s local const) was referenced by nothing.
 *
 * #783 flipped this constant to {@link AIR_GAP_EMBED_MODEL} (768d, `cls`, `q8`) on
 * the strength of the #788 eval: +0.156 nDCG@10 over {@link BGE_SMALL_EMBED_MODEL}
 * on NL-requirement → code retrieval. The flip could not land alone — the lockstep
 * guard failed until `Dockerfile.embeddings`'s `ARG EMBED_MODEL` followed it, and
 * the bake list follows this constant automatically.
 *
 * Note what makes this id safe to serve: {@link POOLING_RULES} binds
 * `gte-modernbert*` to `cls`. The SAME weights at `mean` pooling measured 0.254 —
 * indistinguishable from the model this replaced. The model id alone is not the
 * upgrade; the id PLUS its pooling is.
 */
export const DEFAULT_SIDECAR_EMBED_MODEL: string = AIR_GAP_EMBED_MODEL;

/** Case-insensitive, order-preserving dedupe of HuggingFace model ids. */
function dedupeModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of models) {
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

/**
 * Embed models baked into the sidecar image when `BAKE_EMBED_MODELS` is unset.
 *
 * DERIVED from {@link DEFAULT_SIDECAR_EMBED_MODEL} rather than listed beside it:
 * the served default is always element 0, which makes "the default build bakes
 * what it serves" a property of the code instead of a property of a comment.
 *
 * {@link BGE_SMALL_EMBED_MODEL} stays in the list across the #783 flip even once
 * it stops being the default, because chunks already indexed with it are queried
 * BY MODEL ID (`KnowledgeChunk.embeddingModel`) — an offline image without its
 * weights would break retrieval on every pre-flip corpus. At the shipped `q8`
 * dtype carrying both costs ~154 MB (see `docs/EMBEDDINGS_BACKENDS.md`); an
 * operator who has made the call can trim to one with
 * `--build-arg BAKE_EMBED_MODELS=<model>` (see {@link resolveBakeModels}).
 */
export const DEFAULT_BAKE_MODELS: readonly string[] = dedupeModels([
  DEFAULT_SIDECAR_EMBED_MODEL,
  BGE_SMALL_EMBED_MODEL,
  AIR_GAP_EMBED_MODEL,
]);

/**
 * The model the RUNTIME serves by default: `EMBED_MODEL` if set, else
 * {@link DEFAULT_SIDECAR_EMBED_MODEL}.
 *
 * Called by the sidecar's `/embed` (for its `model` default) AND by the image
 * build (through {@link resolveBakeModels}), so `--build-arg EMBED_MODEL=…` moves
 * the served default and the baked set together — the way `EMBED_DTYPE` already
 * does. That only holds because `Dockerfile.embeddings` exports `ENV EMBED_MODEL`
 * into the RUNNER stage as well as the builder: `ARG`/`ENV` do not cross a
 * `FROM`, and without that line the build-time value and the served default are
 * unrelated variables that merely share a name.
 */
export function resolveEmbedModel(env: Record<string, string | undefined> = process.env): string {
  const raw = env.EMBED_MODEL?.trim();
  return raw ? raw : DEFAULT_SIDECAR_EMBED_MODEL;
}

/**
 * The embed models a build should bake: `BAKE_EMBED_MODELS` (a comma-separated
 * list of HF model ids) or {@link DEFAULT_BAKE_MODELS}. Order preserved,
 * case-insensitive duplicates dropped.
 *
 * THROWS when the resolved list omits the model the image will SERVE
 * ({@link resolveEmbedModel}). The rejected alternative — silently PREPENDING the
 * served model, which is what #784 shipped for review — is wrong in both
 * directions:
 *
 *   - `--build-arg BAKE_EMBED_MODELS=<other model>` silently kept baking the
 *     default as well, so the documented way to shrink the image did nothing; and
 *   - it made the served default look guarded when it was not: the value being
 *     prepended was a BUILD-time `EMBED_MODEL` that the runner stage never
 *     exported, so it had no relationship to the model the sidecar would serve.
 *
 * Under `HF_HUB_OFFLINE=1` a model missing from the cache is not a slow first
 * request — it is a pod that cannot boot. Failing the BUILD, with both ways out
 * spelled in the message, is the only behaviour that is honest in both
 * directions.
 */
export function resolveBakeModels(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.BAKE_EMBED_MODELS?.trim();
  const listed = raw
    ? raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [...DEFAULT_BAKE_MODELS];

  const models = dedupeModels(listed);

  if (models.length === 0) {
    throw new Error(
      "BAKE_EMBED_MODELS resolved to an empty model list. Pass a comma-separated " +
        "list of HuggingFace model ids, or set BAKE_MODELS=0 to skip baking entirely.",
    );
  }

  const served = resolveEmbedModel(env);
  if (!models.some((model) => model.toLowerCase() === served.toLowerCase())) {
    throw new Error(
      `BAKE_EMBED_MODELS (${models.join(", ")}) does not include "${served}" — the model this ` +
        "image SERVES by default. The sidecar runs with HF_HUB_OFFLINE=1, so it can only ever " +
        "load weights from the baked cache: that image would boot and then fail on its first " +
        `embed call. Either add "${served}" to BAKE_EMBED_MODELS, or point the runtime at a ` +
        "model you ARE baking, with --build-arg EMBED_MODEL=<one of the baked models>.",
    );
  }
  return models;
}

/**
 * A URL safe to print: any embedded credentials are stripped.
 *
 * `HF_ENDPOINT` is rejected outright when it carries userinfo (see
 * {@link resolveRemoteHost}), but the value still has to be echoed back to be
 * actionable — and the one place a token would otherwise leak is the very
 * message telling the operator not to put a token there.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) return raw;
    url.username = "";
    url.password = "";
    return `${url.href} (credentials redacted)`;
  } catch {
    return raw.replace(/\/\/[^/@\s]*@/, "//<redacted>@");
  }
}

/**
 * `HF_ENDPOINT` — an internal HuggingFace mirror, for corp networks and VPCs
 * with no `huggingface.co` egress (the 401/blocked-fetch that motivated #780).
 *
 * transformers.js does NOT read `HF_ENDPOINT` — that is a `huggingface_hub`
 * (Python) convention. It builds every download URL as
 * `env.remoteHost + env.remotePathTemplate` (`{model}/resolve/{revision}/`), so
 * METIS maps the variable onto `remoteHost` itself and normalises the trailing
 * slash that the template assumes. Without this, setting `HF_ENDPOINT` on a
 * Node deployment looks configured and silently keeps hitting huggingface.co.
 *
 * Returns `null` when unset. Everything else THROWS rather than falling back to
 * the public hub: an operator who typo'd their mirror must find out at boot, not
 * by wondering why the air-gapped pod is making egress calls.
 *
 * This is the one setting that decides where an executable ONNX graph comes
 * from, so it is PARSED, not regex-matched (OWASP A08 — software/data integrity):
 *
 *   - non-URL, or non-http(s) (`file:`, `ftp:`, a bare hostname) → throw;
 *   - embedded credentials → throw. They leak into build logs and stdout;
 *   - query string / fragment → throw. The path template is CONCATENATED onto
 *     this value, so `?x=` silently corrupts every download URL it builds;
 *   - plaintext `http://` → throw UNLESS `HF_ENDPOINT_ALLOW_INSECURE` is set.
 *     transformers.js verifies no checksum, no revision pin and no signature, so
 *     anyone on-path can substitute the model this process is about to execute.
 *     That deserves an explicit, recorded opt-in — not a regex that happened to
 *     spell `https?`.
 */
export function resolveRemoteHost(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.HF_ENDPOINT?.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `Invalid HF_ENDPOINT "${redactUrl(raw)}". Expected an absolute http(s) URL, ` +
        'e.g. "https://hf-mirror.corp.example".',
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `Invalid HF_ENDPOINT "${redactUrl(raw)}": protocol "${url.protocol}" is not supported. ` +
        'Expected an absolute http(s) URL, e.g. "https://hf-mirror.corp.example".',
    );
  }

  if (url.username || url.password) {
    throw new Error(
      "Invalid HF_ENDPOINT: it must not embed credentials (https://user:token@host). The " +
        "endpoint is echoed into build logs and process stdout, so the secret would leak. " +
        "Authenticate the mirror with a proxy or an injected Authorization header instead.",
    );
  }

  if (url.search || url.hash) {
    throw new Error(
      `Invalid HF_ENDPOINT "${redactUrl(raw)}": a query string or fragment cannot survive the ` +
        'download path template transformers.js appends to it ("{model}/resolve/{revision}/"). ' +
        "Pass an origin, plus an optional base path, only.",
    );
  }

  if (url.protocol === "http:" && !isTruthyFlag(env.HF_ENDPOINT_ALLOW_INSECURE)) {
    throw new Error(
      `Refusing plaintext HF_ENDPOINT "${redactUrl(raw)}". Model weights are executable ONNX ` +
        "graphs and transformers.js verifies no checksum, revision pin or signature, so anyone " +
        "on-path could substitute the model this process loads. Use https://, or set " +
        "HF_ENDPOINT_ALLOW_INSECURE=1 to accept that risk explicitly.",
    );
  }

  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

/** Truthy check for `1`/`true`/`yes`/`on` (case-insensitive) flags. */
function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * True when weights must come from the local cache only.
 *
 * `HF_HUB_OFFLINE` and `TRANSFORMERS_OFFLINE` are the HuggingFace-ecosystem
 * names; `EMBEDDINGS_OFFLINE` is METIS's own. Any one of them is enough — an
 * operator who sets the variable they happen to know must not end up with an
 * image that still reaches for the network.
 */
export function isEmbedOffline(env: Record<string, string | undefined> = process.env): boolean {
  return (
    isTruthyFlag(env.HF_HUB_OFFLINE) ||
    isTruthyFlag(env.TRANSFORMERS_OFFLINE) ||
    isTruthyFlag(env.EMBEDDINGS_OFFLINE)
  );
}
