/**
 * #1842 — the prompt-cache posture of a chat turn's TOOL LOOP.
 *
 * A chat turn with tools makes several model calls, each re-sending the whole
 * growing transcript: the question, then every earlier turn's `tool_use` and
 * `tool_result` blocks. With only the system prefix cached (#700), every call
 * paid full input price for that transcript again. On the native Anthropic
 * path this also tags the LAST block of the LAST user turn (the newest tool
 * results) with the request's one cache breakpoint, so call N writes the
 * prefix up to its tool results and call N+1 reads it back at 0.1x before
 * appending its own.
 *
 * Breakpoints: at most two of Anthropic's four (the system, or the last tool
 * when there is no system, plus the last user turn), every one carrying the
 * same TTL, and no top-level automatic `cache_control` — so neither documented
 * 400 (more than four breakpoints; a different TTL on the last block) can
 * occur. Anthropic finds the previous write by walking back at most 20 blocks
 * from the new breakpoint; a turn that adds 20 or more blocks (ten parallel
 * tool calls and their results) misses it and writes afresh.
 *
 * Only the `anthropic` provider gets the messages breakpoint. The
 * OpenAI-compatible client forwards `promptCaching.messages` as
 * `extra_body.prompt_caching` (bedrock-access-gateway reads it), so turning it
 * on there would change those requests; whether DeepSeek or the gateway need
 * anything is a separate question (#1829). A turn with no tools is one call,
 * whose last user block is never re-sent within the turn, so it keeps the
 * system-only posture (#389).
 */
import type { ChatOptions, ProviderKey } from "./types.js";

/** The chat workload's cache posture without a tool loop (#700). */
export const CHAT_PROMPT_CACHING = { system: true } as const;

/** #1842 — the posture of a native-Anthropic tool loop: system plus the moving transcript. */
export const CHAT_TOOL_LOOP_PROMPT_CACHING = { system: true, messages: true } as const;

/** #1842 — the `promptCaching` a chat tool loop sends on `providerKey`. */
export function chatToolLoopPromptCaching(
  providerKey: ProviderKey,
): NonNullable<ChatOptions["promptCaching"]> {
  return providerKey === "anthropic" ? CHAT_TOOL_LOOP_PROMPT_CACHING : CHAT_PROMPT_CACHING;
}
