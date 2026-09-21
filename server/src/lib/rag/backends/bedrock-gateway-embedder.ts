/**
 * Bedrock Access Gateway embeddings backend (Epic #930 / issue #932).
 *
 * Talks to a self-hosted "Bedrock Access Gateway" that exposes an
 * OpenAI-compatible `/embeddings` surface in front of Amazon Bedrock. This is
 * the same gateway the generative LLM path already uses
 * (`BedrockDirectProvider`), so a deployment that already runs the gateway for
 * chat can reuse it for embeddings with zero new infrastructure.
 *
 *   POST ${BEDROCK_GATEWAY_URL}/embeddings
 *   Authorization: Bearer ${BEDROCK_GATEWAY_API_KEY}
 *   { "model": "amazon.titan-embed-text-v2:0", "input": ["text", ...] }
 *   → { "data": [ { "index": 0, "embedding": [...] }, ... ], "model": "..." }
 *
 * `requiresEgress` is true — the gateway is typically reachable over the
 * corporate network, but the request still leaves the application process.
 */
import { DEFAULT_EMBED_DIMENSION } from "@metis/shared";
import { createChildLogger } from "../../logger.js";
import type { EmbedBackend, EmbeddingResult } from "../embedder-registry.js";
import { fetchJsonWithRetry, type FetchLike } from "./http.js";

const log = createChildLogger("rag-embedder-bedrock");

/** Amazon Titan Text Embeddings V2 — 1024-dim by default. */
export const DEFAULT_BEDROCK_EMBED_MODEL = "amazon.titan-embed-text-v2:0";
export const DEFAULT_BEDROCK_EMBED_DIMENSION = 1024;

export interface BedrockGatewayEmbedderConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  dimension?: number;
  maxAttempts?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Base backoff in ms (tests pass 0 to avoid real delays). */
  backoffMs?: number;
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  model?: string;
}

export class BedrockGatewayEmbedder implements EmbedBackend {
  readonly key = "bedrock";
  readonly model: string;
  readonly dimension: number;
  readonly requiresEgress = true;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxAttempts: number;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly backoffMs: number | undefined;

  constructor(cfg: BedrockGatewayEmbedderConfig) {
    if (!cfg.baseUrl) {
      throw new Error("BEDROCK_GATEWAY_URL is required for the bedrock embeddings backend");
    }
    if (!cfg.apiKey) {
      throw new Error("BEDROCK_GATEWAY_API_KEY is required for the bedrock embeddings backend");
    }
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? DEFAULT_BEDROCK_EMBED_MODEL;
    this.dimension = cfg.dimension ?? DEFAULT_BEDROCK_EMBED_DIMENSION;
    this.maxAttempts = cfg.maxAttempts ?? 3;
    this.fetchImpl = cfg.fetchImpl;
    this.backoffMs = cfg.backoffMs;
  }

  async warm(): Promise<void> {
    // No cheap probe on the gateway — a 1-token embed validates connectivity
    // and credentials when an explicit health check is requested.
    await this.embed(["healthcheck"]);
  }

  async healthy(): Promise<boolean> {
    try {
      await this.embed(["healthcheck"]);
      return true;
    } catch (err) {
      log.warn("bedrock gateway health probe failed", { error: (err as Error).message });
      return false;
    }
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], model: this.model, dimension: this.dimension };
    }
    const json = await fetchJsonWithRetry<OpenAiEmbeddingResponse>({
      backend: this.key,
      url: `${this.baseUrl}/embeddings`,
      maxAttempts: this.maxAttempts,
      fetchImpl: this.fetchImpl,
      backoffMs: this.backoffMs,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      },
    });
    const vectors = parseOpenAiEmbeddings(json, texts.length, this.key);
    return {
      vectors,
      model: json.model || this.model,
      dimension: vectors[0]?.length ?? this.dimension,
    };
  }
}

/**
 * Parse + order an OpenAI-shaped embeddings payload. Shared with the OpenAI /
 * Azure backend (#934) since the gateway mirrors that contract.
 */
export function parseOpenAiEmbeddings(
  json: OpenAiEmbeddingResponse,
  expectedRows: number,
  backend: string,
): number[][] {
  if (!Array.isArray(json.data) || json.data.length === 0) {
    throw new Error(`${backend}: response contained no embeddings`);
  }
  const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = ordered.map((row) => {
    if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
      throw new Error(`${backend}: response row missing embedding vector`);
    }
    return row.embedding;
  });
  if (vectors.length !== expectedRows) {
    throw new Error(`${backend}: expected ${expectedRows} embeddings, received ${vectors.length}`);
  }
  return vectors;
}

/** Build the backend from environment variables. */
export function bedrockGatewayFromEnv(cfg: {
  model?: string;
  dimension?: number;
}): BedrockGatewayEmbedder {
  const baseUrl = process.env.BEDROCK_GATEWAY_URL ?? process.env.EMBEDDINGS_BEDROCK_URL ?? "";
  const apiKey =
    process.env.BEDROCK_GATEWAY_API_KEY ?? process.env.EMBEDDINGS_BEDROCK_API_KEY ?? "";
  const dimension =
    cfg.dimension ??
    (process.env.EMBED_DIM ? Number(process.env.EMBED_DIM) : undefined) ??
    DEFAULT_BEDROCK_EMBED_DIMENSION;
  return new BedrockGatewayEmbedder({
    baseUrl,
    apiKey,
    model: cfg.model ?? process.env.EMBED_MODEL ?? DEFAULT_BEDROCK_EMBED_MODEL,
    dimension: Number.isFinite(dimension) ? dimension : DEFAULT_EMBED_DIMENSION,
  });
}
