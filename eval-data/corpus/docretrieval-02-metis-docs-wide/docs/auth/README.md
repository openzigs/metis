# Authentication & SSO

METIS supports four authentication modes selected by **`AUTH_MODE`** —
`mock` | `ldap` | `saml` | `oidc` (`server/src/lib/auth/providers.ts`). This
directory documents how to configure, harden, and locally test each one.

## Start here

| I want to… | Go to |
|------------|-------|
| **Understand env vars vs admin-API config** (the thing that trips people up) | [Configuration reference](#configuration-reference) (below) |
| **Try a login flow locally** (one command, no cloud IdP) | [local-testing.md](./local-testing.md) — OIDC / SAML / LDAP harnesses |
| **Understand SAML's hardened posture** (replay + response signing) | [saml.md](./saml.md) (#520) |
| **Configure a real IdP** | [keycloak.md](./keycloak.md) · [okta.md](./okta.md) · [azure-ad.md](./azure-ad.md) · [google-workspace.md](./google-workspace.md) |

## All auth docs

- **Configuration & operations**
  - [`.env.example`](../../.env.example) — the canonical env-var block (auth section near the top).
  - [USER_GUIDE.md §5.3 Authentication Configuration](../USER_GUIDE.md#53-authentication-configuration) — operator-facing overview of all four modes + SCIM + role mappings.
- **Local test harnesses** (Epic #517)
  - [local-testing.md](./local-testing.md) — index + "which harness tests what" table.
  - [oidc-local-testing.md](./oidc-local-testing.md) — Keycloak (`make oidc-up`), #521.
  - [saml-local-testing.md](./saml-local-testing.md) — mock SAML IdP (`make saml-up`), #523.
  - [ldap-local-testing.md](./ldap-local-testing.md) — OpenLDAP (`make ldap-up`), #525.
- **Security posture**
  - [saml.md](./saml.md) — SAML threat model + verified node-saml options + `requireSignedResponse` knob (#520).
- **Production IdP setup guides**
  - [keycloak.md](./keycloak.md), [okta.md](./okta.md), [azure-ad.md](./azure-ad.md), [google-workspace.md](./google-workspace.md).

---

## Configuration reference

> **The single most important distinction:** **LDAP is configured via env vars;
> SAML and OIDC are configured via the admin API** (there are **no** `AUTH_SAML_*`
> or `AUTH_OIDC_*` env vars). The SSO routes are always mounted and read the
> **stored** provider config — they do **not** gate on `AUTH_MODE` — so SAML/OIDC
> are layered on top of `AUTH_MODE=mock`. Source: `server/src/routes/admin/auth.ts`,
> `server/src/lib/auth/ldap-provider.ts`.

### LDAP — env vars (`AUTH_LDAP_*`)

Authoritative list: exactly the variables `getLDAPConfig()` reads in
[`server/src/lib/auth/ldap-provider.ts`](../../server/src/lib/auth/ldap-provider.ts)
(`getLDAPConfig`, lines 33–48). Only read when `AUTH_MODE=ldap`.

| Env var | Type | Default | Required | Purpose |
|---------|------|---------|----------|---------|
| `AUTH_LDAP_URL` | string | `""` | **Yes** (for `ldap` mode) | LDAP server URL (`ldap://` or `ldaps://`). |
| `AUTH_LDAP_BASE_DN` | string | `""` | Recommended | Root suffix / baseDN of the directory tree. Used as the search base when `AUTH_LDAP_USER_SEARCH_BASE` is unset. |
| `AUTH_LDAP_BIND_DN` | string | `""` | **Yes** | Service-account (read) bind DN used to **search** for users. |
| `AUTH_LDAP_BIND_PASSWORD` | string | `""` | **Yes** | Service-account bind password. |
| `AUTH_LDAP_USER_SEARCH_BASE` | string | `""` (falls back to `AUTH_LDAP_BASE_DN`) | No | Subtree to search for users. |
| `AUTH_LDAP_SEARCH_FILTER` | string | `(&(objectClass=user)(sAMAccountName={{username}}))` | No | User search filter. `{{username}}` is substituted (RFC-4515 escaped) with the login name at auth time. The default is **Active-Directory shaped**; override for OpenLDAP/`inetOrgPerson` (e.g. `(&(objectClass=inetOrgPerson)(uid={{username}}))`). |
| `AUTH_LDAP_TLS_SKIP_VERIFY` | boolean (`"true"`/`"false"`) | `false` | No | Skip TLS cert verification for `ldaps://`. **DEV-ONLY** — see the production guard below. |
| `AUTH_LDAP_CONNECTION_TIMEOUT` | integer (ms) | `10000` | No | Connection/bind timeout in milliseconds. |

**What env vars do NOT carry: `groupMappings` and `defaultRole`.** `getLDAPConfig()`
hard-codes `groupMappings: []` and `defaultRole: "reader"` for the env path, so a
**pure-env LDAP login resolves every user to `reader`**. To map IdP groups to
METIS roles, push the config (including `groupMappings`/`defaultRole`) via the
admin API — see [LDAP admin-API fields](#ldap--admin-api-runtime-override) below.

#### Production guard: `AUTH_LDAP_TLS_SKIP_VERIFY` is refused in production (#529)

`AUTH_LDAP_TLS_SKIP_VERIFY=true` disables TLS certificate verification
(`{ rejectUnauthorized: false }`) on the LDAP connection — a legitimate escape
hatch for a self-signed directory in local dev (e.g. the #525 OpenLDAP harness),
but a man-in-the-middle vector in production. When **`NODE_ENV=production` AND the
flag is `true`**, METIS **fails fast** at TLS-option resolution
(`resolveLDAPTlsOptions` → `assertLDAPTlsConfigSafe`,
[`ldap-provider.ts`](../../server/src/lib/auth/ldap-provider.ts) lines 69–96)
rather than silently authenticating over an unverified channel. In production,
provide a certificate the host trusts and **remove the flag**. Dev/test/unset
environments may still skip verification.

### SAML — admin-API fields (`PUT /api/admin/auth/providers/saml`)

There are **no SAML env vars**. The fields below are exactly what the route
accepts in [`server/src/routes/admin/auth.ts`](../../server/src/routes/admin/auth.ts)
(SAML handler, lines 65–156).

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `name` | string | **Yes** | Display name of the provider. |
| `entityId` | string | **Yes** | SP Entity ID (becomes node-saml `issuer`). |
| `acsUrl` | string | **Yes** | Assertion Consumer Service (ACS) URL. |
| `idpMetadataXml` | string (XML) | On first config | IdP metadata XML. METIS's `parseIdPMetadata` extracts the IdP **SSO URL** (node-saml `entryPoint`), **signing cert(s)** (`idpCert`), and **issuer** from it — you do not set those three directly. May be omitted on update (the parsed values are preserved). |
| `signRequests` | boolean | No (default `false`) | Sign outbound AuthnRequests. |
| `requireSignedResponse` | boolean | No (**default `true`** — secure) | Require the SAML **Response envelope** to be signed (node-saml `wantAuthnResponseSigned`). Set `false` only for an IdP that cannot sign the envelope — assertion signing stays on. See [saml.md](./saml.md#the-one-configurable-knob-requiresignedresponse). |
| `spPrivateKey` | string (PEM) | No | SP private key (masked in the read API; omit on update to keep stored). |
| `spCert` | string (PEM) | No | SP certificate (masked in the read API; omit on update to keep stored). |
| `groupMappings` | `Array<{ claimValue, role }>` | No | IdP group → METIS role mappings. |
| `defaultRole` | role key | No (default `reader`) | Role when no group mapping matches. |
| `id`, `enabled` | string, boolean | No | Provider id (resolved by mode if omitted) and enabled flag (default `false`). |

> Note: `assertion`/`Response` time-window validation (`acceptedClockSkewMs`),
> `validateInResponseTo`, and the request-id cache backend
> (`SAML_REQUEST_ID_CACHE_BACKEND`) are server-side hardening set in
> `saml-provider.ts`, not admin-API fields. See [saml.md](./saml.md).

### OIDC — admin-API fields (`PUT /api/admin/auth/providers/oidc`)

There are **no OIDC env vars**. Fields per
[`server/src/routes/admin/auth.ts`](../../server/src/routes/admin/auth.ts)
(OIDC handler, lines 159–228).

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `name` | string | **Yes** | Display name of the provider. |
| `discoveryUrl` | string | **Yes** | OIDC discovery document URL (`/.well-known/openid-configuration`). |
| `clientId` | string | **Yes** | OAuth client id. |
| `clientSecret` | string | **Yes** (first config) | Client secret (masked in the read API; omit on update to keep stored). |
| `redirectUri` | string | **Yes** | Callback URI (METIS's is `/api/auth/oidc/callback`). |
| `scopes` | string[] | No (default `["openid","profile","email"]`) | OAuth scopes requested. |
| `groupMappings` | `Array<{ claimValue, role }>` | No | `groups`-claim → METIS role mappings. |
| `defaultRole` | role key | No (default `reader`) | Role when no group mapping matches. |
| `id`, `enabled` | string, boolean | No | Provider id (resolved by mode if omitted) and enabled flag (default `false`). |

PKCE (S256) is always enabled server-side (`pkceEnabled: true`); it is not a
configurable field.

### LDAP — admin-API runtime override

`PUT /api/admin/auth/providers/ldap` (and `GET /api/admin/auth/ldap`,
`POST /api/admin/auth/ldap/test`) let an admin set the LDAP config — including the
`groupMappings`/`defaultRole` the env path cannot carry — at runtime
([`admin/auth.ts`](../../server/src/routes/admin/auth.ts) lines 270–314). The
accepted fields mirror the env vars (`url`, `baseDN`, `bindDN`, `bindPassword`,
`userSearchBase`, `searchFilter`, `tlsSkipVerify`, `connectionTimeout`) plus
`groupMappings` and `defaultRole`. `url` and `bindDN` are required; `bindPassword`
is preserved if omitted. An admin override takes precedence over env config.

### Group → role mappings (all modes)

`groupMappings` is `Array<{ claimValue: string, role: RoleKey }>`; a user's groups
match when `groups.includes(claimValue)`. The **highest-privilege** matching role
wins (`resolveRoleFromGroups`, `server/src/lib/auth/sso-config.ts`). Roles are
`admin` | `coordinator` | `developer` | `reader`. `validateGroupMappings` requires
at least one mapping to resolve to `admin`.
