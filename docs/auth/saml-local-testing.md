# Local SAML test harness

One command spins up a **local SAML 2.0 Identity Provider** and configures METIS
to trust it, so you can exercise the SAML login flow — including the
[#520 response-signing / replay hardening](./saml.md) — **without a real
corporate IdP**. (Issue #523, Epic #517.)

## What it gives you

- `docker-compose.saml.yml` — runs [`boxyhq/mock-saml`](https://github.com/boxyhq/mock-saml)
  as a local IdP on `http://localhost:4500`.
- `scripts/saml-harness/up.sh` — generates a throwaway signing keypair, starts
  the mock IdP, and runs the seed script.
- `scripts/seed-saml.mjs` — configures METIS's SAML provider via
  `PUT /api/admin/auth/providers/saml` (admin API), pointing it at the mock IdP.
- `make saml-up` / `make saml-down` targets.

## Why this mock IdP

We chose **`boxyhq/mock-saml`** over `kristophjunge/test-saml-idp` for two reasons:

1. **Maintained.** boxyhq/mock-saml ships regular releases (through Dec 2025);
   `kristophjunge/test-saml-idp` is pinned to SimpleSAMLphp 1.15.2 (2017).
2. **It signs the Response envelope, not just the assertion.** Its
   `@boxyhq/saml20` `createSAMLResponse` signs **both** the `Assertion` *and* the
   `samlp:Response` envelope. That means METIS's **secure default**
   `requireSignedResponse: true` (node-saml `wantAuthnResponseSigned`) is
   satisfied out of the box — **you do not have to relax it for local testing**.
   A mock that only signed the assertion would force every developer to set
   `requireSignedResponse=false`, defeating the very hardening this harness
   exists to exercise.

> The harness therefore runs against METIS's **production-equivalent secure
> defaults**. You should not need `requireSignedResponse=false`. The opt-out is
> only documented for a third-party IdP that genuinely cannot sign the envelope
> (see [docs/auth/saml.md](./saml.md#the-one-configurable-knob-requiresignedresponse)).

## Prerequisites

- Docker (Compose v2), `openssl`, `node`, and `curl` on your PATH.
- A **running METIS server** reachable at `http://localhost:4000` (the dev
  default). Keep `AUTH_MODE=mock` — see the note below; SAML login does **not**
  depend on `AUTH_MODE`.

## Bring it up

```bash
# 1. Start the METIS server the usual way (AUTH_MODE=mock is fine).
pnpm dev            # or docker compose up

# 2. Bring up the mock IdP and seed the METIS SAML provider.
make saml-up        # == bash scripts/saml-harness/up.sh
```

`up.sh` will:

1. Generate a throwaway RSA keypair into `scripts/saml-harness/.keys/`
   (gitignored — never committed; a committed key would trip the Semgrep
   secret-detection gate) and inject it base64-encoded into the mock IdP. The
   mock has **no fallback key**, so this step is required for it to sign.
2. `docker compose -f docker-compose.saml.yml up -d` the IdP and wait for its
   metadata endpoint (`/api/saml/metadata`) to be healthy.
3. Run `scripts/seed-saml.mjs`, which logs in as the mock `admin` user, fetches
   the mock IdP's **signed metadata** (entityID + SSO URL + X509 cert), and
   `PUT`s it to the admin API. METIS parses the entryPoint / cert / issuer out
   of the metadata itself, so the cert METIS trusts is exactly the cert the mock
   signs with. The seed then re-reads the provider and asserts it is enabled.

## Log in end-to-end

1. Open `http://localhost:4000/auth/saml/login` (or click the **Local Mock
   SAML** button on the METIS `/login` page).
2. METIS redirects to the mock IdP. Enter a test user email:
   - `user1@example.com`
   - `user2@example.com`

   (any password — the mock accepts any `@example.com` / `@example.org` email).
3. The mock IdP POSTs a **signed** SAML Response back to METIS's ACS
   (`/auth/saml/acs`). METIS validates the signature + `InResponseTo` +
   `NotOnOrAfter`, issues its session cookies, and redirects to the dashboard.

### Roles

The mock IdP emits only an `email` attribute — it does **not** emit a group/role
claim. METIS therefore resolves the role from the provider's `defaultRole`, which
the seed sets to `admin` (override with `SAML_DEFAULT_ROLE`). To test
group→role mapping you need an IdP that emits a `groups`/`Group` claim — use the
[Keycloak OIDC harness (#521)](./oidc-local-testing.md), which exists
specifically to cover that, or a real IdP.

## Tear down

```bash
make saml-down                                  # stop the IdP, keep the keys
bash scripts/saml-harness/down.sh --purge-keys  # also delete the keypair
```

The keypair is kept by default so a later `make saml-up` reuses the same signing
identity and the already-seeded METIS provider keeps trusting it.

## Configuration (env overrides)

| Variable | Default | Purpose |
|----------|---------|---------|
| `METIS_API_URL` | `http://localhost:4000` | METIS server base used by the seed. |
| `SAML_IDP_URL` | `http://localhost:4500` | Where the mock IdP is published. |
| `METIS_ADMIN_USER` / `METIS_ADMIN_PASSWORD` | `admin` / `password` | Mock-auth admin creds the seed logs in with. |
| `SAML_DEFAULT_ROLE` | `admin` | METIS role assigned on SAML login (no group claim). |
| `SAML_PROVIDER_NAME` | `Local Mock SAML` | Provider label on the login page. |
| `SKIP_SEED=1` | — | `up.sh` starts the IdP but does not seed (seed manually). |

### Why `AUTH_MODE` stays `mock`

SAML is configured through the **admin API**, not env vars. The SSO routes
(`/auth/saml/login`, `/auth/saml/acs`, `/auth/saml/metadata`) are always mounted
and read the **stored provider config** — they do not gate on `AUTH_MODE`. So the
dev server keeps `AUTH_MODE=mock` (which is also what lets the seed script obtain
an admin token to call the admin API), and SAML login is layered on top exactly
as it is in production.

## What runs in CI vs. manually

- **CI:** the pure config-builder helper (`scripts/lib/saml-harness.mjs`) is unit
  tested (`scripts/lib/saml-harness.test.mjs`, 100% coverage) in the existing
  `scripts` vitest workspace. This runs on every PR.
- **Manual only:** spinning the live mock IdP container + the end-to-end login
  round-trip. Like the [`make kind-smoke`](../../Makefile) Kubernetes smoke
  (#545), this is a documented local `make` target, **not** a CI job — a job that
  spins an external IdP container would be flaky and is intentionally avoided.

## Related

- [Auth docs index + config reference](./README.md) — env vars vs admin-API config (#527).
- [Local IdP test harnesses index](./local-testing.md) — "which harness tests what".
- [OIDC local test harness](./oidc-local-testing.md) — the sibling #521 harness (covers group→role mapping).
- [LDAP local test harness](./ldap-local-testing.md) — the sibling #525 harness (env-driven).
