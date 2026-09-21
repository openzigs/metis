# Local IdP test harnesses

METIS ships three one-command local Identity-Provider harnesses so you can
exercise each login flow end-to-end — **without** a cloud IdP or a corporate
directory. They were added by Epic #517 (sub-issues #521, #523, #525); this page
is the connective index (#527). Each harness has its own detailed page — this
page only ties them together and tells you **which harness tests what**.

| Bring up | IdP | Flow exercised | `AUTH_MODE` | Group→role mapping? | Details |
|----------|-----|----------------|-------------|---------------------|---------|
| `make oidc-up` | Keycloak (`quay.io/keycloak/keycloak:26.6.4`) on `:4600` | OIDC: PKCE S256 + state + nonce, `groups` claim | stays `mock` (admin-API configured) | **Yes** — `tester`→admin, `dev`→developer | [oidc-local-testing.md](./oidc-local-testing.md) |
| `make saml-up` | `boxyhq/mock-saml` on `:4500` | SAML: signed-Response + `InResponseTo` replay + `NotOnOrAfter` (#520) | stays `mock` (admin-API configured) | **No** — mock emits only `email`; role falls to `defaultRole` | [saml-local-testing.md](./saml-local-testing.md) |
| `make ldap-up` | OpenLDAP (`bitnami/openldap:2.6`) on `:4400` | LDAP: service bind → search → user bind (password verify) | set to **`ldap`** (env-driven) | **Yes** — `alice`→admin, `bob`→developer (needs `groupMappings`, see below) | [ldap-local-testing.md](./ldap-local-testing.md) |

> **Why the SAML harness can't test roles, but OIDC and LDAP can.** The mock SAML
> IdP emits only an `email` attribute — no group/role claim — so a SAML login
> there always resolves to the provider's `defaultRole`. To exercise
> IdP-group→METIS-role mapping (`resolveRoleFromGroups`), use the **Keycloak OIDC
> harness** (its realm puts each test user in a group and emits a `groups` claim)
> or the **LDAP harness** (users have `memberOf` group DNs). This split is by
> design — see the SAML harness doc for the rationale.

## The one big difference: env-driven vs admin-API configured

This trips people up, so it is the single most important thing on this page:

- **SAML and OIDC are configured through the admin API**
  (`PUT /api/admin/auth/providers/{saml,oidc}`) — there are **no** `AUTH_SAML_*`
  or `AUTH_OIDC_*` env vars. The SSO routes are always mounted and read the
  **stored** provider config; they do **not** gate on `AUTH_MODE`. So for the
  OIDC and SAML harnesses you keep the dev server on `AUTH_MODE=mock` and the seed
  script `PUT`s the provider config for you. (Keeping `mock` is also what lets the
  seed obtain an admin token to call the admin API.)
- **LDAP is env-driven.** The active login provider is selected by
  **`AUTH_MODE=ldap`** and reads its connection settings from `AUTH_LDAP_*` env
  vars (`server/src/lib/auth/ldap-provider.ts` `getLDAPConfig`). So for the LDAP
  harness you start METIS **with `AUTH_MODE=ldap`** and the printed `AUTH_LDAP_*`
  block; login then goes through `POST /api/auth/login` against the directory.
  One subtlety: env-only LDAP config carries **no** `groupMappings`, so a pure-env
  login resolves every user to `defaultRole` (`reader`). To get the mapped roles
  in the table above, push the `groupMappings` via the admin API
  (`PUT /api/admin/auth/providers/ldap`) — the LDAP harness does this for you with
  `CONFIGURE=1 make ldap-up`.

For the authoritative env-var and admin-API config-field reference, see
[**README.md → Configuration reference**](./README.md#configuration-reference).

## What runs in CI vs. manually

For all three harnesses, only the **pure config-builder helper**
(`scripts/lib/{oidc,saml,ldap}-harness.mjs`) is unit-tested in the `scripts`
vitest workspace (100% coverage) and runs on every PR. **Spinning the live IdP
container + the end-to-end login round-trip is a documented manual `make` target,
not a CI job** — a job that spins an external IdP/directory container would be
flaky and is intentionally avoided (mirroring the `make kind-smoke` Kubernetes
smoke, #545).

## Related

- [README.md](./README.md) — the auth docs index + authoritative config reference.
- [saml.md](./saml.md) — SAML threat model + verified node-saml options (#520).
- [keycloak.md](./keycloak.md), [okta.md](./okta.md), [azure-ad.md](./azure-ad.md),
  [google-workspace.md](./google-workspace.md) — production IdP-side setup guides.
