/**
 * Deterministic offline-stub provider.
 *
 * Used when `AI_OFFLINE=1` (or no other provider can be reached). Produces
 * stable, content-hash–derived responses so:
 *   • tests pass without a real model
 *   • sub-issue #41 / RAG bringup can develop without burning tokens
 *   • the orchestrator can still exercise routes/middleware end-to-end.
 *
 * Every response carries `provider: "offline-stub"` and `offline: true` so
 * callers can filter telemetry / refuse to display fake answers in prod.
 */
import crypto from "node:crypto";
import { embedTexts } from "../embeddings.js";
import { NO_PROVIDER_CAPABILITIES, type ProviderCapabilities } from "../capabilities.js";
import type {
  AIProvider,
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatToolCall,
  EmbedResult,
  ProviderKey,
  TokenUsage,
} from "../types.js";
import { messageText } from "../types.js";

const STUB_MODEL = "offline-stub";
const STUB_PROVIDER: ProviderKey = "offline-stub";

const tokenize = (s: string): string[] => s.match(/\S+/g) ?? [];

/**
 * Build a deterministic textual reply. The format is intentionally JSON-like
 * so callers can assert on it without parsing free-form prose.
 */
function deterministicReply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const promptHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex")
    .slice(0, 12);
  const summary = messageText(lastUser ?? { content: "(no prompt)" }).slice(0, 120);
  return [
    "[offline-stub]",
    `prompt: ${summary}`,
    `hash: ${promptHash}`,
    `messageCount: ${messages.length}`,
  ].join("\n");
}

function usageFor(messages: ChatMessage[], reply: string) {
  const promptTokens = messages.reduce((sum, m) => sum + tokenize(messageText(m)).length, 0);
  const completionTokens = tokenize(reply).length;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * #131 — one scripted model turn. A scripted stub replies with these instead of
 * the content hash, so a test can drive a whole tool loop (call → result →
 * answer) with no network. Every field is optional: a turn may be text only,
 * tool calls only, or both.
 */
export interface OfflineScriptTurn {
  content?: string;
  toolCalls?: ChatToolCall[];
  usage?: Partial<TokenUsage>;
  /** Defaults to `"tool_calls"` when the turn calls tools, else `"stop"`. */
  finishReason?: string;
}

export interface OfflineStubProviderOptions {
  /**
   * Turns to replay, one per `chat()`/`stream()` call, in order. When set, the
   * stub declares native tool calls (it will return the scripted calls) and
   * records every request on {@link OfflineStubProvider.requests}. Once the
   * script runs out, calls fall back to the deterministic hash reply.
   */
  script?: OfflineScriptTurn[];
}

export class OfflineStubProvider implements AIProvider {
  readonly key: ProviderKey = STUB_PROVIDER;
  readonly model: string = STUB_MODEL;
  readonly offline = true;
  /**
   * #1115 — the default stub honours nothing: its reply is a content hash, so a
   * schema could not constrain it even in principle. No drop-warning is emitted
   * here because `offline: true` already tells callers the response is
   * synthetic, and warning would spam every offline test run.
   *
   * #131 — a SCRIPTED stub declares `nativeToolCalls`, because it returns the
   * scripted calls on the native channel exactly as a real adapter would.
   */
  readonly capabilities: ProviderCapabilities;
  /** #131 — every request a scripted stub received, for assertions. */
  readonly requests: Array<{ messages: ChatMessage[]; opts: ChatOptions }> = [];
  private readonly script: OfflineScriptTurn[] | undefined;

  constructor(opts: OfflineStubProviderOptions = {}) {
    this.script = opts.script ? [...opts.script] : undefined;
    this.capabilities = this.script
      ? { ...NO_PROVIDER_CAPABILITIES, nativeToolCalls: true }
      : NO_PROVIDER_CAPABILITIES;
  }

  /** The next scripted turn, recording the request; `undefined` when unscripted/exhausted. */
  private nextTurn(messages: ChatMessage[], opts: ChatOptions): OfflineScriptTurn | undefined {
    if (!this.script) return undefined;
    const { signal: _signal, ...rest } = opts;
    this.requests.push({ messages, opts: rest });
    return this.script.shift();
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    if (opts.signal?.aborted) {
      throw makeAbortError();
    }
    const turn = this.nextTurn(messages, opts);
    if (turn) {
      const content = turn.content ?? "";
      return {
        content,
        usage: scriptedUsage(messages, content, turn),
        model: opts.model ?? this.model,
        provider: this.key,
        offline: true,
        finishReason: scriptedFinishReason(turn),
        ...(turn.toolCalls && turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
      };
    }
    const content = deterministicReply(messages);
    return {
      content,
      usage: usageFor(messages, content),
      model: opts.model ?? this.model,
      provider: this.key,
      offline: true,
    };
  }

  async *stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    const turn = this.nextTurn(messages, opts);
    if (turn) {
      if (opts.signal?.aborted) throw makeAbortError();
      if (turn.content) yield { type: "delta", content: turn.content };
      for (const call of turn.toolCalls ?? []) {
        yield {
          type: "tool_call",
          name: call.name,
          arguments: call.args,
          toolCallId: call.id,
          native: true,
        };
      }
      yield { type: "usage", usage: scriptedUsage(messages, turn.content ?? "", turn) };
      yield { type: "done", finishReason: scriptedFinishReason(turn) };
      return;
    }
    const content = deterministicReply(messages);
    const tokens = tokenize(content);
    for (const token of tokens) {
      if (opts.signal?.aborted) {
        throw makeAbortError();
      }
      yield { type: "delta", content: `${token} ` };
    }
    yield { type: "usage", usage: usageFor(messages, content) };
    yield { type: "done" };
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    return embedTexts(texts);
  }

  async models(): Promise<string[]> {
    return [STUB_MODEL];
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

function scriptedUsage(
  messages: ChatMessage[],
  content: string,
  turn: OfflineScriptTurn,
): TokenUsage {
  return { ...usageFor(messages, content), ...(turn.usage ?? {}) };
}

function scriptedFinishReason(turn: OfflineScriptTurn): string {
  return turn.finishReason ?? (turn.toolCalls && turn.toolCalls.length > 0 ? "tool_calls" : "stop");
}

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
