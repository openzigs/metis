/**
 * Core types for the METIS AI engine.
 *
 * Every model backend implements the {@link AIProvider} contract (#131): the
 * OpenAI-compatible client (`local-gemma`, `bedrock-gateway`, `openai`,
 * `azure`), the Anthropic Messages client (`anthropic`), the Copilot SDK
 * adapter (`copilot-native`, removed in P4) and the offline deterministic stub.
 * The contract covers chat/stream, native tool calls, structured output,
 * cache-aware usage and per-model capabilities, so routes and middleware speak
 * one shape regardless of backend.
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
  resolveCapabilities,
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

// ── Native tool calls (#131) ───────────────────────────────────────────

/**
 * #131 — one tool the model may call, in the provider-neutral shape both wire
 * formats derive from: OpenAI-compatible `tools[].function` and Anthropic
 * `tools[]` (`input_schema`). `parameters` is a JSON Schema object describing
 * the arguments; it is forwarded verbatim, never interpreted here.
 */
export interface ChatToolSpec {
  name: string;
  description: string;
  /** JSON Schema (`{ type: "object", properties, required }`) for the arguments. */
  parameters: Record<string, unknown>;
}

/**
 * #131 — how the model may use {@link ChatOptions.tools}:
 *   • `"auto"`     — the model decides (the default when tools are supplied);
 *   • `"none"`     — tools are described but must not be called;
 *   • `"required"` — the model must call at least one tool;
 *   • `{ name }`   — the model must call exactly that tool.
 */
export type ChatToolChoice = "auto" | "none" | "required" | { name: string };

/**
 * #131 — a tool call the model made, parsed from the provider's NATIVE channel
 * (OpenAI `tool_calls`, Anthropic `tool_use`) — never scraped from prose.
 * `args` is the parsed JSON arguments object; when a runtime returns arguments
 * that are not valid JSON the raw string is kept so nothing is silently lost.
 */
export interface ChatToolCall {
  /** Provider-assigned id; echo it back as the tool result's `toolCallId`. */
  id: string;
  name: string;
  args: unknown;
}

/**
 * #198 — a provider's OWN content blocks for one assistant turn, kept opaque and
 * in their original order so a tool loop can replay the turn verbatim. The
 * Anthropic Messages API requires the assistant turn that issued `tool_use` to be
 * sent back with its `thinking` / `redacted_thinking` blocks (signature and all,
 * unmodified, in the order generated) when extended thinking is on. Only the
 * provider named here reads it; every other adapter ignores it, so a model switch
 * mid-conversation never sends one provider's blocks to another.
 */
export interface NativeAssistantContent {
  provider: "anthropic";
  blocks: unknown[];
}

export interface ChatMessage {
  /**
   * `"tool"` is the tool-RESULT role (#131): a message carrying the output of a
   * tool call, correlated by {@link toolCallId}. Providers serialise it as an
   * OpenAI `role: "tool"` message or an Anthropic `tool_result` block.
   */
  role: ChatRole;
  /** String for text-only messages, or an array of content blocks for multimodal. */
  content: string | ChatContentPart[];
  /** Tool name when role === "tool". */
  name?: string;
  /** Tool-call id correlating the response to the request. */
  toolCallId?: string;
  /**
   * #131 — on an `assistant` message: the tool calls that turn made. Replayed
   * to the provider so the following `tool` results have a call to answer —
   * both wire formats reject an orphaned tool result.
   */
  toolCalls?: ChatToolCall[];
  /** #131 — on a `tool` message: the tool failed (Anthropic `is_error`). */
  isError?: boolean;
  /**
   * #198 — on an `assistant` message: the provider's own blocks for this turn
   * (see {@link NativeAssistantContent}). Echo {@link ChatResponse.nativeContent}
   * here when replaying a tool-calling turn.
   */
  nativeContent?: NativeAssistantContent;
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
  /**
   * #131 — tool calls the model made on the provider's native channel, in the
   * order the model emitted them. Absent when the model called no tool.
   */
  toolCalls?: ChatToolCall[];
  /**
   * #198 — set only when the turn carried reasoning blocks that must be replayed
   * with its tool calls (Anthropic extended thinking). Copy it onto the
   * assistant {@link ChatMessage} of the next request.
   */
  nativeContent?: NativeAssistantContent;
}

export type ChatChunk =
  | { type: "delta"; content: string }
  /**
   * A tool call. #131 — a call from a provider's NATIVE channel always carries
   * `toolCallId` (the {@link ChatToolCall.id}) and `arguments` holds the parsed
   * {@link ChatToolCall.args}; `native: true` marks it. A chunk without
   * `native` was recovered from `<tool_call>` text by `tool-tag-parser.ts`.
   */
  | {
      type: "tool_call";
      name: string;
      arguments: unknown;
      toolCallId?: string;
      native?: boolean;
    }
  | { type: "usage"; usage: TokenUsage }
  /**
   * Terminal chunk. `finishReason` (#1226) is the streaming counterpart of
   * {@link ChatResponse.finishReason} — verbatim from the upstream API (e.g.
   * `"stop"`, `"length"`, `"max_tokens"`). Without it a streamed answer cut off
   * at the output cap is indistinguishable from one that finished cleanly.
   * Optional: adapters that cannot surface it simply omit it.
   */
  | {
      type: "done";
      finishReason?: string;
      /** #198 — the streaming counterpart of {@link ChatResponse.nativeContent}. */
      nativeContent?: NativeAssistantContent;
    };

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

/**
 * #117 — OpenAI-compatible JSON mode: the runtime guarantees a JSON object but
 * no particular shape, so the caller states the shape in the prompt. For local
 * runtimes that accept `json_schema` with HTTP 200 and then ignore it (measured:
 * `laguna-s-2.1` on Ollama 0.34.2 returns prose), yet honour `json_object`.
 */
export interface JsonObjectResponseFormat {
  type: "json_object";
}

/** Either `response_format` shape the OpenAI-compatible adapter forwards verbatim. */
export type ResponseFormat = JsonSchemaResponseFormat | JsonObjectResponseFormat;

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
   * Messages API and DeepSeek's Anthropic-compatible endpoint. The
   * `local-gemma` provider sends `think: false` + `reasoning_effort: "none"`
   * (and forwards `reasoningEffort` as `reasoning_effort`). Other providers
   * ignore it.
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
   *
   * Every provider reads this as "send NO tools" — the native-Anthropic and
   * OpenAI-compatible providers drop `tools` from the request when it is set.
   * Never set it on a call that carries METIS's own `tools`; to withhold only
   * the Copilot SDK's built-ins, use {@link withholdSdkBuiltinTools}.
   */
  disableTools?: boolean;
  /**
   * #142 — withhold the GitHub Copilot SDK's OWN built-in tools (shell, file
   * write, URL fetch, …) from the session and refuse every SDK permission
   * request, WITHOUT touching the caller's `tools`. Read only by the Copilot
   * provider; every other provider ignores it. Chat sessions set it on every
   * call: the only tools a chat may run are METIS's, through its approval gate.
   */
  withholdSdkBuiltinTools?: boolean;
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
   * #336 — request schema-constrained ("structured") output. Honoured by:
   *   • the OpenAICompatibleProvider (a.k.a. BedrockDirectProvider — one class,
   *     two exported names), which sends it as the OpenAI-compatible
   *     `response_format` field (`json_schema` or `json_object`) so a vLLM
   *     (xgrammar) / OpenAI runtime decodes JSON that validates against it;
   *   • #133 — the AnthropicProvider on the native endpoint, which sends a
   *     `json_schema` as `output_config.format` (`json_object` has no Messages
   *     API equivalent and is dropped).
   *
   * Both degrade gracefully: if the runtime rejects the field with a client
   * error (e.g. an Ollama build that does not support it), the call is retried
   * ONCE without it and logged, so the caller's existing free-form JSON
   * parse/repair path still runs. Undefined = unchanged request (the default).
   *
   * **#1115 — every other adapter DROPS this option**: the Copilot SDK (neither
   * 0.2.2 nor 1.0.8), DeepSeek's Anthropic-compatible endpoint (only `effort`
   * is accepted in `output_config`) and the offline stub yield unconstrained
   * text. Do not guess which provider you are on — probe first (per model, and
   * per mode when it matters: `supportsResponseFormat(provider, model, mode)`):
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
  responseFormat?: ResponseFormat;
  /**
   * #131 — tools the model may call natively. Honoured by adapters whose
   * capabilities for the requested model report `nativeToolCalls` (see
   * {@link AIProvider.capabilitiesFor}); an adapter or model that cannot take
   * tools drops them with a one-time warning rather than failing the call.
   * Calls come back on {@link ChatResponse.toolCalls} / `tool_call` chunks.
   */
  tools?: ChatToolSpec[];
  /** #131 — see {@link ChatToolChoice}. Ignored when `tools` is empty. */
  toolChoice?: ChatToolChoice;
  /**
   * #127 — called by a provider that QUEUES requests (the `local-gemma`
   * per-base-URL concurrency limiter) once this request's slot is acquired and
   * before its stream is opened, on every attempt. A caller that runs its own
   * deadline over the stream (chat's idle timeout) starts it here, so time spent
   * waiting behind another generation is not counted as a stall. Providers that
   * do not queue never call it.
   */
  onSlotAcquired?: () => void;
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

/**
 * #140 — where a registered tool comes from. MCP tools carry their server id so
 * the tool runtime can offer only servers the session's project may use.
 */
export interface ToolOrigin {
  kind: "mcp";
  serverId: string;
  serverLabel: string;
}

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** Zod schema describing the tool's argument shape. */
  schema: TSchema;
  risk: RiskLevel;
  /** #140 — set by the MCP bridge; absent for METIS's own tools. */
  origin?: ToolOrigin;
  /**
   * #140 — the JSON Schema a model is shown for the arguments, when the tool
   * has a better one than its zod schema describes (an MCP tool's own
   * `inputSchema`). The zod schema still validates every call.
   */
  parameters?: Record<string, unknown>;
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
  /**
   * #142 — set ONLY by the tool runtime, after the session's approval gate has
   * already decided this exact call (a person approved it where the policy
   * required that). The MCP bridge then skips its own, UI-less per-server
   * approval prompt instead of asking twice.
   */
  gateDecided?: boolean;
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
  /**
   * #131 — capabilities for ONE model on this adapter. Local runtimes differ
   * per model (`laguna-s-2.1` ignores `json_schema` but honours
   * `json_object`), so an adapter that serves many models resolves them from
   * the model catalog (#135). Optional: read it through
   * `resolveCapabilities(provider, model)`, which falls back to
   * {@link capabilities} and then to "supports nothing".
   */
  capabilitiesFor?(model: string): ProviderCapabilities;

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
