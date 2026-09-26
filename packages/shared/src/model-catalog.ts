/**
 * #135 — the model catalog wire shape, shared by `GET /api/ai/models` and every
 * UI model picker so the two can never disagree about what a model is.
 *
 * The server is the only author of these records (`server/src/lib/ai/model-catalog.ts`);
 * the UI renders them and never keeps a model list of its own.
 */

/** The per-model capability flags a picker (and the provider layer) reads. */
export interface ModelCatalogCapabilities {
  /** Native tool calls are sent to this model. */
  tools: boolean;
  /** `response_format: json_schema` (OpenAI) / `output_config.format` (Anthropic) is honoured. */
  jsonSchema: boolean;
  /** `response_format: json_object` is honoured. */
  jsonObject: boolean;
  /** Image input is accepted. */
  vision: boolean;
  /** The model has a thinking / reasoning mode. */
  thinking: boolean;
}

/**
 * Price in USD per million tokens — derived from the server's single pricing
 * source (`server/src/lib/finops/provider-rates.ts`). `null` on the entry means
 * UNPRICED, never free.
 */
export interface ModelCatalogPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

/**
 * Where an entry's facts came from; `override` wins over `discovered` wins over
 * `builtin`. `configured` marks the provider's configured default model when the
 * catalog knows nothing else about it (its facts are then `null`, never guessed).
 */
export type ModelCatalogSource = "builtin" | "configured" | "discovered" | "override";

export interface ModelCatalogEntry {
  /** Provider key (`anthropic`, `bedrock-gateway`, `local-gemma`, …). */
  provider: string;
  /** The id the provider is sent. */
  id: string;
  displayName: string;
  /** Context window in tokens; `null` when not known (never guessed). */
  contextWindow: number | null;
  /** Output ceiling in tokens; `null` when not known. */
  maxOutputTokens: number | null;
  price: ModelCatalogPrice | null;
  capabilities: ModelCatalogCapabilities;
  /** Set on the models the analysis ModelRouter can select, with their tier. */
  routerTier?: "fast" | "balanced" | "complex";
  source: ModelCatalogSource;
}

/** `GET /api/ai/models` response body (inside the `ApiResponse` envelope). */
export interface ModelCatalogResponse {
  /** The configured provider the list describes. */
  provider: string;
  /** The provider's configured default model id. */
  defaultModel: string;
  models: ModelCatalogEntry[];
}
