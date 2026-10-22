/**
 * #1386 — a minimal, in-process OpenID Connect identity provider for tests.
 *
 * It exists so an SSO login can be driven end to end — the METIS redirect to
 * the IdP, the IdP's redirect back to the callback, the code exchange, and the
 * signed-in page — without an external IdP or a container. Used by
 * `server/tests/sso-browser-session-1386.sqlite.test.ts` and the Playwright spec
 * `e2e/tests/sso-oidc-session.spec.ts`.
 *
 * What it implements, and nothing more:
 *   - discovery   GET  /.well-known/openid-configuration
 *   - JWKS        GET  /jwks             (one RS256 key, generated per instance)
 *   - authorize   GET  /authorize        signs the configured user in at once and
 *                                         302s to `redirect_uri?code&state`
 *   - token       POST /token            authorization_code grant with PKCE (S256);
 *                                         returns an RS256 `id_token` carrying the nonce
 *
 * It checks what a real IdP checks on these two legs — a known client, the
 * registered redirect URI, a one-time code, the PKCE verifier — so a client bug
 * (a wrong verifier, a replayed code) fails here as it would in production.
 *
 * Plain HTTP on loopback: METIS accepts an `http://` discovery URL only for a
 * loopback host outside production (`server/src/lib/auth/oidc-provider.ts`).
 *
 * Node built-ins only.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";

/** @param {Buffer | string} input */
function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * @typedef {object} MockOidcUser
 * @property {string} sub
 * @property {string} preferredUsername
 * @property {string} email
 * @property {string} name
 * @property {string[]} [groups]
 * @property {boolean} [emailVerified]  the `email_verified` claim, default true
 */

/**
 * @typedef {object} MockOidcIdpOptions
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string} redirectUri  the only redirect URI the client may use
 * @property {MockOidcUser} user   who signs in at /authorize
 * @property {string} [host]       bind address, default 127.0.0.1
 */

/**
 * @typedef {object} MockOidcIdp
 * @property {string} issuer
 * @property {string} discoveryUrl
 * @property {() => Promise<void>} close
 * @property {{ authorize: number, token: number }} calls
 */

/**
 * Sign a compact JWS (RS256).
 *
 * @param {Record<string, unknown>} header
 * @param {Record<string, unknown>} payload
 * @param {import("node:crypto").KeyObject} privateKey
 */
export function signRs256(header, payload, privateKey) {
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  return `${input}.${base64url(sign("sha256", Buffer.from(input), privateKey))}`;
}

/** @param {string} verifier */
export function pkceS256(verifier) {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** @param {import("node:http").IncomingMessage} req */
async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * The client credentials on a token request: `client_secret_basic` or
 * `client_secret_post`.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {URLSearchParams} form
 */
function clientCredentials(req, form) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const at = decoded.indexOf(":");
    return {
      id: decodeURIComponent(decoded.slice(0, at)),
      secret: decodeURIComponent(decoded.slice(at + 1)),
    };
  }
  return { id: form.get("client_id") ?? "", secret: form.get("client_secret") ?? "" };
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Start the IdP on an ephemeral port.
 *
 * @param {MockOidcIdpOptions} options
 * @returns {Promise<MockOidcIdp>}
 */
export async function startMockOidcIdp(options) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = base64url(randomBytes(8));
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
  /** @type {Map<string, { nonce: string | null, challenge: string, redirectUri: string }>} */
  const codes = new Map();
  const calls = { authorize: 0, token: 0 };
  let issuer = "";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer || "http://localhost");
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "profile", "email"],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/jwks") {
      json(res, 200, { keys: [jwk] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      calls.authorize += 1;
      const q = url.searchParams;
      if (q.get("client_id") !== options.clientId)
        return json(res, 400, { error: "invalid_client" });
      if (q.get("redirect_uri") !== options.redirectUri) {
        return json(res, 400, { error: "invalid_request", error_description: "redirect_uri" });
      }
      if (q.get("response_type") !== "code") {
        return json(res, 400, { error: "unsupported_response_type" });
      }
      const challenge = q.get("code_challenge");
      if (!challenge || q.get("code_challenge_method") !== "S256") {
        return json(res, 400, {
          error: "invalid_request",
          error_description: "PKCE S256 required",
        });
      }
      const code = base64url(randomBytes(24));
      codes.set(code, { nonce: q.get("nonce"), challenge, redirectUri: options.redirectUri });
      const back = new URL(options.redirectUri);
      back.searchParams.set("code", code);
      const state = q.get("state");
      if (state) back.searchParams.set("state", state);
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      calls.token += 1;
      void readForm(req).then((form) => {
        const client = clientCredentials(req, form);
        if (client.id !== options.clientId || client.secret !== options.clientSecret) {
          return json(res, 401, { error: "invalid_client" });
        }
        if (form.get("grant_type") !== "authorization_code") {
          return json(res, 400, { error: "unsupported_grant_type" });
        }
        const code = form.get("code") ?? "";
        const grant = codes.get(code);
        codes.delete(code); // one use, success or not
        if (!grant || form.get("redirect_uri") !== grant.redirectUri) {
          return json(res, 400, { error: "invalid_grant" });
        }
        if (pkceS256(form.get("code_verifier") ?? "") !== grant.challenge) {
          return json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = signRs256(
          { alg: "RS256", typ: "JWT", kid },
          {
            iss: issuer,
            sub: options.user.sub,
            aud: options.clientId,
            iat: now,
            exp: now + 300,
            auth_time: now,
            ...(grant.nonce ? { nonce: grant.nonce } : {}),
            preferred_username: options.user.preferredUsername,
            email: options.user.email,
            email_verified: options.user.emailVerified ?? true,
            name: options.user.name,
            groups: options.user.groups ?? [],
          },
          privateKey,
        );
        return json(res, 200, {
          access_token: base64url(randomBytes(24)),
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        });
      });
      return;
    }
    json(res, 404, { error: "not_found" });
  });

  await new Promise((resolve) =>
    server.listen(0, options.host ?? "127.0.0.1", () => resolve(undefined)),
  );
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  issuer = `http://${options.host ?? "127.0.0.1"}:${address.port}`;
  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}
