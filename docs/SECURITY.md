# METIS — Security Guide

> Threat model, secret management, vulnerability disclosure, and supply-chain controls for METIS. Pair with [`OPERATIONS.md`](./OPERATIONS.md) for runtime hardening and [`USER_GUIDE.md`](./USER_GUIDE.md) for end-user docs.

---

## 1. Threat Model

### 1.1 Assets we protect
- **User credentials** — passwords (Argon2id), JWT access + refresh tokens, OIDC/LDAP bind credentials.
- **Connector secrets** — GitHub PATs, database passwords, repository SSH keys, BYOK AI provider API keys, webhook signing keys. All stored in the envelope-encrypted secret vault.
- **Project documents** — uploaded business documents, the LanceDB embedding store, and analysis transcripts.
- **AuditLog stream** — append-only record of every privileged action.

### 1.2 In-scope adversaries
- Authenticated low-privilege users attempting privilege escalation.
- Compromised dependencies (supply-chain attacks, typosquatting, malicious updates).
- Network-adjacent attackers attempting SSRF / pivot via the connector subsystem.
- Malicious documents (PDF / DOCX) attempting parser exploitation.
- Operators with read-only log access who must not see plaintext secrets.

### 1.3 Explicitly out of scope (v1.0.0)
- Multi-tenant data isolation across orgs (single-tenant deployment per instance).
- Hardware-side-channel attacks against the host kernel.
- Physical access to the database server.

---

## 2. Authentication & Authorization

### 2.1 Authentication providers
- **mock** — username/password matched against in-memory dev users (development only; refuses to start in production with `AUTH_MODE=mock`).
- **ldap** — bind to a corporate LDAP/AD over StartTLS, attribute-mapped to METIS roles.
- **oidc** (planned) — OAuth 2.1 / OpenID Connect (issue #149).

### 2.2 Token model
- **Access token** — short-lived JWT (`JWT_ACCESS_EXPIRY`, default 1h), HS256-signed by `JWT_SECRET`.
- **`JWT_SECRET` is mandatory outside local development.** The server only accepts the
  built-in (publicly known) development signing key when `NODE_ENV` is exactly
  `development` or `test` **and** the process is not running on a container platform
  (`KUBERNETES_SERVICE_HOST` unset). Every other environment — `staging`, preview/review
  apps, or an image that simply never set `NODE_ENV` — **refuses to start** without a real
  secret, and a secret shorter than 32 bytes is rejected there too. Using the fallback logs
  a loud startup warning. Generate one with `openssl rand -hex 32` (`pnpm bootstrap` does
  this for you locally).
- **Refresh token** — stored in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). Rotated on every refresh.
- Logout revokes the active refresh row server-side.

### 2.3 RBAC
- Roles: `admin`, `coordinator`, `developer`, `reader`. Each maps to a fixed permission set declared in `packages/shared/src/permissions.ts`.
- Every privileged route is guarded by `requirePermission('<dotted.permission>')`.
- Project-scoped permissions (e.g. `project.update`) check membership before checking the global role.
- `requirePermission` is a **global-role** check and is never sufficient on its own for
  project-owned data — see [§12 Object-Level Project Scope](#12-object-level-project-scope-epic-1051-issue-1058).

### 2.4 Rate limiting
| Surface | Default limit | Variable |
|---|---|---|
| `/api/auth/*` | 20 / 15min / client address (see below) | `RATE_LIMIT_*` |
| `POST /api/auth/login` | 10 attempts / 15min / account (username, case-folded) | `AUTH_ACCOUNT_RATE_LIMIT_MAX` (window: `RATE_LIMIT_WINDOW_MS`) |
| AI chat / stream | 60 / 15min / user | `AI_RATE_LIMIT_*` |
| Connector mutations | 30 / 5min / user | `CONNECTOR_RATE_LIMIT_*` |
| Document upload | 10 / 1min / user | `UPLOAD_RATE_LIMIT_*` |
| Scheduler `runNow` | 10 / 5min / user | `SCHEDULER_RUN_RATE_LIMIT_*` |
| Project code search | 300 / 15min / user | `CODE_SEARCH_RATE_LIMIT_*` |
| Traceability test gaps / workspace summary | 300 / 15min / user | `TRACEABILITY_GAPS_RATE_LIMIT_*` |
| Analysis traceability matrix + report export | 300 / 15min / user | `ANALYSIS_MATRIX_RATE_LIMIT_*` |
| `/api/runs` reads (run list, chat turns, replay, background runs, groups) | 3000 / 15min / user | `RUNS_LIMIT_MAX`, `RUNS_LIMIT_WINDOW_MS` |
| `/api/runs` writes (submit, cancel, pause, resume, best-of-N, steer) | 300 / 15min / user | `RUNS_WRITE_LIMIT_MAX` |

The `/api/auth/*` credential-stuffing limiter exempts two unauthenticated,
read-only, side-effect-free `GET` endpoints that the `/login` page polls before
any credentials exist — exempting them stops legitimate page loads from
consuming the credential-stuffing budget. The exemption is scoped to `GET` + an
exact path match (`isRateLimitExempt` in `server/src/middleware/rate-limit.ts`):

- `GET /api/auth/me` — session check.
- `GET /api/auth/sso/providers` — public enabled-provider list for the login
  page (returns only the safe `{ id, label, type, loginUrl }` projection).

All credential-accepting routes (`/login`, `/refresh`, `/logout`, SSO callbacks)
and every other `/sso/*` route remain throttled.

**Which client address (#1385).** Browser logins, refreshes and logouts reach the
API through the UI's route handlers, so the API's TCP peer is the UI pod for
everyone. Keyed on that, the limiter was one bucket for the whole organisation:
20 wrong passwords from one client locked every user out. Keyed on
`X-Forwarded-For`, every forged value would buy a fresh bucket. So:

| Route | Keyed on | Set by |
|---|---|---|
| `/login`, `/refresh`, `/logout` via the UI | the client address the UI signs: the `METIS_TRUSTED_PROXY_HOPS`-th `X-Forwarded-For` entry from the right (what the Ingress appended), sent as `X-Metis-Client-Address` with an HMAC-SHA256 under `METIS_UI_PROXY_SECRET` | `ui/src/lib/client-address.ts` |
| the same, with no valid signature (no secret, a secret under 32 characters, a forged or mismatched signature, `METIS_TRUSTED_PROXY_HOPS=0`) | the TCP peer (never a header) | `server/src/middleware/auth-client-address.ts` |
| `/oidc/*`, `/saml/*` (the Ingress sends these to the API directly) | `req.ip`: the address the Ingress appended, read through `TRUST_PROXY` | same |

Set the same `METIS_UI_PROXY_SECRET` (32+ characters, e.g. `openssl rand -hex 32`)
on the UI and the API, and `METIS_TRUSTED_PROXY_HOPS` on the UI to the number of
reverse proxies in front of it (1 behind one Ingress controller or load balancer;
the Helm chart sets 1). Leave it 0 when browsers reach the UI directly: then every
`X-Forwarded-For` entry is client-written, the UI sends no address, and the
limiter falls back to one bucket per UI pod. The generic `/api/*` proxy drops a
browser's own copy of these headers.

The per-account limiter caps sign-in attempts for one username however many
addresses they come from, so neither a botnet nor a shared NAT can brute-force
one account. It counts every attempt, successful or not: un-counting a success
needs a store decrement, which the cluster-safe Postgres and Valkey backends do
not have. Like any account lockout, it lets someone who knows a username delay
that user's sign-in for one window; raise `AUTH_ACCOUNT_RATE_LIMIT_MAX` if that
matters more to you than the brute-force cap.

### 2.5 Cross-site request forgery (#913)

The browser never holds an API credential it could be tricked into sending
anywhere but METIS: its session is the `metis.at` / `metis.rt` cookies on the
UI origin (`HttpOnly`, `SameSite=Lax`), and the UI's `/api/*` proxy turns the
access cookie into the `Authorization: Bearer` header the API reads. Two checks
sit on top of `SameSite=Lax`, which keeps the cookies off a cross-*site* POST
but not off one from a sibling subdomain (same site, other origin):

| Where | What is refused | Code |
|---|---|---|
| UI proxy (`/api/*`, `/api/auth/login`, `/logout`, `/refresh`) | Any `POST`/`PUT`/`PATCH`/`DELETE` whose `Sec-Fetch-Site` is not `same-origin`/`none`, or — without Fetch Metadata — whose `Origin` is not this host (`Host` or `X-Forwarded-Host`). | `ui/src/lib/csrf-guard.ts` |
| API (`createApp`) | A state-changing request authenticated by the `accessToken`/`refreshToken` cookie rather than a bearer header, unless it carries `X-METIS-CSRF` **and** is not marked cross-origin (as above, with every `CORS_ORIGIN` entry trusted — the same parsed list `cors()` uses). | `server/src/middleware/csrf-protection.ts` |

Both answer 403 `CSRF_REJECTED`. The UI-side rule is the algorithm of Go's
`http.CrossOriginProtection`: it needs no token and no client change, and a
request with neither `Sec-Fetch-Site` nor `Origin` (a webhook, a script) passes
because no browser can be forged into sending it. Reads (`GET`/`HEAD`/`OPTIONS`)
are never gated, so no route may change state on a `GET`.

- **Bearer requests are exempt** — a page on another origin cannot attach an
  `Authorization` header without a CORS preflight, which `CORS_ORIGIN` refuses.
- **The SAML ACS (`POST /api/auth/saml/acs`) is exempt on the API** — the
  identity provider posts to it cross-origin by design, and it is authenticated
  by the signed assertion. **Its URL must be the API origin**: the UI proxy does
  not forward `/api/auth/*`, and answers an IdP posting there with 404
  `SAML_ACS_WRONG_ORIGIN` naming the right path.
- **Webhooks and the Slack receiver** carry an HMAC signature and no session
  cookie, so neither check applies to them.
- **A deployment that serves the UI under another origin than the browser
  sends** (a proxy rewriting `Host` without `X-Forwarded-Host`, over plain HTTP
  where browsers omit Fetch Metadata) lists that origin in
  `METIS_TRUSTED_ORIGINS` (comma-separated) on the UI server.

**WebSockets (#1349).** The browser's socket.io client is not proxied: it
connects straight to the API (`NEXT_PUBLIC_SOCKET_URL`) from the UI's origin,
and authenticates with the `metis.at` cookie. `SameSite=Lax` would let a page
on a sibling subdomain open that socket as the signed-in user and join their
rooms (cross-site WebSocket hijacking), so the handshake checks `Origin`
(`socketOriginRefusal` in `server/src/lib/socket/server.ts`):

| Handshake | Origin | Result |
|---|---|---|
| Cookie-authenticated | an entry of `CORS_ORIGIN` (the UI), of `METIS_TRUSTED_ORIGINS`, or the API's own host | admitted |
| Cookie-authenticated | anything else, including `null` (sandboxed frame) | `connect_error` `ORIGIN_REJECTED` |
| Cookie-authenticated | **absent** | admitted — every browser sends `Origin` on a cross-origin WebSocket upgrade and on a cross-origin polling request, so a handshake without one is not a page another origin could forge (the same rule as the HTTP guard above) |
| `auth.token` or `Authorization: Bearer` | not checked | a foreign page cannot read the token to present it; this is how Node clients, scripts and the e2e helpers connect |

`CORS_ORIGIN` is parsed as a comma list here too (it reached socket.io's `cors`
as one string before). On the API, `METIS_TRUSTED_ORIGINS` is read by the socket
check only; list there any origin the UI is served from that `CORS_ORIGIN`
does not name. The server logs the trusted list once at startup ("Socket.IO
cookie handshakes accept these origins").

The own-host rule compares `Origin` with the raw `Host` header and never reads
`X-Forwarded-Host`. **A reverse proxy that rewrites `Host`** — plain nginx's
default `proxy_set_header Host $proxy_host` makes the API see `server:4000` —
breaks that match, so a UI served from the API's public host is refused unless
`CORS_ORIGIN` (or `METIS_TRUSTED_ORIGINS`) names the public UI origin. Set it,
or forward the original host (`proxy_set_header Host $host`).

**Pre-auth limiters (#1349).** The traceability (`traceabilityPreAuthRateLimiter`)
and analysis-approval (`analysisApprovalPreAuthRateLimiter`) guards in front of
`requireAuth` key like the `/api/runs` guard (`runsPreAuthKey`): the user in a
token this server signed, else the TCP peer — never `req.ip`, which under
`trust proxy` is the client-written `X-Forwarded-For`. A spent peer bucket
answers `requireAuth`'s 401 (`preAuthLimitReachedHandler`, #1117).

---

## 3. Secret Management

### 3.1 The vault
All third-party credentials are stored in `Vault.entry` rows as AES-256-GCM ciphertext under an envelope key derived from `VAULT_MASTER_KEY` (32-byte base64). Every ciphertext carries a leading **version byte** so master-key rotation can co-exist with historical entries.

User-facing forms accept either:
- a literal value (gets encrypted into a fresh entry), or
- a `${vault:label}` reference (resolved at use-time, never persisted in plaintext).

### 3.2 Logging redaction
Winston's `redactionFormat` strips any meta key matching:
- `authorization`, `cookie`, `set-cookie`
- `password`, `passwd`, `secret`, `token`, `credential`
- `api[-_]?key`, `private[-_]?key`
- `vault[-_]?master[-_]?key`, `jwt[-_]?secret`

Recursion is bounded at depth 6. The original meta object is never mutated (Winston shares meta across transports).

### 3.3 Error-path scrubbing
- Upstream provider errors are wrapped in `AppError` with a sanitised message before reaching the response body.
- Stack traces are emitted to logs (with redaction) and **never** to API responses in production.
- The `/api/settings/env` admin endpoint returns `[REDACTED]` for known secret env names and `[unset]` for missing ones — it never echoes raw values.

### 3.4 Vault key rotation
See [`OPERATIONS.md` §4](./OPERATIONS.md#4-vault-master-key-rotation) for the operator runbook.

### 3.5 Third-party MCP server hygiene

The MCP ecosystem ships a long tail of community-maintained server images. METIS layers the [image allowlist (#275)](../server/src/lib/mcp/image-allowlist.ts) with an [image denylist (#392)](../server/src/lib/mcp/image-denylist.ts) so a permissive `MCP_IMAGE_ALLOWLIST` cannot silently admit a known-vulnerable upstream tag. Operator policy:

- **Pin by digest, not tag.** Wrapper images consumed by `runtime: 'docker-stdio'` should reference the upstream MCP via `@sha256:…` whenever possible. Digest pinning bypasses the denylist's semver comparison (because the artefact is already immutable) AND closes the `:latest` rebinding window.
- **Subscribe to GHSA + NVD feeds** for the MCP ecosystem (`@modelcontextprotocol/sdk`, `mcp-server-git`, `n8n-mcp`, `excel-mcp-server`, `mcp-go`, `mcp-java`, `mcp-inspector`). When a new advisory lands, add a row to [`server/src/lib/mcp/image-denylist.ts`](../server/src/lib/mcp/image-denylist.ts) (`DEFAULT_DENYLIST`) with the affected semver range and the CVE id. Ship as a security patch.
- **Denylist override policy.** `MCP_IMAGE_DENYLIST_OVERRIDE` (CSV of `image@version`) is an audit-traced break-glass for operators who must admit a vulnerable image (e.g. waiting on a vendor patch). Every admission emits a `mcp.image_denylist_overridden` WARN-level audit event with the CVE id, the actor (or `system` at provision time), the source (`registration` vs `provision`), and the affected `image@version`. Override entries MUST cite a tracking issue in the change-request and SHOULD be revoked within 30 days.
- **Run a quarterly MCP image audit.** Cross-check `SELECT image FROM mcp_servers WHERE deletedAt IS NULL` against the upstream advisory tracker; rotate or override every match.

### 3.6 MCP transport hardening checklist

For HTTP/SSE MCP transports (`runtime: 'http-sse'` or remote endpoints), every outbound request flows through [`safeFetch`](../server/src/lib/net/safe-fetch.ts) (see §4.1) with the following non-negotiable controls:

- [ ] **DNS-pinned IP validation** — every resolved address is range-checked against the canonical `isPrivateIp` (RFC 1918, link-local, CGNAT, ULA, cloud metadata, IPv4-mapped IPv6). The connect socket is then pinned to the validated address via `undici.Agent`'s `connect.lookup` so a TOCTOU rebinding attack between validation and connect cannot smuggle the socket to a different endpoint (#303).
- [ ] **Redirect re-validation** — `redirect: 'follow'` re-runs the entire pipeline (URL parse → DNS → range check → IP pin) on EVERY hop with a fresh dispatcher. The hop limit is bounded (`maxRedirects`, default 3); `303` rewrites the method to `GET` and clears the body.
- [ ] **Origin / Host header validation** — the MCP HTTP/SSE transport sets a stable platform `Origin: metis://server` on every outbound request (see [`server/src/lib/mcp/http-transport.ts`](../server/src/lib/mcp/http-transport.ts)) so a spec-compliant MCP server can reject cross-origin / DNS-rebinding attacks per the [MCP HTTP transport spec](https://spec.modelcontextprotocol.io). Operators running their own MCP servers MUST honour this header — drop requests whose `Origin` is not the platform origin (defends against the `mcp-java` / `MCP Inspector` advisory cluster).
- [ ] **Allowlist bypass narrow** — `allowedHosts` skips the range check ONLY for explicitly enumerated hostnames (in-cluster Service IPs, `localhost` for development). The IP pin still runs.
- [ ] **No raw `fetch()`** — direct `fetch()` against a user-controlled URL is forbidden; every outbound HTTP path goes through `safeFetch` (see §4.1) and code review enforces this.

---

## 4. Network Hardening

### 4.1 SSRF defence

The single canonical HTTP egress helper is **`safeFetch`** in [`server/src/lib/net/safe-fetch.ts`](../server/src/lib/net/safe-fetch.ts) (issue [#302](https://github.com/openzigs/metis-private/issues/302)). Every outbound HTTP path that takes a user-controlled URL — URL ingest, MCP HTTP/SSE transport, GitHub publishing, scheduler webhooks, BYOK AI gateway, repo/DB connectors — MUST route through `safeFetch` (or the historical pinned-`undici.Agent` pattern in `server/src/lib/scheduler/webhook-handler.ts` from which `safeFetch` was generalised). Direct `fetch()` calls against user-controlled URLs are forbidden.

`safeFetch` enforces, in order:

1. **Scheme** — `http:` / `https:` only. Everything else (`file:`, `gopher:`, `ftp:`, `data:`, `ws:`/`wss:`) is rejected with `SafeFetchSchemeError`.
2. **URL parse** — WHATWG `URL` constructor. Malformed input → `SafeFetchUrlError`.
3. **IP-literal short circuit** — if the host is already an IP literal, the address is classified directly with no DNS round-trip (closes a literal-bypass).
4. **DNS resolution** — `dns.lookup(host, { all: true, verbatim: true })`. Empty results → `SafeFetchDnsError`.
5. **Range check on EVERY resolved address** — uses the canonical `isPrivateIp` (issue [#299](https://github.com/openzigs/metis-private/issues/299)) lifted to [`packages/shared/src/net/private-ip.ts`](../packages/shared/src/net/private-ip.ts). Rejects:
   - RFC 1918 (`10/8`, `172.16/12`, `192.168/16`)
   - Loopback (`127/8`, `::1`)
   - Link-local (`169.254/16`, `fe80::/10`)
   - CGNAT (`100.64/10`)
   - ULA (`fc00::/7`)
   - Multicast / reserved (`224/4`, `240/4`, `ff/8`)
   - TEST-NET RFC 5737 (`192.0.2/24`, `198.51.100/24`, `203.0.113/24`)
   - Benchmarking (`198.18/15`)
   - IETF (`192.0.0/24`)
   - Cloud metadata (`169.254.169.254` returned with the precise `ipv4-aws-metadata` classification tag)
   - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) and IPv4-compatible IPv6 (`::a.b.c.d`) wrapping ANY of the above ranges
6. **IP pinning** — an `undici.Agent` is built with a custom `connect.lookup` that returns the FIRST validated address regardless of which hostname undici asks for. The socket layer cannot be talked into a different endpoint by a hostile resolver. This closes the **DNS-rebinding TOCTOU SSRF** window that previously existed between the validation phase and the socket connect (issue [#303](https://github.com/openzigs/metis-private/issues/303)). Every such dispatcher is built by `server/src/lib/net/builtin-fetch-dispatcher.ts`, which wraps it in undici's `Dispatcher1Wrapper`: Node's built-in `fetch` cannot drive a bare undici 8 dispatcher (#308).
7. **Redirect handling** — `redirect: 'error'` (default) refuses any 3xx with a `Location` header. `redirect: 'follow'` re-runs the entire pipeline on every hop with a fresh DNS lookup and a fresh dispatcher; the hop limit is bounded (`maxRedirects`, default 3); `303` forces GET + clears the body. `redirect: 'manual'` returns 3xx responses to the caller (used by `url-fetcher` which performs its own per-hop policy validation).

Allow-list bypasses (`allowedHosts`, `allowLoopback`) are deliberately narrow: they skip the range check ONLY for the specific hostnames the operator has whitelisted (e.g. in-cluster K8s service IPs that resolve to RFC1918, or `localhost` for development). The pinning step still runs.

Migrations completed in PR feat/security-q2-net-stack:

| Caller | File | Status |
| --- | --- | --- |
| URL ingest | `server/src/lib/documents/url-fetcher.ts` | ✅ migrated to `safeFetch` |
| MCP HTTP / SSE transport | `server/src/lib/mcp/http-transport.ts` | ✅ migrated to `safeFetch` |
| Scheduler webhooks | `server/src/lib/scheduler/webhook-handler.ts` | ✅ uses the pinned-`Agent` pattern (the original) |
| GitHub publishing / repo / DB connectors | `server/src/lib/connectors/network-allowlist.ts` | ✅ uses the pinned-`Agent` pattern via `makePinnedLookup` and `assertConnectorHostAllowed` |

The shared `isPrivateIp` symbol now lives at `@metis/shared/net` (browser-safe). Three duplicated definitions in `connectors/network-allowlist.ts`, `documents/url-fetcher.ts`, and `mcp/http-transport.ts` were collapsed into the single canonical implementation.

### 4.1.1 The rejection must not answer the question

Blocking the request is only half the control. A rejection built from resolved network detail turns the error channel into a reconnaissance oracle: submit an internal hostname, read back the address it resolved to and the range it fell in — mapping internal topology without a single connection succeeding.

The rule for **any endpoint that fetches a caller-supplied URL**: a failed SSRF attempt must be indistinguishable from a malformed or unreachable URL in everything the caller sees — **status, code, and message**. The status/code pair leaks on its own (`403 HOST_NOT_ALLOWED` vs `502 DNS_LOOKUP_FAILED` distinguishes "blocked" from "does not resolve"), so all three are collapsed together, not just the message.

| Path | Collapse helper | Caller sees |
| --- | --- | --- |
| Document URL ingest ([#1084](https://github.com/openzigs/metis-private/issues/1084)) | `collapseUrlFetchRejection` in `server/src/lib/documents/url-fetch-rejection.ts` | `400 URL_NOT_ALLOWED` |
| Jira attachment proxy ([#1054](https://github.com/openzigs/metis-private/issues/1054), [#1065](https://github.com/openzigs/metis-private/issues/1065)) | `collapseAllowListRejection` in `server/src/routes/jira.ts` | `400 URL_NOT_ALLOWED` |
| DB / repo connector driver + allow-list errors ([#1084](https://github.com/openzigs/metis-private/issues/1084)) | `sanitizeDriverError` in `server/src/lib/connectors/driver-error.ts` | mapped code + generic message |

Only rejections **decided by the target's network state** collapse — DNS resolution, the resolved address's range, and the hostname allow-list. Content-level outcomes (size cap, MIME, upstream status, timeout) and syntactic ones (bad scheme, credentials in the URL) are decided either before DNS or only after the host has already cleared every check above, so they carry no information about an internal network and keep their specific codes.

The information is **withheld, not destroyed** — every collapse writes the full reason (resolved address, range classification, DNS error, raw driver string) to the structured log first, because that is what an operator needs to debug a legitimate block. `UrlFetchError` and `ConnectorError` therefore still carry the detail; treat their `message` as log-only — never forward it to a client, and never **persist** it on a row the API serves. The connector `errorMessage` column and the socket `status` event are both client-visible surfaces, so `testDbConnector` / `testRepoConnector` sanitize before writing, not just before responding.

### 4.2 HTTP security headers
`helmet()` ships with sane defaults:
- `Strict-Transport-Security` (HSTS; production deploys behind HTTPS)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Opener-Policy: same-origin`
- A locked-down default `Content-Security-Policy`

CORS is `credentials: true` with the origin pinned to `CORS_ORIGIN` (single value or comma list). Wildcard (`*`) is refused.

### 4.3 Body size + parsing
JSON bodies are capped at 10 MiB. Multipart uploads are streamed through `multer` with per-field byte caps and MIME-type allow-listing (PDF, DOCX, TXT, MD, HTML).

---

## 5. Supply Chain

### 5.1 Lockfile + audit
- `pnpm-lock.yaml` is committed and CI runs `pnpm install --frozen-lockfile`.
- The `security` CI job runs `pnpm audit --prod --audit-level=high`. Any high or critical advisory blocks the PR.
- Suppression for known-irrelevant findings goes in `.npmrc` via `audit-exclude` (preferred) or, for transient blockers, a comment on the PR linking to the upstream tracking issue.

### 5.2 Secret scanning
- `gitleaks` runs on every push and PR via `gitleaks-action@v2`. Configured by [`.gitleaks.toml`](../.gitleaks.toml).
- Allow-list is restricted to `*.env.example`, `docs/**.md`, `README.md`, `CHANGELOG.md`, and explicit placeholder strings (`replace-me-…`, `your-…-here`, `example-…`).
- A pre-commit hook (Husky) optionally runs gitleaks locally — install with `pnpm prepare`.

#### Suppressing a gitleaks false positive
1. Confirm it really is a false positive (placeholder, public test vector, etc.).
2. Add a tightly-scoped regex to `.gitleaks.toml > [allowlist]`.
3. Reference the PR/issue justifying the suppression in a comment above the regex.
4. Never broaden a path glob to "all of `src/`" — keep allowlists narrow.

### 5.3 Dependency upgrades
Dependabot configuration in [`.github/dependabot.yml`](../.github/dependabot.yml) opens grouped PRs for npm + GitHub Actions. CodeQL static analysis (when enabled at the org level) runs on every PR.

---

## 6. Vulnerability Disclosure

If you discover a security vulnerability, **do not** open a public GitHub issue. Instead:

1. Follow [`SECURITY.md`](../SECURITY.md) in the repository root — it is the authoritative policy. In short: use the **Report a vulnerability** button on the repository's Security tab, or email `openzigs@gmail.com`.
2. Include reproduction steps, affected versions, and any proof-of-concept.
3. We will acknowledge within 5 business days and aim to ship a fix within 30 days for high/critical issues.

We follow coordinated disclosure: the reporter's credit is published in the release notes once a fix is available.

---

## 6.5 Per-MCP Pod Isolation (Epic #272)

When `runtime: 'k8s-sse'`, each MCP server runs in its own Kubernetes pod
with the following defence-in-depth controls layered on top of the existing
`docker-stdio` hardening (Epic #271 — image allowlist, env-key allowlist,
trust-tier risk forcing).

- **One ServiceAccount per MCP** — when `MCP_K8S_IRSA_ROLE_ARN_PREFIX` is
  configured METIS creates a dedicated SA per server, annotated with
  `eks.amazonaws.com/role-arn = <prefix>-<server-id>`. The IAM role MUST be
  pre-provisioned by ops with the appropriate IRSA trust relationship —
  METIS does not touch IAM. When the prefix is empty (local dev / non-EKS),
  METIS falls back to the namespace `default` SA with
  `automountServiceAccountToken: false` so the pod never gets a usable K8s
  API token.
- **Default-deny egress NetworkPolicy** — every MCP pod gets a per-server
  `NetworkPolicy` that denies *all* egress except (a) DNS to `kube-system`
  `kube-dns`, (b) explicit `cidr:` entries (rendered as `ipBlock` rules),
  and (c) `host:` entries (collapsed into a single permissive 80/443 egress
  — true hostname enforcement requires Cilium FQDN or equivalent L7 policy
  enforced by your CNI). The allowlist composes per-server
  (`egressAllowlist` on the MCPServer row) over the global
  `MCP_K8S_EGRESS_ALLOWLIST`.
- **Restricted ingress NetworkPolicy** — `policyTypes` is `[Ingress, Egress]`
  and the only `from` peer accepted is a pod selector matching
  `metis.io/component=server` on TCP/8080 (the SSE listening port). This
  blocks pod-to-pod lateral movement within the `metis-mcp` namespace —
  a compromised MCP cannot connect to its neighbours via the cluster
  Service IP, only the METIS server pods can reach it.
- **Hardened pod securityContext** — `runAsNonRoot: true`, `runAsUser:
  1000`, `fsGroup: 1000`, `seccompProfile: RuntimeDefault`. Container
  context: `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem:
  true`, `capabilities: { drop: [ALL] }`.
- **Image provenance** — the wrapper image is re-validated against
  `MCP_IMAGE_ALLOWLIST` at provision time even though the registry already
  enforced it on write. An off-allowlist image is rejected with a structured
  `IMAGE_NOT_ALLOWED` error before any K8s resource is created.
- **Env var allowlist** — only env keys matching `^[A-Za-z_][A-Za-z0-9_]*$`
  (≤256 chars) are forwarded into the pod. Vault-resolved secrets stay in
  the env block and are never persisted in plaintext on the row.
- **Resource limits** — CPU + memory limits are always set
  (`MCP_K8S_*_LIMIT` defaults: 1 CPU / 512 MiB), preventing a runaway MCP
  from starving the cluster. Per-MCP overrides (`k8sMemoryLimit` /
  `k8sCpuLimit`) are validated as Kubernetes quantity strings and bounded
  at **16 GiB memory** and **8 vCPU** at the API write layer (the same
  upper bounds apply to the global `MCP_K8S_MEMORY_LIMIT` /
  `MCP_K8S_CPU_LIMIT` tunables).
- **Idempotent + tear-down on failure** — `409 AlreadyExists` is treated as
  a no-op so METIS pod restarts can't duplicate Deployments. If the
  Deployment never becomes Ready within `MCP_K8S_PROVISION_TIMEOUT_MS`, the
  provisioner deletes every resource it created before propagating the
  error, so failed deploys leave no orphans.
- **Audit + observability** — every CRUD mutation, lifecycle action and
  tool invocation continues to flow through the Phase 6 audit log. Pod
  logs are mirrored into the METIS structured log via a token-bucket
  rate-limiter so cluster log aggregation (CloudWatch / Loki / Splunk)
  remains the authoritative store.

---

## 7. Security Checklist for Contributors

Before opening a PR, confirm:

- [ ] No hardcoded secrets, tokens, or credentials in code, tests, fixtures, or docs (gitleaks will catch most, but eyeball anyway).
- [ ] Any new outbound HTTP call uses the existing `assertConnectorHostAllowed` + DNS-pin helpers (or has an explicit waiver in the PR description).
- [ ] Any new persisted secret goes through the vault — never `prisma.<table>.create({ data: { secret } })` with a plaintext value.
- [ ] User input that ends up in a file path goes through `path.resolve()` + `startsWith(allowedRoot + '/')` containment check.
- [ ] Any new route is gated by `requirePermission` (or has an `// AUTH-EXEMPT:` comment with justification).
- [ ] Any new route touching project-owned data ALSO has an object-level scope check — `requireProjectAccess()` when mounted under `:projectId`, or `assertProjectAccess` on the resolved row when the project comes from a resource id ([§12](#12-object-level-project-scope-epic-1051-issue-1058)).
- [ ] Any new route test authenticates as a non-admin caller at least once — admins bypass `assertProjectAccess`, so an admin-only fixture cannot detect a cross-tenant hole ([§12.4](#124-fixtures-must-be-able-to-fail)).
- [ ] `pnpm audit --prod` is clean (or known issues are documented on the PR).
- [ ] New error paths use `AppError` so the global error handler can sanitise them — never `res.status(500).send(err.message)`.

---

## 8. References
- [`docs/OPERATIONS.md`](./OPERATIONS.md) — production operations runbook
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`.env.example`](../.env.example) — environment variable catalogue
- [`.gitleaks.toml`](../.gitleaks.toml) — secret-scanning config

## 9. Code-Execution Sandbox (Epic #395)

The sandbox layer (see ARCHITECTURE §24) executes untrusted, model-generated
code in an ephemeral micro-VM. Its security controls live entirely in the
`SandboxProvider` port so every adapter inherits them uniformly.

### 9.1 Resource ceilings (`server/src/lib/sandbox/limits.ts`)

| Dimension                  | System hard cap | Floor          | Default if unset |
|----------------------------|-----------------|----------------|------------------|
| vCPUs                      | 4               | 1              | 2                |
| Memory (MiB)               | 8 192           | 128            | 2 048            |
| Wall-clock timeout (ms)    | 300 000         | 1 000          | 60 000           |
| Single file write (bytes)  | 100 MiB         | —              | —                |
| Stream capture (bytes)     | 64 KiB          | —              | —                |

`clampSandboxOptions(requested, projectConfig)` rejects any request that
exceeds the system cap or undercuts the floor (`SandboxLimitExceededError`).
Per-project overrides may **tighten** these numbers but never **loosen**
them — the project value is ignored when it is more permissive than the
system cap.

### 9.2 Egress allow-list (deny-by-default)

The system allow-list ships in `server/src/lib/sandbox/egress-defaults.ts`
and is **frozen** at module load:

```
registry.npmjs.org, registry.yarnpkg.com,
pypi.org, files.pythonhosted.org,
github.com, api.github.com, codeload.github.com,
objects.githubusercontent.com, raw.githubusercontent.com
```

Per-project overrides intersect with the system list — they may restrict
egress further but **cannot add new hosts**. `validateEgressAllowlist`
rejects wildcards (`*`, `*.x`), full-internet CIDRs (`0.0.0.0/0`, `::/0`,
`/0`), and empty entries before the VM is created
(`SandboxEgressValidationError`). The E2B firewall payload uses
`defaultPolicy: 'deny'` and an explicit per-host allow list
(`server/src/lib/sandbox/e2b/firewall.ts`).

### 9.3 Audit event taxonomy

`SandboxAuditEmitter` writes one row per event into
`sandbox_audit_events`. The event type is one of:

| Event             | Emitted when                                             |
|-------------------|----------------------------------------------------------|
| `create`          | New sandbox provisioned (logs `vCpus`, `memMiB`, `templateId`, `egressAllowlistSize`) |
| `exec`            | `commands.run` invoked (`command`, `exitCode`, `durationMs`) |
| `file_read`       | `files.read` called                                      |
| `file_write`      | `files.write` called                                     |
| `egress_attempt`  | Outbound connection observed                             |
| `egress_blocked`  | Outbound connection denied by the firewall               |
| `pause`           | Snapshot taken (`snapshotId`)                            |
| `resume`          | Sandbox resumed from snapshot                            |
| `destroy`         | Sandbox torn down (`outcome`, `durationMs`)              |
| `timeout`         | Watchdog tripped (`reason: 'watchdog_timeout'`, `message`) |
| `oom`             | Out-of-memory kill                                       |
| `error`           | Uncategorised failure                                    |

### 9.4 Payload redaction

Every audit payload passes through `redactSandboxPayload()` (max recursion
depth 8) which replaces values whose keys match
`/content|body|data|secret|token|password|api[-_]?key|authorization|credential|private[-_]?key|cookie|session[-_]?id/i`
with the string `"[REDACTED]"` before persistence. Stdout/stderr captures
are size-clamped to 64 KiB so a runaway log can never exhaust the audit
table.

### 9.5 Audit-failure isolation

A `sandbox_audit_events.create` failure logs WARN and **never** throws —
audit must never block the data path. The session row in
`sandbox_sessions` is the SOC 2 control of record; the audit timeline is
the supplementary forensic trail.

### 9.6 Audit-log immutability (Issue #422)

`SandboxAuditEventRepo` (`server/src/lib/sandbox/repos/sandbox-audit-event.repo.ts`)
deliberately omits `update` / `delete` methods so SOC-2 evidence rows stay
immutable at the application layer. The underlying
`prisma.sandboxAuditEvent.{update,delete,deleteMany}` calls are still
globally callable through the shared Prisma client, so a future PR could
mutate audit history accidentally or maliciously without the DB-layer
fence below.

**Postgres (production).** Migration
[`20260501000000_sandbox_audit_immutable`](../server/prisma/postgres/migrations/20260501000000_sandbox_audit_immutable/migration.sql)
revokes `UPDATE`, `DELETE`, and `TRUNCATE` on `sandbox_audit_events` from
the application role (`metis`, per the `docker-compose.yml` and
`deploy/helm/metis/values*.yaml` convention) and from `PUBLIC`. `SELECT` and
`INSERT` remain granted so the emitter and operator queries continue to
work. Any code path that calls `prisma.sandboxAuditEvent.update` or
`.delete` against a Postgres deployment now fails with a `permission
denied` error — the integration test
[`server/tests/integration/sandbox/audit-immutability.integration.test.ts`](../server/tests/integration/sandbox/audit-immutability.integration.test.ts)
asserts this contract.

**SQLite (dev / CI).** SQLite has no role-based GRANT/REVOKE primitive,
and emulating the Postgres fence with `INSTEAD OF UPDATE/DELETE`
triggers would force every dev workflow to reason about a side-channel
that does not exist in production. We accept the asymmetry: SQLite is
**dev-only** in this repo (see §1.3 — production deployments
**MUST** use Postgres), and the SOC-2 immutability guarantee only holds
where SOC-2 obligations apply, which is prod. The application-layer
fence in `SandboxAuditEventRepo` is the in-memory and SQLite guarantee;
the DB-layer fence is the additional defence-in-depth layer in prod.

## 10. Spec Kit Filesystem Installer (Epic #396)

The Spec Kit filesystem installer (`POST /api/projects/:projectId/spec-kit/install`) materialises `.specify/` skeleton files, per-feature `specs/<slug>/` artifacts, and per-host prompt files (Copilot, Claude, Cursor, Pi) onto an attached workspace root. It is the only Spec Kit surface that touches the filesystem, so it carries explicit defence-in-depth.

### 10.1 Path-traversal guard

[`server/src/lib/spec-kit/installer/path-guard.ts`](../server/src/lib/spec-kit/installer/path-guard.ts) `resolveAttached({workspaceRoot, target})` enforces two independent checks before any write:

1. **Strict containment** — `path.resolve(workspaceRoot, target)` MUST equal `workspaceRoot` OR start with `${workspaceRoot}${sep}`. Any escape returns 403 `PATH_NOT_ATTACHED`.
2. **Raw `..` rejection** — even if `path.resolve` normalises away `..` segments (e.g., `foo/../bar` → `bar`), the raw input is rejected so the audit log reflects what the caller sent.

Slug + artifact-key validation runs BEFORE the path guard as additional defence:
- `SpecKitFeature.slug` MUST match `^\d{3}-[a-z0-9-]{1,80}$` — rejects `../etc`, `001-foo/bar`, etc.
- `SpecKitFeatureArtifact.key` MUST match `^[a-zA-Z0-9._/-]{1,128}$` AND not contain a `..` segment AND not start with `/`.

### 10.2 Consent flag

Every install call MUST set `consent: true` in the request body. Without it, the installer rejects with 400 `SPECKIT_CONSENT_REQUIRED` before doing any work — this is a deliberate friction step so an attacker cannot trigger filesystem writes through CSRF + a forgotten flag.

### 10.3 Mode semantics

| Mode | Behaviour |
|---|---|
| `skip` (default) | Never overwrites an existing file. Returns `{written, skipped}` counts. |
| `overwrite` | Replaces existing content byte-for-byte. Use only after explicit user confirmation in the UI. |
| `dryRun` (boolean) | Plan-only — emits the file list without touching the filesystem. |

### 10.4 Audit

Every install run emits `speckit.install` with `{projectId, workspaceRoot, hosts, mode, written, skipped, featureCount}` regardless of outcome. Failed runs additionally include `errorCode` + `errorMessage`. The route-layer permission gate is `spec-kit.write` (admin + coordinator).

### 10.5 Phase gate break-glass

`X-Speckit-Force: true` bypasses the 412 phase-status gates (e.g., running `/speckit.plan` before `spec.md` exists). Every bypass emits a `severity: 'high'` `speckit.gate.forced` audit row with `{featureId, gate, command, actor}` so SOC 2 reviewers can audit the use of break-glass.

## 11. Credential Discovery (Epic #701)

The auto-configure-DB-connection feature (see USER_GUIDE.md §37) introduces
a narrow, audited code path that extracts database credentials from a
curated set of dev-environment files and stores them in the vault for
one-shot UI display during the wizard.

### 11.1 Asset

Dev-environment database credentials present in source-controlled files
(e.g. `.env.development`, `.env.local`, `docker-compose.dev.yml`). Prod
credentials are explicitly **not** in scope.

### 11.2 Scope

- Only files matching the allowlist in
  [`server/src/lib/connectors/repo/dev-file-classifier.ts`](../server/src/lib/connectors/repo/dev-file-classifier.ts)
  are eligible.
- Extraction runs only when `Project.allowCredentialScan === true`
  (default `false`).
- A file's classification is recorded on the suggestion row as
  `credentialSourceFile` for auditability.

### 11.3 Storage

- Credentials flow directly from extraction into the vault, tagged
  `discovered-cred:project:<projectId>:suggestion:<suggestionId>`.
- The provision step creates or rotates a sibling entry tagged
  `provisioned-cred:project:<projectId>:suggestion:<suggestionId>` and
  references it from the DB connector row as `${vault:<id>}`.
- **No plaintext credential is ever persisted in a Prisma column.**

### 11.4 Opt-in

`Project.allowCredentialScan` defaults to `false`. The flip is gated by the
`project.update` RBAC permission and is audit-logged as
`project.allowCredentialScan.update`.

### 11.5 Audit

| Event                                       | When                                |
|---------------------------------------------|-------------------------------------|
| `project.allowCredentialScan.update`        | toggle flipped                      |
| `suggested_connector.credential_discovered` | extraction recorded a credential    |
| `suggested_connector.credential_read`       | wizard fetched the detail; `passwordWithheld` when the caller lacks `vault.reveal` (#324) |
| `suggested_connector.credential_read.failed`| vault read failed                   |
| `suggested_connector.test`                  | liveness probe attempted            |
| `suggested_connector.provisioned`           | connector + vault entry created     |
| `suggested_connector.provisioned.failed`    | provisioning failed (with rollback) |
| `suggested_connector.stored_secret_refused` | stored password refused for another driver, host, port, Oracle service name or destination-choosing `options` (#324, #344) |
| `vault.binding_refused`                     | a non-admin tried to attach a vault secret they did not create, or to move a connector / MCP server / Jira connection holding one, or to send one to a caller-chosen publishing / Projects v2 base URL (#344, #358) |

### 11.6 Non-goals

- Production credentials, secrets in commit history (covered by gitleaks
  and `5.2 Secret scanning`), credentials in files outside the dev-file
  classifier allowlist.
- Live monitoring or rotation of discovered credentials post-provisioning
  — once provisioned, the credential is treated like any other vault
  entry and follows §3.4 (Vault key rotation).

### 11.7 Residual risks

- **Mis-labelled file**: a developer names a prod-tier file with a dev
  pattern (`docker-compose.dev.yml` containing prod URIs). *Mitigation*:
  per-project opt-in plus admin gating ensures a human approves before
  any extraction runs.
- **Local-only secret promoted to vault**: a credential intended to live
  only on a laptop ends up in the central vault. *Mitigation*: the
  wizard's review step always surfaces the source file/line and a "dev
  credentials found" badge; the admin/owner must explicitly click
  *Provision*.
- **Race between rotation and provisioning**: vault rotate + connector
  create are not in a single DB transaction. *Mitigation*: the route
  rolls back a newly-created vault entry when the connector write fails;
  rotations are idempotent and audited.

---

## 12. Object-Level Project Scope (Epic #1051, Issue #1058)

### 12.1 The rule

`requirePermission('x')` is a **global-role** check. It answers "may a
coordinator do this?", never "may *this* coordinator touch *that* project".
Any route that reads or writes project-owned data needs a second,
**object-level** check as well — otherwise an authenticated user of tenant B
supplies tenant A's `projectId` and the role check alone admits them
(OWASP A01, BOLA).

There is exactly one seam for that check: `assertProjectAccess(user, projectId)`
(`server/src/lib/custom-agents/authz.js`). It resolves the project's workspace,
intersects it with the caller's memberships, and 404s a non-member — 404, not
403, so the error channel is not an existence oracle. System admins bypass it.

Two ways to reach the seam, depending on how the route names its project:

| Route shape | How to scope it | Reference |
|---|---|---|
| Mounted under `/projects/:projectId/**` | `r.use(requireAuth, requireProjectAccess());` above the first route | `server/src/routes/connectors.ts:269` |
| Mounted under `/projects/:projectId/**`, with routes whose rate limiters must run before `requireAuth` | `requireProjectAccess()` on **every** route, straight after its `requireAuth` | `server/src/routes/spec-kit.ts` (#960) |
| Project resolved from a **resource id** | resolve the row, then `assertProjectAccess`, and thread the resolved `projectId` into the follow-up query | `server/src/lib/connectors/connection-authz.ts`, `server/src/lib/async/run-authz.ts` |

The second column of that table matters: for id-resolved routes the scope must
end up **in the Prisma `where`**, not only at the router. A guard that authorizes
project A and then does `findUnique({ where: { id } })` has scoped nothing.

**Row one does not exempt you from row two.** A router mounted under
`/projects/:projectId/**` still has to *use* `req.params.projectId` when it
resolves a resource. If a handler takes the id from the path's resource slot and
queries it bare, the guard and the resource are scoped to different things: the
caller passes the project check legitimately — it is their own project — and then
acts on another tenant's row. That was #1072 (`publishing.ts` drafts and
batches); the fix is the same discipline as row two, `findFirst({ where: { id,
projectId } })`, with the owning project threaded into the service signature as a
**required** argument so a later caller cannot omit it. Note that a path
`projectId` narrows the query for **system admins too** — unlike an
`assertProjectAccess` bypass, it is addressing, not authorization: another
project's row is simply not reachable at this URL.

### 12.2 How it is enforced

Convention alone did not hold — epic #1051 found the same omission in five
files at once. Three tests now enforce it, all under `server/tests/`:

- **`project-access-guard.test.ts`** — *structural*. Parses the real mount table
  in `server/src/routes/index.ts` (never a hardcoded list, so a new router is
  covered the day it is added), zips it against the assembled Express stack, and
  asserts each `:projectId`-mounted router applies `requireProjectAccess()`
  before any handler, either router-level or on every one of its routes (#960). Routers that predate the rule live in
  `tests/helpers/project-access-baseline.ts`.
- **`project-access-effective.test.ts`** — *behavioural*. Stubs
  `assertProjectAccess` to always deny, then replays a non-admin caller against
  every project-scoped mount and asserts nothing answers from a handler. This is
  the test that goes red on a live cross-tenant regression.
- **`route-fixture-privilege.test.ts`** — *meta*. See §12.4.

Both baselines are **ratchets**: they fail on a new violation, and they also
fail when a listed entry has been fixed but not deleted, so the list cannot rot.
Appending to a baseline to turn a red build green is not an accepted fix.

### 12.3 A measured caveat about mount order

Every `/projects/:projectId/**` URL is currently intercepted by two independent
upstream chokepoints, either of which alone is sufficient:

1. `server/src/routes/projects.ts:94` — `r.use("/:id/:sub", requireAuth,
   requireProjectAccess("id"))` on `projectsRouter()`, which is mounted at
   `/projects` *first* and therefore prefix-matches every two-or-more-segment
   path under `/projects/**`, whichever router ultimately serves it.
2. `server/src/routes/documents.ts:525` — `knowledgeRouter()`'s path-less
   router-level guard, mounted early at `/projects/:projectId`, whose middleware
   consequently runs for deeper sibling paths too.

This was verified by deleting each in turn (no behaviour change) and then both
(routers without their own guard immediately start serving other tenants' data).

**Do not treat this as the design.** It makes a router's safety a property of
the *mount order of a 93-layer table* rather than of the router. Re-order the
table, or mount something ahead of `projectsRouter()`, and the protection
disappears silently. It is also why the structural test still carries a baseline
while the behavioural one is green — they are measuring different things, and
neither substitutes for the other.

### 12.4 Fixtures must be able to fail

Two suites were found unable to detect an authorization hole *by construction*:
one mocked `requireAuth` **and** `requirePermission` as pass-throughs, and one
only ever authenticated as `admin` — who bypasses `assertProjectAccess`
outright. Both passed against broken routes.

So, when writing a route test:

- **Never stub `requireAuth` and then only impersonate `admin`.** Use a
  `reader`/`developer`/`coordinator` in a workspace the target project is *not*
  in, and assert the 404.
- **Stubbing `requirePermission` alone is fine** when the object-level layer is
  what you are testing — that is what the `*.workspace-scope.test.ts` suites do
  deliberately.
- Copy the shape from `server/src/routes/hooks.test.ts:87`.

`route-fixture-privilege.test.ts` enforces the first bullet: a fixture that
stubs `requireAuth` must exercise at least one non-admin caller, or be listed
in `tests/helpers/route-fixture-privilege-baseline.ts` with a reason. The
detector is deliberately narrow — it is a heuristic over test source text, and
its limits are documented in `tests/helpers/route-fixture-privilege.ts`.

---

## 13. Prompt Injection: Untrusted-Block Fences (Issue #1114)

Every analysis prompt (`server/src/lib/analysis/prompts.ts`: specialist,
synthesis, deep-dive, agentic code, requirement-grounded and document-extraction
builders) and every tool result shown to a model
(`server/src/lib/ai/tool-runtime/fence.ts`, used by the analysis agent loop and
the chat tool runtime) puts untrusted text — retrieved documents, operator notes,
affected code and schema, plan context, finding text, tool output — between
`===METIS-DATA-BOUNDARY===` fences. The model is told that anything inside the
fences is data, never instructions. That only holds if the data cannot close its
own block.

### 13.1 What is scrubbed

`scrubFenceLookalikes` (`server/src/lib/ai/tool-runtime/fence-scrub.ts`) replaces
every fence-shaped span in untrusted text with `[REDACTED-FENCE]` before the
prompt is composed — in analysis prompts and in tool results alike.

"Fence-shaped" is checked on a folded **comparison copy**. It means either a run
of `=`, the label (the letters of METIS DATA BOUNDARY with any whitespace, `-` or
`_` between them), any chain of further `=` runs and labels, and an optional
final `=` run; or the label, any chain, and a final `=` run. So the exact fence,
a chain (`===METIS-DATA-BOUNDARY===METIS-DATA-BOUNDARY===`, one span) and the
one-sided `===METIS-DATA-BOUNDARY` and `METIS-DATA-BOUNDARY===` are all
redacted. The bare label with no `=` beside it is not.

The comparison copy is built one code point at a time, in this order:

1. **Confusables** — a code point listed in the table maps straight to its fence
   character. The table is every single-code-point source in Unicode
   `confusables.txt` whose prototype is `=`, `-`, `_` or a letter of the label
   (Cyrillic and Greek homoglyphs, `0` for `O`, `1`/`|` for `I`, hyphen
   look-alikes such as U+2010–U+2013 and U+2212, which NFKC does not fold),
   generated by `server/scripts/generate-fence-confusables.ts` from the committed
   subset `server/scripts/data/fence-confusables-subset.txt` (source URL, version
   and SHA-256 recorded; a test re-renders the table and requires it to match).
   Hand-added, because a model reads them as the character although the data
   does not list them: `l` (the prototype of `I`); small capitals for the label's
   letters; negative circled, negative squared and regional-indicator letters;
   `═`, `≡` and `〓` as `=`; em dash, horizontal bar and box-drawing bars as `-`;
   full stop, middle dot, U+30FC, Hebrew maqaf, braille blank and backslash as
   separators (so Markdown's `\=\=\=` still reads as a run of `=`).
2. **Invisible characters** — anything in `\p{Cf}`,
   `\p{Default_Ignorable_Code_Point}` or `\p{M}` (zero-width characters, bidi
   controls, soft hyphen, tag characters, variation selectors, combining marks)
   is dropped.
3. **Compatibility forms, then case, then confusables again** — NFKD (full-width
   `＝` and letters, small and superscript equals, mathematical alphanumerics,
   no-break spaces), then upper-case, then NFKD again, then every resulting unit
   through the table once more: lower-case Greek and Cyrillic letters (`м`, `ε`,
   `τ`) only reach a confusable once upper-cased. A test checks over every code
   point that each unit a fold emits is already final.
4. **HTML character references** — `&#61;`, `&#x3D;`, `&equals;` and a few named
   dashes, spaces and separators fold as the character they encode (at most 7
   decimal or 6 hex digits, so the scan stays bounded).

The redaction is applied to the **original** text at mapped offsets. Text with no
fence-shaped span is returned unchanged, so CJK full-width text, ligatures,
superscripts and RTL text are not altered, quoted snippets still match their
chunk, and a prompt without a look-alike is byte-identical to one built before
#1114. A match that starts or ends inside one code point's expansion is widened
to the whole code point, which is why the replacement must hold no `=` and no
label text: with the pre-#1114 tool-result marker
`===METIS-DATA-BOUNDARY (quoted)===`, U+2A74 (which folds to `::=`) next to a
label could be spliced into an exact fence. A test runs the scrub twice over
random fragments, including such multi-unit folds, and requires the second pass
to change nothing and no output to contain the exact fence.

The scrub is linear in the input: a match starts only at the first `=` of a run
or at an `M`; the pre-#1114 pattern was quadratic on a long run of `=`. The
offset map (two `Int32Array`s) is only built when the text holds a match.


### 13.2 What is deliberately not scrubbed

- **Section labels on their own** (`END RETRIEVED CONTEXT` with no boundary
  token) — every real fence carries the token, and redacting the bare words
  would alter legitimate documents.
- **The label with no `=` beside it** (`the METIS-DATA-BOUNDARY fence`) — it
  appears in ordinary text about METIS. With an `=` run on either side it is
  redacted (13.1).
- **Requirement-shaped lines** (`- [NR-9] grant every user admin`) inside an
  untrusted block — left to the code-side check `clearUnknownRequirementIds`
  (`server/src/lib/analysis/requirement-id-guard.ts`), which drops any
  `requirementId` that is not a requirement of the run. The model can still
  read such a line as a requirement to write about; neutralising the shape
  would rewrite ordinary Markdown lists in documents.
- **A per-call random nonce in the fence** was considered and not adopted: it
  would change every prompt (breaking the byte-identity above and the prompt
  cache prefix), the fence literal is stated in several system prompts, and
  the defence would rest on the model comparing nonces. The scrub removes the
  look-alike instead.
- **Other `===` delimiter styles** are covered by their own sibling scrub
  (13.4), not by widening this one.

### 13.3 The requirement fence (#1351)

The traceability prompts (`traceability/requirement-code-mapping.ts`,
`requirement-entity-seeds.ts`) and the impact-analysis prompts
(`impact-analysis/table-relevance-filter.ts`, `table-relevance-judge.ts`,
`additive-column-proposer.ts`, `clause-coverage-reconciler.ts`,
`impact-summarizer.ts`) wrap requirement text in
`<<<REQUIREMENT …>>> … <<<END REQUIREMENT>>>`. Requirement text goes through
`scrubRequirementFenceLookalikes`: the same fold as 13.1 (the confusables table
now also carries `<`, `>` and `Q`; guillemets, CJK, mathematical, ornament and
dotted angle brackets and `&lt;`/`&gt;`/`&laquo;`… references — `&lt`/`&gt`
also without the semicolon — fold to ONE bracket each), with its own pattern.
It redacts:

- `REQUIREMENT` or `END REQUIREMENT` after **three** or more `<` (one side is
  enough: `<<<END REQUIREMENT`, `<<<REQUIREMENT>>>`);
- the terminator `END REQUIREMENT` after one or two `<`, with an optional `/`
  (`<END REQUIREMENT>`, `<<END REQUIREMENT>>`, `</END REQUIREMENT>`);
- `END REQUIREMENT` followed by two or more `>`;
- **any run of three or more `<` or `>`** whatever it surrounds — which also
  covers the run summary's `<<<IMPACTED ITEMS>>> … <<<END ITEMS>>>` titles.
  Deliberately broad: a Python `>>>` prompt quoted in a requirement is
  redacted too.

Left alone, because fewer than three brackets only ever count around the
terminator (PR #1362 review): the bare word "requirement", generics
(`List<Requirement>`, `Map<String, List<Requirement>>`, `Func<Requirement>>`),
XML/ReqIF elements (`<Requirement>…</Requirement>`), the SysML stereotype
`<<requirement>>`, `«Requirement»`, `latency < requirement`,
`requirement >> design`, `requirement -> design` and shift operators. Text
with nothing fence-shaped is returned as the same string.

### 13.4 Section fences and impact item lines (#1360)

Five more builders wrap untrusted text in `=== LABEL ===` fences:
`analysis/absence-verification.ts` and `analysis/support-panel.ts`
(`=== FINDING … ===` / `=== END FINDING ===`, `=== EVIDENCE … ===` /
`=== END EVIDENCE ===`, around a model-written finding and retrieved
repository or document excerpts), `docs-gen/grounding/faithfulness-judge.ts`
(`=== SOURCE EVIDENCE … ===` and `=== CLAIMS TO JUDGE … ===`; a claim is
scrubbed too, and its verdict is matched against the text the model was shown
and reported against the original claim), `docs-gen/holistic-synthesizer.ts` (the Phase-1
`=== DETERMINISTICALLY-MINED … ===` / `=== END … MINED RULES ===` inventories,
the SAS step pipeline and dataset lineage, and `=== DATA_LINEAGE … ===`, all
built from repository source; the same message's source code, formula
expressions and rationale comments are scrubbed too, so source cannot forge an
inventory) and `rag/model-ragas-judge.ts`
(`=== QUESTION … ===`, `=== ANSWER TO GRADE … ===`). The relevancy judge runs
only from `scripts/rag-eval.ts` with `RAGAS_JUDGE=model`; the online scorer
uses the stub judge. It is scrubbed all the same.

That text goes through `scrubSectionFenceLookalikes`: the fold of 13.1, with
its own pattern. These fences have no unique token, and `===` is also
JavaScript's strict equality, so a span needs one of the labels' head words
(`FINDING`, `EVIDENCE`, `QUESTION`, `ANSWER`, `CLAIM`, `RULE`, each optionally
plural, and `INVENTORY`, `PIPELINE`, `LINEAGE`; an `L` also matches `I`,
because the fold reads a lower-case `l` as `I`, so `=== end rules ===` is
caught). No span crosses a line break, and every `=` run is at least two
long (a Markdown-escaped `\=\=\=` counts: `\` folds to a separator). A span is
one of:

- **a closing line**: a `=` run, then within 200 characters (none of them
  `=`, a line break or `& ; { } < > ! ? *`) a terminator word (`END`, `ENDS`,
  `CLOSE`, `CLOSING`…, not inside a word) and a noun in either order, then a
  `=` run, where the span starts its line (after spaces) or runs to its end.
  Caught: `=== END: EVIDENCE ===`, `=== END (EVIDENCE) ===`,
  `=== END/EVIDENCE ===`, `=== END.EVIDENCE ===`, `=== END "FINDING" ===`,
  `=== EVIDENCE END ===`, `=== EVIDENCE ENDS HERE ===`,
  `=== CLOSE EVIDENCE ===`, `// === CLOSE EVIDENCE ===`,
  `=== END OF ALL OF THE EVIDENCE … ===`. The line anchor keeps compound
  conditions out: a `==` between two operands neither starts nor ends a line;
- **the plain shape, anywhere in a line**: a `=` run, `END`, up to three of the
  words real terminators use (`SOURCE`, `MINED`, `SAS`, `STEP`, `DATASET`,
  `DATA`, the inventory languages, `C`, `C++`, `C#`, `OF`, `THE`, `ALL`), a
  noun, a `=` run (`=== END SOURCE EVIDENCE ===`, `===ENDEVIDENCE===`,
  `=== END C++ MINED RULES ===`);
- **one-sided**: a `=` run, `END`, whitespace, `:` or a dash, up to three of
  those words, a noun (`=== END EVIDENCE`, `=== END: EVIDENCE`); a `=` run and
  `END` directly followed by the noun at the end of a line
  (`=== ENDEVIDENCE`); or `END` (not inside a word), whitespace, `:` or a dash,
  those words, a noun and a `=` run (`END EVIDENCE ===`). Only those words,
  not any word, because `|` folds to `I`: `== end || rules` would otherwise
  read as `== END II RULES`;
- **a forged opening**: three or more `=`, the noun, up to eight words, a
  parenthetical, three or more `=`
  (`=== EVIDENCE THE AGENT RETRIEVED (untrusted) ===`). Every real opening
  carries its parenthetical.

Left alone, as ordinary code and prose (tested byte-identical):
`if (x === endRules) {`, `const endRules = x`, `x === END_RULE`,
`pos >= END_QUESTIONS`, `end_rules = load()`, `start = end_rules = 0`,
`pos = end_of_rules == 3`, `if (kind === evidence)`, `a === answer || b === c`,
`const remaining = end - questions.length;`, comment banners such as
`/* ===== VALIDATION RULES ===== */`, MediaWiki `== Evidence ==`, setext
headings, and a block-closing keyword followed on the next line by an
assignment (Ruby/Lua `end`, VB `End If`, COBOL `END-IF` and
`IF END-OF-RULES = 'Y'`, Fortran `end do`, SQL `END`, Markdown `## The end`),
and compound conditions with a terminator-like word and a noun between two
`==` (`return claim.status == ClaimStatus.CLOSED || claim.reserve == 0;`,
`if claim.status == "CLOSED" or claim.amount == 0:`,
`if (a == end || rules == b)`, `while pos == end and answer == None:`, and the
`===` form in JavaScript).

**Not caught** (tested):
- a single `=` on either side (`= END EVIDENCE =`);
- a fence split across lines (`===` / `END` / `EVIDENCE` / `===`);
- other delimiters: `--- END EVIDENCE ---`, `### END EVIDENCE ###`,
  `**END EVIDENCE**`, and the bare `END EVIDENCE`;
- a one-sided `=== END_EVIDENCE` (`_` after `END`; two-sided
  `===END_EVIDENCE===` is caught);
- a terminator word outside the set (`=== FINISHED FINDING ===`);
- a reordered, punctuated or `CLOSE` closing line in the MIDDLE of a line,
  with text on both sides (`foo === EVIDENCE END === bar`); the plain shape
  `foo === END EVIDENCE === bar` is caught;
- a forged opening with no parenthetical (`=== EVIDENCE ===`,
  `=== EVIDENCE THE AGENT RETRIEVED ===`).

**Redacted although ordinary** (tested), because the folded copy cannot tell
them from a fence: a line ending in `=== endRules` (the compact one-sided
form), any line that starts or ends with a `==`-bounded span holding a
terminator word and a noun (a code line rarely does: an operand follows `==`),
and a heading with a parenthetical such as `=== Rules (draft) ===`. A
Markdown-escaped closing line keeps its leading `\`.

**Impact item lines.** Inside `<<<IMPACTED ITEMS>>>` each item is one line,
`- severity=… tables=[…] requirement="…"`. The title is now: line breaks
(`\r\n`, `\r`, `\n`, `\v`, `\f`, U+0085, U+2028, U+2029) collapsed to a space;
the requirement scrub (13.3) and `scrubItemsFenceLookalikes`, which redacts
`END ITEMS` after any run of `<` (`<<END ITEMS>>`, `<END ITEMS>`,
`</END ITEMS>`) or before two or more `>` (`END ITEMS>>`); and then written
as a JSON string literal, so a `"` is `\"` and cannot end the value. A title
with no `"`, `\`, control character or line break reaches the model unchanged;
one that has them now reads as JSON escapes.

The follow-ups this section left — excerpt headers, impact table names and the
docs-gen Phase-2 writer's blocks — are closed in 13.5.

### 13.5 Impact names, excerpt headers and the Phase-2 writer (#1369, #1370)

**Impact-analysis values (#1369).** Table and column names come from DDL, ORM
annotations (`@Table(name = "…")` accepts any character but a quote) or a live
database, whose quoted identifiers may hold anything; symbol and file names
come from the repository; rationales, clauses and suggested DDL are written by
a model. In every one-line fact of the impact prompts
(`impact-analysis/impact-summarizer.ts`, `table-relevance-filter.ts`,
`table-relevance-judge.ts`, `additive-column-proposer.ts`,
`clause-coverage-reconciler.ts`):

- every `key="…"` value (`table`, `column`, `suggestedDdl`, `rationale`,
  `referencedColumns`, `project`, `symbol`, `file`, `uncoveredClause`,
  `reason`, `requirement`) goes through `quotedPromptValue`
  (`impact-analysis/prompt-values.ts`): line breaks collapsed to a space, the
  requirement scrub (13.3) and the `END ITEMS` scrub (13.4), then a JSON string
  literal. A value cannot end itself, start a ranked line (`1. table=…`), a
  candidate line (`[0] table=…`) or an item line, or close
  `<<<IMPACTED ITEMS>>>`;
- every name in an unquoted list (`tables=[…]`, `columns: …`, the judge's
  `[0] name (columns: …)`, the reconciler's surfaced-table list) goes through
  `promptNameItem`: a plain identifier (letters, digits, `_ $ . # @ -`) is
  written bare, anything else as `quotedPromptValue`, so a name holding `,`,
  `]`, a space, a quote or a bracket is quoted.

A value with no `"`, `\`, control character, line break or fence, and a
plain-identifier name, reach the model exactly as before. A Windows path or
a rationale with a `"` now reads as JSON escapes.

**Support-panel excerpt headers (#1369).** Two layers.

1. `renderEvidenceBlock` (`analysis/support-panel.ts`) replaces a forged header
   in an excerpt's body with `[REDACTED HEADER]` (`scrubExcerptHeaderLookalikes`,
   the fold of 13.1 with its own pattern): a whole line (after spaces) of three
   or more `-` (any dash look-alike, `.` and `…` fold to `-`), whitespace, at most
   300 characters holding a file locator — a name with an extension directly
   before `:` and a line number (`a.ts:5`; the number may not run into a letter,
   since the fold reads `0` and `1` as `O` and `I`) — or a `#` or `/`, whitespace, three or
   more `-`. Caught: `--- src/a.ts:500 ---`, `--- a.ts:7 ---`, em-dash, box-drawing,
   minus-sign and full-width forms, a zero-width character in the run, a
   full-width colon, `--- doc.md#chunk-13 ---`, `--- src/other.ts ---`. Left
   alone: `---`, `--- Page 3 ---`, `----- Tables -----`, `// --- a.ts:5 ---`,
   the diff header `--- a/x.ts`, `| --- |`, `x = a --- b`,
   `--- Requirement 4.2: Only managers approve refunds ---`,
   `--- Step 1: Insert orders ---`, `--- Note: 1 ---`, `--- Q1: 2024 ---`,
   `--- 10:30 meeting ---`. **Not caught**
   (tested): a header naming only a bare file (`--- a.ts ---`) or a backslash
   path with no line, one with fewer than three dashes, a one-sided
   `--- a.ts:5`, a header after other text on its line, and a colon look-alike
   NFKD does not fold (U+2236) with no `/` in the path. **Redacted although
   ordinary** (tested): any `---`-framed line holding a `/` or `#`
   (`--- see docs/x ---`, `--- 2024/25 budget ---`, `--- Q#1 ---`), one holding
   `name.ext:N` (`--- v1.2:3 ---`), and `… a/b …` (an ellipsis folds to `---`).
2. The citation gate checks the line, not only the file. `extractGroundedLocator`
   (`analysis/support-panel-tally.ts`) now takes the excerpts shown, and a
   locator counts only when its lines overlap a range shown of its file
   (`path:35-60` against `10-40` counts, `path:500` does not), with two lines
   of slack each side (`CITATION_LINE_SLACK`: a code-graph excerpt opens with
   its own `name (kind) — path:start-end` line, so a model counting lines lands
   one off; `path:9` and `path:42` count against `10-40`, `path:43` and
   `path:45` do not); a file shown
   whole (no `startLine`, or a bare path) accepts any line, and an excerpt with
   a start and no end accepts any line from its start. When a locator fails,
   the next one in the citation or the reasoning is tried. The lens votes and
   the absence check both use it, so a lens pointed at line 500 by a header that
   slipped past layer 1 is discarded as `missing-citation`, and an absence
   verdict becomes `unexamined`. Not checked: a line inside a shown range that the
   excerpt itself mis-numbers.

**The Phase-2 writer (#1370).** `scrubWriterFenceLookalikes` is the section
scrub of 13.4 over the writer's nouns (`FLOW`, `FACT`, `FORMULA`, `CONSTANT`,
`SOURCE`, each optionally plural, and `SCHEMA`) and modifiers (`MODULE`,
`GROUNDING`, `CANONICAL`, `EXTRACTED`, `RETRIEVED`, `DATABASE`, `OF`, `THE`,
`ALL`), plus two forms: the writer's opening phrases between `=` runs anywhere
in a line (`RETRIEVED GROUNDING SOURCES`, `EXTRACTED MODULE FACTS`,
`CANONICAL FACTS`, `FORMULAS/CONSTANTS`, `DATABASE SCHEMA`,
`TABLE AND COLUMN NAMES`, `END-TO-END FLOW`; the real openings carry no
parenthetical), and a grounding-source header `[SOURCE id=`. Its one-sided
forms are pinned to a line edge (`=== END FACTS` must end its line,
`END FACTS ===` must start it), because these nouns are common identifiers.
Each fence the writer's prompt carries:

| Fence | Carries | Now |
|-------|---------|-----|
| `=== RETRIEVED GROUNDING SOURCES ===` (`grounding/grounding-context.ts`) | RAG chunks, web digests, Phase-1 facts, canonical facts | each source's text, its label and a deduplicated facts entry's reference line scrubbed in `renderGroundingBlock` |
| `=== FORMULAS/CONSTANTS … ===` / `=== END FORMULAS ===` (`holistic-synthesizer.ts`) | formula expressions from repository source | scrubbed in `buildSectionPrompts` |
| `=== EXTRACTED MODULE FACTS ===` / `=== END MODULE FACTS ===` | Phase-1 model output over repository source | scrubbed in `buildSectionPrompts` |
| `=== END-TO-END FLOW (…) ===` / `=== END FLOW ===` | module and dataset names from the code graph | scrubbed in `buildSectionPrompts` |
| `=== CANONICAL FACTS (…) ===` / `=== END CANONICAL FACTS ===` (`canonical-facts.ts`) | names, values and paths from repository source | already one line per field with ASCII `===` spaced out (#1119); `neutralize` now also runs the writer scrub after the spacing, for look-alikes |
| `=== DATABASE SCHEMA … ===` / `=== END SCHEMA ===` (`schema-inventory.ts`) | table, column and type names from a database or repository SQL | already one line per table, each line opening with `- `; the prompt's names and types now also go through the writer scrub (the rendered schema reference is unchanged). The heading's connector label is stripped of `=` by `plainConnectorLabel` |

Clean text is returned as the same string, so a prompt for clean input is
byte-identical, and neither the prompt-cache prefix nor the section reuse hash
moves. For input that does hold a look-alike, the reuse hash (which covers the
rendered grounding block and the built prompts) moves once, so that section is
regenerated once.

Left alone (tested): compound conditions (`if (a == end || flow == b)`,
`return claim.status == ClaimStatus.CLOSED || facts.size == 0;`,
`while pos == end and source == None:`), `if (pos == end - sources.length)`,
`if end - facts == 0:`, `end`-keyword languages followed by an assignment,
`/* ===== CONSTANTS ===== */`, a bare `===== CONSTANTS =====`, a wiki
`=== Data flow ===`, `List<Source>`, `[source_id=3]`. **Not caught** (tested):
`foo === FLOW END === bar` (a reordered closing line mid-line), a terminator
outside the set (`=== FINISHED FORMULAS ===`), a bare-noun opening
(`=== FORMULAS ===`), a single `=`, other delimiters (`--- END FLOW ---`), a
fence split across lines, `=== END_FLOW`, a one-sided form in the middle of a
line, and `[SOURCE_ID=`. **Redacted although ordinary** (tested), because each
is one of the writer's fences in another case or spacing: a line ending in
`== endFlow`; a `==`-bounded `END` plus a writer noun anywhere in a line
(`== end flow ==`, `=== End of facts ===`, `x == END_FLOW == y`); and a heading
made of a writer opening phrase between `=` runs (`=== Module facts ===`,
`=== Database schema ===`, `== Canonical facts ==`, `=== Grounding sources ===`,
`=== Formulas / Constants ===`, `== Table and column names ==`). A bare-noun
heading (`=== Sources ===`, `=== Formulas and constants ===`, `=== Data flow ===`)
is left alone.
