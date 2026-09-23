/**
 * Core types for the METIS AI engine.
 *
 * Two provider implementations live behind the {@link AIProvider} interface
 * (`copilot-native`, `bedrock-gateway`) plus an offline deterministic stub
 * used when `AI_OFFLINE=1` or no SDK is reachable. Keeping the surface tiny
 * lets routes/middleware speak one shape regardless of backend.
 */
import type { z } from "zod";
import type { ProviderCapabilities } from "./capabilities.js";

export type {
  CapabilityName,
  CapabilityProbeTarget,
  ProviderCapabilities,
} from "./capabilities.js";
export {
  NO_PROVIDER_CAPABILITIES,
  providerSupports,
  supportsResponseFormat,
} from "./capabilities.js";

/** OpenAI-style chat role. */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Coarse workload tag for prompt-cache hit-ratio telemetry (#390). Threaded
 * from the known call sites so the in-process aggregator can break the
 * cache-hit ratio down by workload. `"unknown"` is the default for any call
 * that does not set it. This is purely an observability label — it never
 * changes request behaviour.
 */
export type CacheTelemetryCallType =
  | "agent-loop"
  | "synthesis"
  | "grounding"
  // #701 — claim extraction is broken out of the shared "grounding" bucket so its
  // real input:output ratio and cache-hit rate surface distinctly in the #699
  // admin telemetry endpoint, validating the cached-Sonnet-vs-Haiku decision.
  | "claim-extraction"
  | "chat"
  | "discussion"
  | "spec-kit"
  | "unknown";

// ── Multimodal content blocks (#660) ───────────────────────────────────

/** Text content part — always present in multimodal messages. */
export interface ChatContentPartText {
  type: "text";
  text: string;
}

/** Image content part — base64 data URI or remote URL. */
export interface ChatContentPartImage {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

/** Union of supported content part types. */
export type ChatContentPart = ChatContentPartText | ChatContentPartImage;

/**
 * Extract the plain-text representation of a message's content.
 * When `content` is a string, returns it directly. When it's a content
 * block array, concatenates all `text` parts (images are ignored).
 */
export function messageText(msg: Pick<ChatMessage, "content">): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((p): p is ChatContentPartText => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export interface ChatMessage {
  role: ChatRole;
  /** String for text-only messages, or an array of content blocks for multimodal. */
  content: string | ChatContentPart[];
  /** Tool name when role === "tool". */
  name?: string;
  /** Tool-call id correlating the response to the request. */
  toolCallId?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Bedrock prompt-cache accounting (R-C2) — defaults to 0 when unsupported. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * #1257 — extended-thinking spend, when the provider reports it. Already
   * INCLUDED in {@link completionTokens}; it is broken out because it is drawn
   * from the same `max_tokens` budget as the answer and varies 5,088–9,763 run
   * to run on `claude-sonnet-5`, which is what makes a cap sized against the
   * expected payload wrong by roughly half.
   *
   * `undefined` means the provider reported nothing — never "it did not think".
   */
  thinkingTokens?: number;
}

export interface ChatResponse {
  content: string;
  usage: TokenUsage;
  model: string;
  provider: ProviderKey;
  /** Sentinel — when `true`, the response is a deterministic offline stub. */
  offline?: boolean;
  /**
   * #1217 — why the model stopped, verbatim from the upstream API (e.g.
   * `"stop"`, `"length"`). `"length"` is the tell that an output cap truncated
   * the answer, which is otherwise indistinguishable from a malformed one.
   * Optional: most adapters do not surface it, so treat absence as unknown.
   */
  finishReason?: string;
}

export type ChatChunk =
  | { type: "delta"; content: string }
  | { type: "tool_call"; name: string; arguments: unknown; toolCallId?: string }
  | { type: "usage"; usage: TokenUsage }
  /**
   * Terminal chunk. `finishReason` (#1226) is the streaming counterpart of
   * {@link ChatResponse.finishReason} — verbatim from the upstream API (e.g.
   * `"stop"`, `"length"`, `"max_tokens"`). Without it a streamed answer cut off
   * at the output cap is indistinguishable from one that finished cleanly.
   * Optional: adapters that cannot surface it simply omit it.
   */
  | { type: "done"; finishReason?: string };

/**
 * OpenAI-compatible `response_format: { type: "json_schema", ... }` payload
 * (#336). Requesting this constrains a compatible runtime (OpenAI ≥ 2024-08,
 * vLLM ≥ 0.8.5 via its xgrammar/guidance structured-output backend) to emit
 * output that validates against `schema` — the model literally cannot produce
 * unparseable structure.
 *
 * METIS uses this ONLY on the local/vLLM path and ONLY behind a flag; runtimes
 * that don't recognise the field (some Ollama / LM Studio builds) reject the
 * request, and the OpenAICompatibleProvider transparently RETRIES without it so
 * the existing free-form + `extractFirstJson` repair path still runs (graceful
 * degradation — never a hard failure). See
 * https://docs.vllm.ai/en/latest/features/structured_outputs/ and
 * https://developers.openai.com/api/docs/guides/structured-outputs.
 */
export interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    /** Descriptive identifier for the schema (required by both APIs). */
    name: string;
    /** Optional human-readable context about the schema. */
    description?: string;
    /** A JSON Schema object describing the required output shape. */
    schema: Record<string, unknown>;
    /**
     * OpenAI strict mode: guarantees the output matches the schema exactly
     * (requires `additionalProperties: false` + every property in `required`).
     * vLLM currently ignores this field but tolerates its presence, so it is
     * safe to send. Only enable it for schemas that satisfy the strict rules.
     */
    strict?: boolean;
  };
}

export interface ChatOptions {
  /** Override the provider/session default model. */
  model?: string;
  /** Optional system message prepended to the conversation. */
  systemMessage?: string;
  /** Conversation/session id — persists state across calls per provider. */
  sessionId?: string;
  /** Cancellation signal. Providers MUST honour it and stop work cleanly. */
  signal?: AbortSignal;
  /** Per-request reasoning effort hint for SDKs that support it. */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  /**
   * #25 — turn the model's thinking OFF for this request. Honoured by the
   * native Anthropic provider as `thinking: { type: "disabled" }` (which also
   * drops any `reasoningEffort`) — the documented toggle on both the Anthropic
   * Messages API and DeepSeek's Anthropic-compatible endpoint. Other providers
   * ignore it. Distinct from the local provider's constructor-level
   * `disableThinking` (Ollama `think: false`).
   */
  disableThinking?: boolean;
  /**
   * Issue #113 — extra directories the provider should scan for `SKILL.md`
   * files (Copilot SDK `skillDirectories`). Phase 10 materialises loaded
   * library skills under `<copilotHome>/skills/` and forwards that path.
   * Other providers may ignore this option.
   */
  skillDirectories?: string[];
  /**
   * Issue #113 — skill keys the provider should NOT load even if present
   * on disk (Copilot SDK `disabledSkills`). Mirrors per-project
   * `ProjectSkillAllowlist` rows where `enabled = false`.
   */
  disabledSkills?: string[];
  /**
   * When true, no tools are exposed to the model for this session. Useful
   * for pure text-synthesis calls (e.g. doc generation) where the model
   * would otherwise be tempted to call file/search tools instead of
   * producing prose from the supplied context. Maps to the Copilot SDK
   * `availableTools: []` setting.
   */
  disableTools?: boolean;
  /**
   * Hint to the provider to enable prompt caching for parts of the request.
   * Cache hits are reported via `usage.cacheReadTokens` (writes via
   * `usage.cacheWriteTokens`).
   *
   *   • `system`   — cache the (stable) system prefix.
   *   • `messages` — cache the large stable prefix in the last user turn.
   *
   * Honoured by:
   *   - BedrockDirectProvider — maps to bedrock-access-gateway's `extra_body`
   *     `{ prompt_caching: { system, messages } }`.
   *   - AnthropicProvider (native, official SDK) — sets `cache_control:
   *     { type: "ephemeral" }` on the system content block (`system`) and/or
   *     the last user content block (`messages`). Prompt caching is GA, so no
   *     beta header is needed for current Claude models.
   *
   * Requires the cached portion to meet the backend's minimum cacheable size
   * (~1,024 tokens for Sonnet); smaller blocks silently bypass caching — a
   * harmless no-op. Cache TTL is 5 minutes and resets on every hit.
   *
   * The CopilotProvider / OpenAI-compatible SDK path ignores it (no hook to
   * forward the directive). For chat/stream routes on Bedrock, caching is
   * handled at the gateway level via `ENABLE_PROMPT_CACHING=true` on the
   * bedrock-access-gateway container (#656).
   */
  promptCaching?: { system?: boolean; messages?: boolean };
  /**
   * Coarse call-site tag used ONLY to attribute prompt-cache hit-ratio
   * telemetry (#390) to a workload. It does NOT change request behaviour.
   * The OpenAICompatibleProvider stamps each call's `cacheReadTokens` /
   * `promptTokens` emission with this tag and the model ID so the in-process
   * aggregator can break the hit ratio down by workload. Defaults to
   * `"unknown"` when the caller does not set it. See
   * {@link CacheTelemetryCallType}.
   */
  callType?: CacheTelemetryCallType;
  /**
   * Override the provider's default `max_tokens` for this call. Useful
   * for long-form synthesis (e.g. doc generation) where the default 4K
   * cap would truncate output.
   */
  maxTokens?: number;
  /**
   * Per-call sampling overrides (OpenAI-spec). Honoured by the
   * OpenAICompatibleProvider; other providers may ignore them. Used by
   * docs-gen to tune local models (e.g. Gemma) for factual writing without
   * affecting the gateway/Bedrock defaults. #116.
   */
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  /**
   * #336 — request schema-constrained ("structured") output. Honoured ONLY by
   * the OpenAICompatibleProvider (a.k.a. BedrockDirectProvider — one class,
   * two exported names), which sends it as the OpenAI-compatible
   * `response_format` request field so a vLLM (xgrammar) / OpenAI runtime
   * decodes JSON that validates against the schema.
   *
   * That provider degrades gracefully: if the runtime rejects the field with a
   * client error (e.g. an Ollama build that does not support it), the call is
   * retried ONCE without `response_format` and logged once, so the caller's
   * existing free-form JSON parse/repair path still runs. Undefined = unchanged
   * request (the default), so no existing behaviour is affected.
   *
   * **#1115 — every OTHER adapter DROPS this option.** The Anthropic Messages
   * API, the Copilot SDK (neither 0.2.2 nor 1.0.8) and the offline stub have no
   * equivalent field, so supplying a schema there yields unconstrained text.
   * Do not guess which provider you are on — probe first:
   *
   * ```ts
   * if (supportsResponseFormat(provider)) opts.responseFormat = SCHEMA;
   * // else: keep the parse-and-repair path
   * ```
   *
   * Adapters that drop it log a one-time warning naming the provider, so the
   * loss is visible in the logs even when the caller does not probe. See
   * {@link ProviderCapabilities}.
   */
  responseFormat?: JsonSchemaResponseFormat;
}

export interface EmbedResult {
  /** Each row is one input text encoded as a unit-length float vector. */
  vectors: number[][];
  /** Length of every vector — stable for a given embedding model. */
  dimension: number;
  model: string;
}

/** Risk classification for tool gating. */
export type RiskLevel = "low" | "medium" | "high";

/** Per-risk decision policy applied to tool invocations in a session. */
export type RiskPolicy = "auto" | "prompt-once" | "always-prompt" | "deny";

export interface ApprovalPolicy {
  low: RiskPolicy;
  medium: RiskPolicy;
  high: RiskPolicy;
}

export const DEFAULT_APPROVAL_POLICY: Readonly<ApprovalPolicy> = Object.freeze({
  low: "auto",
  medium: "prompt-once",
  high: "always-prompt",
});

export type ApprovalDecision = "approve" | "auto-approve" | "deny" | "expired" | "error";

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** Zod schema describing the tool's argument shape. */
  schema: TSchema;
  risk: RiskLevel;
  /**
   * Tool implementation. The signature is constrained to a `ToolContext` so
   * MCP/agent code can correlate audit entries back to the calling session.
   */
  exec: (args: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  sessionId: string;
  userId: string;
  /** Optional project scope for project-aware tools. */
  projectId?: string;
  /** Logger child — agents/tests inject one. */
  log?: {
    info: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
}

export interface ToolResult {
  /** Stringified payload returned to the model. */
  text: string;
  /** Optional structured payload preserved for the caller. */
  data?: unknown;
  isError?: boolean;
}

/** Provider implementations live in `providers/`. */
export type ProviderKey =
  | "copilot-native"
  | "bedrock-gateway"
  | "local-gemma"
  | "openai"
  | "azure"
  | "anthropic"
  | "offline-stub";

/**
 * #58 — the provider an EMBEDDING usage row is recorded under: `embed:` plus the
 * embedder registry key that ran (`embed:xenova`, `embed:bedrock`, …). A
 * namespace of its own, so an embedder key can never pick up an LLM provider's
 * price row (the `openai` embedder is not the `openai` chat provider).
 */
export type EmbeddingUsageProvider = `embed:${string}`;

/** Whose usage a token row records: an LLM provider, or an embedder (#58). */
export type UsageProvider = ProviderKey | EmbeddingUsageProvider;

export interface AIProvider {
  /** Stable provider identifier — surfaced in `ChatResponse`/audit. */
  readonly key: ProviderKey;
  /** Effective default model id when no per-call override is supplied. */
  readonly model: string;
  /** Returns `true` when this is a no-network deterministic stub. */
  readonly offline: boolean;
  /**
   * #1115 — which optional {@link ChatOptions} this adapter actually honours.
   *
   * Every adapter in `providers/` declares this. It is OPTIONAL on the
   * interface only so test doubles need not restate capabilities they never
   * exercise: an absent record reads as "supports nothing", which degrades to
   * the free-form path and can never over-promise. Read it through
   * {@link providerSupports} / {@link supportsResponseFormat}, never inline.
   */
  readonly capabilities?: ProviderCapabilities;

  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse>;
  stream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<ChatChunk>;
  embed(texts: string[]): Promise<EmbedResult>;
  models(): Promise<string[]>;

  /**
   * Lightweight reachability probe. Implementations should run with a
   * 1–2 second timeout so they can be called from `/readyz` without
   * stalling. Offline providers return `true` immediately.
   */
  ping(): Promise<boolean>;
}

// ── Epic #593 — Intelligent Model Selection & Routing ──────────────────

/** Reasoning depth classification for task profiling (#598). */
export type ReasoningDepth = "simple" | "moderate" | "complex";

/** Latency SLA for task profiling (#598). */
export type LatencySLA = "interactive" | "standard" | "background";

/** High-level task type classification (#598). */
export type TaskType =
  | "summarization"
  | "extraction"
  | "analysis"
  | "synthesis"
  | "cross-referencing"
  | "general";

/** Task profile produced by the TaskProfiler (#598). */
export interface TaskProfile {
  /**
   * Estimated total tokens, or `null` when no honest estimate is available
   * (issue #1095 — the pre-flight endpoint reports nothing rather than a
   * fabricated number when the project has no run history to learn from).
   */
  tokenEstimate: number | null;
  reasoningDepth: ReasoningDepth;
  latencySLA: LatencySLA;
  taskType: TaskType;
}

/** Model selection result from the ModelRouter (#599). */
export interface ModelSelection {
  modelId: string;
  modelName: string;
  rationale: string;
  /** `null` when the token estimate is unknown — cost is not invented (#1095). */
  estimatedCost: number | null;
  wasDowngraded: boolean;
}

/** User override for model selection (#599). */
export type ModelOverride = "auto" | "force-haiku" | "force-sonnet" | "force-fable" | "force-opus";
