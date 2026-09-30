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

/**
 * #512 — true when `baseUrl` is Anthropic's own API: unset (the SDK default,
 * api.anthropic.com) or naming that host exactly. Any other Anthropic-compatible
 * host — DeepSeek, another vendor, a proxy — is not known to run Claude tier ids
 * as sent, and an unparseable URL is not known to be Anthropic's → false.
 */
export function isAnthropicApiEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return true;
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}
