# Local LDAP test harness

One command spins up a **local OpenLDAP directory**, seeds it deterministically
with users and groups, and prints the exact `AUTH_LDAP_*` env block to point METIS
at it — so you can exercise the LDAP login flow (bind + search + password verify)
**and group→role mapping** **without a corporate directory**. (Issue #525, Epic
#517.)

## What it gives you

- `docker-compose.ldap.yml` — runs [OpenLDAP](https://www.openldap.org/)
  (`bitnami/openldap:2.6`) on `ldap://localhost:4400`, seeded from an LDIF.
- `scripts/ldap-harness/bootstrap.ldif` — the deterministic seed: two org units,
  two users with passwords, two `groupOfNames` groups, and an explicit `memberOf`
  on each user.
- `scripts/ldap-harness/up.sh` — starts OpenLDAP and runs the verify script.
- `scripts/seed-ldap.mjs` — performs the **same** bind → search → user-bind →
  group→role flow METIS's provider does (a smoke check), then prints the
  `AUTH_LDAP_*` block. Optionally configures the METIS LDAP provider via the admin
  API (`--configure-metis`) so group→role mapping takes effect at login.
- `make ldap-up` / `make ldap-down` targets.

## Why OpenLDAP (and why this harness exists)

METIS's LDAP provider (`server/src/lib/auth/ldap-provider.ts`) reads the
`memberOf` attribute and extracts each group's CN with the regex `/^CN=([^,]+)/i`.
**OpenLDAP** returns `memberOf` as full group DNs
(`cn=metis-admins,ou=groups,dc=metis,dc=local`), which that regex turns into the
bare group **name** (`metis-admins`) used for role mapping — a clean fit. The
provider also lets us **override** the user search filter
(`AUTH_LDAP_SEARCH_FILTER`) to match OpenLDAP's `inetOrgPerson`/`uid` schema, so a
standard OpenLDAP tree exercises every code path the provider has. (lldap uses its
own group model and AD-style attribute shapes less directly; OpenLDAP maps 1:1 to
what the provider already extracts.)

The directory is provisioned via a **custom LDIF** rather than manual edits, so the
users / groups / `memberOf` are **identical on every boot** — no flaky setup.

## LDAP is env-driven (unlike SAML/OIDC)

The [OIDC (#521)](./oidc-local-testing.md) and [SAML (#523)](./saml-local-testing.md)
harnesses configure METIS through the **admin API**, so the dev server stays on
`AUTH_MODE=mock`. **LDAP is different**: the active login provider is selected by
**`AUTH_MODE=ldap`** and reads its connection settings from `AUTH_LDAP_*` env vars.
So for LDAP you start METIS **with `AUTH_MODE=ldap`** and the printed env block —
login then goes through `POST /api/auth/login` (username/password) against the
directory.

## Prerequisites

- Docker (Compose v2) and `node` on your PATH. (`ldapts`, the LDAP client the verify
  script uses, is already a server dependency — run `pnpm install` once.)
- A running METIS server is **not** required to bring the harness up; it is only
  needed for the optional `--configure-metis` step.

## Bring it up

```bash
# 1. Start OpenLDAP, seed it, verify the directory, and print AUTH_LDAP_*.
make ldap-up        # == bash scripts/ldap-harness/up.sh

# 2. Export the printed AUTH_LDAP_* block, then start METIS with AUTH_MODE=ldap.
#    (eval the env, or paste it into your shell / .env)
```

`up.sh` will:

1. `docker compose -f docker-compose.ldap.yml up -d` OpenLDAP with the LDIF
   imported, and wait until a real **bind+search** against the seeded tree
   succeeds (first boot + import can take ~30s).
2. Run `scripts/seed-ldap.mjs`, which binds as the service account, searches each
   seeded user with METIS's filter, binds **as the user** to verify the password,
   extracts `memberOf` groups the way the provider does, asserts the resolved role,
   and prints the `AUTH_LDAP_*` env block.

### The exact `AUTH_LDAP_*` env block

These are precisely the variables `getLDAPConfig()` reads, plus `AUTH_MODE=ldap`:

```bash
export AUTH_MODE="ldap"
export AUTH_LDAP_URL="ldap://localhost:4400"
export AUTH_LDAP_BASE_DN="dc=metis,dc=local"
export AUTH_LDAP_BIND_DN="cn=admin,dc=metis,dc=local"
export AUTH_LDAP_BIND_PASSWORD="adminpassword"
export AUTH_LDAP_USER_SEARCH_BASE="ou=users,dc=metis,dc=local"
export AUTH_LDAP_SEARCH_FILTER="(&(objectClass=inetOrgPerson)(uid={{username}}))"
export AUTH_LDAP_TLS_SKIP_VERIFY="false"
export AUTH_LDAP_CONNECTION_TIMEOUT="10000"
```

> The default `AUTH_LDAP_SEARCH_FILTER` in the provider is Active-Directory shaped
> (`(&(objectClass=user)(sAMAccountName={{username}}))`). We **override** it for
> OpenLDAP's `inetOrgPerson`/`uid` schema. `{{username}}` is substituted (after
> RFC-4515 escaping) with the login name at authentication time.

## Log in end-to-end (and verify the role mapping)

1. With METIS running under the env block above, open the METIS `/login` page and
   log in as a seeded user (or `POST /api/auth/login` with `{username, password}`):

| LDAP user (uid) | Password | LDAP group | METIS `groupMappings` | Resolved METIS role |
|-----------------|----------|------------|-----------------------|---------------------|
| `alice` | `alicepass` | `metis-admins` | `metis-admins → admin` | **admin** |
| `bob` | `bobpass` | `metis-developers` | `metis-developers → developer` | **developer** |

2. METIS binds the service account, finds the user, re-binds as the user to verify
   the password, reads `memberOf`, extracts the group CNs, and maps them to a role.

### Making group→role mapping take effect

There is an important subtlety: **env-only LDAP config has no `groupMappings`**, so
a pure env login resolves **every** user to the default role (`reader`). The
`groupMappings` are only carried via the admin API. Two ways to get the mapped
roles in the table above:

- Run the verify script with `CONFIGURE=1 make ldap-up` (or
  `node scripts/seed-ldap.mjs --configure-metis`). This `PUT`s the LDAP provider
  config — including `metis-admins → admin`, `metis-developers → developer` — to
  `PUT /api/admin/auth/providers/ldap`. Requires a running METIS server whose
  current login can obtain an admin token.
- Or set the same mappings in the admin UI (Settings → Auth → LDAP → group→role).

The harness's smoke check **always** verifies that each user's `memberOf` resolves
to the expected role using the **same** logic the server uses
(`resolveRoleFromGroups`), so you know the directory is seeded correctly even
before you wire the mappings into METIS.

## Tear down

```bash
make ldap-down                      # stop OpenLDAP and remove its data volume
```

The data volume is removed so the LDIF is re-seeded fresh on the next
`make ldap-up` (bitnami/openldap only runs the custom LDIF on a first boot with an
empty data dir).

## Configuration (env overrides)

| Variable | Default | Purpose |
|----------|---------|---------|
| `LDAP_URL` | `ldap://localhost:4400` | Where the verify script connects. |
| `LDAP_BASE_DN` | `dc=metis,dc=local` | Root suffix of the directory. |
| `LDAP_BIND_DN` | `cn=admin,dc=metis,dc=local` | Service-account bind DN. |
| `LDAP_BIND_PASSWORD` | `adminpassword` | Service-account password (matches compose). |
| `LDAP_USER_SEARCH_BASE` | `ou=users,dc=metis,dc=local` | User subtree. |
| `LDAP_ROOT` / `LDAP_ADMIN_USERNAME` / `LDAP_ADMIN_PASSWORD` | `dc=metis,dc=local` / `admin` / `adminpassword` | OpenLDAP container seed (compose). |
| `SKIP_SEED=1` | — | `up.sh` starts OpenLDAP but does not run the verify script. |
| `CONFIGURE=1` | — | `up.sh` also configures the METIS LDAP provider (group→role) via the admin API. |
| `METIS_API_URL` / `METIS_ADMIN_USER` / `METIS_ADMIN_PASSWORD` | `http://localhost:4000` / `admin` / `password` | Only used by `--configure-metis`. |

## `AUTH_LDAP_TLS_SKIP_VERIFY` is dev-only (refused in production)

`AUTH_LDAP_TLS_SKIP_VERIFY=true` disables TLS certificate verification on the
LDAP connection (`{ rejectUnauthorized: false }`). It exists so you can point
METIS at a self-signed or untrusted-cert directory in local dev. **In production
it is refused** (#529, epic #517): when `NODE_ENV=production` and the flag is
`true`, METIS **fails fast** at LDAP TLS-option resolution
(`resolveLDAPTlsOptions` → `assertLDAPTlsConfigSafe` in
`server/src/lib/auth/ldap-provider.ts`) with a clear error rather than silently
authenticating over an unverified channel — a silent downgrade would expose the
auth channel to a man-in-the-middle. To use `ldaps://` in production, provide a
certificate the host trusts and **remove the flag**; do not set it to `true`.

This harness is unaffected: it talks to OpenLDAP over plain `ldap://localhost:4400`
and the printed env block sets `AUTH_LDAP_TLS_SKIP_VERIFY="false"`. The guard only
ever triggers on `NODE_ENV=production`, so `development`/`test`/unset environments
(including this harness) may still skip verification when they need to.

## What runs in CI vs. manually

- **CI:** the pure config-builder/role-mapping helper
  (`scripts/lib/ldap-harness.mjs`) is unit tested
  (`scripts/lib/ldap-harness.test.mjs`, 100% coverage) in the existing `scripts`
  vitest workspace. This runs on every PR. The TypeScript coverage gate is scoped
  to this helper module.
- **Manual only:** spinning the live OpenLDAP container + the end-to-end login
  round-trip. Like the [SAML harness (#523)](./saml-local-testing.md), the
  [OIDC harness (#521)](./oidc-local-testing.md), and the
  [`make kind-smoke`](../../Makefile) Kubernetes smoke (#545), this is a documented
  local `make` target, **not** a CI job — a job that spins an external directory
  container would be flaky and is intentionally avoided.

## Related

- [Auth docs index + config reference](./README.md) — authoritative `AUTH_LDAP_*`
  env vars and admin-API SAML/OIDC/LDAP config fields (#527).
- [Local IdP test harnesses index](./local-testing.md) — "which harness tests what".
- [`.env.example`](../../.env.example) — the full `AUTH_LDAP_*` reference block.
- [OIDC local test harness](./oidc-local-testing.md) — the sibling #521 harness.
- [SAML local test harness](./saml-local-testing.md) — the sibling #523 harness.
