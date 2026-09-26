/**
 * ReplayProvider — deterministic {@link AIProvider} backed by recorded fixtures
 * (#234).
 *
 * Replays previously-captured `.chat()` responses keyed by {@link fixtureKey},
 * so generative paths run end-to-end in CI without any live LLM credentials.
 * `stream()` is synthesised from the recorded `content` (token-by-token) so
 * streaming routes also work under replay; `embed()` falls back to the supplied
 * deterministic embedding provider.
 *
 * On a fixture miss the provider throws {@link ReplayFixtureMissError} by
 * default. Callers running a partially-recorded suite can pass a
 * `fallbackProvider` (e.g. the {@link OfflineStubProvider}) to soften misses
 * into deterministic stub responses instead of failing.
 */
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
import { fixtureKey } from "./fixture-key.js";
import { FixtureStore } from "./fixture-store.js";

/** Thrown when replay mode has no fixture for a request and no fallback. */
export class ReplayFixtureMissError extends Error {
  constructor(
    readonly key: string,
    readonly dir: string,
  ) {
    super(
      `No replay fixture for key ${key} in ${dir}. ` +
        `Re-record with AI_RECORD=1 (and real LLM credentials), or set a fallback provider.`,
    );
    this.name = "ReplayFixtureMissError";
  }
}

export interface ReplayProviderOptions {
  store: FixtureStore;
  /** Provider used to serve `embed()` and (optionally) chat misses. */
  fallbackProvider?: AIProvider;
  /** Provider identity surfaced on synthesised misses / model lookups. */
  key?: ProviderKey;
  model?: string;
}

const tokenize = (s: string): string[] => s.match(/\S+/g) ?? [];

export class ReplayProvider implements AIProvider {
  readonly key: ProviderKey;
  readonly model: string;
  /** Replay never hits the network, but it is *not* the offline stub. */
  readonly offline = false;
  /**
   * #1115 — a replayed response is whatever was recorded; no request option can
   * constrain it after the fact, so this adapter honestly honours nothing.
   */
  readonly capabilities: ProviderCapabilities = NO_PROVIDER_CAPABILITIES;

  private readonly store: FixtureStore;
  private readonly fallback?: AIProvider;

  constructor(opts: ReplayProviderOptions) {
    this.store = opts.store;
    this.fallback = opts.fallbackProvider;
    this.key = opts.key ?? "offline-stub";
    this.model = opts.model ?? "replay";
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const key = fixtureKey(messages, opts);
    const record = await this.store.read(key);
    if (record) return record.response;
    if (this.fallback) return this.fallback.chat(messages, opts);
    throw new ReplayFixtureMissError(key, this.store.directory);
  }

  async *stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    const key = fixtureKey(messages, opts);
    const record = await this.store.read(key);
    if (!record) {
      if (this.fallback) {
        yield* this.fallback.stream(messages, opts);
        return;
      }
      throw new ReplayFixtureMissError(key, this.store.directory);
    }
    const { content, usage } = record.response;
    for (const token of tokenize(content)) {
      if (opts.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      yield { type: "delta", content: `${token} ` };
    }
    // #131 — a recorded response's native tool calls replay as tool_call chunks.
    for (const call of record.response.toolCalls ?? []) {
      yield {
        type: "tool_call",
        name: call.name,
        arguments: call.args,
        toolCallId: call.id,
        native: true,
      };
    }
    yield { type: "usage", usage };
    yield {
      type: "done",
      ...(record.response.finishReason ? { finishReason: record.response.finishReason } : {}),
    };
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (this.fallback) return this.fallback.embed(texts);
    throw new Error("ReplayProvider.embed requires a fallback provider");
  }

  async models(): Promise<string[]> {
    return [this.model];
  }

  async ping(): Promise<boolean> {
    return true;
  }
}
