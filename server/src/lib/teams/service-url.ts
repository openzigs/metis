/**
 * #1466 — which `serviceUrl` a proactive Teams send may go to.
 *
 * A proactive send (`continueConversationAsync`) POSTs the activity to the
 * reference's `serviceUrl` with a Bot Framework bearer token for the bot's
 * identity. A reference captured from an inbound activity carries the URL Teams
 * sent, but a notification target's reference is supplied by a workspace admin,
 * so its `serviceUrl` could name any host — which would then receive that token.
 * Sends are refused unless the URL is HTTPS on a Microsoft Bot Framework / Teams
 * connector host.
 */

/** Hosts matched exactly. `trafficmanager.net` is shared Azure DNS, so never a suffix. */
const TRUSTED_EXACT_HOSTS = new Set(["smba.trafficmanager.net"]);

/** Microsoft-owned zones whose subdomains host the Bot Connector service. */
const TRUSTED_HOST_SUFFIXES = [
  ".botframework.com",
  ".botframework.azure.us",
  ".teams.microsoft.com",
  ".teams.microsoft.us",
];

/** True when `serviceUrl` is HTTPS on a Bot Framework / Teams connector host. */
export function isTrustedBotServiceUrl(serviceUrl: unknown): boolean {
  if (typeof serviceUrl !== "string" || serviceUrl.length === 0) return false;
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return TRUSTED_EXACT_HOSTS.has(host) || TRUSTED_HOST_SUFFIXES.some((s) => host.endsWith(s));
}
