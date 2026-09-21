# Local OIDC test harness

One command spins up a **local Keycloak OpenID Connect Identity Provider** and
configures METIS to trust it, so you can exercise the OIDC login flow — including
the PKCE / state / nonce hardening **and IdP-group→role mapping** — **without a
cloud IdP**. (Issue #521, Epic #517.)

## What it gives you

- `docker-compose.oidc.yml` — runs [Keycloak](https://www.keycloak.org/)
  (`quay.io/keycloak/keycloak:26.6.4`) as a local IdP on `http://localhost:4600`,
  with the `metis` realm imported deterministically from a JSON file.
- `scripts/oidc-harness/realm-metis.json` — the realm import: a confidential
  `metis` client, two test users, groups, and a Group Membership protocol mapper
  that emits a `groups` claim.
- `scripts/oidc-harness/up.sh` — starts Keycloak and runs the seed script.
- `scripts/seed-oidc.mjs` — configures METIS's OIDC provider via
  `PUT /api/admin/auth/providers/oidc` (admin API), pointing it at Keycloak's
  discovery URL with the group→role mappings.
- `make oidc-up` / `make oidc-down` targets.

## Why Keycloak (and why this harness exists)

The [SAML harness (#523)](./saml-local-testing.md) uses `boxyhq/mock-saml`, which
emits **only an `email` attribute — no group/role claim**. It therefore *cannot*
exercise METIS's IdP-group→role mapping (`resolveRoleFromGroups`); a SAML login
there always falls back to `defaultRole`.

This OIDC harness exists to cover exactly that gap. **Keycloak** is a real,
actively maintained IdP (26.6.4 is the current stable, June 2026). The imported
realm puts the test user in a **group**, and a **Group Membership** protocol
mapper emits that group in a `groups` claim. METIS reads the `groups` claim
(`oidc-provider.ts`) and maps it to a METIS role via the provider's
`groupMappings` (`resolveRoleFromGroups`, `sso-config.ts`). So a grouped user
lands with the **mapped** role, not just the default.

The realm is provisioned via Keycloak's `--import-realm` from a JSON file rather
than manual admin-console clicks, so the client / user / groups / claim mapper are
**identical on every boot** — no flaky setup.

## Prerequisites

- Docker (Compose v2), `curl`, and `node` on your PATH.
- A **running METIS server** reachable at `http://localhost:4000` (the dev
  default). Keep `AUTH_MODE=mock` — see the note below; OIDC login does **not**
  depend on `AUTH_MODE`.

## Bring it up

```bash
# 1. Start the METIS server the usual way (AUTH_MODE=mock is fine).
pnpm dev            # or docker compose up

# 2. Bring up Keycloak and seed the METIS OIDC provider.
make oidc-up        # == bash scripts/oidc-harness/up.sh
```

`up.sh` will:

1. `docker compose -f docker-compose.oidc.yml up -d` Keycloak with the `metis`
   realm imported, and wait for the realm's OIDC discovery doc
   (`/realms/metis/.well-known/openid-configuration`) to answer. First boot +
   realm import can take ~1 minute.
2. Run `scripts/seed-oidc.mjs`, which logs in as the mock `admin` user, waits for
   discovery, and `PUT`s the provider config (discovery URL, client id/secret,
   redirect URI, scopes, and the group→role mappings) to the admin API. The seed
   then re-reads the provider and asserts it is enabled.

## Log in end-to-end (and verify the role mapping)

1. Open `http://localhost:4000/api/auth/oidc/login` (or click the **Local
   Keycloak (OIDC)** button on the METIS `/login` page).
2. METIS redirects to Keycloak. Log in as the test user:
   - **`tester`** / **`testpass`** — member of group **`metis-admins`**.
3. Keycloak redirects back to METIS's callback
   (`/api/auth/oidc/callback`). METIS validates the PKCE code, state and nonce,
   reads the `groups` claim (`["metis-admins"]`), maps it to the **`admin`** role
   via `groupMappings`, issues its session cookies, and redirects to the
   dashboard.

### Verifying the group→role mapping

The harness ships two users so you can see the mapping actually take effect:

| Keycloak user | Password | Keycloak group | METIS `groupMappings` | Resolved METIS role |
|---------------|----------|----------------|-----------------------|---------------------|
| `tester` | `testpass` | `metis-admins` | `metis-admins → admin` | **admin** |
| `dev` | `devpass` | `metis-developers` | `metis-developers → developer` | **developer** |

Log in as each and confirm the role differs (e.g. `tester` sees admin-only nav;
`dev` does not). A user in **no** mapped group would fall back to the provider's
`defaultRole` (`reader`). This is the capability the SAML harness could not test.

> **How the claim flows:** the realm's Group Membership mapper has
> `Full group path = OFF`, so the `groups` claim carries bare group **names**
> (`metis-admins`), not paths (`/metis-admins`). METIS matches a mapping when
> `groups.includes(mapping.claimValue)`, so each `claimValue` is the bare group
> name. (`validateGroupMappings` requires at least one mapping resolve to
> `admin`, which is why `metis-admins → admin` is always present.)

## Tear down

```bash
make oidc-down                      # stop Keycloak
```

Keycloak (`start-dev`) uses an in-memory H2 database, so the realm is re-imported
fresh on every `make oidc-up` — there is no persistent state to purge.

## Configuration (env overrides)

| Variable | Default | Purpose |
|----------|---------|---------|
| `METIS_API_URL` | `http://localhost:4000` | METIS server base used by the seed. |
| `OIDC_IDP_URL` | `http://localhost:4600` | Where Keycloak is published. |
| `OIDC_REALM` | `metis` | Keycloak realm to discover. |
| `OIDC_CLIENT_ID` | `metis` | Confidential client id (matches the realm import). |
| `OIDC_CLIENT_SECRET` | `metis-local-secret` | Client secret (matches the realm import). |
| `METIS_ADMIN_USER` / `METIS_ADMIN_PASSWORD` | `admin` / `password` | Mock-auth admin creds the seed logs in with. |
| `OIDC_DEFAULT_ROLE` | `reader` | METIS role when no group claim matches. |
| `OIDC_PROVIDER_NAME` | `Local Keycloak (OIDC)` | Provider label on the login page. |
| `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` | `admin` / `admin` | Keycloak master-realm admin console creds. |
| `SKIP_SEED=1` | — | `up.sh` starts Keycloak but does not seed (seed manually). |

### Why `AUTH_MODE` stays `mock`

OIDC is configured through the **admin API**, not env vars (there are no
`AUTH_OIDC_*` env vars). The SSO routes (`/api/auth/oidc/login`,
`/api/auth/oidc/callback`) are always mounted and read the **stored provider
config** — they do not gate on `AUTH_MODE`. So the dev server keeps
`AUTH_MODE=mock` (which is also what lets the seed script obtain an admin token to
call the admin API), and OIDC login is layered on top exactly as it is in
production.

## What runs in CI vs. manually

- **CI:** the pure config-builder helper (`scripts/lib/oidc-harness.mjs`) is unit
  tested (`scripts/lib/oidc-harness.test.mjs`, 100% coverage) in the existing
  `scripts` vitest workspace. This runs on every PR.
- **Manual only:** spinning the live Keycloak container + the end-to-end login
  round-trip. Like the [SAML harness (#523)](./saml-local-testing.md) and the
  [`make kind-smoke`](../../Makefile) Kubernetes smoke (#545), this is a
  documented local `make` target, **not** a CI job — a job that spins an external
  IdP container would be flaky and is intentionally avoided.

## Related

- [Auth docs index + config reference](./README.md) — env vars vs admin-API config (#527).
- [Local IdP test harnesses index](./local-testing.md) — "which harness tests what".
- [Keycloak SSO integration guide](./keycloak.md) — production Keycloak setup.
- [SAML local test harness](./saml-local-testing.md) — the sibling #523 harness.
- [LDAP local test harness](./ldap-local-testing.md) — the sibling #525 harness (env-driven).
