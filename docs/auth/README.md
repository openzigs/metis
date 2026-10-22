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

For a production install, configure OIDC from the environment instead (next
section). The admin API edits the provider at runtime only. Fields per
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

### OIDC and SAML from the environment (#1376)

The admin API keeps SSO providers **in memory**. So a provider configured that
way exists on one replica only and is lost when the pod restarts. It also needs
an admin, which a fresh OIDC- or SAML-only install does not have. Set the
provider in the server's environment instead. It is configured on every
replica at boot, before the first request.

| Variables | Required | Purpose |
|---|---|---|
| `AUTH_OIDC_DISCOVERY_URL`, `AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`, `AUTH_OIDC_REDIRECT_URI` | all four, or none | An enabled OIDC provider with PKCE. The redirect URI is `https://<host>/api/auth/oidc/callback`. Put the client secret in the Secret. |
| `AUTH_OIDC_NAME`, `AUTH_OIDC_SCOPES` | no | Button label (default `Single sign-on`) and scopes (default `openid profile email`). |
| `AUTH_SAML_ENTITY_ID`, `AUTH_SAML_ACS_URL`, `AUTH_SAML_IDP_METADATA_XML` | all three, or none | An enabled SAML provider, parsed from the IdP's metadata, which must name an SSO URL and a signing certificate. |
| `AUTH_SAML_NAME`, `AUTH_SAML_REQUIRE_SIGNED_RESPONSE` | no | Button label, and `false` to accept an unsigned Response envelope (the assertion must still be signed). |
| `AUTH_OIDC_GROUP_MAPPINGS`, `AUTH_SAML_GROUP_MAPPINGS` | no | `group=role` pairs, comma-separated, e.g. `metis-admins=admin,engineers=developer`. At least one must map to `admin`. |
| `AUTH_OIDC_DEFAULT_ROLE`, `AUTH_SAML_DEFAULT_ROLE` | no | Role when no group matches (default `reader`). |

A half-set provider, an unknown role, or metadata with no SSO URL or
certificate **fails the boot** with a message naming the variable. An edit
through the admin API lasts until the next restart, when the environment wins
again, so keep lasting settings here.

### First admin: `METIS_BOOTSTRAP_ADMINS` (#1376)

A non-mock install has no admin at first, and only an admin can set the group
mappings that make one. `METIS_BOOTSTRAP_ADMINS` is the supported way through.
It takes a comma- or whitespace-separated list of usernames and e-mail
addresses, matched case-insensitively.

- **When it applies:** a listed identity signs in through LDAP, OIDC or SAML
  (for OIDC and SAML, configure the provider from the environment as above:
  without an admin, the admin API cannot),
  and **no user holds the admin role** from any source (a local grant, SCIM, or
  a provider group mapping). That user is granted `admin` as an explicit
  (`local`) role, the same role an admin grants, and the audit log records
  `user.role.bootstrap_admin`.
- **When it does nothing:** whenever an admin already exists. So it cannot be
  replayed to escalate: a second listed person, or the same variable left set
  for a year, gets the role their provider maps. The check and the grant run in
  the login's serializable transaction, so two listed people signing in at once
  cannot both be granted admin.
- **Which identities count:** only values the provider states as-is, never one
  METIS derives.
  - **LDAP:** the account's username and its `mail` attribute.
  - **SAML:** the signed assertion's `upn`, `uid`, e-mail attributes and
    NameID. When the assertion has no `upn` or `uid`, METIS names the account
    from the e-mail's local part. That name never matches, because
    `jdoe@other.example` would otherwise match a listed `jdoe`.
  - **OIDC:** only the `email` claim, and only when the IdP marks it
    `email_verified: true`. The OIDC username is `preferred_username`, which
    users can often edit, or the local part of a possibly unverified e-mail. So
    list an e-mail address for an OIDC install.
  - **Normalisation:** identities are NFKC-folded and case-insensitive. A
    signing-in identity that NFKC would change (a Kelvin sign `\u212A` for `K`,
    full-width letters) never matches.

After the first admin signs in, set the group mappings (`/settings/auth`,
or `PUT /api/admin/auth/providers/<mode>`) and grant other admins from there.
**It re-arms.** "An admin exists" means some row grants the admin role, even
one belonging to a deactivated or deleted user. If every such row is later
removed, the next listed identity to sign in is granted admin again. Unset
`METIS_BOOTSTRAP_ADMINS` once your first admin exists if you do not want that
recovery path.

### Completing an SSO login (OIDC and SAML, #1386)

The OIDC callback and the SAML ACS end the login with the browser session the
UI reads: the `metis.at` (access, 1 hour) and `metis.rt` (refresh, 7 days)
cookies, `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` under
`NODE_ENV=production`. They then redirect to `<APP_URL>/dashboard`. Without
`APP_URL`, the redirect goes to the first `CORS_ORIGIN` entry, which the Helm
install sets to `https://<host>`.

The cookies belong to the host that serves the callback, so serve
`/api/auth/oidc` and `/api/auth/saml` on the UI's host. The Helm Ingress does.
An IdP may reach the API on another host only if the UI is served from that
host too.

### One account per sign-in identity (#1395)

A METIS account is bound to the identity that signs in as it, not to the
username alone. Every sign-in carries a (provider, issuer, subject) key, stored
in the `user_identities` table:

| Provider | Issuer | Subject |
|---|---|---|
| OIDC | the ID token's `iss` | the ID token's `sub` (never `preferred_username`) |
| SAML | the assertion's `Issuer` (else the configured IdP entity ID) | the `NameID`; for a transient NameID, `urn:metis:saml:transient-username:<username>`, a prefix no NameID uses |
| LDAP | `ldap` (one directory per install) | the entry's `entryUUID` (OpenLDAP) or `objectGUID` (Active Directory); without either, the account name the directory returned (`uid` / `sAMAccountName`), NFKC-folded and lower-cased so `Alice` and `alice` are one identity |
| mock | `mock` | the folded account name |

A sign-in is resolved in this order
([`login-identity.ts`](../../server/src/lib/auth/login-identity.ts)):

1. The account already bound to the identity, whatever its username is now.
2. No account has the username: a new account, bound to the identity.
3. An account has the username but no identity yet (created before this
   change, by SCIM, or by the seed): the sign-in claims it only if the account
   belongs to the same provider kind (`users.authSource`). An account whose kind
   is unknown (`authSource` NULL) can be claimed only by the `AUTH_MODE`
   provider:
   - LDAP or mock claim it by username, as they always have;
   - OIDC claims it only when the IdP asserts `email_verified: true` and that
     e-mail equals the account's e-mail (case- and NFKC-folded; an address NFKC
     would change never matches). Without that, the seed's `admin` row would go
     to whoever the IdP lets call themselves "admin";
   - SAML asserts no `email_verified`, so it never claims such an account: link
     it (below).
4. Anything else is **refused** with `409 ACCOUNT_LINK_REQUIRED`: the username
   belongs to another provider's identity (an OIDC user named like an LDAP user,
   or a SAML user named like an OIDC user), to another subject at the same IdP,
   or (step 3) the e-mail is not verified as the account's own. Nothing about
   the existing account changes.

A **disabled or deleted** account is refused with `403 ACCOUNT_DISABLED` and
never written on the login path, by any of these steps. When SCIM re-provisions
a deleted username, the revived account drops the deleted person's identities
and provider (`authSource` NULL): it is a new person, and the old IdP account
cannot sign in as them.

The upgrade migration fills `users.authSource` from the audit log: an account
whose every recorded login came through OIDC is marked `oidc`, through SAML
`saml`. Every other existing account stays NULL and is claimed as in step 3 at
its next sign-in. If such an account actually signs in through another
provider, link it as below.

**Linking two identities to one account.** When the same person really does
sign in through two providers, a host operator links the second identity. The
refused sign-in's audit event (`user.login.failed`, reason
`identity_conflict:*`) records the provider, issuer and subject to use:

```bash
pnpm --filter @metis/server exec tsx src/lib/auth/link-identity-cli.ts \
  link --operator "$USER" --username alice --provider oidc \
  --issuer https://idp.example.com --subject 00u1abcd
pnpm --filter @metis/server exec tsx src/lib/auth/link-identity-cli.ts list --username alice
```

The link is audited as `user.identity.linked`. Once linked, both identities
sign in as the account, and each sign-in reconciles provider-granted roles from
the provider that signed in.

**Switching `AUTH_MODE` (for example LDAP → OIDC).** Accounts are bound to the
old provider's identities, so after the switch every existing user's first
sign-in through the new provider is refused with `409 ACCOUNT_LINK_REQUIRED`.
That is deliberate: nothing proves the new IdP's `alice` is the directory's
`alice`. To move users across:

1. Before switching, list each account's current binding with
   `link-identity-cli.ts list --username <name>`.
2. Switch `AUTH_MODE` and configure the new provider.
3. Have each user sign in once. The refusal's audit event records their new
   provider, issuer and subject.
4. After confirming the person out of band (or matching the IdP's directory
   export to METIS usernames), run `link-identity-cli.ts link` for each.
   Until linked, the user cannot sign in through the new provider.

Accounts still unbound (`authSource` NULL, for example seeded or SCIM-provisioned
ones) follow step 3 above under the new `AUTH_MODE`.

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
