# Embeddings Backends

METIS supports **pluggable, multi-backend RAG embeddings** (epic
#930). The embeddings /
retrieval path is decoupled from the generative LLM path: you can run a
cloud-hosted LLM for generation while keeping embeddings fully local, or vice
versa.

> **No single backend is mandated.** The backend is selected per deployment via
> `EMBED_BACKEND` (and a small set of fallbacks). If nothing is configured the
> server resolves a sensible default based on the embeddings mode — see
> [Selection precedence](#selection-precedence). Every backend implements the
> same `EmbedBackend` interface and is registered in the embedder registry.

## Local runtime: `@huggingface/transformers` v3

The three local backends (`xenova`, `embeddinggemma`, and the `sidecar`'s
in-process pipelines) all run on **`@huggingface/transformers` v3**
(transformers.js v3) — the maintained successor to `@xenova/transformers`, which
was pinned at 2.17.2 and is no longer developed. The migration landed in
[#781](https://github.com/openzigs/metis-private/issues/781).

Why it matters:

- **ModernBERT-class models are now loadable.** transformers.js v2 registers
  neither the `modernbert` nor the `gemma3` architecture, so
  `Alibaba-NLP/gte-modernbert-base` (the model chosen by epic
  [#780](https://github.com/openzigs/metis-private/issues/780)) could not be loaded at
  all on the old runtime.
- **`embeddinggemma` now actually works.** That backend's default model,
  `onnx-community/embeddinggemma-300m-ONNX`, is a Gemma3 architecture and was
  therefore **unloadable on the old runtime** — the backend was effectively dead
  on arrival. It loads and embeds (768-dim) under v3.

The `xenova` **registry key is retained** (`EMBED_BACKEND=xenova`) for config
compatibility — it names a backend and its persisted
`KnowledgeChunk.embeddingModel` rows, not the npm package.

## Where the in-process model runs — `EMBED_INPROCESS_RUNTIME` (issue #189)

`onnxruntime-node` runs inference **synchronously on the thread that calls it**. Its
binding defers `InferenceSession.run` with `setImmediate`, which only moves the block
to the next loop turn. Until #189, the `xenova` and `embeddinggemma` backends called it
from the server's main thread. Embedding a 611,592-character generated document
therefore stopped `/healthz` from answering, made `/api/auth/me` take 5.2 minutes to
fail, and never finished.

| `EMBED_INPROCESS_RUNTIME` | Behaviour |
| --- | --- |
| `worker` (default) | The model loads and runs in a `worker_thread`. The main thread only posts a message and awaits the vectors. |
| `inline` | Runs on the calling thread, as before #189. Only tests use it: a module mock of `@huggingface/transformers` does not cross a thread boundary. |

- **One worker per backend, one forward call at a time.** `XenovaEmbedder` still
  applies the #807 forward-batch policy (one text per call at `q8`). In the worker, an
  `fp32` batch is also split into calls of at most 16 texts. `fp32` is batch-invariant,
  so the split is exact. A chat query that arrives during a large ingest waits for at
  most one forward pass.
- **Every input is capped at 2,048 tokens** (`MAX_EMBED_SEQUENCE_TOKENS`). gte-modernbert
  accepts 8,192 tokens, and attention cost grows with the square of the length. A
  51,081-character chunk measured **15.1 s and 7.8 GB RSS at 8,192 tokens**, and
  **0.9 s and 1.4 GB at 2,048**. Every METIS chunker emits less than 2,048 tokens per
  chunk, so no stored vector changes. The chunkers are the primary bound: the
  generated-document chunker is now hard-capped at 1,500 characters. The token cap is
  the backstop.
- **Measured on the real 611,592-character document** (576 chunks, real model, `q8`):
  in the worker, the embed took 33.1 s and the worst `/healthz` answer during it was
  17 ms, over 1,481 probes. Inline, with the same chunks, the worst `/healthz` answer
  was 1,563 ms. Chunking alone does not meet the 1 s responsiveness bar.
- **Why not the sidecar?** The `sidecar` backend moves inference out of the process
  entirely, and it remains the recommended production topology. It is a separate
  deployment that an operator opts into. The worker fixes the default, in-process
  backend without adding a deployment.
- **Why the worker body is a string** (`EMBED_WORKER_SOURCE`): on Node 22, tsx's loader
  hooks do not take effect in worker threads, so a `.ts` worker entry cannot import its
  siblings under `pnpm dev` or vitest. `tsc` also does not copy a `.mjs` into `dist`.
  The body is therefore a small JavaScript constant that imports transformers.js by an
  absolute URL.

## Pooling — this MUST match the model

A feature-extraction pipeline collapses a `[tokens × hidden]` matrix into one
vector per input. **How** it collapses is a property of the model, not a taste
setting:

| Model (`EMBED_MODEL`) | Pooling | Dims |
| --- | --- | --- |
| `Alibaba-NLP/gte-modernbert-base` **(default since [#783](https://github.com/openzigs/metis-private/issues/783))** | **`cls`** | 768 |
| `onnx-community/granite-embedding-small-english-r2-ONNX` | **`cls`** | 384 |
| `onnx-community/granite-embedding-english-r2-ONNX` | **`cls`** | 768 |
| `Xenova/bge-small-en-v1.5` *(the pre-#783 default)* | `mean` | 384 |
| `jinaai/jina-embeddings-v2-base-code` | `mean` | 768 |
| `Xenova/all-MiniLM-L6-v2` | `mean` | 384 |
| `onnx-community/embeddinggemma-300m-ONNX` | `mean` | 768 (Matryoshka 768/512/256/128) |

> **If the pooling is wrong, nothing breaks — and that is the danger.** Mean-pooling
> a CLS model still returns a finite, unit-norm, entirely plausible-looking
> vector; it is just semantically worse. Measured on real weights (see
> `server/embeddings-svc/tests/pooling.integration.test.ts`): the CLS and mean
> vectors for the same input have cosine similarity **0.856** on
> `gte-modernbert-base`. Retrieval quality silently drops, the vector half of
> hybrid `search_code_symbols` stops pulling its weight, and hybrid search
> degenerates towards **BM25-only quality** — with no error, no warning in the
> data, and no way to tell from the vectors themselves.

Pooling is resolved per model (issue
[#782](https://github.com/openzigs/metis-private/issues/782)) by, in order:

1. an explicit `pooling` field on the sidecar's `/embed` request;
2. `EMBED_POOLING_MAP` — an operator per-model override;
3. the built-in per-model map above (`gte-modernbert*` / `granite-embedding*` →
   `cls`; `embeddinggemma*` / `bge*` / `jina*` / `*minilm*` → `mean`);
4. `EMBED_POOLING` — a global default for models the map does not know;
5. `mean` — the historical fallback.

The rules live in `server/embeddings-svc/src/model-config.ts` (sidecar) and
`server/src/lib/rag/embed-model-config.ts` (server); the two files are kept
byte-identical by a parity test. The resolved pooling + dtype are **logged at
model load** on both paths. If a model's own config declares a pooling mode and
it disagrees with the resolved one, the load logs a loud `POOLING MISMATCH`
warning — but note that most HF configs say nothing about pooling
(sentence-transformers keeps it in `1_Pooling/config.json`, which the
feature-extraction pipeline does not read), so **the map, not auto-detection, is
the real safeguard**. Adding a new model means adding a rule.

A malformed `EMBED_POOLING`, `EMBED_POOLING_MAP` or `EMBED_DTYPE` is rejected **at
process start** (server `createApp()`, sidecar `createApp()`) — the pod crashloops
instead of booting, passing its health check, and then failing every embed call.
An invalid `pooling` field on an individual `/embed` request is still a plain
`400`.

> ### Changing the pooling (or dtype) of an already-indexed model is caught mechanically
>
> Pooling and dtype are part of the **persisted embedding identity**, not just a
> runtime setting — [#792](https://github.com/openzigs/metis-private/issues/792). A stored
> vector is a function of `(model, pooling, dtype)`: `cos(cls, mean) = 0.856` on
> gte-modernbert (a completely different vector), and `q8` vs `fp32` weights differ
> too. So all three participate in the identity the chunk-reuse guard compares,
> written into the one field that already flows end-to-end
> (`KnowledgeChunk.embeddingModel` **and** the vector-store row metadata).
>
> **The representation — "bare when default".** The identity is:
>
> - the **bare model id** (`Alibaba-NLP/gte-modernbert-base`) when the resolved
>   pooling+dtype are the model's built-in defaults (its `POOLING_RULES` entry and
>   `DEFAULT_DTYPE=q8`) — the shipped config; and
> - `model|pooling|dtype` (`Alibaba-NLP/gte-modernbert-base|mean|q8`) otherwise.
>
> This makes grandfathering a mathematical identity instead of a data migration:
> every row written before #792 carries a bare model id, and every one of them was
> produced by the built-in resolution, so the active embedder at its default config
> produces the **same** bare identity and those rows match exactly — **no spurious
> reindex, no retag, no migration, no schema change.** The instant you flip
> `EMBED_POOLING` / `EMBED_POOLING_MAP` / `EMBED_DTYPE`, the resolved values leave
> the defaults, the identity gains its `|pooling|dtype` suffix, it stops matching
> the bare corpus, and `coverageReport()` reports `needsReindex` — driving the
> existing model-change reindex flow for free. A redundant override that resolves
> to the built-in value (`EMBED_POOLING_MAP=…=cls` on a model already `cls`) stays
> **bare** and correctly reuses: the vectors are identical.
>
> **The sidecar process boundary.** For the `sidecar` backend, pooling+dtype are
> resolved *inside the sidecar process*, from the **sidecar's** env, which can
> differ from the server's. The sidecar's `/embed` response echoes the pooling and
> dtype it **actually used**, and the server persists **that wire value** — never a
> locally re-derived guess. Stamping a server-side guess onto a sidecar-produced
> vector is exactly the silent disagreement this closes, now with a guard vouching
> for it. Because the persisted identity carries the sidecar's real values, a
> **server/sidecar env mismatch is detectable** — it surfaces as an identity (and
> therefore coverage/reindex) change rather than being mislabelled.
>
> Scope note: the pooling/dtype identity applies to the **document chunk** corpus.
> The code-symbol corpus ([#797](https://github.com/openzigs/metis-private/issues/797))
> keeps its model-id key; extending the composite identity to symbols is that
> issue's domain.

## Quantization — `EMBED_DTYPE`

transformers.js v2 loaded the **quantized (q8)** ONNX weights by default. v3
replaced that flag with `dtype`, which defaults to **fp32** on Node. METIS pins
**`q8`** as its default so download size and resident memory are unchanged from
the pre-v3 runtime (~150 MB vs ~600 MB for the epic's target model). `EMBED_DTYPE`
(`fp32` | `q8`) makes it configurable. The quality question (is fp32 worth 4× the
memory?) was gated on the [#788](https://github.com/openzigs/metis-private/issues/788) eval:
on that corpus fp32 scored *below* q8 on the headline metric (0.360 vs 0.402 vector
nDCG@10). The 30-query corpus is **underpowered to prove the two equivalent** (paired
95% CI [−0.054, +0.137], p = 0.48), so the honest reading is *no evidence q8
degrades retrieval* rather than *q8 and fp32 are the same* — and that is enough:
there is **no measured quality reason to pay 4× the memory for fp32**. See
[Model evidence](#model-evidence--the-788-retrieval-eval-decision-matrix-evidence-row)
for the failed tolerance check and the recorded AC deviation. **`q8` stays the default.**

> **Dtype lockstep.** v3 resolves a *different weights file* per dtype
> (`model_quantized.onnx` vs `model.onnx`). An air-gapped image can only serve
> the dtype it BAKED, so `EMBED_DTYPE` is a **build arg on both Dockerfiles** and
> the bake step reads the same env var the runtime does:
>
> ```bash
> docker build -f Dockerfile.embeddings --build-arg EMBED_DTYPE=fp32 .
> ```
>
> That single arg moves the bake *and* the runtime request together. Overriding
> `EMBED_DTYPE` at deploy time on an image baked with a different dtype and
> `HF_HUB_OFFLINE=1` will fail to boot (the requested weights were never baked) —
> rebuild instead. An invalid value fails loud rather than defaulting.
> `server/tests/embeddings-dtype-lockstep.test.ts` guards this in CI.

## Batch invariance — `EMBED_FORWARD_BATCH` (issue #807)

**At `q8`, an embedding used to be a function of `(model, text, whatever else was in
the batch)`.** Not of the text alone. Measured on the shipped model:

| comparison | cosine |
|---|---|
| batch-1 vs batch-1 (control) | `1.00000000` |
| batch-1 vs batch-8 | `0.98040137` |
| **batch-1 vs batch-64** | **`0.97384070`** |
| batch-1 vs batch-64, at `fp32` | `1.00000000` (max \|Δ\| `8.9e-8`) |

That was worth ~6 places of retrieval rank, and it made reindexes non-reproducible —
the same corpus, re-ingested in a different order, yielded a different index.

**The cause is dynamic quantization, not padding.** The `q8` graph carries 88
`DynamicQuantizeLinear` → `MatMulInteger` pairs, and per the ONNX spec
`DynamicQuantizeLinear` emits a **scalar** `y_scale`: one per-tensor activation scale
derived from the min/max of the *whole* `[batch, seq, hidden]` tensor. So every row in
a batch is quantized against its batch-mates' dynamic range. The obvious suspects were
both tested and cleared:

- **Not the attention mask.** `attention_mask` *is* an input of the ONNX graph, and
  transformers.js *does* pass it.
- **Not padding.** A batch of 64 **identical** texts pads to nothing and reproduces the
  batch-1 vector *exactly*. A batch of same-length, different-content texts *also* pads
  to nothing — and **still drifts** (`0.98766913`). It is batch **composition**.
  Corollary: **length-sorting the batch to minimise padding would have fixed nothing.**

**The fix bounds the model forward pass, not the HTTP request.** A quantized dtype runs
**one text per forward pass**; `fp32` keeps full batching, because there it is provably
exact. The sidecar still accepts `MAX_EMBED_TEXTS_PER_REQUEST` (64) texts per `/embed`
post and still amortises the round-trip over them — so ingest still makes ~235 posts for
METIS's ~15k symbols, **not ~15,000**. The real cost is CPU, and it is bounded: **1.87×**
the wall time of one 64-text call (a batched ONNX CPU run is already largely serial over
rows). Both the sidecar and the in-process embedder are covered.

`EMBED_FORWARD_BATCH` (positive integer) may only **lower** the cap, never raise it:

| dtype | default | `EMBED_FORWARD_BATCH=8` | `EMBED_FORWARD_BATCH=64` |
|---|---|---|---|
| `q8` | 1 | 1 | **1** (ignored — see below) |
| `fp32` | unbounded | 8 | 64 |

On `fp32` it is a genuine **memory control** (peak resident memory scales with
`batch × longest-row-tokens`). On a quantized dtype, raising it would silently restore
non-deterministic vectors in exchange for 1.87× throughput — not a trade an operator
should be able to make by typo — so it is clamped. A malformed value **crashloops at
boot** rather than 500ing on the first embed call.

> **If you change the dtype, re-run the retrieval sweep.** The RRF weights in
> `hybrid-search.ts` are tuned against the *vectors the embedder actually produces*.
> #803's weights were swept against the batch-contaminated vectors and had to be
> re-swept once #807 fixed them.

## The default model — `Alibaba-NLP/gte-modernbert-base` (768d, `cls`, `q8`)

| | Value | Why |
| --- | --- | --- |
| **Model** | `Alibaba-NLP/gte-modernbert-base` | [#788](https://github.com/openzigs/metis-private/issues/788) measured **0.402 nDCG@10** on NL-requirement → code retrieval vs **0.246** for the `Xenova/bge-small-en-v1.5` it replaced (+0.156; 95% CI [+0.054, +0.266]; sign test p = 0.007). Flipped in [#783](https://github.com/openzigs/metis-private/issues/783). |
| **Pooling** | `cls` — **not** a tunable | The SAME weights at `mean` scored **0.254** — level with the model they replaced, and *identical* in the hybrid channel (0.287 vs 0.287). Shipping this model without `cls` buys nothing and no end-to-end metric would say so. Bound to the model id by the per-model map. |
| **Dtype** | `q8` | Scored **higher** than `fp32` (0.402 vs 0.360) at ¼ the download/RAM, and it is what both Dockerfiles bake. *Recorded limitation:* n=30 is underpowered to certify q8 ≈ fp32 (paired CI [−0.054, +0.137], p = 0.48). The claim is "no evidence q8 is worse", not "proven equivalent". |
| **Dims** | 768 | Sizes the pgvector column / Lance table. Upgrading from a 384d corpus requires a **reindex** — see [Changing model or dimension](#changing-the-model-or-the-dimension-reindex). |

`onnx-community/granite-embedding-english-r2-ONNX` (768d, `cls`) remains a
**config-only fallback**: it is documented and its pooling is mapped, but it was
never evaluated — the candidate cleared the bar, so it was not needed. Selecting it
is an `EMBED_MODEL` change plus a reindex; it is not baked, so an air-gapped image
would need `--build-arg BAKE_EMBED_MODELS` as well.

## The hash fallback is OPT-IN (`EMBED_ALLOW_HASH_FALLBACK`)

Before [#783](https://github.com/openzigs/metis-private/issues/783), a `xenova`/`sidecar`
backend that failed to load (an HF 401, a missing baked weight, a sidecar that was
down) was **silently** replaced by the deterministic hash stub. The process kept
serving. Every ingest wrote non-semantic vectors. `/readyz` stayed green, the admin
panel stayed green, and the only trace was a single `warn` line at boot. Retrieval
was noise and nothing said so.

**Now:** the stub is used only when it is *asked for*.

| Config | Behaviour |
| --- | --- |
| *(default — nothing set)* | A backend that cannot load **THROWS**. `/readyz` reports `embeddings: error` → **503** (the pod never goes ready, so a broken rollout never takes traffic). Admin → Embedding backends shows the error. **No hash vectors are ever written.** |
| `EMBED_ALLOW_HASH_FALLBACK=1` | The stub takes over, loudly: `/readyz` reports `embeddings: degraded` ("hash fallback ACTIVE — vectors are NOT semantic") and the admin panel shows the backend as unhealthy with the reason. For local dev / genuinely offline work where useless vectors beat no service. |
| `AI_OFFLINE=1` / `EMBED_BACKEND=offline` / `EMBED_MODEL=metis-offline-hash-v1` | The stub is the *selected* backend. Nothing "fell back" — this is a deliberate choice, and it is what tests and air-gap smoke runs use. |

Two related fixes shipped with it:

- **`EMBED_MODEL=metis-offline-hash-v1` now routes to the `offline` backend.** It
  used to be handed to `xenova`, which asked HuggingFace for a repo by that name,
  got a 401, and fell through to the hash stub — *via the network*. That was the
  shipped `.env` default.
- **The stub always emits 384-dim vectors**, never the width of the backend it
  replaced. Vectors are tagged by model id; a 768-dim vector labelled
  `metis-offline-hash-v1` would put one model id in two incompatible vector spaces.

The cloud backends (`bedrock`, `bedrock-sdk`, `openai`) are **unaffected** by
`EMBED_ALLOW_HASH_FALLBACK`: the fallback is gated on the backend key and only ever
relaxes `xenova` / `sidecar`. This is deliberate and enforced. A cloud backend warms
by making a **live API call**, so its failures are rotated credentials, expired
tokens, sick gateways and timeouts — and the honest answer to a 401 is an error, not
a corpus of hash vectors. Without that gate, a Bedrock/OpenAI deployment that merely
inherited the flag (a dev profile, a base Helm values file, a copied `.env`) would
answer a key rotation by silently degrading. A new backend must opt IN to the
fallback explicitly rather than inherit it.

## Decision matrix

| Backend | `EMBED_BACKEND` | Firewall-friendly | Egress | Cost | Latency | Dimension | Offline | Ops burden | Best-fit client | Sub-issue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Offline hash stub | `offline` | ✅ Total | None | Free | Lowest | 384 | ✅ Yes | Lowest (no model) | Tests, CI, demos, `AI_OFFLINE=1` air-gap smoke | #931 |
| Xenova (in-process) | `xenova` | ✅ High | First load only¹ | Free (CPU) | Low–med | **768** (gte-modernbert, `cls`) | ✅ Yes (`HF_HUB_OFFLINE=1`) | Low (bake model) | Small/medium self-hosted; air-gapped after bake | #936 |
| Google EmbeddingGemma (ONNX) | `embeddinggemma` | ✅ High | First load only¹ | Free (CPU) | Med | 768² (Matryoshka 768/512/256/128) | ✅ Yes | Low–med (larger model) | Higher-quality local embeddings; dimension tuning | #939 |
| Embeddings sidecar (HTTP) | `sidecar` | ✅ High | None (in-cluster) | Free (CPU) | Low–med | **768** (gte-modernbert, `cls`) | ✅ Yes (baked image) | Med (extra pod) | K8s deployments wanting a slim server image | #935 |
| Amazon Bedrock (Access Gateway) | `bedrock` | ⚠️ Needs gateway egress | Yes | Per-token | Network-bound | 1024 | ❌ No | Med (gateway + key) | AWS shops with a Bedrock Access Gateway | #932 |
| Amazon Bedrock (AWS SDK) | `bedrock-sdk` | ⚠️ Needs AWS egress/VPC | Yes | Per-token | Network-bound | 1024 | ❌ No | Med (IAM + SDK) | AWS-native deployments using IAM creds | #933 |
| OpenAI / Azure OpenAI | `openai` | ⚠️ Needs OpenAI/Azure egress | Yes | Per-token | Network-bound | 1536³ | ❌ No | Med (key + endpoint) | Teams standardized on OpenAI/Azure | #934 |

¹ Xenova/EmbeddingGemma download model weights from HuggingFace on first load
unless the weights are pre-baked into the image. With `HF_HUB_OFFLINE=1` (and a
populated `TRANSFORMERS_CACHE`) they load from disk only and **fail loud** if the
cache is missing — no silent download, no hash fallback.

² EmbeddingGemma's native dimension is 768; Matryoshka truncation supports
`EMBED_DIM` of 768/512/256/128.

³ `text-embedding-3-small` default; `text-embedding-3-large` is 3072.

## Model evidence — the #788 retrieval eval (decision-matrix evidence row)

The decision matrix above chooses a **backend**. This section is the measured
evidence for choosing a **model**, and it is the gate on the default-model flip
([#783](https://github.com/openzigs/metis-private/issues/783)).

**What was measured.** METIS's actual retrieval use case: a natural-language
requirement ("*Calls the server makes to an address supplied by a user must not be
able to reach machines inside our own private network*") must retrieve the code
symbol that implements it (`validateTarget` / `safeFetch`). That is what the vector
half of hybrid `search_code_symbols` does. Prose-similarity benchmarks (STS, and the
CoIR numbers quoted in the epic) predict direction only — they are not this.

**Corpus** — `eval-data/corpus/embedretrieval-01-nl-to-code/`: **30 hand-authored NL
requirements** over **183 real METIS code symbols** (a verbatim snapshot of 18
`server/src/lib/**` source files at commit `391f0f1`, parsed with METIS's own parser
and formatted for embedding with the production `formatSymbolForEmbedding`). Ground
truth is hand-authored by a human reading the code — not LLM-labelled. Corpus and bar
were frozen **before** any arm ran.

**Reproduce** (opt-in — it downloads real weights, reusing #781's gate):

```bash
EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval
```

### Results — vector channel, measured in isolation (2026-07-13)

The vector channel is scored **alone** on purpose: in the fused hybrid ranking a
strong BM25 half can mask a broken vector half entirely — which is how a hash
embedder survived in production this long.

| Arm | Model · dims · pooling · dtype | nDCG@10 | MRR | R@5 | hit@10 |
| --- | --- | --- | --- | --- | --- |
| **A — incumbent** | `Xenova/bge-small-en-v1.5` · 384 · mean · q8 | 0.246 | 0.234 | 0.267 | 0.500 |
| **B — candidate** | `Alibaba-NLP/gte-modernbert-base` · 768 · **cls** · q8 | **0.402** | **0.394** | **0.433** | **0.700** |
| **C — wrong-pooling trap** | same model · 768 · **mean** (deliberately wrong) · q8 | 0.254 | 0.260 | 0.250 | 0.500 |
| **D — candidate fp32** | `Alibaba-NLP/gte-modernbert-base` · 768 · cls · fp32 | 0.360 | 0.359 | 0.350 | 0.533 |
| **E — hash floor** | `metis-offline-hash-v1` · 384 (chance level) | 0.032 | 0.033 | 0.033 | 0.100 |

Hybrid channel (production BM25 + vector RRF fusion) — A 0.287, B 0.396, C 0.287,
D 0.348, E 0.050. BM25-only reference line: **0.143** — identical across all five
arms (spread 0.0000), because that channel is driven by an *empty* vector store, so
no vector can reach it by any path.

> **Correction (2026-07-13).** The first version of this section reported the BM25
> line as a single number, 0.194, and called it "identical across arms by
> construction". It was neither. The harness built that channel by weighting the
> vector half to zero, and `HybridCodeSearch` ran the vector query regardless of
> weight and inserted every hit into the fused map at a weighted score of zero —
> so vector-derived symbols padded the tail of the "BM25-only" top-10 in vector
> rank order (BM25 scores only symbols with a non-zero term match, often fewer than
> 10 of the 183). The "constant" reference line silently tracked each arm's vector
> quality: 0.194 / 0.203 / 0.169 / 0.188 / 0.143 across A–E, a spread of **0.060 —
> larger than the 0.05 decision bar**. The true, uncontaminated line is **0.143**;
> every arm's was inflated. Fixed in `hybrid-search.ts` (the vector channel is now
> skipped at `vectorWeight <= 0`) and in the harness (the reference channel gets an
> empty vector store). **The vector and hybrid channels were never affected** — the
> vector channel bypasses `HybridCodeSearch` entirely and hybrid uses real non-zero
> weights — so every number in the table above and the GO verdict are unchanged, and
> were re-run to confirm it rather than assumed.

### Paired significance (added 2026-07-13)

The gate rests on a difference of means over 30 queries, so the harness now also
reports a paired bootstrap CI (20,000 resamples, fixed seed) and a two-sided exact
sign test on the same per-query values. These do **not** gate anything — the bar was
pre-registered on mean deltas and has not been moved — they only show which deltas
are distinguishable from zero at n=30.

| Comparison | mean Δ nDCG@10 | 95% CI | sign test |
|---|---|---|---|
| B candidate − A incumbent (**the gate**) | +0.156 | **[+0.054, +0.266]** | p = 0.007 |
| B candidate − C wrong-pooling (validity) | +0.148 | [+0.032, +0.264] | p = 0.019 |
| A incumbent − E hash floor (validity) | +0.215 | [+0.098, +0.335] | p = 0.013 |
| B q8 − D fp32 (informational) | +0.042 | **[−0.054, +0.137]** | p = 0.481 |

The gate's CI excludes zero and its lower bound clears the pre-registered 0.05 bar —
but only just (+0.054). The direction of the candidate's win is established; its
exact magnitude is not.

### What the numbers say

- **The candidate wins: +0.156 vector nDCG@10 over the incumbent** (0.402 vs 0.246),
  +0.167 recall@5, and hit@10 rises 0.50 → 0.70. The bar (stated before the run) was
  ≥ +0.05 with no recall or hybrid regression. **PASS → GO for #783.**
- **The wrong-pooling trap is real, and this eval catches it.** Mean-pooling the CLS
  model costs **0.148 nDCG@10** (0.402 → 0.254) — it lands the "upgraded" model
  *level with the incumbent it replaced* (0.254 vs 0.246), and the win it keeps over
  a pure keyword search (0.254 vs the 0.143 BM25 line) is one the incumbent already
  had. #782 measured `cosine(cls, mean) = 0.856` on this model: the wrong
  vectors are unit-norm, finite, and completely plausible. **A pooling mistake in
  #783 would silently buy nothing.** This is the epic's single biggest risk, measured.
- **The eval discriminates.** The hash floor scores 0.032 (chance level) against the
  incumbent's 0.246, so the corpus and metric genuinely see semantics.
- **BM25 masks the vector channel.** The hybrid delta (+0.11) is smaller than the
  vector delta (+0.16), and the wrong-pooling arm is *indistinguishable* from the
  incumbent in hybrid (0.287 vs 0.287) while being clearly worse in the vector
  channel. Anyone who evaluates only end-to-end hybrid will not see this.
- **q8 vs fp32 (the question #782 deferred):** fp32 did **not** beat q8 here — q8
  scored **higher** (0.402 vs 0.360). The pre-registered check was symmetric
  (|q8 − fp32| ≤ 0.02) and so it is recorded as **FAILED at 0.042**. The bar is not
  being moved after the fact.
  **What 30 queries can and cannot say here:** the paired test gives +0.042,
  95% CI **[−0.054, +0.137]**, p = 0.48. That interval is ~9× wider than the ±0.02
  tolerance band, so this corpus **cannot establish equivalence in either
  direction** — it is underpowered for the question, and an "equivalent" claim
  would be reading an absence of evidence as evidence of absence. What it *does*
  say is that **there is no evidence q8 degrades retrieval** (if anything the point
  estimate favours q8), and no measured quality reason to pay 4× the memory for
  fp32. That is sufficient to **keep `EMBED_DTYPE=q8` as the default**, and it is
  the honest form of the claim. Establishing true equivalence within ±0.02 would
  need a substantially larger corpus.
  **AC deviation, recorded:** #788's acceptance criteria gate q8 shipping on being
  within ~1–2 pts of fp32. This check FAILED (0.042) and is classified
  `informational`, so it structurally cannot enforce that AC. The practical call
  (keep q8) stands on the reasoning above, but the deviation is explicit rather than
  buried in a footnote — see the notes on #788 and #783.

### What this does NOT license

The corpus is small (30 queries / 183 symbols), single-language (TypeScript), and
hand-built by one author. It supports a **directional** conclusion about
NL-requirement → code retrieval on METIS-shaped code. It does **not** support claims
about absolute retrieval quality, about SQL/SAS/Java corpora, or about end-to-end
analysis verdict accuracy. The Granite R2 fallback
(`ibm-granite/granite-embedding-small-english-r2`) was **not** run — it was not
needed, since the candidate cleared the bar; it remains a config-only swap and can be
dropped into the same harness as another arm if gte-modernbert ever disappoints.

Raw artifacts: `eval-results/embed-retrieval-2026-07-13T07-41-49-054Z.{json,md}` (the
re-run after the BM25-channel fix above; it supersedes the earlier
`…T06-52-45-547Z` artifact, whose bm25 channel was contaminated).

## Selection precedence

`resolveBackendKey()` picks the backend in this order:

1. Explicit config `cfg.backend` (programmatic).
2. `AI_OFFLINE=1` → `offline` (hard air-gap override).
3. `EMBED_BACKEND` env var.
4. `EMBED_MODEL=metis-offline-hash-v1` → `offline` (#783 — the stub's id names the
   stub; it is not a HuggingFace repo).
5. Embeddings mode `sidecar` (`EMBEDDINGS_MODE=sidecar`) → `sidecar`.
6. Default → `xenova`.

Note step 4 sits *below* `EMBED_BACKEND`: `EMBED_BACKEND=xenova` +
`EMBED_MODEL=metis-offline-hash-v1` is a contradiction, and it now produces a loud
load failure rather than a backend silently chosen for you.

```mermaid
flowchart TD
    A[Need embeddings] --> B{AI_OFFLINE=1?}
    B -- yes --> OFF[offline hash stub]
    B -- no --> C{EMBED_BACKEND set?}
    C -- yes --> D[Use that backend]
    C -- no --> HASHID{EMBED_MODEL=metis-offline-hash-v1?}
    HASHID -- yes --> OFF
    HASHID -- no --> E{EMBEDDINGS_MODE=sidecar?}
    E -- yes --> SIDE[sidecar HTTP]
    E -- no --> XEN[xenova in-process]

    D --> F{Air-gapped?}
    F -- yes --> G[offline / xenova+HF_HUB_OFFLINE / embeddinggemma / sidecar]
    F -- no --> H{AWS shop?}
    H -- yes --> I[bedrock / bedrock-sdk]
    H -- no --> J[openai / azure]
```

## Environment variables per backend

Common (apply to any backend):

| Var | Purpose |
| --- | --- |
| `EMBED_BACKEND` | Select the backend key (see matrix). |
| `AI_OFFLINE` | `1` forces the `offline` hash stub regardless of other settings. |
| `EMBED_ALLOW_HASH_FALLBACK` | `1` permits a failing `xenova`/`sidecar` backend to fall back to the hash stub (reported as **degraded**, never silent). **Unset = fail loud**, which is the default. See [The hash fallback is opt-in](#the-hash-fallback-is-opt-in-embed_allow_hash_fallback). |
| `EMBED_MODEL` | Override the model id for the selected backend. |
| `EMBED_DIM` | Override the embedding dimension. **A no-op for `xenova`/`sidecar`** (they emit their model's native width); read only by `embeddinggemma` (Matryoshka) and the cloud backends. It still drives the **pgvector column width**, so a stale value is refused at bootstrap — see reindex below. Leave it unset unless you need Matryoshka truncation. |
| `EMBED_DTYPE` | ONNX weight dtype for the local runtimes: `q8` (default, ~150 MB) or `fp32` (~600 MB). Must match what the image baked — see [Quantization](#quantization--embed_dtype). Invalid values fail loud. |
| `EMBED_POOLING` | Global pooling default (`mean` \| `cls`) for models the built-in map does not know. Rarely needed. |
| `EMBED_POOLING_MAP` | Per-model pooling override, e.g. `acme/custom-embedder=cls,other/model=mean`. Beats the built-in map. |

### `offline`
No configuration required. Deterministic, non-semantic — for tests and
air-gapped smoke only.

### `xenova`
| Var | Purpose |
| --- | --- |
| `EMBED_MODEL` | Default `Alibaba-NLP/gte-modernbert-base` (768d, `cls`, `q8`). |
| `HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` | `1` → load from cache only, fail loud if missing. |
| `TRANSFORMERS_CACHE` | Directory holding the baked ONNX weights. |

Bake the weights into the server image with
`docker build -f Dockerfile.server --build-arg INCLUDE_XENOVA=1 ...`.

### `embeddinggemma`
Same env as `xenova`, plus `EMBED_DIM` ∈ {768, 512, 256, 128} for Matryoshka
truncation. Default model `onnx-community/embeddinggemma-300m-ONNX`. Review the
Gemma Terms of Use before deploying.

### `sidecar`
| Var | Purpose |
| --- | --- |
| `EMBEDDINGS_MODE` | `sidecar` to route in-process calls to the HTTP sidecar. |
| `EMBEDDINGS_URL` | Sidecar base URL (e.g. `http://embeddings:5050`). |
| `EMBEDDINGS_TOKEN` | Shared bearer token; must match the sidecar. |

The `metis-embeddings` sidecar (`Dockerfile.embeddings`) bakes its model at
build time and runs with `HF_HUB_OFFLINE=1` by default, so it serves embeddings
with **zero HuggingFace egress** at runtime. See
[air-gapped deployment](#air-gapped-deployment).

### `bedrock` (Access Gateway)
| Var | Purpose |
| --- | --- |
| `BEDROCK_GATEWAY_URL` / `EMBEDDINGS_BEDROCK_URL` | Gateway base URL. |
| `BEDROCK_GATEWAY_API_KEY` / `EMBEDDINGS_BEDROCK_API_KEY` | Gateway API key. |
| `EMBED_MODEL` | Default `amazon.titan-embed-text-v2:0` (dim 1024). |

### `bedrock-sdk` (AWS SDK)
| Var | Purpose |
| --- | --- |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | Bedrock region. |
| Standard AWS credential chain | IAM role / `AWS_ACCESS_KEY_ID` etc. |
| `EMBED_MODEL` | Default `amazon.titan-embed-text-v2:0` (dim 1024). |

### `openai` (OpenAI / Azure OpenAI)
| Var | Purpose |
| --- | --- |
| `EMBEDDINGS_OPENAI_BASE_URL` | OpenAI or Azure endpoint base URL. |
| `EMBEDDINGS_OPENAI_API_KEY` | API key. |
| `EMBEDDINGS_OPENAI_API_VERSION` | Azure API version (Azure only). |
| `EMBED_MODEL` | Default `text-embedding-3-small` (dim 1536). |

## Recommended hybrid profile

> **Bedrock gateway for the generative LLM + local Xenova/EmbeddingGemma for
> embeddings.**

This profile uses a cloud LLM (via the Bedrock Access Gateway) for generation
while keeping the embeddings/retrieval path fully local (`EMBED_BACKEND=xenova`
or `embeddinggemma`, with `HF_HUB_OFFLINE=1`). Because RAG indexing embeds every
chunk of every document — far more tokens than generation — running embeddings
locally yields the largest cost savings and keeps your corpus on-prem with
**zero embedding egress**, while still leveraging a managed LLM for answers.

## Which backend in which environment

> **Decision of record:** keep the **embedder identical across every environment** and vary
> the **reranker** instead — see
> [ADR 0005](decisions/0005-fix-the-embedder-vary-the-reranker.md) (#1161, epic #1156) for
> the full argument, the file-cited dimension evidence, and the measurement behind the
> reranker half.

| Environment | Recommended `EMBED_BACKEND` | Reranker |
| --- | --- | --- |
| Local dev | `xenova` (or `sidecar`) — `gte-modernbert-base`, 768d | none (`RAG_RERANK` unset) |
| CI / tests | `offline` for speed and determinism; `xenova` for any run whose *retrieval quality* is being measured | none |
| Self-hosted / air-gapped | `xenova` with `HF_HUB_OFFLINE=1`, or `sidecar` — same model, same width | none |
| AWS / production | **the same one you measured on** — do not swap the embedder by tier | none |

**Why the last row is not "`bedrock-sdk`, obviously".** The backends do not agree on vector
width — `xenova`/`sidecar` emit 768 (`packages/shared/src/constants.ts:599`) while
`bedrock-sdk` defaults to 1024
(`server/src/lib/rag/backends/bedrock-sdk-embedder.ts:22-23`) — and an embedding's width is
an index contract, not a runtime option. Varying the embedder by environment therefore means
a **separately re-embedded store per environment**, and local retrieval numbers stop
predicting production. Note this is *fragmentation and non-transferable measurement*, **not**
silent corruption: every row is tagged with its `embeddingModel` and the vector store's model
filter is mandatory (`server/src/lib/code-graph/symbol-embedding-service.ts:331-334`), so a
mixed-generation store is safe to query — it just under-retrieves.

`bedrock`, `bedrock-sdk`, `openai` and `embeddinggemma` all remain fully supported. A
deployment that cannot run local model weights should use one — ADR 0005 only asks that the
separate store and the non-transferable evals be accepted **knowingly**, rather than arrived
at by tier drift.

**`EMBED_DIM` is not a tuning knob.** Titan v2 supports 256/512/1024 output dimensions and
this codebase exposes that (`bedrock-sdk-embedder.ts:35`, `:187-192`), which makes a width
change look reversible. It is not: a same-model dimension change is still a **full re-embed**
and an index-contract change — see
[Changing the model or the dimension (reindex)](#changing-the-model-or-the-dimension-reindex).

**To check whether a deployment has already drifted**, do not guess from config — the store
knows. `pnpm embeddings:migrate status` compares the persisted per-row model tags against the
active embedder and **exits 1 while work remains**, so it can gate a deploy; the same report
is available per project on the admin embeddings route. See
[Runbook — migrating a deployment to a new embedding model (#787)](#runbook--migrating-a-deployment-to-a-new-embedding-model-787).

**On rerankers.** The "none" column is measured, not conservative. #1158 wired a
`ms-marco-MiniLM-L-6-v2` cross-encoder into the code-search path and swept it at pool depths
20/50/100: nDCG@10 went **0.276 → 0.218 / 0.182 / 0.160** — worse at every depth, monotone in
depth — for 91–508 ms of added p50 latency. The wiring was reverted. `RAG_RERANK` is wired on
the *document* path but that path has **no harness that runs retrieval at all**, so it is
unmeasured rather than cleared; do not enable it citing #1158. Both are detailed in ADR 0005.

## Code-symbol embeddings (#797)

Code symbols are embedded too, not just document chunks. They are stored in the **same
vector store** under a per-project namespace `<projectId>__symbols`, alongside the
document vectors — on pgvector that means they share the one `rag_vectors.embedding`
`vector(N)` column, so the column-width migration below already covers them and there is
no second dimension to manage.

| | document chunks | code symbols |
| --- | --- | --- |
| vector store namespace | `<projectId>` | `<projectId>__symbols` |
| durable text + model tag | `KnowledgeChunk` | `CodeSymbolEmbedding` |
| populated by | document ingest | code-graph ingest → **background job** |
| reindexed by | `reindexProject` phase 1 | `reindexProject` phase 2 |

Operational notes:

- **Row growth.** A project contributes roughly one `rag_vectors` row per code symbol —
  ~15k for METIS itself — all HNSW-indexed, on top of its document chunks. Fine at this
  scale; size the Postgres volume with it in mind for very large monorepos.
- **First build is slow, on purpose.** ~15k symbols batches into ~235 sidecar posts and
  takes **45–95 minutes** on the `values-prod` CPU allocation. It runs as a background job
  after ingest, never inline — an ingest that returns quickly has *not* finished embedding.
  Until it does, `search_code_symbols` serves BM25-only results (degraded, not broken).
- **`embed-migrate status` reports symbols separately**, including a `(pending — not
  embedded yet)` row for symbols whose ingest wrote the metadata but whose vector the
  background job has not computed. A deployment is not fully migrated until both corpora
  are on the active model.
- **The job is resumable.** A pod eviction costs at most the batch in flight; re-running it
  (a fresh ingest, or a reindex) skips every symbol already embedded at the active model
  with an unchanged content hash.

## Changing the model or the dimension (reindex)

Switching backends or models usually changes the embedding **dimension** (e.g. the
#783 flip: 384 → 768). The vector store is dimension-aware (epic
#937): existing vectors are
not automatically re-embedded. After changing `EMBED_BACKEND` / `EMBED_MODEL` /
`EMBED_DIM`:

1. Open **Admin → Embedding backends** to see the active backend, health, and
   per-project coverage (which chunks were embedded with which model).
2. Trigger a **reindex** for any project flagged as needing one, or call
   `POST /api/admin/embeddings/projects/:projectId/reindex`.

> **Upgrading from the 384-dim default? CLEAR `EMBED_DIM` (or set it to 768).**
> `EMBED_DIM` does **not** resize the `xenova` / `sidecar` backends — they always
> emit their model's native width (768 for `gte-modernbert-base`). It is read only
> by `embeddinggemma` (Matryoshka truncation) and by the cloud backends. What it
> *does* still do is size the **pgvector column**, so a leftover `EMBED_DIM=384`
> (which the pre-#783 `.env.example` suggested) would size the column 384 while the
> embedder emits 768. `PgVectorStore` now refuses to bootstrap on that disagreement
> with an error naming `EMBED_DIM` — rather than creating the column and letting
> every insert die inside Postgres, mid-ingest.

### What happens BEFORE you reindex

Nothing is silently corrupted, and nothing is silently mixed. Concretely, on the
first boot after the #783 flip, a deployment whose corpus is 384-dim:

| | Behaviour |
| --- | --- |
| **Retrieval of old chunks** | They are **ignored**, not mis-scored. Chunks carry the model they were embedded with (`KnowledgeChunk.embeddingModel`) and search filters to the ACTIVE model, so a 768-dim query never touches a 384-dim vector. A project whose chunks are all old-generation simply returns no dense hits until it is reindexed (BM25 still works). |
| **Coverage** | `GET /api/admin/embeddings/projects/:id/coverage` reports `needsReindex: true` and lists the stale models. This is the signal to act on. |
| **Writing new chunks into an old table** | **Refused, loudly.** The vector stores enforce the width: pgvector checks the real `vector(N)` column width at bootstrap (a `CREATE TABLE IF NOT EXISTS` cannot widen an existing column, so it would otherwise fail one INSERT at a time from inside an ingest), and Lance/local check on upsert and search. The error names both widths and the reindex route. An **empty** table of the wrong width is simply recreated at the new width — there is nothing to protect, and demanding a "reindex" of an empty project would be nonsense. |
| **384-dim and 768-dim vectors in one space** | **Impossible.** That comparison is refused (`VECTOR_DIMENSION_MISMATCH`) rather than scored. A wrong ranking would be worse than an error, because a wrong ranking is invisible. |

See #937 for the
dimension-migration and reindex implementation, and the runbook below for the
production cutover.

## Chunker drift — a different problem with a different remedy (#1182)

Everything above is about how chunk text was **vectorised**. `chunkerIdentity`
records how it was **cut**, and the two drift independently.

`chunkMarkdown` did not tile its input for eight months
(#1178): content fell between
consecutive chunks and was indexed nowhere. The fix moved **every chunk boundary**
without changing a single parameter, so a corpus ingested before it and one ingested
after are different chunkings that carry identical `embeddingModel` tags. At the
shipped 2048/256, a pre-fix corpus has **94.1%** of its characters indexed; a post-fix
one has 99.8%.

**Read the difference from the model case correctly:**

| | Model drift | Chunker drift |
| --- | --- | --- |
| Are the vectors comparable? | No — different widths and coordinate systems | **Yes** — same model, same space |
| What retrieval does today | Those rows are **filtered out**. The index is dark for them | Those rows **still rank**. The index is serving, with gaps |
| Remedy | `reindex` (re-embed) | **Re-ingest** (re-chunk) |
| `status` exit code | 1 | 3 |

**A reindex does not fix chunker drift.** `reindexProject` re-embeds the chunk *text*
already in `KnowledgeChunk`; `chunkMarkdown` runs only at ingest. Re-embedding leaves
every boundary exactly where it was, so a reindex would run for hours and change
nothing — which is why chunker drift is reported separately and never appears in
`Projects needing reindex`.

To repair a project, **re-ingest its documents** (re-upload, or re-run ingest per
document) so the chunker runs again.

**`doc:v2` → `doc:v3` (#201).** v3 also bounds a chunk with non-ASCII text by the
model's token input, charging each such character its UTF-8 bytes. A CJK or emoji
chunk is no longer truncated at the model's 2,048-token input.

After upgrading, `status` reports chunker drift for **every** project ingested under
v2, all-ASCII ones included: drift is judged by the recorded chunker identity, not by
the text. Re-ingest them all to clear it. Order the work by content: a project with
non-ASCII text has truncated chunks that the re-ingest actually repairs, so do those
first. An all-ASCII project is cut exactly as v2 cut it, so its re-ingest reproduces
the same chunks byte-for-byte and changes only the recorded identity; it can wait.

### Reading the report

```
Chunker       doc:v3:2048/256  <- active
               50%       50  (untagged — written before #1182, provenance unrecorded)
               40%       40  doc:v3:2048/256  <- active
               10%       10  docsgen:v1:1500  (a different chunker — not compared)

Projects needing re-ingest: 1/2 (chunker drift — a reindex does NOT fix this)
  p-gappy  40/100 on the active chunker  (doc:v3:2048/256, untagged)
```

- The identity is **composite** — `<producer>:v<algorithm>:<chunkSize>/<overlap>`.
  The **producer** distinguishes chunkers: generated-document ingest
  (`docs-gen/rag-ingest.ts`) uses its own 1,500-character chunker, and its rows are
  that chunker's correct output rather than a stale generation of this one. They are
  shown but **not counted as drift** — counting them pinned `status` at exit 3 forever
  with a remedy that could not clear it.
  The **version** matters for the *next* boundary change: once both generations carry
  a tag, a same-parameter change (exactly what #1178 was) would otherwise produce two
  identical strings.
- **`untagged` means provenance unrecorded**, not "pre-#1178 with gaps". Rows written
  before #1182 carry `NULL` and could be either producer. They are counted as work
  outstanding — every pre-#1178 row is in that bucket — and deliberately **not**
  backfilled, because a value invented for them would assert a chunking nobody
  measured.
- Two known over-reports, both erring toward advising unnecessary work rather than
  hiding necessary work: rows ingested in the few days between #1178 and #1182, and
  generated-doc chunks written before this release. The latter clear on the next
  regeneration.
- Nothing is excluded from retrieval on this signal, ever. See
  [ADR 0006](decisions/0006-chunker-drift-serve-degraded-but-observable.md) for why
  excluding would be strictly worse than the gaps.

---

## Runbook — migrating a deployment to a new embedding model (#787)

The state this gets you out of: after the #783 flip your corpus is 384-dim (or
hash) and the embedder emits 768-dim, so **dense retrieval returns nothing and
hybrid search is BM25-only**. Nothing is corrupt — old vectors are ignored, not
mis-scored — but nobody gets the +0.156 nDCG@10 until the corpus is re-embedded.

Everything below is driven by one CLI, which wraps the same shadow-reindex the
admin panel triggers:

```bash
pnpm embeddings:migrate status                    # where am I?
pnpm embeddings:migrate prepare --force           # pgvector ONLY, destructive
pnpm embeddings:migrate reindex --all             # cut over, project by project
pnpm embeddings:migrate retag --force             # rollback only: re-label restored vectors
pnpm embeddings:migrate discard --project <id>    # throw away a checkpoint
```

### The mental model

| | |
| --- | --- |
| **Source of truth** | Chunk **text** (`KnowledgeChunk`, Prisma). It is never touched by a migration. |
| **Derived data** | Vectors. Regenerable from the text at any time, by any model. |
| **Therefore** | There is no such thing as an unrecoverable embedding migration. The worst case is *paying the re-embed again*. Everything below follows from that. |

### Step 1 — check the state

```bash
pnpm embeddings:migrate status
```

Prints the active embedder, the store's vector width, the **per-model chunk split
across every project** (the mixed-generation view), the **per-chunker-generation
split** (#1182, below), and the ordered next steps. Exits non-zero while work
remains, so it can gate a deploy check. The same data is served, authenticated, at
`GET /api/admin/embeddings/coverage` (`admin.read`).

**Exit codes.** They encode whether the index is *serving*, not a severity ordering:

| Code | Meaning | Remedy |
| --- | --- | --- |
| 0 | Nothing outstanding | — |
| 1 | Model/column drift, or a broken embedder. Those rows are **dark**: search filters on the model tag, so dense retrieval returns nothing for them | `prepare` / `reindex` |
| 2 | Usage error, or a refused destructive command | — |
| 3 | **Chunker drift only** (#1182). The index is **serving**, just with the gaps #1178 left | **Re-ingest** — see below |

A gate that should block only on a dark index:

```bash
pnpm embeddings:migrate status; c=$?; [ "$c" -eq 0 ] || [ "$c" -eq 3 ]
```

It **refuses to plan a migration** if the embedder is unhealthy or has fallen back
to the hash stub. Reindexing is the single most expensive way to discover your
embedder is broken, and the hash stub tags its own model id — so a reindex onto it
would look like a *successful* migration to a different model.

### Step 2 (pgvector only) — migrate the column width

`values-prod` sets `vectorStore: pgvector`. Every project shares **one**
`rag_vectors.embedding` column of type `vector(N)`, and **N is fixed at the
column**: 384-dim and 768-dim rows cannot coexist in it. Worse,
`CREATE TABLE IF NOT EXISTS … vector(768)` is a **silent no-op** against an
existing `vector(384)` table — which is why the store now reads the real width out
of the catalog at boot and refuses, instead of letting Postgres reject inserts one
row at a time from the middle of an ingest.

```bash
# Back up first if you want a rollback that skips the re-embed (see Step 4).
pg_dump "$DATABASE_URL" -t rag_vectors > rag_vectors-384.sql

pnpm embeddings:migrate prepare --force
```

This **drops every stored vector** and recreates the table (with its HNSW index)
at the new width, in **one transaction** — if the rebuild fails for any reason, the
drop rolls back with it and the old table is still standing. It does *not* drop the
chunk text.

Two gates, and `--force` is only the second one:

- **It refuses outright while the embedder is unhealthy or has fallen back to the
  hash stub** — even with `--force`. `--force` gates your *intent*; it says nothing
  about the system's *fitness*. The column is rebuilt at the width the **active
  embedder** reports, and after a fallback that is the *hash stub's* width, not your
  model's. Fix the backend, confirm with `status`, then come back.
- `--force` itself is mandatory, because the operation is fleet-wide, destructive and
  **not** resumable.

Lance and the local store need no such step — their tables are per-project and the
reindex swap carries the new width.

### Step 3 — reindex, project by project

```bash
pnpm embeddings:migrate reindex --all            # or --project <id>
```

Per project, this:

1. snapshots the project's chunks;
2. re-embeds them into a **shadow** table (`<projectId>__reindex`) while the LIVE
   table keeps serving — **Lance/local only.** On **pgvector** Step 2 has already
   dropped the old vectors (384 and 768 cannot coexist in one `vector(N)` column), so
   every project is **BM25-only** from `prepare` until its own reindex completes,
   including the projects that have not started yet. That is a property of pgvector's
   fixed-width column, not of this tooling — but plan the window for it;
3. **atomically swaps** the shadow into the live name;
4. re-applies any chunk ingested during the window, reconciles deletions, and
   updates each chunk's `embeddingModel` tag.

A failure at any point before the swap leaves the live index **exactly as it was**.
Projects are done one at a time and one failure does not abort the rest.

**Interruptions are expected and cheap.** The shadow *is* the checkpoint: a pod
eviction, OOM kill or rolling deploy leaves it in place, and re-running the same
command **resumes** from it rather than re-embedding from zero. `status` and
`GET /api/admin/embeddings/projects/:id/coverage` both report the checkpoint
(`shadow.shadowChunks`, `shadow.resumable`). A shadow built by a *different* model
— an abandoned migration — is discarded rather than resumed; splicing two vector
spaces into one table is the exact failure the model tagging exists to prevent.

Force a clean rebuild with `--fresh`, or drop a checkpoint with
`pnpm embeddings:migrate discard --project <id>`.

`discard` takes the **same per-project reindex lease the reindex takes**, so it
refuses (`409`) while a reindex is running — *including one running on another
replica*, and including one started from the server while you are in a `kubectl exec`
shell. Do not work around it. A discard that lands mid-reindex would let the in-flight
run rebuild a **partial** shadow and swap that over the live index, reporting success
while silently dropping every chunk embedded before the discard. Wait for the reindex,
or let it fail first.

### The reindex lease — observing it, and clearing a wedged one (#798)

The cross-replica guard is a **lease row**, not a Postgres session advisory lock.
That distinction is operationally load-bearing, so it is worth thirty seconds of your
attention before you are paged about it.

**Why it is a lease.** A session advisory lock belongs to the *backend connection*
that took it. Prisma talks to Postgres through a connection **pool**, so the `unlock`
could be routed to a connection that never held the lock, silently no-op, and leave
the lock **held until the pod restarted** — wedging every later reindex of that
project with a `409`. Retrying (the obvious instinct) could not clear it. A lease is
an ordinary row with an absolute `expires_at`, so acquisition, renewal and release are
ordinary statements and it does not matter which pooled connection serves them. (It is
also safe under PgBouncer *transaction* pooling, which the old lock explicitly was
not.)

**What that buys you: an interruption is self-healing.** A pod that is evicted,
OOM-killed or SIGKILLed stops renewing. Its lease lapses (TTL, default **120 s** —
`REINDEX_LEASE_TTL_MS`), and the next reindex or discard simply takes it. **You never
have to restart a pod to clear a reindex lock.**

```bash
# Who holds this project's reindex lease, since when, and has it expired?
pnpm embeddings:migrate lock-status --project <id>

# Clear a wedged lease. --force is required only while the lease is still LIVE
# (i.e. the holder is still renewing — it is a running reindex, not a wedge).
pnpm embeddings:migrate unlock --project <id> --force
```

`GET /api/admin/embeddings/projects/:id/coverage` reports the same thing as
`shadow.lease` (`holder`, `expiresAt`, `ageMs`, `expired`).

**What `unlock` costs, and why it is safe.** Every mutating step of a reindex carries a
**fencing token** — the lease's `holder` (`<podId>:<runId>`, fresh per attempt) — and
re-proves it owns the lease *at the instant it mutates*: once per embed batch **before
the upsert**, and again **inside the swap's own SQL transaction**. So clearing a lease
does not race the run that held it; it **fences** it. The guarantee is that **a fenced
run can never cut a partial index over the live one** — the swap's check is a
row-locking `UPDATE` on the lease row *inside the swap's transaction*, so a replica
trying to steal the lease blocks behind the cut-over's `COMMIT` instead of racing it.
(`INSERT … ON CONFLICT DO UPDATE` must take the row lock **before** it evaluates its
`WHERE`, so even a *legitimate* steal of a lapsed lease queues behind the swap rather
than interleaving with it. Verified on a real Postgres — see `(c4)`/`(c4-control)` in
`server/tests/reindex-lease-postgres.integration.test.ts`.)
The worst an over-eager `unlock` can cost is a re-run of the reindex. (This is
*stronger* than the advisory lock ever was: the old `swapTable` never re-checked the
lock at all — it assumed a lock taken minutes earlier was still meaningful, which, per
the leak above, it might not even have been.)

That same `UPDATE` also **renews** the lease, and that is not incidental. Its row lock is
what stops the run's own heartbeat from renewing during the cut-over (a heartbeat
`UPDATE` on another pooled connection could only *block* on it), so a swap that outran
the 120 s TTL would otherwise reach `COMMIT` with an **expired** lease — and the steal
queued behind the row lock would win the moment it dropped, fencing the run out of its
own post-swap work (delta re-apply, orphan deletes, model retag). Renewing as it fences
closes that. Because the renewal is written *inside* the swap's transaction, it **rolls
back with the swap**: a pod killed mid-cut-over leaves its lease on the ordinary TTL, so
this cannot wedge a project for the full 10-minute budget.

Be precise about the *bound*, though: the per-batch fence is `renew()` **then**
`upsert()`, two statements. A run fenced in the gap between them can still land the
upsert already in flight, so **up to one batch of orphan _shadow_ rows** may be written
after a `discard`/archive. Those rows are never read (search is scoped to the live
namespace) and never swapped; clear them with `embeddings:migrate discard --project <id>`.

**The cut-over's deadline.** The swap runs in one interactive transaction (that is what
makes "I still hold the lease" and "the shadow is now live" a single atomic fact), and
it rewrites the whole corpus inside it. It is given an explicit **10-minute** budget —
`REINDEX_SWAP_TIMEOUT_MS` (and `REINDEX_SWAP_MAX_WAIT_MS`, default 30 s, to get a pooled
connection) — because Prisma's default interactive-transaction timeout is **5 s**, which
a large project's `DELETE` + `UPDATE` cannot possibly meet: it would abort the cut-over
with `P2028` after the entire embed loop had already been paid for. Raise it if you have
a corpus (or a disk) that makes 10 minutes tight (it is clamped at 1 h — a backstop you
can set to a day is not a backstop). **Runbook note:** for the duration of
that transaction the swap holds row locks on the live project's `rag_vectors` rows, so
concurrent ingest into the *live* namespace blocks behind it.

> **These durations are in MILLISECONDS, and are parsed strictly — digits only.**
> `REINDEX_SWAP_TIMEOUT_MS`, `REINDEX_SWAP_MAX_WAIT_MS` and `REINDEX_LEASE_TTL_MS` reject
> anything else with a warning rather than reinterpreting it. Writing `10min` used to
> parse as **10 milliseconds** (`Number.parseInt` keeps the numeric prefix and throws the
> rest away), which is a far worse cut-over deadline than the 5 s default it was meant to
> raise. Same trap for `600s` (→ 600), `10_000` (→ 10) and `1e6` (→ 1). Write
> `REINDEX_SWAP_TIMEOUT_MS=600000`.

**One deliberate design note.** The `reindex_lease` table is `UNLOGGED`: Postgres
truncates it on crash-recovery restart, so every lease vanishes. That is **fail-open for
new acquirers** — the next attempt takes the lease immediately, so a crash can never
wedge a project. It is *not* true that the crash also kills every holder: a pod has a
reconnecting pool and a reindex awaiting the embeddings sidecar sails straight through a
Postgres restart. Such a survivor is **fail-closed** instead — its next `renew()` matches
zero rows in the now-empty table, so it aborts before its next upsert, and its pre-swap
check finds no row and throws. (Which is why `renew`/`assertHeld` must keep treating a
missing row as "I am fenced", and must never "helpfully" re-insert it.) UNLOGGED also
means there is no Prisma model and no migration; the table is created lazily on first use.

### Step 4 — rollback

Rollback is a **forward** operation, because vectors are derived data. Step 1 is the
same either way; then pick **one** of the two paths below — do not mix them.

```bash
# 1. Point the embedder back at the previous model.
EMBED_MODEL=Xenova/bge-small-en-v1.5     # 384d, mean-pooled
# (unset EMBED_DIM; and restore EMBED_POOLING_MAP / EMBED_DTYPE if you moved them)
```

**Path A — you took the `pg_dump` in Step 2 (no re-embed).** Restore the old vectors,
then re-label the chunks to match them. `retag` writes the `KnowledgeChunk.embeddingModel`
tag and **nothing else** — it is what makes the dump worth taking:

```bash
psql "$DATABASE_URL" -c 'DROP TABLE rag_vectors' && psql "$DATABASE_URL" < rag_vectors-384.sql
pnpm embeddings:migrate retag --force     # tags catch up with the restored vectors
pnpm embeddings:migrate status            # must report "Up to date."
```

Do **not** run `reindex --all` after restoring the dump. It would re-embed the entire
corpus and swap its fresh shadow straight over the rows you just restored — you would
pay the re-embed *and* throw the restore away. (`retag` refuses if the column width
disagrees with the active embedder, which is exactly the signal that the vectors in the
store were *not* produced by the model you are rolling back to.)

**Path B — no dump (one re-embed).**

```bash
pnpm embeddings:migrate prepare --force   # pgvector only, if the width differs
pnpm embeddings:migrate reindex --all
```

The old weights are still in the image: `DEFAULT_BAKE_MODELS` keeps
`Xenova/bge-small-en-v1.5` baked alongside the new default precisely so a rollback
does not need a rebuild or any egress.

**What is KEPT on a rollback:** every document, every chunk's text, position, ACL
subjects and md5; the BM25 index (it indexes text, not vectors); every Prisma row.
Retrieval quality returns exactly to its pre-migration state.

**What is LOST:** the new generation's vectors, and — on Path B — the time to re-embed.
That is all. Path A (restore + `retag`) does not pay the re-embed at all.

**What the recovery guarantee actually is:** the chunk **text**, not the old vectors.
Cut-over does not keep the previous generation around — Lance's `swapTable()` drops and
renames the live table, and pgvector's `DELETE`s the live rows and relabels the shadow
in one transaction. There is no state in which both generations are queryable; on
pgvector the fixed-width `vector(N)` column makes that impossible by construction. This
is a *stronger* guarantee than keeping the old vectors would be: text regenerates any
model's index, so no embedding migration is unrecoverable.

**What is DEGRADED in between:** dense retrieval. From the moment the model flips
until a project's reindex completes, that project's hybrid search is BM25-only.
This is unavoidable — it is a property of changing the vector space, not of this
tooling — and it is why the reindex is per-project and resumable rather than a
single fleet-wide switch.

### Scale, timing, and what is actually in the index

Only **document chunks** are vector-indexed. Code symbols are *not*: the symbol
vector store is unwired (`project-code-searcher.ts` passes a no-op store and an
empty embed service), so the ~15k symbols / ~3.3k files of a METIS-sized repo cost
the reindex **nothing**. The corpus to re-embed is the project's uploaded and
generated documents.

Reindex cost is therefore `chunks × per-chunk embed time`, embed-bound:

| Chunks | @ ~50 chunks/s (q8, CPU, batch 128) |
| --- | --- |
| 1,000 | ~20 s |
| 10,000 | ~3.5 min |
| 100,000 | ~35 min |

Throughput depends entirely on the host CPU and on whether the sidecar or the
in-process runtime is serving, so **measure yours** with `--project` on your
smallest project before running `--all`. The absolute number is not the thing that
matters, though: because the reindex is resumable and per-project, a long one is an
inconvenience rather than a risk. Tune `--batch-size` (default 128) if the sidecar
is memory-constrained.

### EKS specifics

- Run the CLI from a pod that already has `DATABASE_URL` and the embedding config,
  e.g. `kubectl exec deploy/metis-server -- pnpm embeddings:migrate status`. Do
  **not** run it from a laptop against a prod DB with a *different* embedding
  config — the model the CLI resolves is the model it will write.
- Run it in a `screen`/`tmux` or as a `Job`, not a bare `kubectl exec` you might
  disconnect from. If it *is* interrupted, that is fine — re-run it and it resumes.
- The reindex takes a per-project **lease** (a `reindex_lease` row with an absolute
  `expires_at`), so two replicas cannot reindex the same project concurrently. It
  deliberately does not hold a transaction open for the embed loop, and — unlike the
  session advisory lock it replaces (#798) — it cannot leak across Prisma's connection
  pool and wedge the project until a pod restart. See "The reindex lease" above.
- On `VECTOR_STORE=pgvector`, Step 2 is a fleet-wide destructive DDL. Do it in a
  maintenance window, or accept a BM25-only window for the duration of Step 3.
- HPA/eviction during a reindex is safe. See "Interruptions are expected and cheap".

## Air-gapped deployment / corp networks with no HuggingFace access

The failure this section exists to prevent: on a corp network, a runtime weight
download from `huggingface.co` **401s or is blocked outright** (and Node's
`fetch` ignores `HTTPS_PROXY`, so the usual proxy escape hatch does not apply).
Weight delivery therefore must not depend on runtime egress.

> ### The env vars are METIS's, not transformers.js's
>
> `@huggingface/transformers` v3 reads **no environment variables at all** — not
> `HF_HUB_OFFLINE`, not `TRANSFORMERS_CACHE`, not `HF_ENDPOINT`. It exposes an
> `env` object (`allowRemoteModels` / `allowLocalModels` / `cacheDir` /
> `remoteHost`) and nothing more. Every variable below works because METIS maps
> it onto that object. Two things follow:
>
> - Setting `HF_ENDPOINT` on a stock Node/transformers.js deployment does
>   nothing. METIS wires it (issue #784); a plain `huggingface_hub`-style
>   assumption would silently keep hitting `huggingface.co`.
> - With `TRANSFORMERS_CACHE` **unset**, weights land in transformers.js's own
>   default cache — a `.cache/` directory **inside `node_modules`**, which the
>   next `pnpm install` may discard. Always pin `TRANSFORMERS_CACHE` for a cache
>   you intend to keep or mount.

### Env vars, and how they interact

| Var | Read by | Effect |
| --- | --- | --- |
| `HF_HUB_OFFLINE` | server + sidecar | `1`/`true`/`yes`/`on` → `allowRemoteModels=false`. Load from cache only; **fail loud** if the model is missing. |
| `TRANSFORMERS_OFFLINE` | server + sidecar | Alias of the above. |
| `EMBEDDINGS_OFFLINE` | server + sidecar | METIS's own alias of the above. Any **one** of the three is enough. |
| `TRANSFORMERS_CACHE` | server (in-process) | Cache directory for the in-process `xenova`/`embeddinggemma` backends. |
| `EMBEDDINGS_CACHE_DIR` | sidecar | Cache directory for the sidecar. Wins over `TRANSFORMERS_CACHE` **inside the sidecar container**. Deliberately *not* read by the server: the two run in different containers with different mounts. |
| `HF_ENDPOINT` | server + sidecar | Internal HF mirror, e.g. `https://hf-mirror.corp.example`. Mapped onto `env.remoteHost`; a trailing slash is added for you. **Parsed and validated at boot** — see below. |
| `HF_ENDPOINT_ALLOW_INSECURE` | server + sidecar | Opt-in to a **plaintext `http://`** mirror. Off by default; see below before you set it. |
| `EMBED_MODEL` | server + sidecar | The embed model served when a request omits one. On the sidecar image it is also a **build arg**, and the built image bakes exactly what it serves. |
| `EMBED_DTYPE` | server + sidecar | `q8` (default) \| `fp32`. Selects **which ONNX file** is fetched — see [dtype lockstep](#quantization--embed_dtype). |

**Offline beats the mirror.** When any offline flag is set, `HF_ENDPOINT` is
ignored — an air-gapped process fetches from *nowhere*, mirror included, and the
mirror URL is cleared from the transformers.js env rather than merely unused.

**The mirror decides where executable code comes from.** ONNX weights are
executable graphs, and transformers.js verifies **no checksum, no revision pin and
no signature** on what it downloads. `HF_ENDPOINT` is therefore parsed (not
regex-matched) and rejected at boot when it is:

- **not an absolute `http(s)` URL** — `file:`, `ftp:`, or a bare hostname;
- **carrying credentials** (`https://user:token@mirror`) — the endpoint is echoed
  into build logs and process stdout, so the token would leak. Authenticate the
  mirror with a proxy or an injected `Authorization` header instead. (Any mirror
  value that *is* logged has its userinfo redacted regardless.)
- **carrying a query string or fragment** — the download path template
  (`{model}/resolve/{revision}/`) is *concatenated* onto this value, so `?x=1`
  silently corrupts every URL it builds;
- **plaintext `http://`** — anyone on-path can substitute the model the process is
  about to execute. If your mirror is genuinely HTTP-only on a trusted segment,
  accept the risk explicitly with `HF_ENDPOINT_ALLOW_INSECURE=1`.

### Option A — baked image (recommended; the only one that needs zero egress at runtime)

`Dockerfile.embeddings` downloads the ONNX weights at **build** time into
`/var/cache/metis-embeddings` and ships `HF_HUB_OFFLINE=1` in the runtime stage.
The running container makes **no** HuggingFace calls.

```bash
# Default build: bakes BOTH Alibaba-NLP/gte-modernbert-base (the served default
# since #783) and Xenova/bge-small-en-v1.5 (the superseded one — kept so a
# pre-flip corpus, whose chunks are queried BY MODEL ID, can still be served and
# so EMBED_MODEL can be rolled back without a rebuild), plus the reranker — all
# at EMBED_DTYPE=q8.
docker build -f Dockerfile.embeddings -t metis-embeddings:local .

# Verify the weights are in the image:
docker run --rm --entrypoint sh metis-embeddings:local \
  -c 'find /var/cache/metis-embeddings -name "*.onnx"'
# Alibaba-NLP/gte-modernbert-base/onnx/model_quantized.onnx
# Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx
# Xenova/ms-marco-MiniLM-L-6-v2/onnx/model_quantized.onnx
```

**Proving zero egress.** Run the container with **no network namespace at all**
(`--network none`) and embed. Nothing here can reach HuggingFace, so a 200 is
proof the weights came off the disk:

```bash
docker run -d --name emb --network none -e EMBEDDINGS_TOKEN=proof-token \
  metis-embeddings:local

docker exec emb node -e "
const req = (p, b) => fetch('http://127.0.0.1:5050' + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer proof-token' },
  body: JSON.stringify(b),
}).then(r => r.json());
(async () => {
  try { await fetch('https://huggingface.co'); console.log('EGRESS: REACHABLE'); }
  catch (e) { console.log('EGRESS to huggingface.co:', e.cause?.code); }
  const v = await req('/embed', { texts: ['throttle repeated login attempts'],
                                  model: 'Alibaba-NLP/gte-modernbert-base' });
  console.log('dim=' + v.dimension, 'pooling=' + v.pooling, 'dtype=' + v.dtype);
})();"
```

```text
EGRESS to huggingface.co: EAI_AGAIN        <- no DNS, no network, at all
dim=768 pooling=cls dtype=q8               <- and it still embeds
```

Build args:

| Arg | Default | Purpose |
| --- | --- | --- |
| `BAKE_MODELS` | `1` | `0` skips the bake entirely (smaller image that downloads at runtime — **not** air-gap safe). |
| `EMBED_MODEL` | `Alibaba-NLP/gte-modernbert-base` | The model the sidecar **serves** when an `/embed` request omits `model`. Exported into the runtime stage, and **always** part of the baked set — a `BAKE_EMBED_MODELS` list that omits it **fails the build** (see below). |
| `BAKE_EMBED_MODELS` | *(unset → both defaults)* | Comma-separated list of embed models to bake. Trim it to shrink the image — but move `EMBED_MODEL` with it (see below). |
| `RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Reranker; baked at the same dtype. |
| `EMBED_DTYPE` | `q8` | Moves the bake **and** the runtime request together. |
| `HF_ENDPOINT` | *(unset)* | Build **behind a corp mirror** — see Option C. |

Why both embed models by default: the runtime default flip to gte-modernbert
(#783) is gated on the #788 eval. If the image carried only one of the two, that
config flip would silently become "rebuild and redeploy every image" — or, on an
`HF_HUB_OFFLINE=1` pod, a model that cannot load. At `q8` the second model is
cheap (see the table below); at `fp32` it is not, so trim the list if you have
already made the call.

#### Trimming the bake list safely

`EMBED_MODEL` is **one value with two consumers**: it selects what the builder
bakes (`resolveBakeModels`) *and* what the runtime serves (`resolveEmbedModel`),
exactly as `EMBED_DTYPE` does. So a trim means moving **both** args together:

```bash
# gte-modernbert ONLY — baked and served. Works.
docker build -f Dockerfile.embeddings -t metis-embeddings:gte \
  --build-arg EMBED_MODEL=Alibaba-NLP/gte-modernbert-base \
  --build-arg BAKE_EMBED_MODELS=Alibaba-NLP/gte-modernbert-base .
```

Trimming only `BAKE_EMBED_MODELS` would leave the runtime serving a model the
image never downloaded, which under `HF_HUB_OFFLINE=1` is a container that starts,
passes its health check, and then fails every embed call. That build is **rejected
at build time** instead:

```bash
docker build -f Dockerfile.embeddings \
  --build-arg BAKE_EMBED_MODELS=Xenova/bge-small-en-v1.5 .
```
```text
[bake] FAILED Error: BAKE_EMBED_MODELS (Xenova/bge-small-en-v1.5) does not
include "Alibaba-NLP/gte-modernbert-base" — the model this image SERVES by default. The
sidecar runs with HF_HUB_OFFLINE=1, so it can only ever load weights from the baked
cache: that image would boot and then fail on its first embed call. Either add
"Alibaba-NLP/gte-modernbert-base" to BAKE_EMBED_MODELS, or point the runtime at a model you
ARE baking, with --build-arg EMBED_MODEL=<one of the baked models>.
```

Note the sidecar still **serves any model the caller names** in the request body —
`EMBED_MODEL` only sets the default. The server sends an explicit `model` on every
call, so if you trim the image, make sure the server's `EMBED_MODEL` names a model
you baked.

Measured image sizes (linux/arm64, on-disk rootfs — `du -sb /` inside the
container; the `docker images` SIZE column over-reports these):

| Build | Size | vs. previous default |
| --- | --- | --- |
| `BAKE_MODELS=0` (what the CI size gate builds — no weights) | 669.9 MB | — |
| bge-small + reranker, `q8` — the **pre-#784 default** | 728.4 MB | baseline |
| **Default:** gte-modernbert (served, #783) + bge-small + reranker, `q8` | 882.3 MB | **+153.8 MB** |
| Default models at `fp32` (`--build-arg EMBED_DTYPE=fp32`) | 1.50 GB | +771 MB |

So the second embed model costs **+153.8 MB** at the shipped `q8` dtype — the
price of making #783 a config flip. At `fp32` the same insurance costs ~600 MB,
which is the point at which trimming `BAKE_EMBED_MODELS` is worth doing.

The sidecar is **exempt** from the image-size budget enforced by
`scripts/lib/verify-image-size.mjs` (it exists precisely to externalise this
weight — see the `Dockerfile.embeddings` header and issue #145). `metis-server`
and `metis-ui` are **not** exempt, and are unaffected by this change: the server
bakes embedding weights only under `--build-arg INCLUDE_XENOVA=1` (default `0`).

### Option B — mounted cache volume

Ship a *slim* image and mount a pre-populated cache. Useful when several pods
share one PVC, or when the weights are managed as a separate artifact.

**Populate the cache** on a network-allowed machine:

```bash
# In-process path (also what Windows dev uses):
TRANSFORMERS_CACHE=/data/hf-cache \
EMBED_BACKEND=xenova \
EMBED_MODEL=Alibaba-NLP/gte-modernbert-base \
EMBED_DTYPE=q8 \
  pnpm --filter @metis/server prefetch:embeddings

# Verify it will actually load with the network off — this is the same code path
# the air-gapped deploy takes, and it fails loud on a missing/wrong-dtype cache:
TRANSFORMERS_CACHE=/data/hf-cache HF_HUB_OFFLINE=1 \
EMBED_BACKEND=xenova EMBED_MODEL=Alibaba-NLP/gte-modernbert-base EMBED_DTYPE=q8 \
  pnpm --filter @metis/server prefetch:embeddings
```

**Mount it**:

```bash
# Sidecar container
docker run -v /data/hf-cache:/var/cache/metis-embeddings:ro \
  -e EMBEDDINGS_CACHE_DIR=/var/cache/metis-embeddings \
  -e HF_HUB_OFFLINE=1 \
  metis-embeddings:local

# Server container (in-process backend)
docker run -v /data/hf-cache:/app/.cache/huggingface:ro \
  -e EMBED_BACKEND=xenova -e TRANSFORMERS_CACHE=/app/.cache/huggingface \
  -e HF_HUB_OFFLINE=1 \
  metis-server:local
```

The cache must have been populated at the **same `EMBED_DTYPE`** the runtime asks
for — `q8` and `fp32` are different files (`model_quantized.onnx` vs
`model.onnx`), and offline means there is no second chance to fetch the other one.

> A Helm PVC-backed variant of this option is tracked separately in
> [#786](https://github.com/openzigs/metis-private/issues/786); this section is the
> container-level contract it will use.

### Option C — internal HF mirror (`HF_ENDPOINT`)

For corp networks that allow an internal artifact mirror (Artifactory/Nexus HF
remote, or an `hf-mirror`-style proxy) but not `huggingface.co`. The mirror must
serve the standard hub layout, i.e. `{endpoint}/{model}/resolve/{revision}/...`.

```bash
# Build the sidecar image through the mirror (no huggingface.co egress at all):
docker build -f Dockerfile.embeddings \
  --build-arg HF_ENDPOINT=https://hf-mirror.corp.example \
  -t metis-embeddings:local .

# Or let a RUNTIME container fetch from the mirror on first load. NOTE: this
# requires turning OFF offline mode — offline beats the mirror by design.
docker run -e HF_HUB_OFFLINE=0 \
  -e HF_ENDPOINT=https://hf-mirror.corp.example \
  -e EMBEDDINGS_CACHE_DIR=/var/cache/metis-embeddings \
  metis-embeddings:local
```

`HF_ENDPOINT` is intentionally **not** exported into the sidecar's runtime stage:
an air-gapped image should not carry a URL it might try. Set it explicitly (with
`HF_HUB_OFFLINE=0`) if you want the runtime-fetch behaviour.

### Other options

- **In-process server image**: build
  `Dockerfile.server --build-arg INCLUDE_XENOVA=1` (bakes into
  `TRANSFORMERS_CACHE=/app/.cache/huggingface`), deploy with
  `EMBED_BACKEND=xenova` and `HF_HUB_OFFLINE=1`.
- **Hash-only smoke**: `AI_OFFLINE=1` selects the `offline` stub with zero
  dependencies (non-semantic — **not** for production retrieval quality; this is
  the degraded state epic #780 exists to eliminate).

---

## Running the sidecar on Kubernetes / EKS (issue #786)

Everything below is about the **`sidecar` backend deployed by the Helm chart**
(`deploy/helm/metis/`). The chart ships this hardened by default; this section
exists so you know *why* the numbers are what they are before you change them.

### Resource profiles

Sizing this pod from the size of the weights file is wrong by roughly 5×. The
weights are the *small* part.

**Measured** (dev host: darwin/arm64, Node 20, `@huggingface/transformers` 3.8.1,
the shipped `q8` `Alibaba-NLP/gte-modernbert-base`; `process.memoryUsage().rss`,
sampled every 25 ms):

| What | RSS |
|---|---|
| bare Node process | **79 MiB** |
| + transformers.js + the q8 ONNX session (weights: 143 MiB on disk) | **~570 MiB** |
| + one 8192-token row in flight | **+36 MiB** |

Two consequences:

1. **The resident floor is ~570 MiB, not 150 MiB.** ONNX Runtime's arena and the
   dequantized compute graph dominate; the `model_quantized.onnx` file is a
   minority of the footprint. A 512Mi limit OOMKills this pod before it serves a
   single request.
2. **The variable part scales with `batch × longest-row-tokens`**, because the
   feature-extraction pipeline pads every row in a batch to the longest one. The
   model's context is 8192 tokens, so the worst case a single request can demand
   is large — which is what the batch cap exists to bound.

| Profile | requests | limits | QoS | Notes |
|---|---|---|---|---|
| **q8 (shipped default)** | 1536Mi / 1000m | **3Gi** / 2000m | Burstable | requests = limits/2 (see the arena-ratchet rule below) |
| **q8, prod** (`values-prod.yaml`) | 3Gi / 2000m | 3Gi / 2000m | **Guaranteed** | 2 replicas; `requests == limits` ⇒ evicted last, never CPU-throttled to the request |
| **q8, dev** (`values-dev.yaml`) | 896Mi / 500m | 1792Mi / 1000m | Burstable | Laptop-sized ceiling; will not survive a full-size 8k-context batch, and is not asked to |
| **fp32 (opt-in)** | 1.75Gi / 1000m | 3.5Gi / 2000m | Burstable | fp32 weights are 569 MiB vs q8's 143 MiB (measured from the HF manifest), so the floor rises by ~430 MiB. Activations are fp32 either way, so the batch working set is roughly unchanged |

The 3Gi limit derives as: `570 MiB floor + (64 rows × ~36 MiB/row at full 8192-token
context) ≈ 2.9 GiB`. **The per-row figure is measured at batch = 1; the ×64 step is a
linear EXTRAPOLATION, not a measurement** — an 8-row full-context batch did not
complete inside a 19-minute CPU budget on the dev host, so the marginal per-row cost
was never isolated from batch-1's fixed per-call buffers. It is therefore likely to be
*conservative*, which is the direction to err. Nobody has yet run this under sustained
load on cluster hardware.

#### The arena ratchets — why `requests` is NOT the resident floor

**BASIS: reasoned, not measured.** The 570 MiB floor and the 36 MiB/row above are
measured; everything in this subsection is inference from them plus ONNX Runtime's
documented allocator behaviour. Nobody has measured cgroup RSS on cluster hardware.

ONNX Runtime allocates through a **BFC arena that does not return memory to the OS**.
Once a real batch has inflated it, the pod's RSS stays near that high-water mark **for
the rest of the pod's life** — it does not fall back to ~570 MiB when the batch
finishes. So the "resident floor" is only the floor *before the first large batch*, and
`requests` must be sized against the **steady-state warm working set** instead:

* **QoS / eviction.** `requests ≪ limits` is **Burstable**, and kubelet ranks Burstable
  pods for eviction by *usage above requests*. A sidecar durably resident at 1.5–2 GiB
  against a 768Mi request is the single **most evictable pod on the node** — killed to
  protect pods that are actually misbehaving, and killing it costs a full cold start.
* **Scheduling.** The scheduler reserves only what you request, so nodes get packed as
  if the sidecar were small; it then grows into memory promised to other pods.

**Rule: `requests ≥ limits/2` for this component** — asserted for every profile by
`deploy/helm/metis/tests/render-tests.sh`. Prod goes further and uses
`requests == limits` (**Guaranteed** QoS: evicted last, and no gap for CFS to throttle
into). Note also that the RSS figures were measured on **darwin/arm64**, which if
anything *under*-states linux RSS (macOS compresses memory; glibc's per-thread malloc
arenas do not) — the error bar points **up**, which is another reason not to shave it.

Memory *limits* remain a ceiling, not a reservation. The **request** is what the
scheduler reserves and what the pod is entitled to under node pressure.

#### CPU: the likely production failure is a TIMEOUT, not an OOM

The number most likely to bite is the **CPU request**, not the memory limit — because
under node contention CFS throttles a container toward its *request*, and the client
gives up before the pod comes anywhere near its memory ceiling.

Arithmetic (**reasoned** from one **measured** datapoint — 11.5 s of CPU for a single
8192-token row):

* METIS's default chunk is `DEFAULT_RAG_CHUNK_SIZE` = **2048 chars ≈ 512 tokens**, i.e.
  ~1/16 of the model's 8192-token context.
* Scaling **linearly** in sequence length — which *over*-states the cost, since attention
  is quadratic — one realistic chunk is ~`11.5 / 16` ≈ **0.72 CPU-s**.
* A full 64-chunk batch (one `/embed` post after the client's split) ≈ **46 CPU-seconds**.

| CPU request | wall clock for a 64-chunk batch | vs `EMBEDDINGS_TIMEOUT_MS` (120 s) |
|---|---|---|
| 250m (the old chart request) | ~184 s | **fails** — timeout, on a pod nowhere near OOM |
| 1000m (chart default now) | ~46 s | ~2.6× headroom |
| 2000m (prod, Guaranteed) | ~23 s | ~5× headroom |

So: `requests.cpu` is **1000m** by default and **2000m** in prod, and
`EMBEDDINGS_TIMEOUT_MS` defaults to **120 s** (raised from 60 s in #786). A
worst-case *full-context* 64-row batch (~736 CPU-s) beats any sane client timeout at
any CPU allocation — the memory limit protects the pod from it, but the timeout is the
real governor. METIS's chunker never emits rows that long.

> **Watch this first in staging.** #787's reindex is exactly a sustained-batch
> workload. Watch p99 `/embed` latency against `EMBEDDINGS_TIMEOUT_MS`; if it is close,
> raise `embeddings.resources.requests.cpu` before raising the timeout.

> **fp32 is not a values-only change.** transformers.js resolves a *different
> weights file* per dtype (`model.onnx` vs `model_quantized.onnx`) and the image
> runs `HF_HUB_OFFLINE=1`, so it can only load what it baked. fp32 means
> `docker build --build-arg EMBED_DTYPE=fp32` **and** a reindex (the vectors
> change). Setting `embeddings.env.EMBED_DTYPE=fp32` against a q8 image produces a
> pod that boots and then cannot load its model. Note also that #788 measured q8
> *higher* than fp32 on METIS's own retrieval eval (0.402 vs 0.360 nDCG@10), so
> fp32 is an option, not an upgrade.

### The `/embed` batch cap: 64

`POST /embed` rejects more than **64** texts with a `400`. It does not truncate —
returning 64 vectors for 100 texts would silently mis-align every chunk downstream.

The server does **not** need to know this: `EmbeddingsClient.embed()` splits
oversized calls into ≤64-text requests (sequentially — parallel posts to one pod
would put every slice in the ONNX arena at once and recreate the very spike the cap
prevents) and stitches the vectors back in order. This matters because
`knowledge-service` ingests a document by handing over *every* chunk of it in one
call, and its reindex batches at 128. The constant lives in
`model-config.ts` / `embed-model-config.ts`, whose two copies are byte-identical
under a parity test, so client and server cannot drift.

The cap bounds latency as well as memory: one 8192-token row measured **11.5 s of
CPU** on an M-series core. A 256-row full-context request was never a slow request;
it was an OOMKill or a timeout.

### Probes: why a bad model stalls the rollout instead of crash-looping

```
startupProbe   → /readyz   gates on WARMTH; suppresses liveness while loading
readinessProbe → /readyz   503 until the ONNX session is warm
livenessProbe  → /healthz  "is the process wedged?" — NEVER /readyz
strategy: RollingUpdate, maxUnavailable: 0, maxSurge: 1
```

**THE PROBE-BUDGET INVARIANT — `startup budget > progressDeadlineSeconds`**, where

```
startup budget = initialDelaySeconds + periodSeconds × failureThreshold
                 (when kubelet RESTARTS the container)
progressDeadlineSeconds
                 (when the Deployment reports ProgressDeadlineExceeded)
```

The deadline must fire **first**. If it does not, kubelet kills a still-warming
container before the rollout is ever declared failed — the CrashLoopBackOff that all
of the below exists to avoid. The two numbers are **per profile** and must move
together; the invariant is *not* a property of the 900/600 pair specifically:

| Profile | startup budget | progressDeadlineSeconds | Margin |
|---|---|---|---|
| default (`values.yaml`) | 5 + 10 × 90 = **905 s** | 600 s | 305 s |
| dev (`values-dev.yaml`) | 5 + 10 × 30 = **305 s** | **240 s** | 65 s |
| prod (`values-prod.yaml`) | 5 + 10 × 90 = **905 s** | 600 s | 305 s |

`deploy/helm/metis/tests/render-tests.sh` asserts `budget > deadline` for **every**
profile, computed from each profile's own rendered values (never against a hard-coded
constant). It has to: #786 originally shipped `values-dev.yaml` with a 305 s budget
under a **600 s** deadline — the invariant inverted, and dev getting precisely the
crash-loop — because the budget was shortened for a laptop and the deadline was copied
over from the default profile unchanged.

(The deadline's clock starts at *rollout*, which is earlier than the container's probe
clock — it also covers scheduling and the image pull — so real-world slack is larger
than the arithmetic above. Requiring the inequality on the probe clock alone is the
conservative form.)

The sidecar now warms the model **at boot** (`src/readiness.ts`), concurrently with
`listen()`, and `/readyz` reports `warming` (503) until the session is built. Before
#786 the chart's readinessProbe pointed at `/readyz` — **a route the sidecar never
implemented**, so Express answered the catch-all 404 and the pod could never become
Ready at all.

The causal chain, for a model that will never load (missing baked weights, a bad
`EMBED_MODEL`):

1. **The startupProbe suppresses liveness.** While a startupProbe has not yet
   passed, kubelet runs *neither* liveness nor readiness. This is the only thing
   preventing the livenessProbe from counting failures against a pod that is doing
   exactly what it should — loading a model. That is the whole reason the
   startupProbe gates on `/readyz` (warmth) and not on `/healthz` (port open).
2. **Liveness never fires afterwards either**, because it asks `/healthz`, which
   stays `200` even after a permanent load failure. A failed load does **not**
   `exit(1)`: restarting cannot fix a model that isn't in the image, and a
   CrashLoopBackOff would bury the one log line that explains the problem.
3. **No Ready pod ⇒ no Service endpoint ⇒ no capacity lost.** `maxUnavailable: 0`
   means Kubernetes will not scale down a single old pod until a new one is Ready,
   so the previous ReplicaSet keeps serving every request.
4. **At `progressDeadlineSeconds` the Deployment trips `ProgressDeadlineExceeded`** —
   the rollout FAILS, `kubectl rollout status` exits non-zero, and your CD pipeline
   goes red. By the invariant above that is always *before* the startup budget would
   let kubelet restart the container (305 s earlier on the default/prod profiles, 65 s
   on dev), so the failure presents as a stalled rollout with a Running-but-NotReady
   pod you can `kubectl logs` and `kubectl exec` into.

Step 4 is the whole reason the invariant is enforced per profile rather than assumed:
if any profile's deadline outlives its startup budget, that profile's step 4 becomes
"kubelet restarts the container", and the design collapses back into a crash-loop.

Verify with:
`kubectl get pod -l app.kubernetes.io/component=embeddings` (expect `1/1` Ready
only once warm) and `curl -s localhost:5050/readyz | jq` inside the pod, which
returns `{status, model, dtype, pooling, durationMs}`.

`/readyz` is unauthenticated (kubelet carries no `EMBEDDINGS_TOKEN`), so on a failed
load it reports only a **generic** reason — `"model failed to load — see the pod logs
for the underlying error"`. The raw loader exception routinely contains filesystem
paths and cache directories, and the route is readable by anything on the pod network,
not just kubelet. **`kubectl logs` has the real error**, which is where you were going
anyway.

### HPA on CPU

Off by default. The sidecar is stateless, so horizontal scaling is *correct*; it is
just an expensive lever. Every replica carries a ~570 MiB resident session and pays
a cold start before it serves, so scaling out is slow to help and scaling in throws a
warm session away. CPU is nonetheless the honest **signal** — embedding is pure CPU,
so utilisation tracks queue depth directly.

Turn it on for a sustained bottleneck (ingesting a large monorepo, a #787 reindex),
not to absorb bursts — the batch cap plus the client's sequential slicing already
bound a burst.

```yaml
autoscaling:
  embeddings:
    enabled: true
    minReplicas: 2      # ALSO becomes the floor the PDB is computed against
    maxReplicas: 4
    targetCPUUtilizationPercentage: 70   # of the 2000m limit
```

Requires `metrics-server`. Size against the memory **request** — 1536Mi/pod by
default, 3Gi/pod under `values-prod.yaml` (Guaranteed QoS), not the limit. So 4
replicas reserve ~6 GiB by default and ~12 GiB in prod. Those requests are large on
purpose (the ONNX arena never shrinks — see the arena-ratchet note above); if that is
too much reservation to scale into, cap `maxReplicas` rather than shaving the request.

**PDB interaction:** a PodDisruptionBudget is only rendered when the replica floor
*exceeds* `minAvailable`. `minAvailable: 1` with one replica is an
undrainable node — `kubectl drain` (and therefore every managed-node-group upgrade,
Karpenter consolidation and spot reclaim) would block forever. So the chart renders
no embeddings PDB at the single-replica default, and a real one in
`values-prod.yaml`, which runs two.

### Never Alpine; arm64 is genuinely fine

`onnxruntime-node` ships **prebuilt** native bindings and **no musl build**. Verified
against the installed v1.21.0: `bin/napi-v3/linux/{x64,arm64}/`, both linking
`GLIBC_2.17`, zero musl references, and **no `libc` field** in its `package.json` —
so npm/pnpm will happily *install* it on Alpine and it only explodes at `require()`
time, inside the pod, at boot.

- **Alpine is an image property, not a scheduling one.** A container brings its own
  libc, so no node label can defend against it. `Dockerfile.embeddings` stays on
  `node:20-bookworm-slim`, and `server/tests/embeddings-image-arch.test.ts` fails CI
  if anyone changes that.
- **arm64 / Graviton is supported.** `.github/workflows/build-images.yml` publishes
  `linux/amd64,linux/arm64` for `metis-embeddings-svc` on release tags (also asserted
  by that test). The chart's `embeddings.affinity` accordingly permits `amd64` and
  `arm64` on `linux` — and nothing else, so the pod cannot be scheduled onto an
  architecture with no prebuilt binding.

### Air-gapped: the chart needs zero HuggingFace egress

Verified in the rendered manifest, not assumed:

- The pod runs `ghcr.io/<org>/metis-embeddings-svc`, the image that **bakes** the
  weights (#784).
- `Dockerfile.embeddings` sets `ENV HF_HUB_OFFLINE=1`, and the chart does **not**
  override it: `embeddings.env.HF_HUB_OFFLINE` is empty by default, and
  `metis.renderEnv` **skips empty values**, so no `HF_HUB_OFFLINE` env lands in the
  pod spec at all. (Emitting `""` would have *un-set* the image's own value — this
  is why the helper skips empties rather than rendering them.) The same holds for
  `EMBED_MODEL` and `EMBED_DTYPE`: leaving them blank is what guarantees the runtime
  asks for exactly the weights the image baked.
- Belt and braces: the default NetworkPolicy is deny-egress except DNS,
  intra-namespace, and the AI gateways — `huggingface.co` is not on that list, so the
  sidecar could not reach it even if offline mode were turned off by accident.

**Why baked weights and not a PVC / EFS cache / init-container.** Baking is the
default and the recommendation. The alternatives, with their costs:

| Option | Cost |
|---|---|
| **Baked image** (chosen) | ~150 MiB of image layer per model at q8. Zero runtime egress, zero extra failure modes, the weights are content-addressed by the image digest, and rollout = rollback. Cold start is a *local file read*. |
| **EFS (RWX) cache PVC** | ~$0.30/GiB-month (EFS Standard, us-east-1) — trivial for ~200 MiB. But: adds a network filesystem to the boot path, so a cold read of a 143 MiB ONNX file over EFS is materially slower than a local read and its p99 is EFS's, not yours; it needs the EFS CSI driver, a mount target per AZ and a security group; and it introduces a failure mode the baked image does not have (pod is fine, weights are unreachable). It also makes the weights mutable state *outside* the image digest, so two pods can disagree about what "the model" is. |
| **EBS (RWO) cache PVC** | Cheaper (~$0.08/GiB-month gp3) but RWO — it cannot be shared across the 2 prod replicas, so each needs its own volume, each still has to be populated once, and the populating fetch needs the egress we were trying to avoid. |
| **Init-container that downloads** | Needs HuggingFace (or mirror) egress at *pod start*, which is precisely the thing an air-gapped VPC does not have. It converts a build-time failure into a runtime one. |

The weights are ~150 MiB at q8 and immutable per release. That is exactly the shape
of thing an image layer is *for*. Revisit only if the fp32 profile (569 MiB) plus a
multi-model bake makes the image unpleasant to pull — at which point EFS with a
pre-populated volume is the first thing to try, and the cold-read latency must be
measured against the 900 s startup budget before it ships.
## Is my embedder REAL? — `pnpm embeddings:smoke` (#785)

The failure this epic exists to kill is **invisible**. Hash vectors are finite,
unit-norm and entirely plausible-looking; nothing about a vector tells you it is
noise, and before [#783](https://github.com/openzigs/metis-private/issues/783) a backend
that failed to load was silently swapped for the stub while every health check
stayed green. So there is one command that answers the question:

```bash
pnpm --filter @metis/server embeddings:smoke          # human-readable
pnpm --filter @metis/server embeddings:smoke --json   # machine-readable
```

It reads the same `.env` the dev server does, loads whatever backend your config
selects, and prints the identity **and then makes the embedder prove it**:

```text
VERDICT: REAL — semantic embeddings are working

  • Real semantic embeddings: "Alibaba-NLP/gte-modernbert-base" (768d, cls, q8) via the "xenova" backend.
  • The vector space discriminates — a paraphrase scored 0.760 against the anchor
    while an unrelated sentence scored 0.379 (margin 0.381).

Embedder
  backend        xenova
  model          Alibaba-NLP/gte-modernbert-base
  dimension      768
  pooling        cls (from: model-map)
  dtype          q8
  health         ok
  fell back      false
  hash fallback  not allowed — a load failure throws

Weights
  offline        false
  mirror         <huggingface.co>
  cache          /Users/you/hf-cache

Semantic probe
  cosine(anchor, related)    0.7604
  cosine(anchor, unrelated)  0.3793
  margin                     0.3810 (must exceed 0.25)
  discriminates              true
```

**Exit code is the contract**, so it can gate a setup script or CI:

| Verdict | Exit | Meaning |
| --- | --- | --- |
| `REAL` | 0 | A real model loaded **and** its vector space separates a paraphrase from an off-topic sentence. |
| `HASH STUB` | 1 | You are indexing non-semantic noise — either the stub is *selected* (`AI_OFFLINE=1`) or a real backend **fell back** to it. |
| `ERROR` | 1 | The backend did not load at all. Nothing is being embedded. |
| `SUSPECT` | 1 | Identity looks real, but the vectors are at **chance level**. Trust the vectors. |

### Why it embeds probe texts instead of just reading the config back

Config can lie by omission. A mirror serving the wrong file, a truncated cache, a
stub reached by a path the identity check does not recognise — every one of those
produces a config dump that looks perfect. So the check embeds three sentences and
requires the vector space to separate a **paraphrase** of a requirement from an
**unrelated** one by a margin of **0.25**.

That number is calibrated from measurement, and the obvious guess is wrong. The
hash stub SHA-256s the whole string, so its cosines are zero-mean noise — and the
*margin* between two noisy cosines has real spread. Measured over 50,000 triples
through the actual 384-dim stub: **mean 0.0001, sd 0.0726**, and
**P(margin > 0.05) = 24.8 %**. A "reasonable-looking" 0.05 bar would therefore
certify hash noise as REAL in one run out of four. At 0.25 the stub clears it
0.026 % of the time, while the real model measures **0.381**.

> **What this check does NOT do.** It catches *chance-level* vector spaces. It will
> **not** catch subtler damage — most importantly a CLS model that got mean-pooled,
> which still discriminates ([#782](https://github.com/openzigs/metis-private/issues/782)
> measured `cosine(cls, mean) = 0.856` on this model) while quietly costing 0.148
> nDCG@10. Pooling is guarded by the per-model map and the
> [#788](https://github.com/openzigs/metis-private/issues/788) eval, not by this smoke test.
> A green smoke check means "not noise", not "optimally tuned".

---

## Windows dev path (#785)

Both local modes work on Windows. `onnxruntime-node` (**1.21.0**, resolved as a
transitive dependency of `@huggingface/transformers` 3.8.1) publishes **prebuilt
`win32-x64` and `win32-arm64`** binaries, so there is **no native compilation** and
no Visual Studio Build Tools requirement.

> ### ⚠️ Verification status — read this before trusting the steps below
>
> **Nobody on the team has run these steps on Windows.** They were authored on
> macOS/arm64, where every command below was executed and every claim about METIS's
> own behaviour was verified (see the table). What is **NOT** verified is Windows
> itself: the `MAX_PATH` limit, WSL2 memory behaviour, and Git Bash / PowerShell
> quoting.
>
> | Claim | Status |
> | --- | --- |
> | `pnpm embeddings:smoke` reports REAL / HASH STUB / ERROR correctly, with the right exit codes | **Verified** (macOS; pure Node + the same code path Windows runs) |
> | `HF_HUB_OFFLINE=1` + a populated `TRANSFORMERS_CACHE` loads with **zero** HF egress | **Verified** (macOS) |
> | `prefetch:embeddings` populates the cache, and fails loud on an empty one | **Verified** (macOS) |
> | Compose dev default resolves to the **sidecar**, not the hash stub | **Verified** (`docker compose config` + unit test) |
> | `onnxruntime-node` ships win32-x64 / win32-arm64 prebuilds | **Verified against the published package**, not by installing on Windows |
> | Windows enforces a 260-char `MAX_PATH` on the model cache | **Reasoned, not verified** — mitigation below is precautionary |
> | WSL2 RAM cap / `.wslconfig` | **Reasoned, not verified** |
>
> If a step here is wrong, the smoke check will tell you immediately and unambiguously
> — that is precisely why it exists. **Please correct this section when you run it.**

### Mode A — in-process (`tsx`, no Docker)

Runs the model inside the server process via `@huggingface/transformers`. Simplest
setup; the server process carries the model's memory.

```powershell
# 1. A SHORT cache path. This is the MAX_PATH mitigation — see caveat 1.
setx TRANSFORMERS_CACHE C:\hf-cache
# (new shell picks it up; or for this session: $env:TRANSFORMERS_CACHE = "C:\hf-cache")

# 2. Configure the in-process backend at the laptop-friendly dtype.
#    Put these in .env at the repo root:
#      EMBED_BACKEND=xenova
#      EMBED_MODEL=Alibaba-NLP/gte-modernbert-base
#      EMBED_DTYPE=q8
#      # and make sure AI_OFFLINE is NOT 1, or you get the hash stub (see caveat 5)

# 3. Download the weights ONCE, while you have network access.
pnpm --filter @metis/server prefetch:embeddings

# 4. Prove it is real BEFORE you index anything.
pnpm --filter @metis/server embeddings:smoke
```

Step 4 must print `VERDICT: REAL` and exit 0. If it prints `HASH STUB`, stop — you
are about to fill your index with noise, and only a reindex undoes that.

### Mode B — Docker Desktop (the sidecar)

The model runs in the `metis-embeddings` container, which **bakes its weights at
build time** and runs `HF_HUB_OFFLINE=1`. The server stays slim and needs no ONNX
runtime at all.

```powershell
docker compose up
```

That is the whole setup, and **as of #785 it gives you real 768-dim vectors with
the default dev env**. It previously did not: `docker-compose.yml` set
`AI_OFFLINE=1`, which is a *global* kill switch that outranks both `EMBED_BACKEND`
and `EMBEDDINGS_MODE` in `resolveBackendKey()` — so compose built, scheduled and
health-gated a sidecar full of real weights and then **never asked it to embed
anything**. Dev silently indexed hash noise.

Compose now separates the two concerns:

| Var | Dev default | Why |
| --- | --- | --- |
| `AI_PROVIDER` | `offline-stub` | Keeps the **LLM** offline, so dev still needs **no AI credentials**. |
| `AI_OFFLINE` | `0` | Lets the **embedder** resolve to the sidecar instead of the hash stub. |
| `EMBED_BACKEND` | `sidecar` | Explicit, rather than inferred from `EMBEDDINGS_MODE`. |

There is deliberately **no hash fallback** in that default: `EMBED_ALLOW_HASH_FALLBACK`
is unset, so a sidecar that fails to load now **fails loud** rather than quietly
serving noise. Set `AI_OFFLINE=1` in your `.env` to get the old fully-offline
behaviour back.

Verify from the host:

```powershell
docker compose exec server pnpm --filter @metis/server embeddings:smoke
```

### The four Windows caveats — each with a concrete mitigation

#### 1. MAX_PATH (260 chars) vs deep model-cache paths

transformers.js composes weights as `{cacheDir}\{org}\{model}\onnx\{file}`. With
`TRANSFORMERS_CACHE` **unset**, the cache lands **inside `node_modules`** — the
deepest path on the machine, and one `pnpm install` may delete. Classic Win32 APIs
cap a full path at 260 characters and the resulting failure is an `ENOENT`/access
error that says nothing about path length.

**Mitigation — pin a short cache root:**

```powershell
setx TRANSFORMERS_CACHE C:\hf-cache
```

`embeddings:smoke` prints the resolved cache and **warns when the root leaves too
little headroom** on `win32`:

```text
  ⚠ WINDOWS MAX_PATH: this cache root leaves 41 of 260 characters for the
    model subpath, which may not be enough. Pin a SHORT cache dir, e.g. TRANSFORMERS_CACHE=C:\hf-cache
```

Optionally also enable long paths system-wide (Windows 10 1607+, needs an admin
shell and a reboot):

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
```

#### 2. Node's `fetch` ignores `HTTPS_PROXY` — so a corp proxy will NOT save you

This is the caveat that started this whole thread: the original bug was an **HF 401
on a corp network**. transformers.js downloads with `fetch`, and Node's built-in
`fetch` (undici) does **not** read `HTTPS_PROXY`/`HTTP_PROXY`. Setting them does
nothing, so a runtime weight download behind a corp proxy fails — and it fails at
the worst moment, on first use.

**Do not rely on a runtime download at all.** Pick one:

```powershell
# (a) BEST — Docker Desktop: the sidecar image BAKES its weights at build time and
#     runs HF_HUB_OFFLINE=1. Zero HuggingFace egress at runtime.
docker compose up

# (b) Prefetch on a network-allowed session, then go offline. The cache is a
#     directory — copy it to the air-gapped machine if need be.
$env:TRANSFORMERS_CACHE = "C:\hf-cache"
pnpm --filter @metis/server prefetch:embeddings

#     Then pin offline. This is the SAME code path the air-gapped deploy takes and
#     it fails LOUD on a missing or wrong-dtype cache:
$env:HF_HUB_OFFLINE = "1"
pnpm --filter @metis/server prefetch:embeddings   # verifies; must exit 0
pnpm --filter @metis/server embeddings:smoke      # must print VERDICT: REAL

# (c) Internal HF mirror (Artifactory/Nexus HF remote). NOTE: HF_ENDPOINT is a
#     METIS variable — transformers.js reads NO env vars; METIS maps it on.
$env:HF_ENDPOINT = "https://hf-mirror.corp.example"
pnpm --filter @metis/server prefetch:embeddings
```

See [Air-gapped deployment](#air-gapped-deployment--corp-networks-with-no-huggingface-access)
for the full contract. Offline **beats** the mirror: with `HF_HUB_OFFLINE=1` set,
`HF_ENDPOINT` is ignored and cleared.

#### 3. WSL2 RAM — an fp32 session is ~1.5 GB

Docker Desktop runs containers in a WSL2 VM whose memory is capped independently of
Windows'. An ONNX session that exceeds it is **OOM-killed**, which surfaces as the
sidecar container dying or failing its health check rather than as an obvious memory
error.

**Mitigation — give WSL2 explicit headroom.** Create `%UserProfile%\.wslconfig`:

```ini
# %UserProfile%\.wslconfig
[wsl2]
memory=6GB        # q8 needs far less; 6GB leaves room for the server + Postgres
processors=4
swap=2GB
```

Then `wsl --shutdown` and restart Docker Desktop. Prefer **q8** (caveat 4) and this
is a non-issue; the ~1.5 GB figure is the **fp32** session, which is the case worth
sizing for if you deliberately switch.

#### 4. Prefer `q8` on laptops — and it is already the default

`EMBED_DTYPE=q8` (~150 MB) is METIS's default; `fp32` is ~600 MB on disk and ~4× the
resident memory. There is **no measured quality reason to pay for fp32** — on the
#788 corpus q8 actually scored *higher* (0.402 vs 0.360 nDCG@10). Leave it alone.

If you do switch, note the **dtype lockstep**: `q8` and `fp32` are *different weights
files*, so an offline cache or a baked image can only serve the dtype it fetched.
Re-run the prefetch after changing it.

#### 5. `AI_OFFLINE=1` silently outranks everything (the one that bites)

`AI_OFFLINE` is a **global** kill switch, and in `resolveBackendKey()` it sits
*above* both `EMBED_BACKEND` and `EMBEDDINGS_MODE`. So `AI_OFFLINE=1` +
`EMBED_BACKEND=xenova` does **not** give you xenova — it gives you the 384-dim hash
stub, with no error. The pre-#783 shipped `.env` also set
`EMBED_MODEL=metis-offline-hash-v1`, which routes to the stub by a different rule.

**Mitigation:** if you want real embeddings, make sure your `.env` has neither. Then
confirm rather than assume:

```powershell
pnpm --filter @metis/server embeddings:smoke
```

### Known quirk — exit code 134 on a successful in-process run

Both `prefetch:embeddings` and `embeddings:smoke` used to call `process.exit()` while
onnxruntime-node still held a live inference session, so ORT aborted during teardown
(`libc++abi: … mutex lock failed`) and the process exited **134 (SIGABRT) on the path
where everything worked**. Both scripts now set `process.exitCode` and let Node drain,
so success really is exit 0. If you see 134 from any *other* ONNX-loading script, this
is the cause.
