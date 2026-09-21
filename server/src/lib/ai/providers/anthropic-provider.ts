/**
 * Native Anthropic provider — Messages API via the official `@anthropic-ai/sdk`.
 *
 * Issue #285. This is a FIRST-CLASS, native provider distinct from:
 *   • the Bedrock path (`bedrock-gateway` / `bedrock-direct`), which uses the
 *     `us.anthropic.*` Bedrock model ids and an OpenAI-compatible gateway, and
 *   • the Copilot wrapper / OpenAI-compatible shim, which is NOT wire-compatible
 *     with Anthropic's Messages API.
 *
 * It talks directly to `api.anthropic.com` (or a configured `baseURL`) using
 * BARE model ids (`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`).
 *
 * Auth: an Anthropic **API key** (`ANTHROPIC_API_KEY`, pay-per-token). An OAuth
 * developer token (`authToken`) and a custom `baseURL` are also supported. A
 * personal Claude Pro/Max (claude.ai) subscription is NOT usable here — that
 * licence covers Claude.ai / Claude Code only and using it programmatically in
 * a third-party server violates Anthropic's consumer terms.
 *
 * `embed()` is intentionally unsupported: Anthropic has no embeddings API.
 * METIS RAG embeddings come from a dedicated embeddings backend
 * (`server/src/lib/rag/`), independent of the chat provider.
 *
 * The API key is never logged.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createChildLogger } from "../../logger.js";
import { AIProviderError } from "../errors.js";
import { ToolTagStreamParser } from "./tool-tag-parser.js";
import { boundNonStreamingOutputTokens } from "../nonstreaming-output-bound.js";
import {
  createUnsupportedResponseFormatWarner,
  type ProviderCapabilities,
} from "../capabilities.js";
import {
  cacheControlFor,
  resolveAnthropicCacheTtl,
  type CacheControl,
} from "../prompt-cache-ttl.js";
import {
  messageText,
  type AIProvider,
  type ChatChunk,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type EmbedResult,
  type ProviderKey,
  type TokenUsage,
} from "../types.js";

const log = createChildLogger("ai-anthropic");

/**
 * Normalize a (possibly Bedrock-style) model id into the BARE form the direct
 * Anthropic Messages API expects.
 *
 * METIS's `model-router` emits canonical Bedrock ids (e.g.
 * `us.anthropic.claude-sonnet-4-6`, `us.anthropic.claude-haiku-4-5-20251001-v1:0`)
 * so the Bedrock / Copilot paths work unchanged. The direct Anthropic API,
 * however, 404s on the `us.anthropic.` cross-region prefix and the `-v1:0`
 * Bedrock version suffix — it only accepts bare ids like `claude-sonnet-4-6`.
 * This helper strips those Bedrock-isms so the direct provider can consume the
 * SAME canonical ids without forcing `model-router` to fork per-provider. It is
 * applied ONLY at this provider's boundary — the router's ids are untouched.
 *
 * Transformations (in order):
 *   1. Strip a leading cross-region inference prefix: `us.` / `eu.` / `apac.`
 *      (so `us.anthropic.<x>` → `anthropic.<x>`).
 *   2. Strip a leading `anthropic.` vendor segment (→ `<x>`).
 *   3. Strip a trailing Bedrock version suffix matching `-v\d+:\d+` (e.g. `-v1:0`).
 *
 * Already-bare ids (`claude-sonnet-4-6`, `claude-opus-4-8`) pass through
 * unchanged. Empty / undefined input is returned as-is (empty string) so a
 * mis-resolved model never throws here — the SDK call surfaces the real error.
 */
export function normalizeAnthropicModelId(id: string | undefined): string {
  if (!id) return "";
  let out = id;
  // 1. Cross-region inference prefix (us./eu./apac.).
  out = out.replace(/^(?:us|eu|apac)\./, "");
  // 2. `anthropic.` vendor segment.
  out = out.replace(/^anthropic\./, "");
  // 3. Trailing Bedrock version suffix `-v<major>:<minor>`.
  out = out.replace(/-v\d+:\d+$/, "");
  return out;
}

/** Bare (non-Bedrock) default — mirrors the Bedrock default tier. */
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
/** Messages API non-streaming default budget (#285). */
const DEFAULT_MAX_TOKENS = 16_000;
/** Larger budget for streaming, where long outputs are expected (#285). */
const DEFAULT_STREAM_MAX_TOKENS = 64_000;
/** Lightweight `ping()`/`models()` probe timeout — safe for `/readyz`. */
const PROBE_TIMEOUT_MS = 2_000;

export interface AnthropicProviderOptions {
  /** Anthropic API key (`ANTHROPIC_API_KEY`). */
  apiKey?: string;
  /** Optional OAuth/dev token (`ANTHROPIC_AUTH_TOKEN`). */
  authToken?: string;
  /** Optional base URL override (`ANTHROPIC_BASE_URL`); defaults to the SDK's. */
  baseUrl?: string;
  /** Default model id (bare). Defaults to `claude-sonnet-4-6`. */
  model?: string;
  /** Default non-streaming `max_tokens`. */
  defaultMaxTokens?: number;
  /** Default streaming `max_tokens`. */
  streamMaxTokens?: number;
}

/** Shape of the SDK `Message.usage` we depend on (mocked in tests). */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /**
   * #1257 — extended-thinking spend. `claude-sonnet-5` populates this even
   * though METIS sends no `thinking` field, and the count is drawn from the
   * SAME `max_tokens` budget as the answer (it is already inside
   * `output_tokens`). `null` when the API reported no breakdown.
   */
  output_tokens_details?: { thinking_tokens?: number } | null;
}

/** Minimal shape of the SDK `Message` we depend on. */
interface AnthropicMessage {
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  usage?: AnthropicUsage;
  /** #1226 — `"max_tokens"` here means the output cap truncated the answer. */
  stop_reason?: string | null;
}

/**
 * A Messages API text content block, optionally carrying a prompt-cache
 * breakpoint. Mirrors the SDK's `TextBlockParam` for the subset we emit.
 */
interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export class AnthropicProvider implements AIProvider {
  readonly key: ProviderKey = "anthropic";
  readonly offline = false;
  /**
   * #1115 — capability honesty.
   *
   * `responseFormat: false` — the Anthropic Messages API has no
   * `response_format`/`json_schema` request field. Structure is enforced there
   * by forcing a tool call, which this adapter does not do (it sends no
   * `tools`), so a supplied schema is dropped.
   *
   * `nativeToolCalls: false` — following from the same fact: with no `tools` on
   * the request there is no native tool-call channel, which is exactly why
   * `stream()` runs a {@link ToolTagStreamParser} over the visible text.
   */
  readonly capabilities: ProviderCapabilities = {
    responseFormat: false,
    nativeToolCalls: false,
  };
  /** Emits a ONE-TIME warning when a caller supplies a schema we must drop. */
  private readonly unsupportedResponseFormat = createUnsupportedResponseFormatWarner(
    log,
    "anthropic",
  );
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly streamMaxTokens: number;

  constructor(opts: AnthropicProviderOptions) {
    // Normalize the configured default so the bare id is reported consistently
    // by `get model()` / `models()` and used as the request default.
    this.defaultModel = normalizeAnthropicModelId(opts.model) || DEFAULT_ANTHROPIC_MODEL;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.streamMaxTokens = opts.streamMaxTokens ?? DEFAULT_STREAM_MAX_TOKENS;
    // Only pass auth fields that are actually set so the SDK can apply its own
    // env-var defaults. We never log the key/token.
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.authToken ? { authToken: opts.authToken } : {}),
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  get model(): string {
    return this.defaultModel;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    if (opts.signal?.aborted) throw makeAbortError();
    this.unsupportedResponseFormat(opts.responseFormat);
    // Normalize at the provider boundary: callers (and `model-router`) may pass
    // a Bedrock-style id (`us.anthropic.…-v1:0`) which the direct Messages API
    // rejects — strip it to the bare id the SDK accepts.
    const model = normalizeAnthropicModelId(opts.model ?? this.defaultModel);
    const params = this.buildRequest(messages, opts, model, this.defaultMaxTokens);
    // #1257 — the LAST line of defence, and the only one every non-streaming
    // caller passes through. `messages.create` runs the SDK's own
    // `calculateNonstreamingTimeout` (this client carries no `timeout`) and
    // THROWS client-side above 21,333, converting a merely-degraded run into a
    // hard provider error. Clamping here bounds every call site at once —
    // including ones resolved by knobs this module has never heard of, such as
    // docs-gen's 32,768 section cap — rather than relying on each to remember.
    params.max_tokens = boundNonStreamingOutputTokens(params.max_tokens as number, this.key, {
      logger: log,
      knob: "the requested max_tokens",
      // The id AS SENT. The SDK's per-model table is matched exactly against
      // `body.model`, and this is the only place that string exists — the cap
      // resolvers upstream may still be holding a Bedrock-style spelling.
      model,
    }).value;

    log.debug("Anthropic chat request", {
      model,
      messageCount: messages.length,
      maxTokens: params.max_tokens,
      thinking: !!params.thinking,
    });

    let message: AnthropicMessage;
    try {
      message = (await this.client.messages.create(
        params as never,
        opts.signal ? { signal: opts.signal } : undefined,
      )) as AnthropicMessage;
    } catch (err) {
      throw this.mapError(err, "chat");
    }

    const usage = mapUsage(message.usage);
    logCacheUsage("chat", usage);
    logOutputBudget("chat", params.max_tokens, usage, message.stop_reason);
    return {
      content: extractText(message.content),
      usage,
      model: message.model ?? model,
      provider: this.key,
      // #1224 — the non-streaming path dropped `stop_reason` while `stream()`
      // forwarded it (#1226), so `ChatResponse.finishReason` was permanently
      // `undefined` on this provider and every truncation check downstream read
      // "no evidence" rather than "cap hit". Anthropic spells it `max_tokens`
      // where the OpenAI-compatible wire format says `length`.
      ...(message.stop_reason ? { finishReason: message.stop_reason } : {}),
    };
  }

  async *stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    if (opts.signal?.aborted) throw makeAbortError();
    this.unsupportedResponseFormat(opts.responseFormat);
    // Normalize at the provider boundary (see chat()): the direct Messages API
    // streaming endpoint also rejects Bedrock-style ids.
    const model = normalizeAnthropicModelId(opts.model ?? this.defaultModel);
    const params = this.buildRequest(messages, opts, model, this.streamMaxTokens);

    log.debug("Anthropic stream request", {
      model,
      messageCount: messages.length,
      maxTokens: params.max_tokens,
    });

    let handle: ReturnType<Anthropic["messages"]["stream"]>;
    try {
      handle = this.client.messages.stream(params as never);
    } catch (err) {
      throw this.mapError(err, "stream");
    }

    // Forward caller cancellation to the SDK's underlying controller.
    const onAbort = (): void => {
      try {
        handle.controller.abort();
      } catch {
        /* swallow — best-effort cancellation */
      }
    };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    // #718 — strip inline <tool_call>/<tool_response> XML that some models
    // hallucinate into the text stream, converting it to structured events.
    const toolTagParser = new ToolTagStreamParser();
    try {
      for await (const event of handle as AsyncIterable<unknown>) {
        const ev = event as { type?: string; delta?: { type?: string; text?: string } };
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          for (const chunk of toolTagParser.push(ev.delta.text)) yield chunk;
        }
      }
      for (const chunk of toolTagParser.flush()) yield chunk;
      const final = (await handle.finalMessage()) as AnthropicMessage;
      const usage = mapUsage(final.usage);
      logCacheUsage("stream", usage);
      // #1257 — streaming is NOT subject to the SDK's non-streaming bound, but
      // it spends thinking from the same budget, so the accounting is the same.
      logOutputBudget("stream", params.max_tokens, usage, final.stop_reason);
      yield { type: "usage", usage };
      // #1226 — forward the stop reason so callers can tell a cap-truncated
      // answer (`"max_tokens"`) from a cleanly-completed one.
      yield { type: "done", ...(final.stop_reason ? { finishReason: final.stop_reason } : {}) };
    } catch (err) {
      throw this.mapError(err, "stream");
    } finally {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }
  }

  async embed(_texts: string[]): Promise<EmbedResult> {
    // Anthropic has no embeddings API. RAG embeddings are produced by the
    // dedicated embeddings backend (`server/src/lib/rag/`), never by the chat
    // provider — surfacing a clear error keeps mis-routing loud rather than
    // silently returning a chat answer.
    throw new AIProviderError(
      "anthropic provider does not support embeddings; configure a separate embeddings backend",
    );
  }

  async models(): Promise<string[]> {
    try {
      const page = (await this.client.models.list(undefined, {
        timeout: PROBE_TIMEOUT_MS,
      } as never)) as {
        data?: Array<{ id?: string }>;
      };
      const ids = (page.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
      return ids.length > 0 ? ids : [this.defaultModel];
    } catch {
      return [this.defaultModel];
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.models.list(undefined, { timeout: PROBE_TIMEOUT_MS } as never);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build the Messages API request body. The system prompt is hoisted to the
   * TOP-LEVEL `system` param (never a message). Removed knobs
   * (`temperature`/`top_p`/`top_k`/`budget_tokens`) are deliberately NOT sent —
   * current models 400 on them. Reasoning depth is expressed via adaptive
   * thinking + `output_config.effort`.
   *
   * Prompt caching (GA — plain `cache_control`, no beta header for current
   * Claude models) is opt-in via {@link ChatOptions.promptCaching}:
   *   • `promptCaching.system` → emit `system` as a content-block array with a
   *     `cache_control: { type: "ephemeral" }` breakpoint on the (single) text
   *     block, so Anthropic caches the system prefix up to that breakpoint.
   *   • `promptCaching.messages` → tag the LAST content block of the LAST user
   *     message with the same breakpoint, caching the large stable
   *     facts/source prefix reused across generation + claim-extraction +
   *     faithfulness-judge calls.
   * Anthropic allows ≤4 breakpoints; we place at most 2 (system + last user
   * turn). Content below the model's min cacheable size simply does not cache —
   * a harmless no-op — so flagging caching is always safe.
   */
  private buildRequest(
    messages: ChatMessage[],
    opts: ChatOptions,
    model: string,
    defaultMaxTokens: number,
  ): Record<string, unknown> {
    const cacheSystem = opts.promptCaching?.system === true;
    const cacheMessages = opts.promptCaching?.messages === true;
    // Resolve the native-Anthropic cache TTL once per request (#702). The 5-min
    // default yields a BARE breakpoint (byte-identical to pre-#702 behaviour);
    // only an explicit `ANTHROPIC_PROMPT_CACHE_TTL=1h` adds `ttl: "1h"`.
    const cacheControl: CacheControl = cacheControlFor(resolveAnthropicCacheTtl());

    const systemParts: string[] = [];
    if (opts.systemMessage) systemParts.push(opts.systemMessage);
    // Each non-system turn's content is either a plain string or, when we need
    // to attach a cache breakpoint, a content-block array (the SDK accepts both).
    const apiMessages: Array<{
      role: "user" | "assistant";
      content: string | AnthropicTextBlock[];
    }> = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(messageText(msg));
        continue;
      }
      // No assistant prefill (current models 400 on a trailing assistant turn
      // used as a prefill); we still forward prior assistant turns verbatim.
      // `tool` role responses are folded into a user turn so the conversation
      // stays valid for the Messages API.
      const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
      // Preserve a MULTI-BLOCK text message as distinct text blocks (the
      // faithfulness judge sends [claims, evidence] so the stable evidence can
      // be the cached trailing block). Single-string content stays a string —
      // back-compat. Messages containing non-text parts (e.g. images) fall back
      // to the flattened text form, since this provider's synthesis paths are
      // text-only and the Messages API would need image blocks handled here.
      const textBlocks = toTextBlocks(msg.content);
      apiMessages.push({
        role,
        content: textBlocks && textBlocks.length > 1 ? textBlocks : messageText(msg),
      });
    }

    const body: Record<string, unknown> = {
      model,
      max_tokens: opts.maxTokens ?? defaultMaxTokens,
      messages: apiMessages,
    };

    if (systemParts.length > 0) {
      const systemText = systemParts.join("\n\n");
      // When caching the system prefix, send it as a one-element content-block
      // array carrying the ephemeral breakpoint; otherwise keep the bare-string
      // form (back-compat — an un-flagged request is byte-for-byte unchanged).
      body.system = cacheSystem
        ? [{ type: "text", text: systemText, cache_control: cacheControl }]
        : systemText;
    }

    // Tag the last content block of the last USER message so the large stable
    // facts/source prefix is cached. We convert that one message's content to
    // block form in place; all other turns stay as plain strings.
    if (cacheMessages) markLastUserBlockForCaching(apiMessages, cacheControl);

    if (opts.reasoningEffort) {
      body.thinking = { type: "adaptive" };
      body.output_config = { effort: opts.reasoningEffort };
    }
    return body;
  }

  /**
   * Map a thrown SDK error to an {@link AIProviderError}, preserving the HTTP
   * status when present. The API key/token is NEVER included in the surfaced
   * message — we only forward the SDK's own message and status.
   */
  private mapError(err: unknown, op: string): AIProviderError {
    if (err instanceof AIProviderError) return err;
    const status = readStatus(err);
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    log.error("Anthropic provider error", { op, name, status });
    return new AIProviderError(`anthropic ${op} failed (${name}): ${message}`, status ?? 502);
  }
}

/** Read a numeric `status` off an SDK error, if present. */
function readStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/** Concatenate all `text` content blocks of a Messages API response. */
function extractText(content: AnthropicMessage["content"]): string {
  if (!content) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("");
}

/** Map Anthropic usage fields → METIS {@link TokenUsage}. */
function mapUsage(usage: AnthropicUsage | undefined): TokenUsage {
  const promptTokens = usage?.input_tokens ?? 0;
  const completionTokens = usage?.output_tokens ?? 0;
  // #1257 — thinking is NOT added to any total: it is already counted inside
  // `output_tokens`. It is carried separately because it is the part of the
  // output budget a cap must be sized against and cannot be seen any other way.
  // Absent → left `undefined`, which means "not reported", never "zero".
  const thinkingTokens = usage?.output_tokens_details?.thinking_tokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    ...(typeof thinkingTokens === "number" ? { thinkingTokens } : {}),
  };
}

/**
 * #1257 — emit the output-budget accounting for one call.
 *
 * The whole point of #1257 is that a cap is sized against the payload while
 * thinking spends the same budget, invisibly and by a variable 5,088–9,763.
 * This is the only place that number is observable, so it is logged on EVERY
 * call that reports it, and at WARN when the cap was actually reached — that
 * combination (`stop_reason: max_tokens` plus a large `thinkingTokens`) is the
 * exact signature of the #1223 failure and previously took a live reproduction
 * to see.
 *
 * `thinkingTokens` / `maxTokens` / `outputTokens` are all allowlisted in
 * `TOKEN_COUNT_META_KEYS` (`logger.ts`) — a key matching `/token/i` is
 * `[REDACTED]` unless it is named there (#1263), so a renamed key here goes
 * silently blank. Add the key to that allowlist rather than renaming around it.
 */
function logOutputBudget(
  op: string,
  maxTokens: unknown,
  usage: TokenUsage,
  finishReason: string | null | undefined,
): void {
  if (usage.thinkingTokens === undefined) return;
  const meta = {
    op,
    maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
    outputTokens: usage.completionTokens,
    thinkingTokens: usage.thinkingTokens,
    finishReason: finishReason ?? "unknown",
  };
  if (finishReason === "max_tokens") {
    log.warn(
      "Anthropic output cap reached — thinking spent part of the SAME budget as the answer, " +
        "so the payload was truncated by however much the model chose to think on this run. " +
        "Raise the call's cap (bounded by the SDK's non-streaming limit) or move it to the " +
        "streaming path.",
      meta,
    );
    return;
  }
  log.debug("Anthropic output budget", meta);
}

/**
 * Convert a {@link ChatMessage.content} value into an array of Anthropic text
 * blocks when (and only when) it is an array consisting ENTIRELY of text parts.
 * Returns `null` for a plain string (caller keeps the string form) or when any
 * non-text part is present (caller falls back to the flattened text form). This
 * lets a caller that pre-splits its message into blocks (e.g. the faithfulness
 * judge: [claims, evidence]) preserve that split so a cache breakpoint can land
 * on a specific block.
 */
function toTextBlocks(content: ChatMessage["content"]): AnthropicTextBlock[] | null {
  if (typeof content === "string") return null;
  if (!Array.isArray(content) || content.length === 0) return null;
  const blocks: AnthropicTextBlock[] = [];
  for (const part of content) {
    if (part.type !== "text") return null; // non-text part → fall back to flatten
    blocks.push({ type: "text", text: part.text });
  }
  return blocks;
}

/**
 * Attach an ephemeral cache breakpoint to the LAST content block of the LAST
 * user message, converting that message's content to block form if it is still
 * a plain string. This caches the large, stable facts/source prefix that the
 * doc-gen workload reuses across generation + claim-extraction + the judge's
 * per-claim batches. No-op when there is no user message. Mutates in place.
 */
function markLastUserBlockForCaching(
  apiMessages: Array<{ role: "user" | "assistant"; content: string | AnthropicTextBlock[] }>,
  cacheControl: CacheControl,
): void {
  // Find the last user turn (the stable facts/source prefix lives there).
  let idx = -1;
  for (let i = apiMessages.length - 1; i >= 0; i--) {
    if (apiMessages[i].role === "user") {
      idx = i;
      break;
    }
  }
  if (idx === -1) return;

  const target = apiMessages[idx];
  // Normalise to block form so we can attach cache_control to a single block.
  const blocks: AnthropicTextBlock[] =
    typeof target.content === "string" ? [{ type: "text", text: target.content }] : target.content;
  if (blocks.length === 0) return;
  // Anthropic caches the prefix UP TO the breakpoint, so the marker belongs on
  // the LAST block of the message.
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: cacheControl,
  };
  target.content = blocks;
}

/**
 * Emit a debug line with the prompt-cache read/write token counts for one call
 * so cache hits are observable in the logs. Only logs when caching actually
 * moved tokens (read or write > 0) to avoid noise on un-cached calls. Token
 * counts are non-sensitive; the API key is never touched here.
 */
function logCacheUsage(op: string, usage: TokenUsage): void {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  if (cacheReadTokens > 0 || cacheWriteTokens > 0) {
    log.debug("Anthropic prompt-cache usage", {
      op,
      cacheReadTokens,
      cacheWriteTokens,
      promptTokens: usage.promptTokens,
    });
  }
}

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
