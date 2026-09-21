# SAML 2.0 — security posture and admin configuration

METIS supports SAML 2.0 SSO (configured via the admin API, no env vars — see
`PUT /api/admin/auth/providers/saml`). This page documents the **hardened
response-validation posture** introduced by Epic #517 / Issue #520 (OWASP A07:
Identification and Authentication Failures) and the one configurable knob it adds.

> **Want to try it locally?** See
> [SAML local test harness](./saml-local-testing.md) (#523) — a one-command mock
> IdP (`make saml-up`) that exercises this hardened posture end-to-end, with the
> secure response-signing defaults intact.

## Threat model

A SAML login is a two-leg flow:

1. **AuthnRequest (initiate)** — `GET /auth/saml/login` redirects the browser to
   the IdP with a signed/unsigned `AuthnRequest` carrying a unique request `ID`.
2. **Response (ACS)** — the IdP POSTs a `SAMLResponse` back to
   `POST /auth/saml/acs`. The Response wraps an `Assertion` and echoes the
   request id in its `InResponseTo` attribute.

The relevant threats and the controls that mitigate them:

| Threat (OWASP A07) | Control |
|--------------------|---------|
| **Response replay** — an attacker captures a valid `SAMLResponse` and re-POSTs it to ACS. | `validateInResponseTo: ifPresent` + a **single-use request-id cache**. The id minted on the AuthnRequest is consumed on first validation; a replayed Response carries an `InResponseTo` that is already gone, so it is rejected. |
| **Forged / tampered Response envelope** — an attacker injects or rewrites the Response around a stolen assertion. | `wantAuthnResponseSigned: true` (the default) — the Response envelope itself must carry a valid XML signature, not just the assertion. |
| **Forged assertion** | `wantAssertionsSigned: true` (always on) — the assertion must be signed by the IdP cert. |
| **Stale / out-of-window assertion** | `acceptedClockSkewMs` enforces the assertion `NotBefore` / `NotOnOrAfter` and the SubjectConfirmationData window with a small (30s) tolerance. |
| **Unsolicited / mismatched `InResponseTo`** | An `InResponseTo` that was never issued (or does not match an outstanding request id) misses the cache and is rejected. |

## The verified node-saml options (`@node-saml/passport-saml` v5.1.0)

Set in `server/src/lib/auth/saml-provider.ts` (`buildSamlConfig`). Option names
verified against `@node-saml/node-saml` v5.1.0 `lib/types.d.ts`:

| Option | Value | Why |
|--------|-------|-----|
| `validateInResponseTo` | `ValidateInResponseTo.ifPresent` | Validate the `InResponseTo` whenever the Response carries one (SP-initiated logins always do) without hard-failing a legitimately IdP-initiated Response that has none. |
| `cacheProvider` | shared request-id cache (see below) | Backs `validateInResponseTo` — saves the request id on AuthnRequest, reads+removes it on Response (single-use). |
| `requestIdExpirationPeriodMs` | `28_800_000` (8h) | Bounds the replay window; an AuthnRequest older than this can no longer be matched. |
| `wantAuthnResponseSigned` | `true` (default; admin-configurable) | Require the Response envelope to be signed. |
| `wantAssertionsSigned` | `true` (always) | Require the assertion to be signed. |
| `acceptedClockSkewMs` | `30_000` (30s) | Enforce assertion time windows with a small, non-zero NTP-drift tolerance. Not `0` (would reject legit logins on minor skew); not unbounded (would defeat `NotOnOrAfter`). |

## Multi-replica request-id cache (Epic #518)

`validateInResponseTo` only works if the **same** request-id cache backs both
legs: the AuthnRequest (which saves the id) and the Response validation (which
reads+removes it). METIS now runs multiple replicas behind a load balancer
(Epic #518), so the two legs can land on different pods. node-saml's bundled
`InMemoryCacheProvider` is per-process — its own docs say it is **not** sufficient
behind a load balancer.

METIS therefore selects the cache backend with `SAML_REQUEST_ID_CACHE_BACKEND`:

- `memory` (default) — `InMemorySamlRequestIdCache`. Per-process; correct only for
  single-replica dev/local.
- `postgres` — **required for multi-replica.** `PostgresSamlRequestIdCache` stores
  the request id in the shared Postgres introduced by #539's
  `DATABASE_URL`-scheme-selected Prisma adapter (the same shared store the #542
  SSO transaction-state work reused). The id minted on one pod is visible — and
  consumable exactly once — on any other pod. The cache self-creates an
  `UNLOGGED` table behind an advisory lock (no Prisma schema migration), mirroring
  the #541 rate-limit and #542 SSO-state tables. The stored value is node-saml's
  non-secret `instant` timestamp keyed by the high-entropy request id; nothing
  sensitive is logged, and all writes are parameterised (OWASP A03).

> Deployment note: when running more than one replica, set
> `SAML_REQUEST_ID_CACHE_BACKEND=postgres` (alongside `SSO_STATE_BACKEND=postgres`
> from #542). Leaving it on `memory` makes cross-pod logins fail intermittently
> AND weakens replay protection to per-pod.

## The one configurable knob: `requireSignedResponse`

`PUT /api/admin/auth/providers/saml` accepts an optional boolean
`requireSignedResponse`:

- **Omitted / `true` (default, recommended): secure posture.** The Response
  envelope must be signed (`wantAuthnResponseSigned: true`).
- **`false`: documented opt-out.** Set this **only** for an IdP that genuinely
  cannot sign the Response envelope. The **assertion is still required to be
  signed** (`wantAssertionsSigned` is always `true`), so the assertion's integrity
  and origin are still cryptographically protected; what you lose is envelope-level
  integrity (e.g. protection against an attacker rewrapping a valid assertion in a
  forged Response shell). Prefer enabling response signing at the IdP instead.

The value is coerced to a strict boolean on write (a stray string cannot enable
the insecure path), preserved across updates that omit it, and surfaced
(non-secret) in the admin read view so the configured posture is visible. Legacy
configs stored before #520 are reported and treated as `requireSignedResponse:
true`.

## Tests

- `server/src/lib/auth/__tests__/saml-provider-security.test.ts` drives the **real**
  node-saml validator with **real** signed/unsigned Responses, proving: valid
  login succeeds; an unsigned Response is rejected when signing is required;
  assertion-only signing is accepted iff `requireSignedResponse=false`; an expired
  `NotOnOrAfter` is rejected; a replayed Response is rejected; an unknown /
  mismatched `InResponseTo` is rejected; minor clock skew within tolerance still
  authenticates. The test mints a throwaway self-signed cert at runtime (no
  committed key material) and signs with `xml-crypto`.
- `saml-request-id-cache*.test.ts` cover the cache contract + cross-replica
  behaviour; `tests/saml-request-id-cache-postgres.integration.test.ts` proves it
  end-to-end against a real Postgres (gated, in the `postgres-adapter` CI job).
