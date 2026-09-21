/**
 * RecordingProvider — transparent {@link AIProvider} decorator that captures
 * real `.chat()` responses to fixtures (#234).
 *
 * In record mode this wraps the *real* provider: every `chat()` call is passed
 * through to the wrapped provider, and the response is written to a fixture
 * keyed by {@link fixtureKey} before being returned to the caller. The wrapped
 * path is otherwise untouched, so recording a fixture exercises exactly the
 * same code as production.
 *
 * `stream()` and `embed()` are delegated verbatim (streaming responses are not
 * captured — replay synthesises a stream from the recorded `chat()` content).
 *
 * By default an existing fixture is NOT overwritten (`overwrite: false`) so a
 * record run only fills gaps; pass `overwrite: true` to refresh every fixture
 * the run touches.
 */
import { createChildLogger } from "../../logger.js";
import type { ProviderCapabilities } from "../capabilities.js";
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

const log = createChildLogger("ai-fixture-recorder");

export interface RecordingProviderOptions {
  /** The real provider whose responses are being captured. */
  inner: AIProvider;
  store: FixtureStore;
  /** Overwrite an existing fixture for the same key (default: false). */
  overwrite?: boolean;
}

export class RecordingProvider implements AIProvider {
  private readonly inner: AIProvider;
  private readonly store: FixtureStore;
  private readonly overwrite: boolean;

  constructor(opts: RecordingProviderOptions) {
    this.inner = opts.inner;
    this.store = opts.store;
    this.overwrite = opts.overwrite ?? false;
  }

  get key(): ProviderKey {
    return this.inner.key;
  }

  get model(): string {
    return this.inner.model;
  }

  get offline(): boolean {
    return this.inner.offline;
  }

  /**
   * #1115 — recording is transparent: requests pass straight through to
   * `inner`, so the wrapper reports the wrapped adapter's capabilities rather
   * than substituting its own.
   */
  get capabilities(): ProviderCapabilities | undefined {
    return this.inner.capabilities;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const response = await this.inner.chat(messages, opts);
    const key = fixtureKey(messages, opts);
    try {
      if (this.overwrite || !(await this.store.has(key))) {
        await this.store.write(key, messages, opts, response);
      }
    } catch (err) {
      // A failed fixture write must never break the live call it wraps.
      log.warn("fixture write failed", { key, error: (err as Error).message });
    }
    return response;
  }

  stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    return this.inner.stream(messages, opts);
  }

  embed(texts: string[]): Promise<EmbedResult> {
    return this.inner.embed(texts);
  }

  models(): Promise<string[]> {
    return this.inner.models();
  }

  ping(): Promise<boolean> {
    return this.inner.ping();
  }
}
