/**
 * Generic OpenAI / Azure OpenAI embeddings backend (Epic #930 / issue #934).
 *
 * Covers any provider that speaks the OpenAI embeddings contract:
 *
 *   - OpenAI / OpenAI-compatible:
 *       POST ${EMBEDDINGS_OPENAI_BASE_URL}/embeddings
 *       Authorization: Bearer ${EMBEDDINGS_OPENAI_API_KEY}
 *       { "model": "text-embedding-3-small", "input": [...] }
 *
 *   - Azure OpenAI (when EMBEDDINGS_OPENAI_API_VERSION is set):
 *       POST ${base}/openai/deployments/${model}/embeddings?api-version=${ver}
 *       api-key: ${EMBEDDINGS_OPENAI_API_KEY}
 *       { "input": [...] }
 *
 * `requiresEgress` is true.
 */
import { createChildLogger } from "../../logger.js";
import type { EmbedBackend, EmbeddingResult } from "../embedder-registry.js";
import { parseOpenAiEmbeddings } from "./bedrock-gateway-embedder.js";
import { fetchJsonWithRetry, type FetchLike } from "./http.js";

const log = createChildLogger("rag-embedder-openai");

export const DEFAULT_OPENAI_EMBED_MODEL = "text-embedding-3-small";
export const DEFAULT_OPENAI_EMBED_DIMENSION = 1536;

export interface OpenAiEmbedderConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  dimension?: number;
  /** Azure OpenAI api-version; when set, the Azure URL + header shape is used. */
  apiVersion?: string;
  maxAttempts?: number;
  fetchImpl?: FetchLike;
  backoffMs?: number;
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  model?: string;
}

export class OpenAiEmbedder implements EmbedBackend {
  readonly key = "openai";
  readonly model: string;
  readonly dimension: number;
  readonly requiresEgress = true;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVersion: string | undefined;
  private readonly maxAttempts: number;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly backoffMs: number | undefined;

  constructor(cfg: OpenAiEmbedderConfig) {
    if (!cfg.baseUrl) {
      throw new Error("EMBEDDINGS_OPENAI_BASE_URL is required for the openai embeddings backend");
    }
    if (!cfg.apiKey) {
      throw new Error("EMBEDDINGS_OPENAI_API_KEY is required for the openai embeddings backend");
    }
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? DEFAULT_OPENAI_EMBED_MODEL;
    this.dimension = cfg.dimension ?? DEFAULT_OPENAI_EMBED_DIMENSION;
    this.apiVersion = cfg.apiVersion;
    this.maxAttempts = cfg.maxAttempts ?? 3;
    this.fetchImpl = cfg.fetchImpl;
    this.backoffMs = cfg.backoffMs;
  }

  get isAzure(): boolean {
    return Boolean(this.apiVersion);
  }

  async warm(): Promise<void> {
    await this.embed(["healthcheck"]);
  }

  async healthy(): Promise<boolean> {
    try {
      await this.embed(["healthcheck"]);
      return true;
    } catch (err) {
      log.warn("openai embeddings health probe failed", { error: (err as Error).message });
      return false;
    }
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], model: this.model, dimension: this.dimension };
    }
    const { url, headers, body } = this.buildRequest(texts);
    const json = await fetchJsonWithRetry<OpenAiEmbeddingResponse>({
      backend: this.key,
      url,
      maxAttempts: this.maxAttempts,
      fetchImpl: this.fetchImpl,
      backoffMs: this.backoffMs,
      init: { method: "POST", headers, body },
    });
    const vectors = parseOpenAiEmbeddings(json, texts.length, this.key);
    return {
      vectors,
      model: json.model || this.model,
      dimension: vectors[0]?.length ?? this.dimension,
    };
  }

  private buildRequest(texts: string[]): {
    url: string;
    headers: Record<string, string>;
    body: string;
  } {
    if (this.isAzure) {
      return {
        url: `${this.baseUrl}/openai/deployments/${encodeURIComponent(this.model)}/embeddings?api-version=${this.apiVersion}`,
        headers: { "Content-Type": "application/json", "api-key": this.apiKey },
        body: JSON.stringify({ input: texts }),
      };
    }
    return {
      url: `${this.baseUrl}/embeddings`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    };
  }
}

export function openAiFromEnv(cfg: { model?: string; dimension?: number }): OpenAiEmbedder {
  const baseUrl = process.env.EMBEDDINGS_OPENAI_BASE_URL ?? "";
  const apiKey = process.env.EMBEDDINGS_OPENAI_API_KEY ?? "";
  const apiVersion = process.env.EMBEDDINGS_OPENAI_API_VERSION;
  const dimension =
    cfg.dimension ?? (process.env.EMBED_DIM ? Number(process.env.EMBED_DIM) : undefined);
  return new OpenAiEmbedder({
    baseUrl,
    apiKey,
    apiVersion,
    model: cfg.model ?? process.env.EMBED_MODEL ?? DEFAULT_OPENAI_EMBED_MODEL,
    dimension: dimension !== undefined && Number.isFinite(dimension) ? dimension : undefined,
  });
}
