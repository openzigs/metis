/**
 * #2344 — the remote endpoint's access-token checks: signature, issuer,
 * expiry and audience, against the authorization server's JWKS.
 */
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import type { RemoteMcpSettings } from "./config.js";
import {
  createAccessTokenVerifier,
  InvalidAccessTokenError,
  JWKS_MAX_BYTES,
  JWKS_MAX_STALE_MS,
  JWKS_MIN_REFRESH_MS,
  JWKS_TTL_MS,
  tokenScopes,
} from "./token-verifier.js";

const ISSUER = "https://idp.example.com/realms/metis";
const RESOURCE = "https://metis.example.com/mcp";

const settings: RemoteMcpSettings = {
  resource: RESOURCE,
  metadataUrl: "https://metis.example.com/.well-known/oauth-protected-resource/mcp",
  issuer: ISSUER,
  jwksUrl: "https://idp.example.com/jwks",
  scope: "mcp:read",
  allowedOrigins: new Set(),
  requireTls: true,
  rateLimitPerMinute: 60,
};

function ecKey() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}
const signing = ecKey();
const other = ecKey();
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwk(pub: KeyObject, kid: string, extra: Record<string, unknown> = {}) {
  return { ...pub.export({ format: "jwk" }), kid, use: "sig", ...extra };
}

const NOW = 1_800_000_000_000;

function sign(
  claims: Record<string, unknown> = {},
  opts: { key?: KeyObject; kid?: string | null; alg?: jwt.Algorithm } = {},
): string {
  const payload = {
    iss: ISSUER,
    aud: RESOURCE,
    sub: "user-sub-1",
    scope: "mcp:read openid",
    iat: NOW / 1000,
    exp: NOW / 1000 + 300,
    ...claims,
  };
  for (const k of Object.keys(payload)) {
    if ((payload as Record<string, unknown>)[k] === undefined)
      delete (payload as Record<string, unknown>)[k];
  }
  return jwt.sign(payload, opts.key ?? signing.privateKey, {
    algorithm: opts.alg ?? "ES256",
    ...(opts.kid === null ? {} : { keyid: opts.kid ?? "k1" }),
  });
}

function jwksFetch(...sets: object[][]) {
  let i = 0;
  return vi.fn(async () => {
    const keys = sets[Math.min(i, sets.length - 1)];
    i += 1;
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidAccessTokenError);
    return (err as InvalidAccessTokenError).reason;
  }
  throw new Error("expected a rejection");
}

function verifier(fetchImpl = jwksFetch([jwk(signing.publicKey, "k1")]), now = () => NOW) {
  return { fetchImpl, ...createAccessTokenVerifier({ fetchImpl: fetchImpl as never, now }) };
}

describe("createAccessTokenVerifier", () => {
  it("accepts a token signed by the issuer's key, for this resource, unexpired", async () => {
    const { verify, fetchImpl } = verifier();
    await expect(verify(sign(), settings)).resolves.toEqual({
      issuer: ISSUER,
      subject: "user-sub-1",
      scopes: ["mcp:read", "openid"],
      expiresAt: NOW / 1000 + 300,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      settings.jwksUrl,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("accepts an RSA-signed token too", async () => {
    const { verify } = verifier(jwksFetch([jwk(rsa.publicKey, "r1", { alg: "RS256" })]));
    const token = sign({}, { key: rsa.privateKey, kid: "r1", alg: "RS256" });
    await expect(verify(token, settings)).resolves.toMatchObject({ subject: "user-sub-1" });
  });

  it("refuses a token minted for another audience (RFC 8707)", async () => {
    const { verify } = verifier();
    expect(await rejection(verify(sign({ aud: "https://other.example.com/mcp" }), settings))).toBe(
      "audience",
    );
  });

  it("refuses a token with no audience", async () => {
    const { verify } = verifier();
    expect(await rejection(verify(sign({ aud: undefined }), settings))).toBe("audience");
  });

  it("accepts a multi-audience token that contains this resource, and refuses one that does not", async () => {
    const { verify } = verifier();
    await expect(
      verify(sign({ aud: ["https://other.example.com", `${RESOURCE}/`] }), settings),
    ).resolves.toMatchObject({ subject: "user-sub-1" });
    expect(
      await rejection(
        verify(sign({ aud: ["https://a.example.com", "https://b.example.com"] }), settings),
      ),
    ).toBe("audience");
  });

  it("refuses another issuer, even with a key the JWKS holds", async () => {
    const { verify } = verifier();
    expect(await rejection(verify(sign({ iss: "https://evil.example.com" }), settings))).toBe(
      "issuer",
    );
  });

  it("refuses an expired token, and one not yet valid", async () => {
    const { verify } = verifier();
    expect(await rejection(verify(sign({ exp: NOW / 1000 - 60 }), settings))).toBe("expired");
    expect(await rejection(verify(sign({ nbf: NOW / 1000 + 600 }), settings))).toBe("expired");
  });

  it("refuses a token with no expiry", async () => {
    const { verify } = verifier();
    expect(await rejection(verify(sign({ exp: undefined }), settings))).toBe("no_expiry");
  });

  it("refuses a token with no subject", async () => {
    const { verify } = verifier();
    expect(await rejection(verify(sign({ sub: undefined }), settings))).toBe("no_subject");
  });

  it("refuses a signature by a key the JWKS does not hold under that kid", async () => {
    const { verify } = verifier();
    expect(await rejection(verify(sign({}, { key: other.privateKey }), settings))).toBe(
      "signature",
    );
  });

  it("refuses an HMAC token (METIS's own session tokens), alg none, and a static METIS API token", async () => {
    const { verify, fetchImpl } = verifier();
    // A per-run random HMAC key, as METIS's JWT_SECRET would be.
    const hs = jwt.sign(
      { iss: ISSUER, aud: RESOURCE, sub: "x", exp: NOW / 1000 + 60 },
      randomBytes(32),
    );
    expect(await rejection(verify(hs, settings))).toBe("algorithm");
    // An unsigned token, built by hand: header `alg: none`, empty signature.
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: ISSUER, aud: RESOURCE, sub: "x" })}.`;
    expect(await rejection(verify(none, settings))).toBe("algorithm");
    expect(await rejection(verify("metis_0123456789abcdef", settings))).toBe("malformed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a key whose JWK alg differs from the token's", async () => {
    const { verify } = verifier(jwksFetch([jwk(signing.publicKey, "k1", { alg: "ES384" })]));
    expect(await rejection(verify(sign(), settings))).toBe("unknown_key");
  });

  it("without a kid, uses the only key, and refuses when the set is ambiguous", async () => {
    const one = verifier();
    await expect(one.verify(sign({}, { kid: null }), settings)).resolves.toMatchObject({
      subject: "user-sub-1",
    });
    const two = verifier(jwksFetch([jwk(signing.publicKey, "k1"), jwk(other.publicKey, "k2")]));
    expect(await rejection(two.verify(sign({}, { kid: null }), settings))).toBe("unknown_key");
  });

  it("skips encryption keys and entries it cannot import", async () => {
    const { verify } = verifier(
      jwksFetch([
        jwk(signing.publicKey, "k1", { use: "enc" }),
        { kty: "EC", kid: "k1", crv: "P-256", x: "bad", y: "bad" },
        { kty: "oct", kid: "k1", k: "c2VjcmV0" },
      ]),
    );
    expect(await rejection(verify(sign(), settings))).toBe("unknown_key");
  });

  it("caches the JWKS, and refetches it after the TTL", async () => {
    let t = NOW;
    const { verify, fetchImpl } = verifier(undefined, () => t);
    await verify(sign(), settings);
    await verify(sign(), settings);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = NOW + JWKS_TTL_MS + 1;
    await verify(sign({ exp: t / 1000 + 300 }), settings);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("picks up a rotated key on an unknown kid, at most once per cooldown", async () => {
    let t = NOW;
    const fetchImpl = jwksFetch(
      [jwk(signing.publicKey, "k1")],
      [jwk(signing.publicKey, "k1"), jwk(other.publicKey, "k2")],
    );
    const { verify } = verifier(fetchImpl, () => t);
    await verify(sign(), settings);
    // A kid unseen within the cooldown: no refetch.
    expect(await rejection(verify(sign({}, { key: other.privateKey, kid: "k2" }), settings))).toBe(
      "unknown_key",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = NOW + JWKS_MIN_REFRESH_MS;
    await expect(
      verify(sign({}, { key: other.privateKey, kid: "k2" }), settings),
    ).resolves.toMatchObject({ subject: "user-sub-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Forged kids now: still bounded by the cooldown.
    for (let i = 0; i < 5; i++) {
      await rejection(verify(sign({}, { kid: `forged-${i}` }), settings));
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight JWKS fetch between concurrent requests", async () => {
    const { verify, fetchImpl } = verifier();
    await Promise.all([verify(sign(), settings), verify(sign(), settings)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses every token while the JWKS cannot be fetched", async () => {
    const failing = vi.fn(async () => new Response("down", { status: 503 }));
    const { verify } = verifier(failing as never);
    expect(await rejection(verify(sign(), settings))).toBe("jwks_unavailable");
  });

  it("refuses an oversized or malformed JWKS", async () => {
    // A valid key set, so only the declared length can refuse it (unread).
    const huge = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [jwk(signing.publicKey, "k1")] }), {
          status: 200,
          headers: { "content-length": String(JWKS_MAX_BYTES + 1) },
        }),
    );
    expect(await rejection(verifier(huge as never).verify(sign(), settings))).toBe(
      "jwks_unavailable",
    );
    const big = vi.fn(async () => new Response("x".repeat(JWKS_MAX_BYTES + 1), { status: 200 }));
    expect(await rejection(verifier(big as never).verify(sign(), settings))).toBe(
      "jwks_unavailable",
    );
    const noKeys = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await rejection(verifier(noKeys as never).verify(sign(), settings))).toBe(
      "jwks_unavailable",
    );
  });

  it("does not re-fetch on every request while the IdP is down (attempt cooldown)", async () => {
    let t = NOW;
    let fail = false;
    const fetchImpl = vi.fn(async () =>
      fail
        ? new Response("down", { status: 500 })
        : new Response(JSON.stringify({ keys: [jwk(signing.publicKey, "k1")] }), { status: 200 }),
    );
    const { verify } = verifier(fetchImpl as never, () => t);
    await verify(sign(), settings);
    fail = true;
    t = NOW + JWKS_TTL_MS + 1;
    for (let i = 0; i < 5; i++) await verify(sign({ exp: t / 1000 + 300 }), settings);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops trusting a stale JWKS after the maximum staleness", async () => {
    let t = NOW;
    let fail = false;
    const fetchImpl = vi.fn(async () =>
      fail
        ? new Response("down", { status: 500 })
        : new Response(JSON.stringify({ keys: [jwk(signing.publicKey, "k1")] }), { status: 200 }),
    );
    const { verify } = verifier(fetchImpl as never, () => t);
    await verify(sign(), settings);
    fail = true;
    t = NOW + JWKS_MAX_STALE_MS + 1;
    expect(await rejection(verify(sign({ exp: t / 1000 + 300 }), settings))).toBe(
      "jwks_unavailable",
    );
  });

  it("bounds a chunked JWKS by the bytes read: stops reading an endless body", async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const endless = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulls += 1;
          c.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    });
    expect(await rejection(verifier(endless as never).verify(sign(), settings))).toBe(
      "jwks_unavailable",
    );
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
  });

  it("counts bytes, not UTF-16 units: multi-byte padding past the limit is refused", async () => {
    const pad = "é".repeat(JWKS_MAX_BYTES / 2 + 1); // under 256K characters, over 256 KiB
    const wide = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [jwk(signing.publicKey, "k1")], pad }), {
          status: 200,
        }),
    );
    expect(await rejection(verifier(wide as never).verify(sign(), settings))).toBe(
      "jwks_unavailable",
    );
  });

  it("keeps verifying with the last good JWKS when a refresh fails", async () => {
    let t = NOW;
    let fail = false;
    const fetchImpl = vi.fn(async () =>
      fail
        ? new Response("down", { status: 500 })
        : new Response(JSON.stringify({ keys: [jwk(signing.publicKey, "k1")] }), { status: 200 }),
    );
    const { verify } = verifier(fetchImpl as never, () => t);
    await verify(sign(), settings);
    fail = true;
    t = NOW + JWKS_TTL_MS + 1;
    await expect(verify(sign({ exp: t / 1000 + 300 }), settings)).resolves.toMatchObject({
      subject: "user-sub-1",
    });
  });
});

describe("tokenScopes", () => {
  it("reads RFC 9068 scope and the scp claim, string or array", () => {
    expect(tokenScopes({ scope: "a b  c" })).toEqual(["a", "b", "c"]);
    expect(tokenScopes({ scp: ["x", 3, "y"] })).toEqual(["x", "y"]);
    expect(tokenScopes({ scp: "x y", scope: "x" })).toEqual(["x", "y"]);
    expect(tokenScopes({})).toEqual([]);
  });
});
