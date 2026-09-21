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
- **Refresh token** — opaque ULID stored in an `httpOnly`, `Secure`, `SameSite=Strict` cookie. Rotated on every refresh.
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
| `/api/auth/*` | 20 / 15min / IP | `RATE_LIMIT_*` |
| AI chat / stream | 60 / 15min / user | `AI_RATE_LIMIT_*` |
| Connector mutations | 30 / 5min / user | `CONNECTOR_RATE_LIMIT_*` |
| Document upload | 10 / 1min / user | `UPLOAD_RATE_LIMIT_*` |
| Scheduler `runNow` | 10 / 5min / user | `SCHEDULER_RUN_RATE_LIMIT_*` |

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
6. **IP pinning** — an `undici.Agent` is built with a custom `connect.lookup` that returns the FIRST validated address regardless of which hostname undici asks for. The socket layer cannot be talked into a different endpoint by a hostile resolver. This closes the **DNS-rebinding TOCTOU SSRF** window that previously existed between the validation phase and the socket connect (issue [#303](https://github.com/openzigs/metis-private/issues/303)).
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
| `suggested_connector.credential_read`       | wizard fetched a one-shot password  |
| `suggested_connector.credential_read.failed`| vault read failed                   |
| `suggested_connector.test`                  | liveness probe attempted            |
| `suggested_connector.provisioned`           | connector + vault entry created     |
| `suggested_connector.provisioned.failed`    | provisioning failed (with rollback) |

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
  before any handler. Routers that predate the rule live in
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
