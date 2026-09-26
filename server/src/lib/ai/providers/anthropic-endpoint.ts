/**
 * Endpoint classification for the Anthropic Messages client, split out of
 * `anthropic-provider.ts` so the model catalog (#135) can use it without
 * importing the SDK-backed provider (which itself reads the catalog).
 */

/**
 * #25 — true when `baseUrl` is DeepSeek's Anthropic-compatible API
 * (`https://api.deepseek.com/anthropic`), keyed on the documented host. A
 * missing or unparseable URL is the SDK default (api.anthropic.com) → false.
 */
export function isDeepSeekEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    return /(^|\.)deepseek\.com$/i.test(new URL(baseUrl.trim()).hostname);
  } catch {
    return false;
  }
}
