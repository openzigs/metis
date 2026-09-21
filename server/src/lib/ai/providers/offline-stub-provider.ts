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
  EmbedResult,
  ProviderKey,
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

export class OfflineStubProvider implements AIProvider {
  readonly key: ProviderKey = STUB_PROVIDER;
  readonly model: string = STUB_MODEL;
  readonly offline = true;
  /**
   * #1115 — the stub honours nothing: its reply is a content hash, so a schema
   * could not constrain it even in principle. No drop-warning is emitted here
   * because `offline: true` already tells callers the response is synthetic,
   * and warning would spam every offline test run.
   */
  readonly capabilities: ProviderCapabilities = NO_PROVIDER_CAPABILITIES;

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    if (opts.signal?.aborted) {
      throw makeAbortError();
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

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
