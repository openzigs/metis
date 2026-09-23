/**
 * #58 — embedding usage is priced through the one price source, under the
 * embedder that ran, and every built-in embedding price is its vendor's
 * published price.
 *
 * Before #58 test-coverage embedding tokens were recorded on `offline-stub`
 * under the Claude Haiku model id, so `resolveRate` family-matched them to
 * Haiku 4.5's $1/MTok input price — another model's price.
 *
 * Embedding usage is recorded under `embed:<registry key>` (see
 * {@link embeddingUsageProvider}), a namespace of its own: an embedder key
 * (`openai`, …) must never pick up an LLM provider's row by accident.
 *
 * Sources (read 2026-09-22):
 *  - Amazon Titan Text Embeddings V2 (the `bedrock` and `bedrock-sdk`
 *    backends' default model): the AWS Price List API, offer `AmazonBedrock`,
 *    region us-east-1, publication 2026-09-17 — SKU
 *    `USE1-TitanEmbeddingV2-Text-input-tokens`, "$0.00002 per 1K tokens"
 *    (https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json).
 *  - OpenAI (the `openai` backend): https://developers.openai.com/api/docs/pricing,
 *    Standard tier — text-embedding-3-small $0.02, text-embedding-3-large $0.13,
 *    text-embedding-ada-002 $0.10 per 1M input tokens.
 *  - The in-process and in-cluster backends (`offline`, `xenova`,
 *    `embeddinggemma`, `sidecar`) run on METIS's own compute: no per-token charge.
 */
import { describe, expect, it } from "vitest";

import { ConfigService } from "../config/config-service.js";
import {
  __testRateKeys,
  DEFAULT_RATE,
  embeddingUsageProvider,
  resolveRate,
} from "./provider-rates.js";

const config = new ConfigService({ env: {}, vault: {} as never });

/** Published USD per 1M input tokens → the table's cents per 1k tokens. */
const centsPer1k = (usdPerMTok: number) => usdPerMTok / 10;

/** Every priced embedding row, pinned to its published input price. */
const PUBLISHED: Record<string, number> = {
  "embed:bedrock:amazon.titan-embed-text-v2:0": 0.02,
  "embed:bedrock-sdk:amazon.titan-embed-text-v2:0": 0.02,
  "embed:openai:text-embedding-3-small": 0.02,
  "embed:openai:text-embedding-3-large": 0.13,
  "embed:openai:text-embedding-ada-002": 0.1,
};

const LOCAL_BACKENDS = ["offline", "xenova", "embeddinggemma", "sidecar"];

describe("embedding prices (#58)", () => {
  it("namespaces embedding usage apart from LLM providers", () => {
    expect(embeddingUsageProvider("openai")).toBe("embed:openai");
    expect(embeddingUsageProvider("xenova")).toBe("embed:xenova");
  });

  it.each(Object.entries(PUBLISHED))("%s is its published price", (key, usdPerMTok) => {
    const sep = key.indexOf(":", "embed:".length);
    const rate = resolveRate(key.slice(0, sep), key.slice(sep + 1), { config });
    expect(rate).not.toBeNull();
    expect(rate!.inputPer1k).toBeCloseTo(centsPer1k(usdPerMTok), 12);
    // An embedding call has no output tokens and no prompt cache.
    expect(rate!.outputPer1k).toBe(0);
    expect(rate!.cacheReadPer1k).toBeUndefined();
    expect(rate!.cacheWritePer1k).toBeUndefined();
  });

  it("every embedding row is pinned here, and no pinned row is missing", () => {
    const rows = __testRateKeys().filter((k) => k.startsWith("embed:"));
    const local = LOCAL_BACKENDS.map((b) => `embed:${b}:default`);
    expect(rows.sort()).toEqual([...Object.keys(PUBLISHED), ...local].sort());
  });

  it.each(LOCAL_BACKENDS)(
    "the local %s backend costs nothing per token, whatever the model",
    (b) => {
      expect(resolveRate(embeddingUsageProvider(b), "any-local-model", { config })).toBe(
        DEFAULT_RATE,
      );
    },
  );

  it("a cloud embedding model with no published row is unpriced, never another model's price", () => {
    expect(
      resolveRate(embeddingUsageProvider("bedrock-sdk"), "cohere.embed-english-v3", { config }),
    ).toBeNull();
    // An Azure deployment name is not a model id METIS can price.
    expect(resolveRate(embeddingUsageProvider("openai"), "my-embeddings", { config })).toBeNull();
    // A backend registered later has no row until someone adds one.
    expect(resolveRate(embeddingUsageProvider("acme-cloud"), "acme-embed", { config })).toBeNull();
  });

  it("an embedder key never picks up an LLM provider's row", () => {
    // `openai:gpt-4o` is an LLM row; the `openai` embedder must not see it.
    expect(resolveRate("openai", "gpt-4o", { config })).not.toBeNull();
    expect(resolveRate(embeddingUsageProvider("openai"), "gpt-4o", { config })).toBeNull();
  });

  it("an administrator's price for an embedding model is honoured", () => {
    const withPrice = new ConfigService({
      env: {
        MODEL_PRICES: JSON.stringify({
          "embed:bedrock-sdk:cohere.embed-english-v3": { inputPerMTok: 0.1, outputPerMTok: 0 },
        }),
      },
      vault: {} as never,
    });
    const rate = resolveRate(embeddingUsageProvider("bedrock-sdk"), "cohere.embed-english-v3", {
      config: withPrice,
    });
    expect(rate?.inputPer1k).toBeCloseTo(0.01, 12);
  });
});
