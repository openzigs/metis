/**
 * Direct AWS Bedrock embeddings backend via the AWS SDK (Epic #930 / #933).
 *
 * For deployments that have native AWS credentials (IAM role / instance
 * profile) and want to call Bedrock's `InvokeModel` directly without standing
 * up the Access Gateway. Supports both major embedding families:
 *
 *   - Amazon Titan  : request `{ inputText }`            → `{ embedding }`
 *   - Cohere Embed  : request `{ texts, input_type }`    → `{ embeddings }`
 *
 * The `@aws-sdk/client-bedrock-runtime` dependency is imported lazily through a
 * string-var dynamic import so it stays out of the typecheck/test path (it is
 * not a declared dependency). Tests inject an `invoke` function instead.
 *
 * `requiresEgress` is true (calls the AWS Bedrock public/VPC endpoint).
 */
import { createChildLogger } from "../../logger.js";
import type { EmbedBackend, EmbeddingResult } from "../embedder-registry.js";

const log = createChildLogger("rag-embedder-bedrock-sdk");

export const DEFAULT_BEDROCK_SDK_MODEL = "amazon.titan-embed-text-v2:0";
export const DEFAULT_BEDROCK_SDK_DIMENSION = 1024;

/** Minimal shape of an InvokeModel call result we depend on. */
export interface BedrockInvokeResult {
  body: Uint8Array | string;
}

/** Injected transport — given a modelId + JSON request body, returns the raw response body. */
export type BedrockInvoke = (modelId: string, body: string) => Promise<BedrockInvokeResult>;

export interface BedrockSdkEmbedderConfig {
  model?: string;
  dimension?: number;
  region?: string;
  /** "titan" (default) or "cohere" — controls request/response shape. */
  family?: "titan" | "cohere";
  /** Cohere only. */
  inputType?: string;
  maxAttempts?: number;
  /** Injected for tests; defaults to the lazily-loaded AWS SDK client. */
  invoke?: BedrockInvoke;
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BedrockSdkEmbedder implements EmbedBackend {
  readonly key = "bedrock-sdk";
  readonly model: string;
  readonly dimension: number;
  readonly requiresEgress = true;
  private readonly region: string | undefined;
  private readonly family: "titan" | "cohere";
  private readonly inputType: string;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private invoke: BedrockInvoke | null;

  constructor(cfg: BedrockSdkEmbedderConfig = {}) {
    this.model = cfg.model ?? process.env.EMBED_MODEL ?? DEFAULT_BEDROCK_SDK_MODEL;
    this.dimension = cfg.dimension ?? DEFAULT_BEDROCK_SDK_DIMENSION;
    this.region = cfg.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    this.family = cfg.family ?? (this.model.startsWith("cohere") ? "cohere" : "titan");
    this.inputType = cfg.inputType ?? "search_document";
    this.maxAttempts = cfg.maxAttempts ?? 3;
    this.backoffMs = cfg.backoffMs ?? 250;
    this.invoke = cfg.invoke ?? null;
  }

  async warm(): Promise<void> {
    await this.ensureInvoke();
  }

  async healthy(): Promise<boolean> {
    try {
      await this.embed(["healthcheck"]);
      return true;
    } catch (err) {
      log.warn("bedrock-sdk health probe failed", { error: (err as Error).message });
      return false;
    }
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], model: this.model, dimension: this.dimension };
    }
    const invoke = await this.ensureInvoke();
    const vectors: number[][] = [];

    if (this.family === "cohere") {
      // Cohere accepts the full batch in one request.
      const body = JSON.stringify({ texts, input_type: this.inputType });
      const parsed = await this.invokeWithRetry(invoke, body);
      const embeddings = (parsed as { embeddings?: number[][] }).embeddings;
      if (!Array.isArray(embeddings)) {
        throw new Error("bedrock-sdk(cohere): response missing 'embeddings' array");
      }
      vectors.push(...embeddings);
    } else {
      // Titan embeds one input at a time.
      for (const text of texts) {
        const body = JSON.stringify({ inputText: text });
        const parsed = await this.invokeWithRetry(invoke, body);
        const embedding = (parsed as { embedding?: number[] }).embedding;
        if (!Array.isArray(embedding)) {
          throw new Error("bedrock-sdk(titan): response missing 'embedding' array");
        }
        vectors.push(embedding);
      }
    }

    return { vectors, model: this.model, dimension: vectors[0]?.length ?? this.dimension };
  }

  private async invokeWithRetry(invoke: BedrockInvoke, body: string): Promise<unknown> {
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const res = await invoke(this.model, body);
        return JSON.parse(decodeBody(res.body));
      } catch (err) {
        lastErr = err as Error;
        const name = (err as { name?: string }).name ?? "";
        const retryable =
          name === "ThrottlingException" ||
          name === "ServiceUnavailableException" ||
          name === "ModelTimeoutException";
        if (retryable && attempt < this.maxAttempts) {
          await sleep(this.backoffMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("bedrock-sdk: invoke failed");
  }

  private async ensureInvoke(): Promise<BedrockInvoke> {
    if (this.invoke) return this.invoke;
    this.invoke = await this.loadSdkInvoke();
    return this.invoke;
  }

  private async loadSdkInvoke(): Promise<BedrockInvoke> {
    const moduleName = "@aws-sdk/client-bedrock-runtime";
    let sdk: {
      BedrockRuntimeClient: new (cfg: { region?: string }) => {
        send: (cmd: unknown) => Promise<{ body: Uint8Array }>;
      };
      InvokeModelCommand: new (input: {
        modelId: string;
        contentType: string;
        accept: string;
        body: string;
      }) => unknown;
    };
    try {
      sdk = (await import(moduleName)) as typeof sdk;
    } catch (err) {
      throw new Error(
        `Failed to import "@aws-sdk/client-bedrock-runtime": ${(err as Error).message}. ` +
          "Install the dependency to use EMBED_BACKEND=bedrock-sdk, or use EMBED_BACKEND=bedrock (gateway).",
      );
    }
    const client = new sdk.BedrockRuntimeClient({ region: this.region });
    return async (modelId, body) => {
      const cmd = new sdk.InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body,
      });
      const out = await client.send(cmd);
      return { body: out.body };
    };
  }
}

function decodeBody(body: Uint8Array | string): string {
  if (typeof body === "string") return body;
  return new TextDecoder().decode(body);
}

export function bedrockSdkFromEnv(cfg: { model?: string; dimension?: number }): BedrockSdkEmbedder {
  const dimension =
    cfg.dimension ?? (process.env.EMBED_DIM ? Number(process.env.EMBED_DIM) : undefined);
  return new BedrockSdkEmbedder({
    model: cfg.model ?? process.env.EMBED_MODEL ?? DEFAULT_BEDROCK_SDK_MODEL,
    dimension: dimension !== undefined && Number.isFinite(dimension) ? dimension : undefined,
  });
}
