/**
 * #1386 — the in-process OIDC test IdP checks what a real IdP checks on the
 * authorize and token legs, so a client bug fails against it.
 */
import { createPublicKey, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pkceS256, startMockOidcIdp } from "./mock-oidc-idp.mjs";

const REDIRECT = "https://metis.test/api/auth/oidc/callback";
const VERIFIER = "a-pkce-verifier-that-is-long-enough-to-be-realistic-0123456789";

/** @type {Awaited<ReturnType<typeof startMockOidcIdp>>} */
let idp;
beforeEach(async () => {
  idp = await startMockOidcIdp({
    clientId: "c1",
    clientSecret: "s1",
    redirectUri: REDIRECT,
    user: { sub: "u1", preferredUsername: "alice", email: "a@x.test", name: "Alice" },
  });
});
afterEach(async () => {
  await idp.close();
});

/** @param {Record<string, string>} overrides */
function authorizeUrl(overrides = {}) {
  const q = new URLSearchParams({
    client_id: "c1",
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: pkceS256(VERIFIER),
    code_challenge_method: "S256",
    state: "st",
    nonce: "n1",
    ...overrides,
  });
  return `${idp.issuer}/authorize?${q}`;
}

async function codeFromAuthorize() {
  const res = await fetch(authorizeUrl(), { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(/** @type {string} */ (res.headers.get("location")));
  expect(back.searchParams.get("state")).toBe("st");
  return /** @type {string} */ (back.searchParams.get("code"));
}

/** @param {Record<string, string>} form @param {Record<string, string>} [headers] */
function token(form, headers = {}) {
  return fetch(`${idp.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form),
  });
}

describe("mock OIDC IdP (#1386)", () => {
  it("serves discovery and a JWKS on its issuer", async () => {
    const discovery = await (await fetch(idp.discoveryUrl)).json();
    expect(discovery.issuer).toBe(idp.issuer);
    expect(discovery.token_endpoint).toBe(`${idp.issuer}/token`);
    const jwks = await (await fetch(`${idp.issuer}/jwks`)).json();
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect((await fetch(`${idp.issuer}/nope`)).status).toBe(404);
  });

  it.each([
    [{ client_id: "other" }, "invalid_client"],
    [{ redirect_uri: "https://evil.test/cb" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
  ])("refuses an authorize request with %j", async (overrides, error) => {
    const res = await fetch(authorizeUrl(overrides), { redirect: "manual" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
  });

  it("redirects without a state when none was sent", async () => {
    const q = new URLSearchParams({
      client_id: "c1",
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: pkceS256(VERIFIER),
      code_challenge_method: "S256",
    });
    const res = await fetch(`${idp.issuer}/authorize?${q}`, { redirect: "manual" });
    expect(
      new URL(/** @type {string} */ (res.headers.get("location"))).searchParams.has("state"),
    ).toBe(false);
  });

  it("exchanges a code with the right verifier for a signed id_token carrying the nonce", async () => {
    const code = await codeFromAuthorize();
    const res = await token(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER },
      { authorization: `Basic ${Buffer.from("c1:s1").toString("base64")}` },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const [header, payload, signature] = body.id_token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(claims).toMatchObject({
      iss: idp.issuer,
      aud: "c1",
      nonce: "n1",
      preferred_username: "alice",
    });
    const jwks = await (await fetch(`${idp.issuer}/jwks`)).json();
    const ok = verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: jwks.keys[0], format: "jwk" }),
      Buffer.from(signature, "base64url"),
    );
    expect(ok).toBe(true);
    expect(idp.calls).toEqual({ authorize: 1, token: 1 });
  });

  it("setUser changes who signs in next, on the same issuer (#1395)", async () => {
    idp.setUser({ sub: "u2", preferredUsername: "bob", email: "b@x.test", name: "Bob" });
    const code = await codeFromAuthorize();
    const res = await token(
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER },
      { authorization: `Basic ${Buffer.from("c1:s1").toString("base64")}` },
    );
    const body = await res.json();
    const claims = JSON.parse(Buffer.from(body.id_token.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ iss: idp.issuer, sub: "u2", preferred_username: "bob" });
  });

  it("refuses bad client credentials, another grant, a wrong verifier and a reused code", async () => {
    const code = await codeFromAuthorize();
    const good = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    };
    expect((await token({ ...good, client_id: "c1", client_secret: "wrong" })).status).toBe(401);
    expect(
      (await token({ ...good, client_id: "c1", client_secret: "s1", grant_type: "password" }))
        .status,
    ).toBe(400);
    const wrongVerifier = await token({
      ...good,
      client_id: "c1",
      client_secret: "s1",
      code_verifier: "x",
    });
    expect((await wrongVerifier.json()).error_description).toBe("PKCE mismatch");
    // The failed attempt spent the code.
    const reused = await token({ ...good, client_id: "c1", client_secret: "s1" });
    expect((await reused.json()).error).toBe("invalid_grant");
  });
});
