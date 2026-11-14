# Serving the METIS index to remote agents (`/mcp`, OAuth 2.1)

The [stdio server](metis-index-mcp.md) runs on a host that runs METIS. The remote endpoint
serves the same eight read-only `metis_*` tools over **Streamable HTTP** at `/mcp`, so an
agent on another machine can use them (#2344). METIS acts as an OAuth 2.1 **resource
server** under the MCP authorization specification, revision 2025-11-25. Your organisation's
identity provider issues the access tokens, and METIS checks them.

Every call still runs as one METIS user, through the stdio server's own path. That user's
project access and per-document ACLs apply. Results are redacted and each call is audit-logged
without its result.

**The endpoint is off by default.** It answers 404, and serves no metadata, until an
administrator turns it on.

## Before you start

You need:

- **An OAuth 2.1 / OIDC authorization server that issues JWT access tokens** (RFC 9068) signed
  with RSA or EC keys published as a JWKS. It must put this endpoint's URL in the token's
  `aud`: a client asks for it with the RFC 8707 `resource` parameter, or the server is
  configured to add it.
- **The same identity provider that users sign in to METIS with over OIDC.** METIS maps a
  token to a user by its `iss` and `sub`, through the identity METIS recorded at that user's
  OIDC sign-in. A user who has never signed in to METIS over OIDC cannot use the endpoint. Nothing
  is matched on email or username. Some providers use a different `sub` in access tokens than
  in ID tokens. Microsoft Entra ID is one: its `sub` is different for each application. Okta is
  another: a custom authorization server puts the username in the access token's `sub` by default,
  and the user id in the ID token's. On Okta, set the access token's `sub` claim to the user id. With
  any other such provider, link each user's access-token subject by hand with `link-identity-cli`,
  provider `oidc` (see [Linking two identities to one account](../auth/README.md)). Keycloak and
  Auth0 use the same `sub` in both tokens by default.
- **ID tokens that never name this endpoint in `aud`.** METIS does not require the RFC 9068
  `typ: at+jwt` header, because some providers (Keycloak among them) omit it from access
  tokens. What stops an ID token from being used as an access token here is the issuer check
  and the audience check: an ID token's `aud` is the client id of the application that signed
  the user in, not this endpoint's URL. Keep it that way. Never register a client whose id is
  this endpoint's URL, and never add the endpoint's URL as an audience on ID tokens.
- **A read-only scope** on the authorization server for this API, for example `mcp:read`.
- **TLS.** The endpoint refuses plain HTTP unless its configured URL is on `localhost`.

## Turning it on

Set these under **Settings → Configuration** (admin, with an MFA sign-in), or with
`PUT /api/admin/config/<KEY>`:

| Key                                | Example                                       | Meaning                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_REMOTE_RESOURCE_URL`          | `https://metis.example.com/mcp`               | The public URL of the endpoint. It must end in `/mcp`. Tokens must name it in `aud`.                                                                    |
| `MCP_REMOTE_ISSUER`                | `https://idp.example.com/realms/metis`        | The authorization server's issuer. A token's `iss` must equal it **exactly**, and it must be the `iss` your OIDC sign-in uses.                          |
| `MCP_REMOTE_JWKS_URL`              | `https://idp.example.com/realms/metis/certs`  | Where the authorization server publishes its signing keys.                                                                                              |
| `MCP_REMOTE_SCOPE`                 | `mcp:read` (default)                          | The one scope a token needs.                                                                                                                            |
| `MCP_REMOTE_ALLOWED_ORIGINS`       | `https://agent.example.com`                   | Origins allowed to send an `Origin` header to `/mcp` (a DNS-rebinding guard; the endpoint sends no CORS headers, so browser pages cannot call it cross-origin). A request whose `Origin` is not listed gets 403. A request with no `Origin` header, as desktop agents send, is not refused. |
| `MCP_REMOTE_RATE_LIMIT_PER_MINUTE` | `60` (default)                                | Requests one user may make per minute. Before the token is checked, each client address may make 20 times this many. |
| `MCP_REMOTE_ENABLED`               | `true`                                        | Turns the endpoint on. Set it last.                                                                                                                     |

The settings are read on every request, so turning the endpoint off takes effect on the next
request. If it is on but a setting is missing or wrong, such as a URL that does not parse,
`http://` to a host other than `localhost`, or a resource that does not end in `/mcp`, every
request gets **503**. The server log names the problem: `remote MCP endpoint is enabled but
misconfigured: …`.

## Routing

The endpoint and its metadata are served by the METIS **server** at the top level, not under
`/api`, which the UI proxies. Route two path prefixes to the server:

- `/mcp`
- `/.well-known/oauth-protected-resource`

With the Helm chart, set `ingress.mcpRemote.enabled=true`. With another proxy, add the two
prefixes beside `/socket.io`. The proxy must send `X-Forwarded-Proto`. METIS reads it through
`TRUST_PROXY` (one hop by default) to tell that the request arrived over TLS.

## What a client sees

1. A request without a token gets `401` and
   `WWW-Authenticate: Bearer scope="mcp:read", resource_metadata="https://metis.example.com/.well-known/oauth-protected-resource/mcp"`.
2. The metadata document (RFC 9728) names the authorization server:

   ```json
   {
     "resource": "https://metis.example.com/mcp",
     "authorization_servers": ["https://idp.example.com/realms/metis"],
     "scopes_supported": ["mcp:read"],
     "bearer_methods_supported": ["header"],
     "resource_name": "METIS index (metis-index-mcp)"
   }
   ```

3. The client signs the user in with the authorization server and gets a token for
   `resource=https://metis.example.com/mcp`, then sends it as `Authorization: Bearer …` on
   every request.

| Refusal                                                                                      | Answer                                                     |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| No token                                                                                     | 401, challenge without an error code                       |
| Bad signature, another issuer, expired, no `exp`, **another audience**, not a JWT at all     | 401 `invalid_token`                                        |
| A METIS API token (`metis_…`) or any other static secret                                     | 401 `invalid_token`: it is not a JWT from the issuer       |
| The subject is not a METIS user's OIDC identity, or that user is disabled or deleted         | 401 `invalid_token`                                        |
| The token lacks the scope                                                                    | 403 `insufficient_scope`, with `scope="mcp:read"`          |
| Plain HTTP to an `https` resource                                                            | 403 `tls_required`                                         |
| An `Origin` that is not allowed                                                              | 403 `origin_not_allowed`                                   |
| Over the per-user rate limit, or the per-address limit ahead of authentication              | 429                                                        |
| A body over 64 KiB                                                                           | 413                                                        |
| `GET` or `DELETE` (the endpoint is stateless: no stream, no session)                         | 405, `Allow: POST`                                         |

The endpoint is **stateless**. It issues no `Mcp-Session-Id`, so a session id is never a
credential, and the token is checked on every request. Revoking the user's sign-in at the
authorization server takes effect when the token expires. Disabling the user in METIS takes
effect on the next request.

**Claude Code** (`.mcp.json`):

```json
{
  "mcpServers": {
    "metis-index": { "type": "http", "url": "https://metis.example.com/mcp" }
  }
}
```

The client discovers the authorization server from the challenge and runs the OAuth flow
itself.

## What METIS does with the token

It reads the token to check it and to find the user, then discards it. The token is **never
forwarded**: not to a connector, not to a model provider, not to any other service. It is not
stored or logged, and it is taken off the request before the MCP layer sees the request
headers. The only outbound call the endpoint makes is the JWKS fetch, which carries no
credential. METIS caches the key set for 10 minutes. When a token names a key it has not seen,
it fetches the set again, at most once every 30 seconds.

## What METIS records

- Each tool call: `mcp.index.tool_call`, with the user, tool, project, result count and
  `transport: "remote"`. It records no result body and no arguments.
- A token that verified but was refused, for scope or because it maps to no active user:
  `mcp.index.denied`, with `transport: "remote"` and the reason.
- A token that failed verification is logged as a warning (`remote MCP token refused
  (<reason>)`). It is not audited, so an anonymous client cannot flood the audit log.
