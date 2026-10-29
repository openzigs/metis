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
the seed sets to `admin` (override with `SAML_DEFAULT_ROLE`). To test SAML
group→role mapping, use the [Entra ID profile](#entra-id-profile-in-process-runs-in-ci)
below, which emits Entra's group and app-role claims.

## Entra ID profile (in-process, runs in CI)

Most customers connect METIS to **Microsoft Entra ID**, whose claim URIs,
signing default, group overage and metadata shape the generic mock above cannot
reproduce. `scripts/lib/mock-entra-saml-idp.mjs` (#1553) is an in-process SAML
IdP that behaves like Entra, on loopback, with no container and no external
network. It needs `node` and `openssl` (it generates a throwaway signing key and
certificate at startup and deletes them from disk at once; nothing is committed).

```js
import { startMockEntraSamlIdp } from "./scripts/lib/mock-entra-saml-idp.mjs";

const idp = await startMockEntraSamlIdp({
  spEntityId: "http://127.0.0.1:4101/api/auth/saml/metadata", // METIS SP Entity ID
  acsUrl: "http://127.0.0.1:4101/api/auth/saml/acs", // METIS ACS URL
  user: { upn: "ada@contoso.example", objectId: "…", displayName: "Ada", groups: ["<group GUID>"] },
});
idp.metadataUrl; // paste what this serves into Admin → Authentication → SAML 2.0
idp.setProfile({ signing: "both", mfa: true }); // for the next sign-in
```

What it serves, each shape from Microsoft Learn:

- **Federation Metadata XML** at `/<tenant>/federationmetadata/2007-06/federationmetadata.xml`:
  signed (`ds:Signature`), entityID `https://sts.windows.net/<tenant-id>/`, the
  WS-Federation `RoleDescriptor`s (`fed:SecurityTokenServiceType`,
  `fed:ApplicationServiceType`) before the `IDPSSODescriptor`, and the signing
  certificate in each section
  ([Microsoft Entra federation metadata](https://learn.microsoft.com/en-us/entra/identity-platform/federation-metadata)).
  The tenant id is random per instance.
- **The SAML endpoint** `/<tenant>/saml2` (HTTP-Redirect): it refuses an
  AuthnRequest whose Issuer is not the configured SP Entity ID (`AADSTS700016`)
  or whose `AssertionConsumerServiceURL` is not the configured ACS URL
  (`AADSTS50011`), signs the configured user in at once, and answers with Entra's
  auto-posting form ([Single sign-on SAML protocol](https://learn.microsoft.com/en-us/entra/identity-platform/single-sign-on-saml-protocol)).
- **The Response**: Issuer `https://sts.windows.net/<tenant-id>/`, the UPN as an
  e-mail NameID, `InResponseTo` the request's ID, and the claims `objectidentifier`,
  `tenantid`, `identityprovider`, `displayname`, `emailaddress`, `name`, `groups`
  (group object IDs), `role` (app role values) and `authnmethodsreferences`
  ([SAML 2.0 token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/reference-saml-tokens)).

The profile, set with `setProfile` before a sign-in (unnamed fields return to
Entra's defaults):

| Field | Default | Effect |
|-------|---------|--------|
| `signing` | `"assertion"` | Entra's **Signing Option**: `"assertion"` (Sign SAML assertion, Entra's default — METIS refuses it), `"response"` (Sign SAML response — refused too, METIS requires a signed assertion), `"both"` (Sign SAML response and assertion — what [azure-ad.md](./azure-ad.md) tells admins to choose) ([Certificate signing options](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/certificate-signing-options)) |
| `mfa` | `false` | `true` adds `multipleauthn` to `authnmethodsreferences` and sends the `MobileTwoFactorContract` class; `false` is a password-only sign-in (`Password`) |
| `groupOverage` | `false` | sends `groups.link` (a Graph link) instead of `groups`, as Entra does past 150 groups ([group claims](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-fed-group-claims)) |
| `expired` | `false` | the assertion was issued two hours ago and its windows closed 50 minutes ago |
| `wrongAudience` | `false` | the Audience names another application |

`idp.lastResponse()` returns the last SAMLResponse it posted, for a replay test.

Where it runs:

- `scripts/lib/mock-entra-saml-idp.test.mjs` — the mock's own contract (`scripts`
  workspace).
- `server/tests/saml-entra-mock-idp-1553.sqlite.test.ts` — every profile through
  METIS's real routes: roles from group object IDs, both refused signing options,
  MFA in the session, the overage admin warning, and refused replay, wrong-audience
  and expired assertions.
- `e2e/tests/sso-saml-entra.spec.ts` — the same in a real browser from the
  `/login` page's SAML button, ending on the dashboard or on the ACS's refusal,
  and the overage warning on **Admin → Authentication**. It runs in the sharded
  `e2e` CI job.

The e2e stack has no Ingress, so the spec routes the SAML button's
`/api/auth/saml/login` (on the UI's port) to the API's port, as the Ingress does
in a deployment.

## Smoke test against a real Entra tenant

The mock proves METIS against Entra's documented shapes; only a real tenant
proves the last step. Once per release that touches SAML, or before a customer's
first Entra rollout:

1. **Enterprise app.** In a test tenant: Entra ID → Enterprise apps → New
   application → Create your own application → Non-gallery. Single sign-on →
   SAML. Basic SAML Configuration: Identifier = METIS **SP Entity ID**, Reply URL =
   `https://<metis-host>/api/auth/saml/acs`.
2. **Signing option.** SAML Signing Certificate → Edit → Signing Option **Sign
   SAML response and assertion**, SHA-256.
3. **Claims.** Attributes & Claims → Add a group claim → **Groups assigned to the
   application**, source **Group ID**. Optionally define app roles and assign them.
   For `authnmethodsreferences`, add the optional `amr` claim with
   `include_granular_amr` to the app registration.
4. **Groups and users.** Create two groups (for example `METIS Admins`,
   `METIS Members`), assign both to the app, and create two test users: one in
   each group. Require MFA for one user (Conditional Access or per-user MFA) and
   not the other.
5. **METIS.** Download **Federation Metadata XML**, paste it into Admin →
   Authentication → SAML 2.0 with the SP Entity ID and ACS URL, enable it, and map
   each group's **object ID** to a role.
6. **Check:**
   - each user signs in from the `/login` button and lands on the dashboard with
     the mapped role (`/api/auth/me`);
   - temporarily set Signing Option back to **Sign SAML assertion**: the sign-in
     is refused with a message naming "Sign SAML response and assertion"; set it
     back;
   - the MFA user's session carries `mfaPassed: true` and the password-only
     user's `false` (decode the `metis.at` cookie's JWT payload);
   - no overage warning appears on the SAML 2.0 tab (a test user is in far fewer
     than 150 groups).
7. **Clean up**: delete the test users and the enterprise app, or disable it.

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

- **CI:** the [Entra ID profile](#entra-id-profile-in-process-runs-in-ci) mock and
  the server and Playwright tests that drive it (no container, no external
  network); and the pure config-builder helper (`scripts/lib/saml-harness.mjs`) is unit
  tested (`scripts/lib/saml-harness.test.mjs`, 100% coverage) in the existing
  `scripts` vitest workspace. This runs on every PR.
- **Manual only:** spinning the live `boxyhq/mock-saml` container + its end-to-end
  login round-trip, and the [real Entra tenant smoke test](#smoke-test-against-a-real-entra-tenant). Like the [`make kind-smoke`](../../Makefile) Kubernetes smoke
  (#545), this is a documented local `make` target, **not** a CI job — a job that
  spins an external IdP container would be flaky and is intentionally avoided.

## Related

- [Auth docs index + config reference](./README.md) — env vars vs admin-API config (#527).
- [Local IdP test harnesses index](./local-testing.md) — "which harness tests what".
- [OIDC local test harness](./oidc-local-testing.md) — the sibling #521 harness (covers group→role mapping).
- [LDAP local test harness](./ldap-local-testing.md) — the sibling #525 harness (env-driven).
