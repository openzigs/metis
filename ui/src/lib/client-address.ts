import { isIP } from "node:net";

/**
 * #1385 — tell the API which client a proxied auth request came from.
 *
 * Every browser login, refresh and logout reaches the API from this UI server,
 * so without help the API's auth limiter sees one client — this pod — for the
 * whole organisation. This module picks the client address the UI can trust and
 * signs it for the API (`server/src/middleware/auth-client-address.ts`).
 *
 * WHICH ADDRESS. The UI never sees the TCP peer (Next's route handlers have no
 * socket), only `X-Forwarded-For`. Each reverse proxy in front of the UI
 * appends the address it received from, so with `METIS_TRUSTED_PROXY_HOPS = N`
 * proxies the N-th entry from the right is the client as the outermost trusted
 * proxy saw it. Everything to its left was written by the client and is ignored.
 *
 * The default is 0: the UI is the edge, and then every entry — including the
 * one Next adds when the header is absent — is either client-written or
 * indistinguishable from it, so no address is sent. Set it to 1 behind one
 * Ingress controller or load balancer (the Helm chart does).
 *
 * WHY SIGNED. The API is reachable inside the cluster, and the SSO routes reach
 * it straight from the Ingress. An unsigned header would be one more value a
 * client could forge. The HMAC key, `METIS_UI_PROXY_SECRET`, is shared by the UI
 * and the API only; without it nothing is sent and the API keys on this pod.
 */

export const CLIENT_ADDRESS_HEADER = "x-metis-client-address";
export const CLIENT_ADDRESS_SIGNATURE_HEADER = "x-metis-client-address-signature";
/** The API ignores a shorter secret; so does the UI, rather than send a signature nobody reads. */
export const UI_PROXY_SECRET_MIN_LENGTH = 32;
const MAX_HOPS = 10;

/** `METIS_TRUSTED_PROXY_HOPS`: the number of reverse proxies in front of the UI. */
export function trustedProxyHops(
  raw: string | undefined = process.env.METIS_TRUSTED_PROXY_HOPS,
): number {
  const n = Number(raw?.trim() || "0");
  return Number.isInteger(n) && n >= 0 && n <= MAX_HOPS ? n : 0;
}

/** A bare IP from one `X-Forwarded-For` entry, tolerating `ip:port` and `[v6]:port`. */
function bareAddress(entry: string): string | null {
  const value = entry.trim();
  if (isIP(value)) return value;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed && isIP(bracketed[1]) === 6) return bracketed[1];
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (v4WithPort && isIP(v4WithPort[1]) === 4) return v4WithPort[1];
  return null;
}

/**
 * The client address the `hops` trusted proxies vouch for, or null when there
 * are none, too few entries, or the entry is not an IP address.
 */
export function trustedClientAddress(
  headers: Headers,
  hops: number = trustedProxyHops(),
): string | null {
  if (hops <= 0) return null;
  const header = headers.get("x-forwarded-for");
  if (!header) return null;
  const entries = header.split(",").map((part) => part.trim());
  if (entries.length < hops) return null;
  return bareAddress(entries[entries.length - hops]);
}

/** Must match `signedClientAddressMessage` in the API. */
function signedMessage(address: string): string {
  return `metis-client-address/v1\n${address}`;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The headers to add to an upstream auth request: the trusted client address and
 * its signature, or nothing when either is unavailable. Never throws.
 */
export async function clientAddressHeaders(incoming: Headers): Promise<Record<string, string>> {
  const secret = process.env.METIS_UI_PROXY_SECRET ?? "";
  if (secret.length < UI_PROXY_SECRET_MIN_LENGTH) return {};
  const address = trustedClientAddress(incoming);
  if (!address) return {};
  try {
    return {
      [CLIENT_ADDRESS_HEADER]: address,
      [CLIENT_ADDRESS_SIGNATURE_HEADER]: await hmacHex(secret, signedMessage(address)),
    };
  } catch {
    return {};
  }
}
