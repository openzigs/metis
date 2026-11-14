/**
 * #2344 — verify an OAuth 2.1 access token presented to the remote endpoint.
 *
 * The token is a JWT (RFC 9068) signed by the authorization server named in
 * the admin settings, checked against that server's published keys (JWKS).
 * Every request is checked for:
 *
 *   - signature, by a key from the configured JWKS, with an asymmetric
 *     algorithm only (no `none`, no HMAC: METIS's own session tokens are HMAC
 *     and must never pass here);
 *   - issuer: `iss` equals the configured issuer exactly;
 *   - expiry: `exp` is required and in the future (`nbf` honoured);
 *   - audience (RFC 8707): `aud` contains THIS resource. A token minted for
 *     another resource is refused, even one from the same issuer;
 *   - a non-empty `sub`, which `identity` maps to one METIS user.
 *
 * No new dependency: `jsonwebtoken` (already direct) verifies, and Node's
 * `crypto.createPublicKey({ format: "jwk" })` imports the keys. The JWKS is
 * cached, refreshed on its TTL and, on an unknown `kid` (key rotation), at
 * most once per {@link JWKS_MIN_REFRESH_MS}, so a stream of forged `kid`s
 * cannot turn into a stream of fetches.
 *
 * The token itself is only ever read here; it is never stored, logged or
 * returned (`identity.ts` keeps only the mapped user).
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { RemoteMcpSettings } from "./config.js";

export const ALLOWED_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
] as const;
type Algorithm = (typeof ALLOWED_ALGORITHMS)[number];

export const JWKS_TTL_MS = 10 * 60_000;
export const JWKS_MIN_REFRESH_MS = 30_000;
export const JWKS_FETCH_TIMEOUT_MS = 5_000;
export const JWKS_MAX_BYTES = 256 * 1024;
/** How long a last-good key set is still trusted while the IdP cannot be reached. */
export const JWKS_MAX_STALE_MS = 60 * 60_000;
const CLOCK_TOLERANCE_S = 30;

/** Why a token was refused. Logged; the client sees only `invalid_token`. */
export type TokenRejection =
  | "malformed"
  | "algorithm"
  | "unknown_key"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "no_expiry"
  | "no_subject"
  | "jwks_unavailable";

export class InvalidAccessTokenError extends Error {
  constructor(readonly reason: TokenRejection) {
    super(`access token refused: ${reason}`);
    this.name = "InvalidAccessTokenError";
  }
}

/** What a verified token says. Not the token. */
export interface VerifiedAccessToken {
  issuer: string;
  subject: string;
  scopes: string[];
  expiresAt: number;
}

interface CachedKey {
  key: KeyObject;
  kid: string | undefined;
  alg: string | undefined;
}

interface JwksEntry {
  keys: CachedKey[];
  fetchedAt: number;
}

export interface TokenVerifierDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Scopes from RFC 9068 `scope` (space-delimited) or the common `scp` (string or array). */
export function tokenScopes(payload: JwtPayload): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string") v.split(" ").forEach((s) => s && out.add(s));
    else if (Array.isArray(v)) v.forEach((s) => typeof s === "string" && s && out.add(s));
  };
  add(payload.scope);
  add(payload.scp);
  return [...out];
}

/** Read a response body, aborting once it passes `max` bytes (a chunked body has no content-length). */
async function readBounded(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("JWKS is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function importKeys(body: unknown): CachedKey[] {
  const list = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) throw new Error("JWKS has no keys array");
  const keys: CachedKey[] = [];
  for (const jwk of list) {
    if (!jwk || typeof jwk !== "object") continue;
    const k = jwk as { kid?: unknown; alg?: unknown; use?: unknown; kty?: unknown };
    if (k.use !== undefined && k.use !== "sig") continue;
    if (k.kty !== "RSA" && k.kty !== "EC") continue;
    try {
      // A private JWK would import as its public half; only the public key is kept.
      const key = createPublicKey({ key: jwk as never, format: "jwk" });
      keys.push({
        key,
        kid: typeof k.kid === "string" ? k.kid : undefined,
        alg: typeof k.alg === "string" ? k.alg : undefined,
      });
    } catch {
      // An unusable entry is skipped; the rest of the set still verifies.
    }
  }
  return keys;
}

export function createAccessTokenVerifier(deps: TokenVerifierDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, JwksEntry>();
  const inflight = new Map<string, Promise<JwksEntry>>();
  const lastAttempt = new Map<string, number>();

  async function fetchJwks(url: string): Promise<JwksEntry> {
    const pending = inflight.get(url);
    if (pending) return pending;
    const p = (async () => {
      lastAttempt.set(url, now());
      const res = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > JWKS_MAX_BYTES) throw new Error("JWKS is too large");
      const text = await readBounded(res, JWKS_MAX_BYTES);
      const entry = { keys: importKeys(JSON.parse(text)), fetchedAt: now() };
      cache.set(url, entry);
      return entry;
    })().finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }

  function pick(entry: JwksEntry, kid: string | undefined, alg: Algorithm): KeyObject | null {
    const fits = (k: CachedKey) => k.alg === undefined || k.alg === alg;
    if (kid !== undefined) return entry.keys.find((k) => k.kid === kid && fits(k))?.key ?? null;
    // No `kid`: only an unambiguous set (one usable key) is accepted.
    const usable = entry.keys.filter(fits);
    return usable.length === 1 ? usable[0]!.key : null;
  }

  async function keyFor(url: string, kid: string | undefined, alg: Algorithm): Promise<KeyObject> {
    let entry = cache.get(url);
    const stale = !entry || now() - entry.fetchedAt > JWKS_TTL_MS;
    // A failed fetch leaves `fetchedAt` as it was, so the attempt cooldown is what
    // stops every request re-fetching (and waiting out the timeout) while the IdP is down.
    const cooling =
      entry !== undefined && now() - (lastAttempt.get(url) ?? 0) < JWKS_MIN_REFRESH_MS;
    try {
      if (stale && !cooling) entry = await fetchJwks(url);
    } catch {
      // A failed refresh keeps the last good set; with none there is nothing to verify against.
      if (!entry) throw new InvalidAccessTokenError("jwks_unavailable");
    }
    // ...but only for a bounded time: a long outage must not trust old keys forever.
    if (!entry || now() - entry.fetchedAt > JWKS_MAX_STALE_MS) {
      throw new InvalidAccessTokenError("jwks_unavailable");
    }
    let key = pick(entry, kid, alg);
    if (!key && now() - (lastAttempt.get(url) ?? 0) >= JWKS_MIN_REFRESH_MS) {
      // Key rotation: the server may have published a key we have not seen yet.
      try {
        entry = await fetchJwks(url);
        key = pick(entry, kid, alg);
      } catch {
        // fall through to unknown_key
      }
    }
    if (!key) throw new InvalidAccessTokenError("unknown_key");
    return key;
  }

  /** Verify `token` for `settings`, or throw {@link InvalidAccessTokenError}. */
  async function verify(token: string, settings: RemoteMcpSettings): Promise<VerifiedAccessToken> {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded.payload !== "object" || decoded.payload === null) {
      throw new InvalidAccessTokenError("malformed");
    }
    const alg = decoded.header.alg;
    if (!(ALLOWED_ALGORITHMS as readonly string[]).includes(alg)) {
      throw new InvalidAccessTokenError("algorithm");
    }
    const key = await keyFor(settings.jwksUrl, decoded.header.kid, alg as Algorithm);
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, key, {
        algorithms: [alg as Algorithm],
        issuer: settings.issuer,
        audience: [settings.resource, `${settings.resource}/`],
        clockTolerance: CLOCK_TOLERANCE_S,
        clockTimestamp: Math.floor(now() / 1000),
      }) as JwtPayload;
    } catch (err) {
      const e = err as Error & { name?: string };
      if (e.name === "TokenExpiredError") throw new InvalidAccessTokenError("expired");
      if (e.name === "NotBeforeError") throw new InvalidAccessTokenError("expired");
      if (/audience/.test(e.message)) throw new InvalidAccessTokenError("audience");
      if (/issuer/.test(e.message)) throw new InvalidAccessTokenError("issuer");
      if (/signature/.test(e.message)) throw new InvalidAccessTokenError("signature");
      throw new InvalidAccessTokenError("malformed");
    }
    // `jsonwebtoken` checks `exp` only when present; an access token without one never expires.
    if (typeof payload.exp !== "number") throw new InvalidAccessTokenError("no_expiry");
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new InvalidAccessTokenError("no_subject");
    }
    return {
      issuer: settings.issuer,
      subject: payload.sub,
      scopes: tokenScopes(payload),
      expiresAt: payload.exp,
    };
  }

  return { verify };
}

export type AccessTokenVerifier = ReturnType<typeof createAccessTokenVerifier>;
