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
 */
import type { AIProvider } from "./types.js";
import { cacheFloorTokens } from "./cache-verification.js";

/** About four characters per token — the estimate the floor check needs. */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function needsPromptCacheWarmUp(
  provider: Pick<AIProvider, "key" | "model" | "servesRouterModel">,
  cachedPrefix: string,
): boolean {
  if (provider.key !== "anthropic" && provider.key !== "bedrock-gateway") return false;
  if (!/claude/i.test(provider.model)) return false;
  if (provider.servesRouterModel && !provider.servesRouterModel(provider.model)) return false;
  const platform = provider.key === "bedrock-gateway" ? "bedrock" : "anthropic";
  return estimatePromptTokens(cachedPrefix) >= cacheFloorTokens(provider.model, platform);
}
