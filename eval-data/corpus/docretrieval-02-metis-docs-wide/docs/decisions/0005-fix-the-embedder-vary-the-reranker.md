# ADR 0005 — Fix the embedder across environments; vary the reranker

- **Status:** Accepted
- **Date:** 2026-07-30
- **Resolves:** GitHub #1161 (sub-issue E of epic #1156)
- **Depends on:** #1158 (the measurement this ADR's reranker half rests on)
- **Related:** #780 / #783 (how the default embedding model was chosen), #787 / #792
  (per-row model tags and the reindex runbook), #797 (code-symbol embeddings), #930 / #931
  (the backend registry), #937 (coverage reporting), #1157 (the corpus these numbers are
  measured on)

## Decision

> **Keep the EMBEDDER identical across every environment. Vary the RERANKER instead.**

And, on today's evidence, the reranker to vary it to is **none** — see
[The reranker half](#the-reranker-half--stateless-and-therefore-the-right-axis-to-vary)
below, which is where that lands after #1158's measurement.

This is a **policy about the axis on which environments are allowed to differ**. It changes
no default, removes no backend and triggers no migration. `bedrock`, `bedrock-sdk` and
`openai` stay registered and supported; a deployment that genuinely cannot run local model
weights still uses one, and this ADR's contribution is to make the price of that choice
explicit rather than to forbid it.

## Context

Epic #1156's entire method is *measure locally, then decide*. That method has a
precondition nobody had written down: the thing measured locally has to be the thing
running in production. Every time a deployment target came up, "should AWS use a bigger /
different embedding model?" was re-litigated from memory. This ADR is the artefact that
stops that, and it is deliberately written as two independent halves — the embedder half
stands on the dimension evidence alone and does not depend on any reranker result.

## The embedder half — embeddings are not portable

An embedding is not a function you call; it is a **width and a coordinate system baked into
every persisted row**. Two backends this repo supports today disagree on the width:

| Environment / backend | Model | Dimension | Citation |
|---|---|---|---|
| Local / CI default (`xenova`, `sidecar`) | `Alibaba-NLP/gte-modernbert-base` | **768** | `packages/shared/src/constants.ts:588` (model id), `:599` (`DEFAULT_EMBED_DIMENSION = 768`) |
| AWS (`bedrock-sdk`) | `amazon.titan-embed-text-v2:0` | **1024** | `server/src/lib/rag/backends/bedrock-sdk-embedder.ts:22-23` |
| Offline stub (`offline`) | `metis-offline-hash-v1` | 384 | `packages/shared/src/constants.ts:565` (`OFFLINE_EMBED_DIMENSION = 384`) |

`constants.ts:594-597` already states the consequence, in the repo's own words:

> Changing this is an INDEX-CONTRACT change: it sizes the pgvector column and the Lance
> table schema. Chunks already embedded at the old width are excluded from retrieval by
> their `embeddingModel` tag […] but they stay unusable until a reindex (#787).

So "use Titan in AWS and gte locally" is not a configuration difference. It is **a second,
separately re-embedded store**, and it means the number measured on the laptop was measured
against a different index than the one serving production.

### State the cost correctly: fragmentation, not corruption

It would be easy — and wrong — to argue this ADR from "mixing models silently corrupts
retrieval". METIS already prevents that, and overstating the risk would be exactly the kind
of unverified technical claim epic #1156 is careful about.

Every row carries the model that produced it:

- `KnowledgeChunk.embeddingModel` — `server/prisma/schema.prisma:878`
- `CodeSymbolEmbedding.embeddingModel` — `server/prisma/schema.prisma:3318`, with
  `@@index([projectId, embeddingModel])` at `:3325`

And the read path filters on it as a **hard requirement**, not an optimisation
(`server/src/lib/code-graph/symbol-embedding-service.ts:331-334`, `createSymbolVectorStore`):

> The model filter is MANDATORY, not an optimisation: it is what makes a mixed-generation
> store safe to query. Without it a 384-dim bge row and a 768-dim gte row would be
> candidates for the same ranking.

A mixed-generation store therefore does **not** silently cross-match. Rows from the wrong
model are excluded, not misranked. The real costs of a per-environment embedder are:

1. **Fragmentation.** Each environment needs its own full re-embed of every document chunk
   and every code symbol. Nothing is shared, and every corpus change is paid N times.
2. **Non-transferable evaluation.** This is the one that is fatal to #1156. A local
   nDCG@10 stops predicting the production nDCG@10, because the retrieval being scored is a
   different retrieval. An epic whose every sub-issue is gated on a locally measured delta
   cannot survive that.
3. **Silent under-retrieval, not wrong retrieval.** The failure mode of a mismatched tag is
   an index that returns *too little* — matching rows are filtered out — which reads as
   "search got worse" rather than as an error. That is detectable, and METIS detects it (see
   [The guard](#the-guard-was-considered-and-deliberately-not-built) below), but it is not
   loud on its own.

### The one place the config surface invites the mistake

Titan v2 supports selectable output dimensions, and this codebase exposes that: `dimension`
on `BedrockSdkEmbedderConfig` (`bedrock-sdk-embedder.ts:35`) resolved from `cfg.dimension`
or the `EMBED_DIM` env var (`bedrock-sdk-embedder.ts:187-192`). `EMBED_DIM` is documented as
a common variable in `docs/EMBEDDINGS_BACKENDS.md`, so it looks like a tuning knob.

**It is not a tuning knob. A same-model dimension change is still a full re-embed** — the
width is what sizes the pgvector column and the Lance schema (`constants.ts:594-597`), and
existing rows keep their old tag. So this exception does not escape the argument; it is
recorded here because it is the one setting an operator could plausibly change on a Tuesday
believing it to be reversible.

Note also that `EMBED_DIM` is a **no-op for `xenova` and `sidecar`** (they emit their model's
native width) and is read only by `embeddinggemma`'s Matryoshka truncation and the cloud
backends — so its behaviour differs by backend, which compounds the trap.

### What is deliberately *not* claimed here

- **No Cohere dimension is asserted.** The `bedrock-sdk` backend has a `cohere` family, but
  it only switches request/response shape — one batched `{texts, input_type}` request versus
  Titan's per-input `{inputText}` (`bedrock-sdk-embedder.ts:93-101` vs `:103-112`). It
  hardcodes **no** Cohere dimension anywhere. Any Cohere width quoted in a future discussion
  must come with an external citation and be labelled as one; it is not a fact this
  repository contains.
- **No claim that one embedding model is better than another.** #1156 is explicit that it is
  not a model-shopping epic. Displacing `gte-modernbert-base` needs its own epic with its own
  eval, following #780 / #783's precedent.

## The reranker half — stateless, and therefore the right axis to vary

A reranker re-scores an already-retrieved candidate list at query time.
`Reranker.rerank(query, candidates)` (`server/src/lib/rag/reranker.ts:73-76`) reads nothing
persisted and writes nothing. It has **zero index implications**: a heavier reranker in one
environment costs compute and latency and **no migration**, and an environment can turn it
off tomorrow with no reindex.

That is the structural argument, and it is why this is the correct axis to scale by
environment tier. It says nothing about whether any *particular* reranker is worth running,
which is a question only measurement can answer — and #1158 answered it.

### The measurement (#1158) — and it is negative

Two findings, both from #1158, both independently reproduced by a second agent at all three
pool depths.

**First, the cross-encoder was inert on every path.** It passed Python-style
`{text, text_pair}` objects to `pipeline("text-classification")`, whose
`TextClassificationPipeline._call` in `@huggingface/transformers@3.8.1` forwards no
`text_pair`; and the checkpoint declares a single label, so softmax over one value returned
exactly 1.0 for every pair. `RAG_RERANK=1` would have changed no ordering **anywhere**,
including the document path where it was already wired (`knowledge-service.ts:348`). The
full diagnosis is now recorded in the module header (`reranker.ts:11-46`). This matters for
this ADR because it means every pre-#1158 intuition about "the reranker" was an intuition
about a stage that did nothing. #1158 fixed the scoring path; that fix is on `main`.

**Second, once it actually scored, reranking code search measured worse — monotone in pool
depth.** Corpus `embedretrieval-02-nl-to-code` (127 requirements / 794 symbols), through the
production searcher, against a rerank-OFF baseline of **0.276**
(`eval-results/embed-retrieval-rerank-2026-07-30T23-31-01-494Z.md`):

| pool → top-10 | nDCG@10 | Δ | paired 95% CI | sign p | verdict | added p50 / p95 |
|---|---|---|---|---|---|---|
| OFF | **0.276** | — | — | — | — | — |
| 20 | 0.218 | −0.058 | [−0.106, −0.013] | 0.117 | **NOT-ESTABLISHED** | 91.0 / 127.0 ms |
| 50 | 0.182 | −0.094 | [−0.155, −0.035] | 0.017 | DIRECTION-ESTABLISHED | 244.7 / 312.3 ms |
| 100 | 0.160 | −0.116 | [−0.176, −0.057] | 0.001 | DIRECTION-ESTABLISHED | 508.1 / 611.9 ms |

Pool 20 is classified NOT-ESTABLISHED because its bootstrap CI excludes zero while the sign
test does not (p = 0.117), and on disagreement the repo's rule is to believe the sign test.
So the honest reading is: **at pool 20 the loss is not statistically established; at 50 and
100 it is, and the direction is negative at every depth.** No depth shows a gain.

Latency is the one figure that is hardware-dependent: an independent re-run reproduced the
quality numbers digit-for-digit but measured p50/p95 of 106/155, 273/357 and 570/688 ms —
higher, which only strengthens the conclusion.

The production wiring was **reverted**, per #1156's rule that a change which does not move
nDCG@10 is reverted and recorded rather than left dormant behind a flag. The eval apparatus
survives (`server/src/lib/eval/embed-retrieval/rerank-searcher.ts`, `rerank-sweep.ts`) so the
negative is re-derivable rather than merely asserted.

**One cost figure is corrected here so it is not inherited wrong.** The reranker is **23.9 MB
on disk** (23,143,499 bytes of ONNX at `q8`, `reranker.ts:42-46`; 23,856,961 bytes total per
the eval report), **not** the "≈150 MB" that `reranker.ts`'s old header and #1156 both
claimed. 150 MB is almost exactly the *embedder*'s footprint (150,218,016 bytes,
`reranker.ts:45-46`). Disk was never the reason to leave the reranker off, and any cost
argument built on 150 MB would have been wrong by a factor of six.

### Recommendation, by environment

| Environment | Embedder | Reranker for `search_code_symbols` | Reranker on the document path |
|---|---|---|---|
| Local / CI | unchanged (`xenova` / `offline` in CI) | **None** — measured worse at every depth | Leave `RAG_RERANK` unset |
| AWS / production | **the same embedder** — do not swap by tier | **None** — same measurement applies; the stage is not even wired | Leave `RAG_RERANK` unset — **unmeasured, see below** |

The recommendation is uniform, which means this ADR's second half currently recommends
*no* per-environment variation. That is the evidence, not a preference: this issue was
opened expecting to recommend a heavier reranker in AWS, and the measurement says otherwise.
The structural argument for reranking being the right axis is unaffected — it is what makes
a future reranker cheap to adopt — but no reranker available today earns its place.

### Why it lost — domain fit, not cross-encoding as a technique

This distinction is the load-bearing part of the recommendation, because "cross-encoders are
bad" would wrongly foreclose the follow-ups.

The same model, in the same run, both **improves** exact-name lookup and **collapses** prose
queries:

- **Exact-name #1 rate: 77% → 88% (pool 20) / 89% (pool 50, 100)** of 155 probes.
  Compared *by name*, that is **18 names recovered and 0 lost** at pool 20, and **19
  recovered / 0 lost** at pools 50 and 100 (comparing the miss sets in the eval report — a
  count alone would have hidden a swap). The recovered set is *entirely*
  camelCase/PascalCase: `VaultService`, `backtestWindow`, `refreshAccessToken`,
  `buildTraceabilityMatrix`, …
- **The `naming: camel` stratum collapses 0.299 → 0.215 / 0.165 / 0.141** across the same
  104 queries.

Same model, same symbols, opposite outcomes — split precisely on whether the query is a
**literal identifier** (exact-name probes use the identifier *as* the query) or **prose**
(the camel stratum). The MS MARCO cross-encoder is behaving as a *lexical matcher* over
short symbol passages, and it overrides the bi-encoder ordering that carries the semantic
signal. That reading is corpus-independent and is the decisive evidence.

**Do not lean on the snake-case stratum for this.** `naming: snake` also improved
(0.169 → 0.230 / 0.258 / 0.245), and it is tempting to read that as a second pillar. It is
not a clean one: 5 of that stratum's 23 queries paraphrase the target table name over bare
one-line header passages, where a lexical matcher is guaranteed to win. That cell is an
**upper bound**. The exact-name / camel-stratum split carries the query-shape argument on
its own and needs no such caveat.

Two alternative explanations were tested and **rejected**, not merely dismissed:

- **Scoring-direction error** — ruled out three ways: a sign flip cannot recover 19 names and
  lose none; the checkpoint's own default activation is `Identity`, so the raw logit *is* the
  score; and the sanity check is monotone.
- **Pool composition** — ruled out by a widen-only control (below).

### Measured vs hypothesis — stated explicitly

Because this ADR will be read as licence for future work, each claim is labelled:

| Claim | Status |
|---|---|
| The cross-encoder was inert before #1158 | **Measured** (against the installed library, reproduced) |
| Reranking `search_code_symbols` with `ms-marco-MiniLM-L-6-v2` is worse at pools 20/50/100 | **Measured** (reproduced digit-for-digit) |
| The reranker is 23.9 MB, not 150 MB | **Measured** (bytes on disk) |
| The failure is domain fit — the model acts as a lexical matcher | **Measured** (the exact-name / camel-stratum split) |
| Pool widening alone is not a confound *on this corpus* | **Measured** (Δ = 0.0000, 0/127 at all depths) — measured by the reviewer of PR #1175 with an identity reranker, reported in that PR's review thread; **no committed artefact**, so cite the thread rather than `eval-results/` |
| A **code-trained** reranker would do better | **HYPOTHESIS — untested.** Nothing in #1158 evaluates one |
| **Query-shape gating** (rerank only identifier-shaped queries) would help | **HYPOTHESIS — supported but untested.** The split above is consistent with it; no arm measured it |
| The snake-case gain generalises | **NOT SUPPORTED** — upper-bounded by 5/23 paraphrase queries |
| Reranking helps or hurts the **document** path | **NO MEASUREMENT EXISTS** — see below |

### The document path rests on no measurement

The reranker *is* wired on the document path (`knowledge-service.ts:348`, applied after RRF
and after the ACL filter), so `RAG_RERANK=1` is a flag flip there — and after #1158 it is a
flag flip that now genuinely changes ordering, where before it changed nothing.

**Nobody should flip it citing #1158.** No harness can currently see it: `rag:eval`'s 20
fixtures carry **canned** `retrievedChunks` (`server/src/lib/rag/ragas.ts:42-43`) scored by a
stub judge whose metrics fall back to 1.0 on an empty denominator. It never runs retrieval,
so it cannot observe a reranker and would print a vacuous pass. Building a real
document-retrieval harness is **#1160's** scope, and that gap is the reason the doc-path row
in the table above says "unset" rather than "measured, no".

One mechanism worth recording for whoever measures it, explicitly **as a hypothesis**: the
cross-encoder truncates its input (`truncation: true`, `reranker.ts:220-223`) at a 512-token
budget, while a document chunk is 2048 characters ≈ 512 tokens
(`packages/shared/src/constants.ts:547`, and the "~512 tokens at 4 chars/token" comment at
`:546`). Chunk tails may therefore be silently truncated out of scoring. That is a reason to
measure carefully, not a measured result.

## Alternatives rejected

**1. A different embedder per environment (the status quo assumption).** Rejected. It buys a
possibly-better model in one tier at the cost of a separate store per tier and evaluation
numbers that stop transferring — which disables the only method epic #1156 has. If a better
model exists, the answer is to adopt it *everywhere*, through its own eval epic, not to run
two.

**2. A different dimension per environment via Titan's configurable output.** Rejected, and
it is the most seductive option because `EMBED_DIM` looks like a knob. A same-model width
change is a full re-embed and an index-contract change (`constants.ts:594-597`); it buys
nothing this ADR wants and costs everything a model swap costs.

**3. Rely on the model tag and let environments drift.** Rejected. The tag makes drift
*safe* (`symbol-embedding-service.ts:331-334`), not *free*. Safe-but-fragmented is still
fragmented, and the tag does nothing about eval transferability, which is the actual problem.

**4. Enable the cross-encoder in AWS only, as a "bigger environment gets more compute"
tier.** Rejected on the measurement: it is worse at every pool depth on code search, so
spending AWS's larger latency budget on it buys negative quality. This is the option the
issue was opened expecting to take.

**5. Keep the rerank stage in the code path, flag-gated and off, "for later".** Rejected per
#1156's rule. A dormant stage nobody measures is precisely the state that produced #1158 —
a reranker believed to work, switched off, and inert for as long as anyone had had it.

## The guard was considered and deliberately not built

#1161 offered an optional startup warning when the resolved embedder differs from the model
tag dominating the existing store, marked "only if cheap; drop it if not". **It was dropped —
because it already exists, and better.**

- `KnowledgeService.coverageReport(projectId)`
  (`server/src/lib/rag/knowledge-service.ts:830-883`, issue #937) compares the persisted
  per-chunk `embeddingModel` *and* the per-symbol model against the currently-active
  embedder, and returns `needsReindex`. It uses the composite pooling/dtype identity for
  documents and the bare model id for symbols, deliberately (#792 / #797) — a subtlety a
  fresh startup check would have got wrong.
- `KnowledgeService.deploymentCoverage()` (`knowledge-service.ts:1609`) does the same across
  **every** project in one query.
- It is reachable by operators two ways: the admin route at
  `server/src/routes/admin/embeddings.ts:228`, and `pnpm embeddings:migrate status`, which
  **exits 1 when work remains specifically so it can gate a deploy**
  (`server/scripts/embed-migrate.ts:131-136`).

A log line at boot would duplicate live, tested logic with a strictly weaker signal, add a
database read to the startup path, and create a second place for the #792/#797 identity
subtlety to rot. The correct action was to find the existing mechanism and point at it,
which is what this ADR and `docs/EMBEDDINGS_BACKENDS.md` now do.

**Consequence: this ADR ships as a documentation-only change.** No production default,
model, dimension or weighting is altered.

## Consequences

- The question "should AWS use a different embedding model?" has a written answer with
  citations, and reopening it now requires new evidence rather than a fresh opinion.
- Local eval numbers remain a valid predictor of production retrieval — which is the
  precondition every remaining sub-issue of #1156 depends on.
- `bedrock`, `bedrock-sdk`, `openai` and `embeddinggemma` remain registered and supported.
  A deployment that must use one accepts a separate store and non-transferable evals
  *knowingly*; that is a legitimate trade, not a mistake, and this ADR only asks that it be
  made on purpose.
- `RAG_RERANK` stays unset in every committed env file. It is not deprecated — the flag is
  the mechanism a future, better reranker will arrive through.
- **Before any future reranker is evaluated, add a permanent `--widen-only` control arm to
  the rerank sweep.** A rerank arm that widens its candidate pool is otherwise confounded
  with the widening itself. On this corpus the confound is measured at **nil** — Δ = 0.0000,
  0/127 queries at all three depths, i.e. the fused top-10 is exactly invariant to fetch
  depth — but that is a useful *known baseline*, not a reason to skip the control on a
  different corpus or a different fusion.

### Open leads, in priority order (each needs its own measurement)

1. **A code-trained reranker.** The failure was domain fit; MS MARCO is a web-passage
   checkpoint. Untested here.
2. **Query-shape gating** — rerank only identifier-shaped queries, leave prose to the
   bi-encoder. Consistent with the exact-name / camel-stratum split, but no arm measured it,
   and the snake-case cell cannot be used as support.
3. **The document path**, once #1160 builds a harness that actually runs retrieval.

None of these is licence to enable a reranker before it is measured. #1156's rule stands: a
change that does not move nDCG@10 is reverted and recorded.

## References

- Measurement: `eval-results/embed-retrieval-rerank-2026-07-30T23-31-01-494Z.md` (#1158);
  reproduce with `EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval --rerank`
- Eval apparatus (eval-only, not reachable from production):
  `server/src/lib/eval/embed-retrieval/rerank-searcher.ts`, `rerank-sweep.ts`
- Backend registry and resolution order: `server/src/lib/rag/embedder-registry.ts:1-20`,
  `:200-216` (`resolveBackendKey`), `:129-140` (`KEY_ALIASES`)
- Backend operations, per-backend env vars and the reindex runbook:
  [`docs/EMBEDDINGS_BACKENDS.md`](../EMBEDDINGS_BACKENDS.md)
- Epic context and the three levers: #1156
