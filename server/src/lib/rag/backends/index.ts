/**
 * Cloud embeddings backend registration barrel (Epic #930).
 *
 * Keeps the heavyweight / network-dependent backends out of the core
 * `embedder.ts` module body. `registerCloudBackends()` is idempotent — the
 * underlying `registerBackend` is itself idempotent, but we also guard so the
 * descriptors are only registered once even if called repeatedly (e.g. after a
 * registry clear in tests followed by a re-import).
 *
 *   bedrock      → Bedrock Access Gateway (OpenAI-shaped)   #932
 *   bedrock-sdk  → direct AWS SDK InvokeModel               #933
 *   openai       → OpenAI / Azure OpenAI                    #934
 */
import { isBackendRegistered, registerBackend } from "../embedder-registry.js";
import {
  bedrockGatewayFromEnv,
  DEFAULT_BEDROCK_EMBED_DIMENSION,
  DEFAULT_BEDROCK_EMBED_MODEL,
} from "./bedrock-gateway-embedder.js";
import {
  bedrockSdkFromEnv,
  DEFAULT_BEDROCK_SDK_DIMENSION,
  DEFAULT_BEDROCK_SDK_MODEL,
} from "./bedrock-sdk-embedder.js";
import {
  DEFAULT_OPENAI_EMBED_DIMENSION,
  DEFAULT_OPENAI_EMBED_MODEL,
  openAiFromEnv,
} from "./openai-embedder.js";

export function registerCloudBackends(): void {
  if (!isBackendRegistered("bedrock")) {
    registerBackend(
      "bedrock",
      (cfg) => bedrockGatewayFromEnv({ model: cfg.model, dimension: cfg.dimension }),
      {
        label: "Amazon Bedrock (Access Gateway)",
        description:
          "OpenAI-shaped Bedrock Access Gateway. Reuses the same gateway as the generative LLM path. Default amazon.titan-embed-text-v2:0.",
        requiresEgress: true,
        defaultModel: DEFAULT_BEDROCK_EMBED_MODEL,
        defaultDimension: DEFAULT_BEDROCK_EMBED_DIMENSION,
        offlineCapable: false,
      },
    );
  }

  if (!isBackendRegistered("bedrock-sdk")) {
    registerBackend(
      "bedrock-sdk",
      (cfg) => bedrockSdkFromEnv({ model: cfg.model, dimension: cfg.dimension }),
      {
        label: "Amazon Bedrock (AWS SDK)",
        description:
          "Direct Bedrock InvokeModel via the AWS SDK using native IAM credentials. Supports Titan + Cohere embedding families.",
        requiresEgress: true,
        defaultModel: DEFAULT_BEDROCK_SDK_MODEL,
        defaultDimension: DEFAULT_BEDROCK_SDK_DIMENSION,
        offlineCapable: false,
      },
    );
  }

  if (!isBackendRegistered("openai")) {
    registerBackend(
      "openai",
      (cfg) => openAiFromEnv({ model: cfg.model, dimension: cfg.dimension }),
      {
        label: "OpenAI / Azure OpenAI",
        description:
          "Generic OpenAI embeddings contract, including Azure OpenAI deployments (set EMBEDDINGS_OPENAI_API_VERSION). Default text-embedding-3-small.",
        requiresEgress: true,
        defaultModel: DEFAULT_OPENAI_EMBED_MODEL,
        defaultDimension: DEFAULT_OPENAI_EMBED_DIMENSION,
        offlineCapable: false,
      },
    );
  }
}
