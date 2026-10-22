/**
 * #1385 — the client address the `/api/auth/*` limiter keys on.
 *
 * Browser traffic reaches the API through the UI's Next.js route handlers
 * (`ui/src/lib/auth-proxy.ts`), which build their upstream request from scratch.
 * The API's TCP peer is therefore the UI pod for every login, so a limiter keyed
 * on it is one bucket per UI pod for the whole organisation: 20 wrong passwords
 * from one client locked everyone out for 15 minutes.
 *
 * Forwarding the browser's `X-Forwarded-For` would not help: under `trust proxy`
 * `req.ip` is whatever the client wrote there, so every forged value would buy a
 * fresh bucket (#1349, #1362).
 *
 * Instead the UI tells the API the client address it trusts (the entry its own
 * reverse proxy appended to `X-Forwarded-For`, `METIS_TRUSTED_PROXY_HOPS`), and
 * signs it with a secret only the UI and the API hold (`METIS_UI_PROXY_SECRET`,
 * HMAC-SHA256). The API believes the address only when the signature verifies.
 * Every other request to a credential route is keyed on its TCP peer, never on a
 * header.
 *
 * The SSO routes (`/oidc/*`, `/saml/*`) are different: the Ingress sends them to
 * the API directly (the IdP posts and redirects there), so their peer is the
 * Ingress controller and `req.ip` — the address the Ingress appended, read
 * through `TRUST_PROXY` — is the client. They accept no password.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

/** The client address the UI vouches for. */
export const CLIENT_ADDRESS_HEADER = "x-metis-client-address";
/** HMAC-SHA256 (hex) of {@link signedClientAddressMessage} under the shared secret. */
export const CLIENT_ADDRESS_SIGNATURE_HEADER = "x-metis-client-address-signature";
/** A shorter secret is ignored: it is guessable offline from one captured header. */
export const UI_PROXY_SECRET_MIN_LENGTH = 32;

/** The exact bytes the UI signs. Versioned so the format can change safely. */
export function signedClientAddressMessage(address: string): string {
  return `metis-client-address/v1\n${address}`;
}

/** Hex HMAC-SHA256 of `address` under `secret` — what the UI sends. */
export function clientAddressSignature(secret: string, address: string): string {
  return createHmac("sha256", secret).update(signedClientAddressMessage(address)).digest("hex");
}

let warnedShortSecret = false;

/** The shared UI↔API secret, or null when unset or too short to trust. */
export function uiProxySecret(): string | null {
  const secret = process.env.METIS_UI_PROXY_SECRET ?? "";
  if (!secret) return null;
  if (secret.length < UI_PROXY_SECRET_MIN_LENGTH) {
    if (!warnedShortSecret) {
      warnedShortSecret = true;
      // eslint-disable-next-line no-console -- one-time misconfiguration warning; the request logger has no request here
      console.warn(
        `METIS_UI_PROXY_SECRET is shorter than ${UI_PROXY_SECRET_MIN_LENGTH} characters; ignoring it, so the auth limiter cannot tell clients behind the UI apart`,
      );
    }
    return null;
  }
  return secret;
}

function singleHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}

/**
 * The client address the UI signed, or null when there is none, no secret is
 * configured, or the signature does not verify.
 */
export function verifiedClientAddress(req: Request): string | null {
  const secret = uiProxySecret();
  if (!secret) return null;
  const address = singleHeader(req, CLIENT_ADDRESS_HEADER)?.trim();
  const signature = singleHeader(req, CLIENT_ADDRESS_SIGNATURE_HEADER)?.trim().toLowerCase();
  if (!address || !signature || isIP(address) === 0) return null;
  if (!/^[0-9a-f]{64}$/.test(signature)) return null;
  const expected = Buffer.from(clientAddressSignature(secret, address), "hex");
  const presented = Buffer.from(signature, "hex");
  return timingSafeEqual(expected, presented) ? address : null;
}

/** The TCP peer of this request: the UI pod, a proxy, or a direct client. Never a header. */
function tcpPeer(req: Request): string {
  return req.socket?.remoteAddress ?? "";
}

/** Routes the Ingress sends straight to the API rather than through the UI. */
function isSsoRoute(path: string): boolean {
  return /^\/(oidc|saml)\//.test(path);
}

function addressKey(address: string): string {
  // A /64 for IPv6: one host owns many /128s. IPv4 (and IPv4-mapped) stay whole.
  return ipKeyGenerator(address, 64);
}

/**
 * The `/api/auth/*` limiter's key. `req.path` is relative to the `/auth` mount.
 *
 *  - a signed address from the UI → that address;
 *  - an SSO route → `req.ip` (the address the Ingress appended);
 *  - anything else → the TCP peer.
 */
export function authAddressKey(req: Request): string {
  const signed = verifiedClientAddress(req);
  if (signed) return `addr:${addressKey(signed)}`;
  if (isSsoRoute(req.path)) return `sso:${addressKey(req.ip ?? tcpPeer(req))}`;
  return `peer:${addressKey(tcpPeer(req))}`;
}
