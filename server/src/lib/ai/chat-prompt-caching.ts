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
 * #1863 — the FIRST call carries the breakpoint too, although a turn that
 * answers on that call never reads its write back (1.25x, or 2x at the 1h
 * TTL, on the whole transcript). Dropping it there would make call 2 pay full
 * price for that transcript and then write it anyway (1x + 1.25x instead of
 * 1.25x + 0.1x), and nothing in the request says in advance whether the model
 * will call a tool. #1845 measured the posture as shipped, first call
 * included, on `claude-sonnet-5-5`: cache-read share 38.7% to 77.1%, and cost
 * per session $0.0289 to $0.0176, a 34–39% saving over 40 sessions.
 *
 * Only an Anthropic adapter whose endpoint is Anthropic's own API, or a proxy
 * the operator declared relays to it (`ANTHROPIC_BASE_URL_BILLS_AS=anthropic`),
 * gets the messages breakpoint. The `anthropic` provider key also covers
 * DeepSeek's Anthropic-format endpoint and any other Anthropic-compatible host,
 * whose requests must not change (#1863); DeepSeek caches prefixes on its own,
 * and #1845 measured no saving there. `servesRouterModel` is the endpoint test
 * pricing and the model router already read (#512). The OpenAI-compatible
 * client forwards `promptCaching.messages` as `extra_body.prompt_caching`
 * (bedrock-access-gateway reads it), so turning it on there would change those
 * requests too. A turn with no tools is one call, whose last user block is
 * never re-sent within the turn, so it keeps the system-only posture (#389).
 */
import type { AIProvider, ChatOptions } from "./types.js";

/** The chat workload's cache posture without a tool loop (#700). */
export const CHAT_PROMPT_CACHING = { system: true } as const;

/** #1842 — the posture of a native-Anthropic tool loop: system plus the moving transcript. */
export const CHAT_TOOL_LOOP_PROMPT_CACHING = { system: true, messages: true } as const;

/** The members of a provider {@link chatToolLoopPromptCaching} reads. */
export type ToolLoopCachingProvider = Pick<AIProvider, "key" | "model" | "servesRouterModel">;

/** #1842 / #1863 — the `promptCaching` a chat tool loop sends on `provider`. */
export function chatToolLoopPromptCaching(
  provider: ToolLoopCachingProvider,
): NonNullable<ChatOptions["promptCaching"]> {
  const relaysToAnthropic =
    provider.key === "anthropic" && provider.servesRouterModel?.(provider.model) === true;
  return relaysToAnthropic ? CHAT_TOOL_LOOP_PROMPT_CACHING : CHAT_PROMPT_CACHING;
}
