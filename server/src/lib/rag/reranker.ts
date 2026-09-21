/**
 * Cross-encoder reranker — Phase 5 follow-up (issue #131).
 *
 * Loads `Xenova/ms-marco-MiniLM-L-6-v2` lazily through `@huggingface/transformers`
 * and uses it to rescore (query, passage) pairs after RRF. We never construct it
 * unless `RAG_RERANK=1` is set or the caller explicitly asks for `mode: "rerank"`.
 *
 * Failures fall through transparently — we return the original ordering so
 * a missing model never breaks search.
 *
 * ## Issue #1158 — this scored NOTHING until the scoring path was rewritten
 *
 * The original implementation called `pipeline("text-classification")` and handed
 * it an array of `{ text, text_pair }` objects. That is the *Python* transformers
 * convention. `TextClassificationPipeline._call` in `@huggingface/transformers`
 * (3.8.1, `src/pipelines.js`) does `this.tokenizer(texts, { padding, truncation })`
 * — it forwards **no** `text_pair`, so every candidate object stringified to the
 * same value and every pair tokenized identically. Two independent consequences,
 * both verified against the installed package rather than reasoned about:
 *
 *   1. Every candidate received an identical logit, so `sort` was a no-op and the
 *      reranker returned the input order for any input.
 *   2. Even with real logits it could not have ranked: this checkpoint's
 *      `config.json` declares a SINGLE label (`id2label: {"0": "LABEL_0"}`), and
 *      the pipeline applies `softmax` across the label axis. Softmax over one
 *      value is 1.0, always — measured: `[{score:1},{score:1},{score:1}]`.
 *
 * So the reranker was not merely switched off; switching it on would have changed
 * nothing on either path. #1158 was raised to measure it, and a measurement of an
 * inert stage is vacuous, so the scoring path is fixed here: tokenize the (query,
 * passage) pair properly through `AutoTokenizer`'s `text_pair` option and read the
 * RAW LOGIT off `AutoModelForSequenceClassification`. Sanity check on MS MARCO-style
 * prose after the fix: +8.65 for the answering passage, −4.48 for a topical
 * distractor, −11.25 for an unrelated one.
 *
 * The raw logit is used unsquashed and only as a SORT KEY — a monotone activation
 * (sigmoid) would produce the identical ordering, and `config.json` records this
 * checkpoint's own default activation as `Identity`.
 *
 * ## Footprint, measured (#1158)
 *
 * A previous revision of this header said "≈150 MB ONNX". At the `q8` dtype METIS
 * actually runs, `Xenova/ms-marco-MiniLM-L-6-v2` is **23.1 MB** of ONNX
 * (23,143,499 bytes) and **23.9 MB** on disk including the tokenizer — about a sixth
 * of the claim. 150 MB is very close to the *embedder*'s footprint
 * (`Alibaba-NLP/gte-modernbert-base`, 150,218,016 bytes), which is the likely origin
 * of the number. Disk is not the reason to leave this off.
 */
import { createChildLogger } from "../logger.js";
import { resolveDtype } from "./embed-model-config.js";
import {
  EmbeddingsClient,
  getEmbeddingsClient,
  resolveEmbeddingsMode,
} from "./embeddings-client.js";

const log = createChildLogger("rag-reranker");

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

export interface RerankCandidate {
  chunkId: string;
  text: string;
  score?: number;
}

export interface RerankerOptions {
  model?: string;
  /** Skip the rerank for queries shorter than this many characters. */
  minQueryLength?: number;
}

export interface Reranker {
  readonly enabled: boolean;
  rerank(query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]>;
}

/**
 * Decide whether reranking should run for this process. Honours
 * `RAG_RERANK=1` (canonical) plus a per-call override.
 */
export function isRerankEnabled(): boolean {
  const raw = process.env.RAG_RERANK;
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Pairs scored per forward pass (#1158).
 *
 * The pool this reranker is handed is caller-controlled — up to 200 chunks on the
 * document path — and one padded batch of 200 × 512 tokens is a memory spike nobody
 * asked for on an interactive search. Chunking bounds the peak; measured cost of the
 * chunking itself is negligible (100 pairs ≈ 46 ms warm either way).
 */
const RERANK_BATCH_SIZE = 32;

/** The minimal surface of `@huggingface/transformers` this module depends on. */
interface TransformersModule {
  AutoTokenizer: {
    from_pretrained: (model: string) => Promise<TokenizerFn>;
  };
  AutoModelForSequenceClassification: {
    from_pretrained: (model: string, opts?: { dtype?: string }) => Promise<SequenceClassifier>;
  };
  env?: { allowRemoteModels?: boolean; allowLocalModels?: boolean; cacheDir?: string };
}

type TokenizerFn = (
  texts: string[],
  opts: { text_pair: string[]; padding: boolean; truncation: boolean },
) => unknown;

type SequenceClassifier = (inputs: unknown) => Promise<{ logits: { tolist: () => unknown } }>;

/**
 * Flatten `logits.tolist()` — shape `[n, numLabels]` for this checkpoint's single
 * label, i.e. `[[-11.37], [-11.42], …]` — to one score per candidate.
 *
 * Exported for test: the shape is the part of the transformers.js contract this
 * module is most exposed to, and #1158 exists because the previous version of this
 * file mis-read that contract silently.
 */
export function firstLogitPerRow(raw: unknown, expected: number): number[] | null {
  if (!Array.isArray(raw) || raw.length !== expected) return null;
  const out: number[] = [];
  for (const row of raw) {
    const v = Array.isArray(row) ? row[0] : row;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

class XenovaCrossEncoderReranker implements Reranker {
  readonly enabled = true;
  private readonly model: string;
  private readonly minQueryLength: number;
  private scorer: ((query: string, passages: string[]) => Promise<number[] | null>) | null = null;
  private loader: Promise<void> | null = null;

  constructor(opts: RerankerOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.minQueryLength = Math.max(opts.minQueryLength ?? 2, 0);
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]> {
    if (candidates.length === 0) return candidates;
    if (query.trim().length < this.minQueryLength) return candidates;
    try {
      await this.warm();
    } catch (err) {
      log.warn("rerank pipeline unavailable, falling back to original order", {
        error: (err as Error).message,
      });
      return candidates;
    }
    if (!this.scorer) return candidates;

    let scored: { cand: RerankCandidate; score: number }[];
    try {
      const logits: number[] = [];
      for (let i = 0; i < candidates.length; i += RERANK_BATCH_SIZE) {
        const batch = candidates.slice(i, i + RERANK_BATCH_SIZE);
        const batchScores = await this.scorer(
          query,
          batch.map((c) => c.text),
        );
        // A batch whose output shape we do not recognise is NOT scored to zero —
        // that would silently reorder the pool by "everything after this batch is
        // worse". Fall through to the fused ordering instead.
        if (batchScores === null) {
          log.warn("rerank produced an unrecognised output shape, keeping original order", {
            model: this.model,
            batchSize: batch.length,
          });
          return candidates;
        }
        logits.push(...batchScores);
      }
      scored = candidates.map((cand, i) => ({ cand, score: logits[i] }));
    } catch (err) {
      log.warn("rerank inference failed, falling back to original order", {
        error: (err as Error).message,
      });
      return candidates;
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(({ cand, score }) => ({ ...cand, score }));
  }

  private async warm(): Promise<void> {
    if (this.scorer) return;
    if (!this.loader) this.loader = this.load();
    await this.loader;
  }

  private async load(): Promise<void> {
    const mod = (await import("@huggingface/transformers")) as unknown as TransformersModule;
    if (mod.env) {
      // Mirror the embedder's offline-friendly defaults.
      mod.env.allowRemoteModels = mod.env.allowRemoteModels ?? true;
    }
    // dtype defaults to q8 (preserving transformers.js v2's quantized-by-default
    // behaviour — v3 defaults to fp32 on Node) and is configurable via
    // `EMBED_DTYPE` (#782). The rerank model rides the SAME knob as the embed
    // model on purpose: both Dockerfile bake steps bake whatever `EMBED_DTYPE`
    // says, so a rerank pipeline that requested a different dtype would fail to
    // find its weights in an air-gapped (HF_HUB_OFFLINE=1) image.
    const dtype = resolveDtype();
    const tokenizer = await mod.AutoTokenizer.from_pretrained(this.model);
    const classifier = await mod.AutoModelForSequenceClassification.from_pretrained(this.model, {
      dtype,
    });
    this.scorer = async (query, passages) => {
      // `text_pair` is what makes this a CROSS-encoder: query and passage enter the
      // same forward pass, separated by [SEP]. The `text-classification` pipeline
      // does not forward it — see this module's header — which is why the model is
      // driven directly.
      const inputs = tokenizer(
        passages.map(() => query),
        { text_pair: passages, padding: true, truncation: true },
      );
      const { logits } = await classifier(inputs);
      return firstLogitPerRow(logits.tolist(), passages.length);
    };
    log.info("rerank cross-encoder loaded", { model: this.model, dtype });
  }
}

class NoopReranker implements Reranker {
  readonly enabled = false;
  async rerank(_query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]> {
    return candidates;
  }
}

/**
 * Reranker that delegates to the `metis-embeddings` sidecar over HTTP.
 * Falls back to original ordering on any failure (same contract as the
 * in-process Xenova reranker).
 */
class RemoteReranker implements Reranker {
  readonly enabled = true;
  private readonly model: string;
  private readonly minQueryLength: number;
  private readonly client: EmbeddingsClient;

  constructor(opts: RerankerOptions = {}, client: EmbeddingsClient) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.minQueryLength = Math.max(opts.minQueryLength ?? 2, 0);
    this.client = client;
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]> {
    if (candidates.length === 0) return candidates;
    if (query.trim().length < this.minQueryLength) return candidates;
    try {
      const res = await this.client.rerank(
        query,
        candidates.map((c) => ({ chunkId: c.chunkId, text: c.text })),
        this.model,
      );
      const scored = candidates.map((cand, i) => ({
        cand,
        score: typeof res.scores[i] === "number" ? res.scores[i]! : (cand.score ?? 0),
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.map(({ cand, score }) => ({ ...cand, score }));
    } catch (err) {
      log.warn("remote rerank failed, falling back to original order", {
        error: (err as Error).message,
      });
      return candidates;
    }
  }
}

let singleton: Reranker | null = null;

/**
 * Build a REAL cross-encoder reranker, bypassing both `RAG_RERANK` and the
 * process singleton — the in-process Xenova one, or the sidecar-backed remote one
 * when `EMBEDDINGS_MODE=sidecar`, exactly as {@link getReranker} would choose.
 *
 * Issue #1158 added this for the eval harness, which has to score a rerank-ON arm
 * and a rerank-OFF arm **in one process**. Flipping `RAG_RERANK` to get the ON arm
 * would silently turn the OFF arm on too — the OFF arm is production's default and
 * must keep reading the default. So the ON arm names its reranker explicitly and
 * the process-wide flag is left alone.
 *
 * This is NOT a way to switch reranking on in production: production reads
 * {@link getReranker}, which still gates on `RAG_RERANK`.
 */
export function createCrossEncoderReranker(opts: RerankerOptions = {}): Reranker {
  return resolveEmbeddingsMode() === "sidecar"
    ? new RemoteReranker(opts, getEmbeddingsClient())
    : new XenovaCrossEncoderReranker(opts);
}

/**
 * Returns the active reranker. When `RAG_RERANK` is unset, returns a no-op
 * implementation that simply forwards the input. When the embeddings sidecar
 * is enabled, returns a `RemoteReranker` that calls `POST /rerank` instead of
 * loading the cross-encoder in-process.
 */
export function getReranker(opts: RerankerOptions = {}): Reranker {
  if (singleton) return singleton;
  singleton = isRerankEnabled() ? createCrossEncoderReranker(opts) : new NoopReranker();
  return singleton;
}

/** Test seam — drop the singleton so each test file picks up env changes. */
export function __resetRerankerSingleton(): void {
  singleton = null;
}

/** Test helper — install a custom reranker (e.g. a deterministic stub). */
export function __setRerankerForTests(r: Reranker | null): void {
  singleton = r;
}
