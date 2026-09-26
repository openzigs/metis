/**
 * Epic #128 / #140 — consume ONE streamed model call into a {@link ChatResponse}
 * so a native tool turn can stream its text to the user as it arrives and still
 * hand the loop a complete reply.
 *
 * Only NATIVE `tool_call` chunks become calls. A chunk the tool-tag parser
 * recovered from prose (`native` unset) is not a call on this path: executing
 * text the model improvised is exactly what native calling replaces.
 */
import { withIdleTimeout } from "../stream-idle.js";
import type { ChatChunk, ChatResponse, ChatToolCall, ProviderKey, TokenUsage } from "../types.js";

export interface CollectOptions {
  provider: ProviderKey;
  model: string;
  onDelta?: (text: string) => void;
}

export async function collectStream(
  chunks: AsyncIterable<ChatChunk>,
  opts: CollectOptions,
): Promise<ChatResponse> {
  let content = "";
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let finishReason: string | undefined;
  let nativeContent: ChatResponse["nativeContent"];
  const toolCalls: ChatToolCall[] = [];
  for await (const chunk of chunks) {
    if (chunk.type === "delta") {
      content += chunk.content;
      opts.onDelta?.(chunk.content);
    } else if (chunk.type === "tool_call") {
      if (chunk.native && chunk.toolCallId) {
        toolCalls.push({ id: chunk.toolCallId, name: chunk.name, args: chunk.arguments });
      }
    } else if (chunk.type === "usage") {
      usage = chunk.usage;
    } else if (chunk.type === "done") {
      finishReason = chunk.finishReason;
      nativeContent = chunk.nativeContent;
      break;
    }
  }
  return {
    content,
    usage,
    model: opts.model,
    provider: opts.provider,
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(nativeContent ? { nativeContent } : {}),
  };
}

export interface GuardedCollectOptions extends CollectOptions {
  /** Idle cap between chunks (`<= 0` disables it). */
  idleMs: number;
  /** Runs before the idle error propagates, so the caller can abort upstream. */
  onIdleTimeout?: () => void;
  /** The first idle clock starts only once this settles (slot acquired). */
  startAfter?: Promise<unknown>;
}

/**
 * The /stream route's model call for a native tool turn: the provider stream
 * under the idle guard, collected into one reply. Kept here — not inlined in
 * the route — so the slot-release tests exercise exactly the composition the
 * route runs (#128 review: a test that skipped the idle wrapper passed while
 * the route leaked the local concurrency slot).
 */
export function collectGuardedStream(
  chunks: AsyncIterable<ChatChunk>,
  opts: GuardedCollectOptions,
): Promise<ChatResponse> {
  const { idleMs, onIdleTimeout, startAfter, ...collect } = opts;
  return collectStream(withIdleTimeout(chunks, idleMs, onIdleTimeout, startAfter), collect);
}
