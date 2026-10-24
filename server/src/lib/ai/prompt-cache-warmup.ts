/**
 * #1277 — whether a parallel fan-out should send ONE call first to write the
 * prompt cache, and only then release the rest.
 *
 * Anthropic: "a cache entry only becomes available after the first response
 * begins. If you need cache hits for parallel requests, wait for the first
 * response before sending subsequent requests" (prompt-caching page, read
 * 2026-10-19). Calls sent together each pay to WRITE the shared prefix. The
 * Bedrock gateway relays to the same Claude models.
 *
 * The wait is worth it only where it buys a read:
 *   - an explicit-breakpoint cache — the native Anthropic provider or the
 *     Bedrock gateway, serving a Claude model. DeepSeek caches every prefix
 *     automatically and its writes are free, so it is skipped: by model id
 *     (`deepseek-*`), and by endpoint, since DeepSeek's Anthropic-compatible
 *     API also answers to `claude-*` names (`servesRouterModel` is false there);
 *   - a cached prefix at or over the model's minimum (`cacheFloorTokens`).
 *     Below it nothing is cached at all, and the wait would buy nothing.
 *
 * DeepSeek needs a different warm-up ({@link needsPrefixCacheWarmUp}).
 */
import type { AIProvider } from "./types.js";
import { cacheFloorTokens } from "./cache-verification.js";

/** About four characters per token — the estimate the floor check needs. */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A Claude model behind an explicit-breakpoint cache: native Anthropic or the Bedrock gateway. */
export function hasExplicitPromptCache(
  provider: Pick<AIProvider, "key" | "model" | "servesRouterModel">,
): boolean {
  if (provider.key !== "anthropic" && provider.key !== "bedrock-gateway") return false;
  if (!/claude/i.test(provider.model)) return false;
  return !provider.servesRouterModel || provider.servesRouterModel(provider.model);
}

export function needsPromptCacheWarmUp(
  provider: Pick<AIProvider, "key" | "model" | "servesRouterModel">,
  cachedPrefix: string,
): boolean {
  if (!hasExplicitPromptCache(provider)) return false;
  const platform = provider.key === "bedrock-gateway" ? "bedrock" : "anthropic";
  return estimatePromptTokens(cachedPrefix) >= cacheFloorTokens(provider.model, platform);
}

/**
 * #1329 — the least a shared user lead must hold (estimated tokens) before a
 * DeepSeek warm-up is sent for it. The system prompt ahead of it is already
 * read back from the section before, so the lead is what the warm-up buys; a
 * lead this short is a few hundredths of a cent either way.
 */
export const PREFIX_WARM_UP_MIN_TOKENS = 1_024;

/** #1329 — the warm-up's OUTPUT cap: it is sent for its prompt, never its reply. */
export const PREFIX_WARM_UP_MAX_TOKENS = 1;

/**
 * #1329 — whether a DeepSeek fan-out should first send ONE short call holding
 * only the prefix its calls share, and wait for it to FINISH.
 *
 * DeepSeek caches automatically, but a request reads back only a "cache prefix
 * unit" it fully matches, and those units are written when a request ends: "at
 * the end of user input and model output", where requests are seen to share a
 * prefix, and at fixed intervals of a long input (KV-cache guide, read
 * 2026-10-24). Calls sent together find none of their shared prefix: on the
 * 2026-10-23 run each section's first wave of up to four parts read about 1.3k
 * tokens, and the parts sent after one had finished read 25.6k. A call whose
 * user input ENDS at the shared prefix writes a unit at exactly that point, so
 * every part sent after it reads the prefix (the guide's `A + B` then
 * `A + B + C`).
 *
 * By model id only: a `claude-*` name sent to DeepSeek's Anthropic endpoint is
 * not recognised here and gets no warm-up.
 */
export function needsPrefixCacheWarmUp(
  provider: Pick<AIProvider, "key" | "model">,
  sharedUserLead: string,
): boolean {
  if (provider.key === "local-gemma") return false;
  if (!/deepseek/i.test(provider.model)) return false;
  return estimatePromptTokens(sharedUserLead) >= PREFIX_WARM_UP_MIN_TOKENS;
}
