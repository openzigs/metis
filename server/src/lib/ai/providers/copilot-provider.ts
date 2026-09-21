/**
 * Provider implementation backed by {@link CopilotWrapper}.
 *
 * One class drives both the native Copilot route and the Bedrock-gateway
 * route — the only difference is whether `provider` was passed when
 * constructing the wrapper. The wrapper handles SDK lifecycle, this layer
 * adapts the SDK session events into the cross-provider {@link AIProvider}
 * shape (chat/stream/embed/models).
 */
import { embedTexts } from "../embeddings.js";
import { AIProviderError } from "../errors.js";
import { withChatSpan } from "../../otel/genai-spans.js";
import { createChildLogger } from "../../logger.js";
import { ToolTagStreamParser } from "./tool-tag-parser.js";
import {
  createUnsupportedResponseFormatWarner,
  type ProviderCapabilities,
} from "../capabilities.js";
import type { CopilotSessionLike, CopilotWrapper } from "../copilot-wrapper.js";
import type {
  AIProvider,
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  EmbedResult,
  ProviderKey,
  TokenUsage,
} from "../types.js";
import { messageText } from "../types.js";

const log = createChildLogger("copilot-provider");

interface UsageEvent {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const sentinelSessionId = (opts?: ChatOptions): string => opts?.sessionId ?? `chat-${Date.now()}`;

function flattenMessages(messages: ChatMessage[]): {
  prompt: string;
  systemMessage?: { mode: "append" | "replace"; content: string };
} {
  const systems: string[] = [];
  const dialog: string[] = [];
  for (const m of messages) {
    const text = messageText(m);
    if (m.role === "system") systems.push(text);
    else if (m.role === "tool") dialog.push(`[tool:${m.name ?? "?"}] ${text}`);
    else dialog.push(`${m.role}: ${text}`);
  }
  return {
    prompt: dialog.join("\n"),
    systemMessage: systems.length > 0 ? { mode: "append", content: systems.join("\n") } : undefined,
  };
}

export interface CopilotProviderOptions {
  wrapper: CopilotWrapper;
  /** Provider key surfaced to telemetry — `copilot-native` or `bedrock-gateway`. */
  key: ProviderKey;
  /** Override the wrapper's default model (per-call options take priority). */
  model?: string;
  /** ms before `ping` gives up. Defaults to 1500. */
  pingTimeoutMs?: number;
}

/**
 * Cross-provider Copilot SDK adapter.
 */
export class CopilotProvider implements AIProvider {
  readonly key: ProviderKey;
  readonly offline = false;
  /**
   * #1115 — capability honesty.
   *
   * `responseFormat: false` — verified against the shipped type definitions of
   * BOTH `@github/copilot-sdk@0.3.0` (installed, #1347) and `1.0.8` (latest): neither
   * exposes `responseFormat`, `response_format`, `json_schema` or
   * `outputSchema` anywhere. Upstream issues #41/#857/#1185 remain open. A
   * schema supplied here is dropped — upgrading the SDK would not change that.
   *
   * `nativeToolCalls: true` — the SDK emits structured `toolCall` session
   * events and `stream()` forwards them as `{ type: "tool_call" }` chunks. Note
   * this describes the CHANNEL: METIS registers no tools of its own on the
   * session, so today those events come from the SDK's built-in tools.
   */
  readonly capabilities: ProviderCapabilities = {
    responseFormat: false,
    nativeToolCalls: true,
  };
  /** Emits a ONE-TIME warning when a caller supplies a schema we must drop. */
  private readonly unsupportedResponseFormat: (responseFormat: unknown) => void;
  private readonly wrapper: CopilotWrapper;
  private readonly defaultModel: string;
  private readonly pingTimeoutMs: number;
  private readonly sessions = new Map<string, CopilotSessionLike>();

  constructor(opts: CopilotProviderOptions) {
    this.wrapper = opts.wrapper;
    this.key = opts.key;
    this.defaultModel = opts.model ?? opts.wrapper.getModel();
    this.pingTimeoutMs = opts.pingTimeoutMs ?? 1500;
    this.unsupportedResponseFormat = createUnsupportedResponseFormatWarner(log, opts.key);
  }

  get model(): string {
    return this.defaultModel;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const model = opts.model ?? this.defaultModel;
    return withChatSpan(
      { provider: this.key, model, prompt: messages.map((m) => messageText(m)).join("\n") },
      async (_span, recordResult) => {
        const chunks: ChatChunk[] = [];
        for await (const chunk of this.stream(messages, opts)) {
          chunks.push(chunk);
        }
        let content = "";
        let usage: TokenUsage = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        for (const c of chunks) {
          if (c.type === "delta") content += c.content;
          else if (c.type === "usage") usage = c.usage;
        }
        recordResult({
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          responseModel: model,
          responseText: content,
        });
        return {
          content,
          usage,
          model,
          provider: this.key,
        };
      },
    );
  }

  async *stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    // `chat()` delegates here, so this one call covers both entry points.
    this.unsupportedResponseFormat(opts.responseFormat);
    const sessionId = sentinelSessionId(opts);
    const { prompt, systemMessage } = flattenMessages(messages);

    let session = this.sessions.get(sessionId);
    if (!session) {
      try {
        session = await this.wrapper.createSession({
          sessionId,
          streaming: true,
          model: opts.model ?? this.defaultModel,
          ...(systemMessage ? { systemMessage } : {}),
          // The SDK requires an onPermissionRequest handler for every
          // session.  Auto-approve because the Bedrock gateway / Copilot
          // native endpoints are trusted internal backends — real policy
          // enforcement happens at the HTTP session layer in routes/ai.ts.
          onPermissionRequest: async () => ({ approved: true }),
          ...(opts.skillDirectories && opts.skillDirectories.length > 0
            ? { skillDirectories: opts.skillDirectories }
            : {}),
          ...(opts.disabledSkills && opts.disabledSkills.length > 0
            ? { disabledSkills: opts.disabledSkills }
            : {}),
          ...(opts.disableTools ? { availableTools: [] } : {}),
        });
      } catch (err) {
        throw new AIProviderError(`failed to create session: ${(err as Error).message}`);
      }
      this.sessions.set(sessionId, session);
    }

    const queue: Array<ChatChunk | { type: "__error__"; error: Error } | { type: "__end__" }> = [];
    const waiters: Array<(value: void) => void> = [];
    const wake = (): void => {
      const w = waiters.shift();
      if (w) w();
    };

    const unsubscribers: Array<() => void> = [];
    const safeOff = (off: unknown): void => {
      if (typeof off === "function") unsubscribers.push(off as () => void);
    };

    // Track whether any incremental deltas were received so we can avoid
    // double-emitting when the SDK fires both `assistant.message_delta`
    // (incremental) and `assistant.message` (complete) events.
    let receivedDeltas = false;
    // Track whether a session-level error was received so the idle
    // handler can surface it when no content was delivered.
    let sessionError: Error | null = null;
    // Track whether __end__ has been pushed to the queue by any handler
    // to prevent multiple __end__ signals. BYOK providers like
    // bedrock-gateway may not fire session.idle at all, so
    // assistant.message is the primary end-of-stream signal.
    let endPushed = false;
    // Timestamp of the last delta received. Used to detect when the
    // stream has stopped producing content (BYOK providers may not fire
    // assistant.message at all — only deltas).
    let lastDeltaAt = 0;
    // Cumulative text emitted as deltas. Used to dedupe the
    // `assistant.message` recap event that bedrock-gateway fires AFTER
    // streaming finishes — if we don't dedupe, the full final body
    // gets appended on top of the already-streamed content, causing
    // duplicate sections in long synthesis responses.
    let emittedText = "";

    const pushEnd = (): void => {
      if (endPushed) return;
      endPushed = true;
      queue.push({ type: "__end__" });
      wake();
    };

    safeOff(
      session.on("assistant.message_delta", (event: { data?: { deltaContent?: string } }) => {
        const text = event?.data?.deltaContent ?? "";
        if (text) {
          receivedDeltas = true;
          lastDeltaAt = Date.now();
          emittedText += text;
          queue.push({ type: "delta", content: text });
          wake();
        }
      }),
    );
    // Bedrock-gateway fallback: when no `assistant.message_delta` events
    // fire, the SDK delivers content via `assistant.message`. Sonnet on
    // bedrock-gateway can emit MULTIPLE `assistant.message` events per
    // turn (e.g. a brief preamble followed by the real content). We must
    // NOT close the stream on the first one — instead, treat each
    // message like a delta and let the quiet-period detector in
    // `waitForStreamEnd` close the stream once activity has stopped.
    safeOff(
      session.on(
        "assistant.message",
        (event: { data?: { content?: string; outputTokens?: number } }) => {
          const text = event?.data?.content ?? "";
          if (text) {
            // Bedrock-gateway fires assistant.message at end-of-stream
            // with the FULL response body, even when we already received
            // it incrementally via assistant.message_delta. Without
            // dedupe, that full body would be pushed again, doubling
            // every long response.
            //
            // Strategy: compare the recap against the cumulative text
            // we already emitted via deltas. Three cases:
            //   1. Exact match (recap == emittedText) — drop it.
            //   2. Recap is a strict suffix-extension of emittedText —
            //      push only the new tail (covers gateways that send
            //      partial deltas + a complete recap).
            //   3. No overlap — the recap is genuinely new content (no
            //      deltas were streamed), push it whole.
            let toEmit: string | null = null;
            if (!receivedDeltas) {
              toEmit = text;
            } else if (text === emittedText) {
              toEmit = null; // exact recap, ignore
            } else if (text.startsWith(emittedText)) {
              // Recap extends what we already streamed — emit only the diff.
              toEmit = text.slice(emittedText.length);
            } else if (emittedText.endsWith(text)) {
              toEmit = null; // recap is a prefix of what we have, ignore
            } else {
              // No structural overlap — either gateway sent unrelated
              // content or our delta tracking is corrupt. Be safe: emit it.
              toEmit = text;
            }
            if (toEmit) {
              queue.push({ type: "delta", content: toEmit });
              receivedDeltas = true;
              lastDeltaAt = Date.now();
              emittedText += toEmit;
              wake();
            }
          }
          const tokens = event?.data?.outputTokens;
          if (tokens != null) {
            queue.push({
              type: "usage",
              usage: {
                promptTokens: 0,
                completionTokens: tokens,
                totalTokens: tokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            });
            wake();
          }
          // Do NOT pushEnd here — additional assistant.message events
          // may follow. The quiet-period detector or session.idle will
          // close the stream.
        },
      ),
    );
    safeOff(
      session.on(
        "toolCall",
        (event: { name?: string; arguments?: unknown; toolCallId?: string }) => {
          if (event?.name) {
            queue.push({
              type: "tool_call",
              name: event.name,
              arguments: event.arguments,
              toolCallId: event.toolCallId,
            });
            wake();
          }
        },
      ),
    );
    safeOff(
      session.on("usage", (event: UsageEvent) => {
        const usage: TokenUsage = {
          promptTokens: event.promptTokens ?? 0,
          completionTokens: event.completionTokens ?? 0,
          totalTokens:
            event.totalTokens ?? (event.promptTokens ?? 0) + (event.completionTokens ?? 0),
          cacheReadTokens: event.cacheReadTokens ?? 0,
          cacheWriteTokens: event.cacheWriteTokens ?? 0,
        };
        queue.push({ type: "usage", usage });
        wake();
      }),
    );

    // Handle both "error" and "session.error" — the Copilot SDK fires
    // "error" for transport-level failures and "session.error" for
    // gateway-level rejections (e.g. unsupported model, 400 responses).
    const pushError = (event: unknown): void => {
      let error: Error;
      if (event instanceof Error) {
        error = event;
      } else {
        const raw = (event as { message?: unknown })?.message ?? event;
        const msg =
          typeof raw === "string"
            ? raw
            : raw instanceof Error
              ? raw.message
              : (JSON.stringify(raw) ?? "Unknown AI error");
        error = new Error(msg);
      }
      sessionError = error;
      queue.push({ type: "__error__", error });
      // An error terminates the stream — let waitForStreamEnd() exit
      // immediately instead of running its 30s safety deadline. Without
      // this, the consumer's `finally { await sendPromise }` blocks for
      // up to 30s after a session.error event, which surfaces as a
      // 5s vitest timeout in copilot-provider-permission.test.ts.
      endPushed = true;
      wake();
    };
    safeOff(session.on("error", pushError));
    safeOff(session.on("session.error" as Parameters<typeof session.on>[0], pushError));

    safeOff(
      session.on("session.idle", async () => {
        // Bedrock-gateway fallback: if no content events were received,
        // extract the response from the session's message history.
        if (!receivedDeltas && queue.filter((q) => q.type === "delta").length === 0) {
          // If a session error already fired, don't try fallback extraction.
          if (!sessionError) {
            try {
              const msgs = await (
                session as unknown as {
                  getMessages: () => Promise<
                    Array<{
                      type: string;
                      data?: { content?: string; message?: string; error?: unknown };
                    }>
                  >;
                }
              ).getMessages();
              log.debug(
                "getMessages() fallback: types=%j",
                msgs.map((m) => m.type),
              );
              // Surface any session.error events found in the message log.
              const errorEvt = msgs.find((m) => m.type.includes("error"));
              if (errorEvt) {
                const errMsg =
                  (errorEvt.data as { message?: string })?.message ?? JSON.stringify(errorEvt.data);
                queue.push({ type: "__error__", error: new Error(errMsg) });
                wake();
              } else {
                const assistantMsg = [...msgs]
                  .reverse()
                  .find((m) => m.type === "assistant.message");
                if (assistantMsg?.data?.content) {
                  queue.push({ type: "delta", content: assistantMsg.data.content });
                  wake();
                }
              }
            } catch (e) {
              log.debug("getMessages() fallback failed: %s", (e as Error).message);
            }
          }
        }
        pushEnd();
      }),
    );

    const cleanup = (): void => {
      for (const off of unsubscribers) {
        try {
          off();
        } catch {
          /* noop */
        }
      }
    };

    const onAbort = (): void => {
      pushEnd();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        cleanup();
        throw makeAbortError();
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const sendPromise: Promise<unknown> = (async () => {
      try {
        await session!.send({ prompt });
      } catch (err) {
        queue.push({ type: "__error__", error: err as Error });
        wake();
        return;
      }
      // Safety: BYOK providers (e.g. bedrock-gateway) may not fire
      // session.idle OR assistant.message after send() resolves. Wait for
      // an end signal, OR for delta activity to go quiet for QUIET_MS,
      // OR for an absolute hard ceiling.
      //
      // The deadline is ROLLING (idle-based): as long as deltas keep
      // flowing, we keep listening. The hard ceiling is a backstop for
      // truly stuck streams. The previous fixed 30s wall-clock cap
      // truncated long synthesis responses (Claude generating 2000+
      // words at ~50 tok/sec needs 50-60s). Configurable via
      // AI_STREAM_QUIET_MS and AI_STREAM_HARD_DEADLINE_MS.
      const QUIET_MS = Number(process.env.AI_STREAM_QUIET_MS) || 5_000;
      const HARD_DEADLINE_MS = Number(process.env.AI_STREAM_HARD_DEADLINE_MS) || 300_000;
      const startedAt = Date.now();
      const waitForStreamEnd = async (): Promise<void> => {
        let lastLoggedDeltaCount = 0;
        while (Date.now() - startedAt < HARD_DEADLINE_MS) {
          if (endPushed) return;
          // Idle exit: deltas were received but have gone quiet for QUIET_MS.
          // This is the EXPECTED termination path for bedrock-gateway,
          // which never fires assistant.message_delta's terminal event.
          if (receivedDeltas && lastDeltaAt > 0 && Date.now() - lastDeltaAt > QUIET_MS) {
            log.debug(
              "stream end via quiet period: deltas=%d lastDelta=%dms ago totalElapsed=%ds",
              queue.filter((q) => q.type === "delta").length + lastLoggedDeltaCount,
              Date.now() - lastDeltaAt,
              Math.round((Date.now() - startedAt) / 1000),
            );
            return;
          }
          // Periodic progress log every 30s so long synthesis calls are visible.
          const elapsed = Date.now() - startedAt;
          if (elapsed > 30_000 && elapsed % 30_000 < 100) {
            const deltaCount = queue.filter((q) => q.type === "delta").length;
            if (deltaCount !== lastLoggedDeltaCount) {
              log.debug(
                "stream still flowing: elapsed=%ds deltas=%d lastDelta=%dms ago",
                Math.round(elapsed / 1000),
                deltaCount,
                lastDeltaAt > 0 ? Date.now() - lastDeltaAt : -1,
              );
              lastLoggedDeltaCount = deltaCount;
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        log.warn(
          "stream end via HARD ceiling (%dms): receivedDeltas=%s endPushed=%s lastDeltaAgo=%dms — content may be truncated",
          HARD_DEADLINE_MS,
          receivedDeltas,
          endPushed,
          lastDeltaAt > 0 ? Date.now() - lastDeltaAt : -1,
        );
      };
      await waitForStreamEnd();
      if (!endPushed) {
        if (
          !sessionError &&
          !receivedDeltas &&
          queue.filter((q) => q.type === "delta").length === 0
        ) {
          try {
            const msgs = await (
              session as unknown as {
                getMessages: () => Promise<
                  Array<{
                    type: string;
                    data?: { content?: string; message?: string; error?: unknown };
                  }>
                >;
              }
            ).getMessages();
            log.debug(
              "sendPromise getMessages() fallback: types=%j",
              msgs.map((m) => m.type),
            );
            const errorEvt = msgs.find((m) => m.type.includes("error"));
            if (errorEvt) {
              const errMsg =
                (errorEvt.data as { message?: string })?.message ?? JSON.stringify(errorEvt.data);
              queue.push({ type: "__error__", error: new Error(errMsg) });
              wake();
            } else {
              const assistantMsg = [...msgs].reverse().find((m) => m.type === "assistant.message");
              if (assistantMsg?.data?.content) {
                queue.push({ type: "delta", content: assistantMsg.data.content });
                wake();
              }
            }
          } catch (e) {
            log.debug("sendPromise getMessages() fallback failed: %s", (e as Error).message);
          }
        }
        pushEnd();
      }
    })();

    // #718 — the bedrock-gateway path streams plain text deltas; convert any
    // inline <tool_call>/<tool_response> XML into structured events at the
    // boundary so raw tags never reach the UI. Applied here (not at each push
    // site) to preserve the internal delta-count heuristics above.
    const toolTagParser = new ToolTagStreamParser();
    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        const item = queue.shift();
        if (!item) continue;
        if (item.type === "__error__") {
          throw new AIProviderError(item.error.message);
        }
        if (item.type === "__end__") {
          for (const chunk of toolTagParser.flush()) yield chunk;
          yield { type: "done" };
          return;
        }
        if (opts.signal?.aborted) {
          throw makeAbortError();
        }
        if (item.type === "delta") {
          for (const chunk of toolTagParser.push(item.content)) yield chunk;
          continue;
        }
        yield item;
      }
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      cleanup();
      await sendPromise.catch(() => {});
    }
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    return embedTexts(texts);
  }

  async models(): Promise<string[]> {
    try {
      return await this.wrapper.listModels();
    } catch (err) {
      throw new AIProviderError(`failed to list models: ${(err as Error).message}`);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await Promise.race([
        this.wrapper.ensureStarted(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("ping timeout")), this.pingTimeoutMs),
        ),
      ]);
      return await this.wrapper.isAuthenticated();
    } catch {
      return false;
    }
  }

  /** Tear down a session's COPILOT_HOME and SDK session. */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        await (session.destroy?.() ?? session.disconnect?.());
      } catch {
        /* swallow */
      }
      this.sessions.delete(sessionId);
    }
    await this.wrapper.cleanupSessionHome(sessionId);
  }

  /**
   * Tear down every session this provider knows about. Used by the graceful
   * shutdown hook in `server/src/index.ts` so a SIGINT/SIGTERM doesn't leave
   * per-session credential dirs lying around on disk.
   */
  async destroyAllSessions(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.destroySession(id).catch(() => undefined)));
  }
}

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
