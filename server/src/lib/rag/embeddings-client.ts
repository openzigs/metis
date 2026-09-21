/**
 * HTTP client for the `metis-embeddings` sidecar service.
 *
 * This module is the only place in the server that knows how to call the
 * sidecar. `embedder.ts` and `reranker.ts` route through here when
 * `EMBEDDINGS_MODE=sidecar` (the default in production); tests and offline
 * mode keep using the in-process backends.
 *
 * Resilience:
 *   - Per-request timeout (default 60 s — model cold-starts can take ~30 s)
 *   - Bounded retry on transient errors (network errors + 5xx)
 *   - 401 / 503 fail loudly — they indicate config drift, not transient flakiness
 */
import { request as undiciRequest } from "undici";
import { DEFAULT_EMBED_DIMENSION, DEFAULT_XENOVA_EMBED_MODEL } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { MAX_EMBED_TEXTS_PER_REQUEST, type EmbedPooling } from "./embed-model-config.js";

const log = createChildLogger("embeddings-client");

const DEFAULT_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

export interface EmbedResponse {
  vectors: number[][];
  model: string;
  dimension: number;
  /** Issue #782 — echoed back by the sidecar. Absent on pre-#782 sidecars. */
  pooling?: EmbedPooling;
  /** Issue #782 — echoed back by the sidecar. Absent on pre-#782 sidecars. */
  dtype?: string;
}

export interface RerankCandidatePayload {
  chunkId: string;
  text: string;
}

export interface RerankResponse {
  scores: number[];
  model: string;
}

export interface EmbeddingsClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export class EmbeddingsClientError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "EmbeddingsClientError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class EmbeddingsClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(opts: EmbeddingsClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.EMBEDDINGS_URL ?? "http://embeddings:5050";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const token = opts.token ?? process.env.EMBEDDINGS_TOKEN ?? "";
    if (!token) {
      throw new Error(
        "EMBEDDINGS_TOKEN is required when EMBEDDINGS_MODE=sidecar — refusing to start the client without a shared secret.",
      );
    }
    this.token = token;
    /**
     * 120 s, raised from 60 s in #786 — this bounds ONE ≤64-text post, and 60 s
     * did not cover a full one on a CPU-throttled pod.
     *
     * The arithmetic (REASONED from one MEASURED datapoint — 11.5 s of CPU for a
     * single 8192-token row; nobody has run this on cluster hardware): METIS's
     * default chunk is `DEFAULT_RAG_CHUNK_SIZE` = 2048 chars ≈ 512 tokens ≈ 1/16
     * of the model's 8192-token context. Scaling linearly in sequence length —
     * which OVER-states the cost, since attention is quadratic — a full 64-chunk
     * batch is ~64 × 11.5/16 ≈ 46 CPU-seconds. Under node contention CFS throttles
     * the sidecar toward its CPU *request*, so the wall clock is:
     *
     *     250m  → ~184 s   (the old chart request: blows any sane timeout)
     *     1000m → ~46 s    (the chart request now)
     *     2000m → ~23 s    (values-prod, Guaranteed QoS: requests == limits)
     *
     * 120 s therefore leaves ~2.6× headroom at the chart's CPU request instead of
     * the ~1.3× that 60 s left — and the failure it prevents is the one actually
     * likely in production: a *timeout*, on a pod nowhere near its memory limit.
     * Raising this is not a licence to under-provision CPU; both were fixed.
     */
    this.timeoutMs = Math.max(
      1_000,
      opts.timeoutMs ?? (Number(process.env.EMBEDDINGS_TIMEOUT_MS) || 120_000),
    );
    this.maxAttempts = Math.max(
      1,
      opts.maxAttempts ?? (Number(process.env.EMBEDDINGS_MAX_ATTEMPTS) || 3),
    );
  }

  /**
   * Embed `texts` on the sidecar.
   *
   * `pooling` (issue #782) is an OPTIONAL, additive request field: when omitted
   * the sidecar resolves it from its own per-model map, so this stays wire-
   * compatible with a pre-#782 sidecar (which simply ignores the extra key).
   *
   * ## Chunking (issue #786)
   *
   * The sidecar caps `/embed` at {@link MAX_EMBED_TEXTS_PER_REQUEST} texts and
   * 400s above it, because peak memory there scales with `batch × context` and
   * the default model's context is 8192 tokens. The callers, however, pass whole
   * work units: `knowledge-service` ingests a document by handing over EVERY
   * chunk of it in one call, and its reindex path batches at 128. Neither knows
   * — nor should know — the sidecar's HTTP limit.
   *
   * So the split happens HERE, in the one module that owns that contract: the
   * request is sliced into ≤64-text posts and the vectors are concatenated back
   * in order. Callers keep their existing "one call, one vector per text"
   * contract; the memory bound is still enforced where it matters, on the wire.
   *
   * Sequential, not parallel, on purpose: firing N concurrent posts at ONE
   * sidecar pod would put all N batches in its arena simultaneously and recreate
   * exactly the memory spike the cap exists to prevent.
   */
  async embed(texts: string[], model?: string, pooling?: EmbedPooling): Promise<EmbedResponse> {
    if (texts.length === 0) {
      return {
        vectors: [],
        model: model ?? DEFAULT_XENOVA_EMBED_MODEL,
        dimension: DEFAULT_EMBED_DIMENSION,
      };
    }
    if (texts.length <= MAX_EMBED_TEXTS_PER_REQUEST) {
      return this.post<EmbedResponse>("/embed", { texts, model, pooling });
    }

    log.debug("splitting oversized embed request to respect the sidecar batch cap", {
      texts: texts.length,
      cap: MAX_EMBED_TEXTS_PER_REQUEST,
    });

    const vectors: number[][] = [];
    let last: EmbedResponse | null = null;
    for (let i = 0; i < texts.length; i += MAX_EMBED_TEXTS_PER_REQUEST) {
      const slice = texts.slice(i, i + MAX_EMBED_TEXTS_PER_REQUEST);
      const res = await this.post<EmbedResponse>("/embed", { texts: slice, model, pooling });
      if (res.vectors.length !== slice.length) {
        throw new EmbeddingsClientError(
          `embeddings sidecar returned ${res.vectors.length} vectors for ${slice.length} texts — ` +
            "refusing to mis-align vectors with their chunks.",
          0,
          false,
        );
      }
      /**
       * Every slice must come back from the SAME vector space.
       *
       * The slices are separate HTTP posts to a ClusterIP Service, so a rolling
       * update can load-balance them across two pods running DIFFERENT models —
       * slices 1–2 embedded by the old model, slice 3 by the new one. Without
       * this check we would concatenate them and return the vectors under the
       * LAST slice's `model`/`dimension` label: an array that is internally
       * inhomogeneous but advertises itself as homogeneous, written into the
       * store as if it were one space. Every distance computed against it is
       * then quietly meaningless, and nothing anywhere would surface it.
       *
       * `maxUnavailable: 0` plus the model lockstep in #784 make this unlikely.
       * "Unlikely" is not the standard for vector-store integrity — same reason
       * the length check above exists.
       */
      if (last && (res.model !== last.model || res.dimension !== last.dimension)) {
        throw new EmbeddingsClientError(
          "embeddings sidecar changed model/dimension mid-batch " +
            `(${last.model}/${last.dimension} → ${res.model}/${res.dimension}) — ` +
            "refusing to mix vector spaces in one result.",
          0,
          false,
        );
      }
      vectors.push(...res.vectors);
      last = res;
    }
    // `last` is non-null: texts.length > cap >= 1 guarantees at least one slice.
    return { ...(last as EmbedResponse), vectors };
  }

  async rerank(
    query: string,
    candidates: RerankCandidatePayload[],
    model?: string,
  ): Promise<RerankResponse> {
    if (candidates.length === 0) {
      return { scores: [], model: model ?? DEFAULT_RERANK_MODEL };
    }
    return this.post<RerankResponse>("/rerank", { query, candidates, model });
  }

  async healthz(): Promise<{ status: string; tokenConfigured: boolean }> {
    const url = `${this.baseUrl}/healthz`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.min(this.timeoutMs, 5_000));
    try {
      const res = await undiciRequest(url, { method: "GET", signal: ac.signal });
      const body = (await res.body.json()) as { status: string; tokenConfigured: boolean };
      return body;
    } finally {
      clearTimeout(t);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await undiciRequest(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        clearTimeout(t);
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
          return (await res.body.json()) as T;
        }
        // Drain body for diagnostics.
        const text = await res.body.text();
        const retryable = status >= 500 && status !== 501;
        if (retryable && attempt < this.maxAttempts) {
          log.warn("embeddings sidecar returned retryable status", {
            status,
            attempt,
            path,
            preview: text.slice(0, 200),
          });
          await delay(backoffMs(attempt));
          continue;
        }
        throw new EmbeddingsClientError(
          `embeddings sidecar ${path} returned ${status}: ${text.slice(0, 200)}`,
          status,
          retryable,
        );
      } catch (err) {
        clearTimeout(t);
        if (err instanceof EmbeddingsClientError) throw err;
        lastError = err;
        if (attempt < this.maxAttempts) {
          log.warn("embeddings sidecar request failed, retrying", {
            attempt,
            path,
            error: (err as Error).message,
          });
          await delay(backoffMs(attempt));
          continue;
        }
      }
    }
    throw new EmbeddingsClientError(
      `embeddings sidecar ${path} failed after ${this.maxAttempts} attempts: ${(lastError as Error)?.message ?? "unknown"}`,
      0,
      true,
    );
  }
}

function backoffMs(attempt: number): number {
  return Math.min(2_000, 200 * 2 ** (attempt - 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let singleton: EmbeddingsClient | null = null;

export function getEmbeddingsClient(): EmbeddingsClient {
  if (!singleton) singleton = new EmbeddingsClient();
  return singleton;
}

export function __resetEmbeddingsClientSingleton(): void {
  singleton = null;
}

/**
 * Mode selection helper. Returns `"sidecar"` when the server should call the
 * remote service, `"in-process"` otherwise.
 *
 * Defaults:
 *   - tests (`NODE_ENV=test` or `VITEST`)              → in-process
 *   - offline mode (`AI_OFFLINE=1`)                    → in-process
 *   - production (`NODE_ENV=production`)               → sidecar
 *   - everything else                                  → in-process
 *
 * Explicit `EMBEDDINGS_MODE=sidecar | in-process` always wins.
 */
export function resolveEmbeddingsMode(): "sidecar" | "in-process" {
  const explicit = process.env.EMBEDDINGS_MODE?.trim().toLowerCase();
  if (explicit === "sidecar" || explicit === "in-process") return explicit;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return "in-process";
  if (process.env.AI_OFFLINE === "1" || process.env.AI_OFFLINE === "true") return "in-process";
  if (process.env.NODE_ENV === "production") return "sidecar";
  return "in-process";
}
