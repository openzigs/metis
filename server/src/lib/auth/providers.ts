/**
 * Auth provider factory.
 *
 * Selects the concrete `AuthProvider` based on the `AUTH_MODE` env var.
 * Supports: `mock`, `ldap`, `saml`, `oidc`.
 * SAML/OIDC modes use a shim that delegates to the SSO flow (login is
 * handled via redirect, not username/password).
 */
import { createChildLogger } from "../logger.js";
import { LDAPAuthProvider } from "./ldap-provider.js";
import { MockAuthProvider } from "./mock-provider.js";
import { SSOAuthProviderShim } from "./sso-auth-shim.js";
import type { AuthProvider } from "./types.js";

const log = createChildLogger("auth-factory");

let cached: AuthProvider | null = null;

/**
 * Production fail-fast guard for mock authentication.
 *
 * The mock provider (`mock-provider.ts`) accepts the publicly-known static
 * credentials `admin`/`password` and grants full admin. It is the intended
 * default for local development and tests, but it must be IMPOSSIBLE to
 * activate in production — a deploy that omits or mistypes `AUTH_MODE` would
 * otherwise boot with these static credentials wide open.
 *
 * We FAIL FAST (throw at startup) rather than silently substituting a real
 * provider: mirroring {@link assertLDAPTlsConfigSafe} in `ldap-provider.ts` and
 * the `JWT_SECRET` check in `jwt.ts`, a loud failure forces the operator to make
 * an explicit, correct choice instead of unknowingly shipping insecure auth.
 *
 * Throws when `NODE_ENV==='production'` and the resolved provider is mock —
 * which covers an explicit `AUTH_MODE=mock`, an unset/empty/whitespace-only
 * value, and any unrecognized value that would otherwise fall back to mock.
 * No-op in every other environment (dev/test may still use mock).
 */
function assertMockAuthAllowed(mode: string): void {
  if (process.env.NODE_ENV === "production") {
    log.error("Refusing to start with mock auth provider in production", { mode });
    throw new Error(
      "Mock authentication is not permitted in production: the mock provider accepts the " +
        "publicly-known static credentials admin/password and grants full admin access. " +
        `Resolved AUTH_MODE=${JSON.stringify(mode)} selects the insecure mock provider. ` +
        "Set AUTH_MODE to a real provider (ldap, saml, or oidc). " +
        "(Mock auth is for local development and tests only.)",
    );
  }
}

export function getAuthProvider(): AuthProvider {
  if (cached) return cached;
  // Trim surrounding whitespace and lowercase so that case and stray spaces
  // cannot smuggle an unrecognized value past the guard. An unset, empty, or
  // whitespace-only value resolves to `mock` — the intended dev/test default,
  // which is then rejected in production by `assertMockAuthAllowed`.
  const raw = process.env.AUTH_MODE;
  const mode = (raw ?? "").trim().toLowerCase() || "mock";
  switch (mode) {
    case "ldap":
      cached = new LDAPAuthProvider();
      break;
    case "mock":
      assertMockAuthAllowed(mode);
      cached = new MockAuthProvider();
      break;
    case "saml":
      cached = new SSOAuthProviderShim("saml");
      break;
    case "oidc":
      cached = new SSOAuthProviderShim("oidc");
      break;
    default:
      assertMockAuthAllowed(mode);
      log.warn("Unknown AUTH_MODE — falling back to mock provider", { mode });
      cached = new MockAuthProvider();
  }
  log.info("Auth provider initialized", { provider: cached.name });
  return cached;
}

/** Test helper. */
export function __resetAuthProvider(): void {
  cached = null;
}

export type { AuthProvider, AuthResult, AuthenticatedUser } from "./types.js";
