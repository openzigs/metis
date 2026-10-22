/**
 * #1376 — the supported way to get the first administrator on an LDAP, OIDC or
 * SAML install.
 *
 * Mock auth is refused in production, the LDAP env path maps everyone to
 * `reader`, and group mappings can only be set by an admin, so a fresh
 * production install had no admin and no supported way to make one (the #1312
 * staging run wrote the role rows into the database by hand).
 *
 * `METIS_BOOTSTRAP_ADMINS` lists usernames and/or e-mail addresses
 * (comma- or whitespace-separated, case-insensitive). When a listed identity
 * signs in through a trusted provider and NO user holds the admin role, that
 * user is granted admin as an explicit (`local`) role, exactly as an admin
 * would grant it. Once any admin exists the list does nothing, so it cannot be
 * replayed to escalate: leaving it set after the first login is harmless, and
 * removing it is tidy.
 *
 * The check and the grant run inside the login's own serializable transaction
 * (`reconcileTrustedLoginRole`), so two listed users signing in at once cannot
 * both see "no admin" and both be granted it.
 */

/** One identity, folded for comparison: NFKC, trimmed, lower-cased. */
function foldIdentity(identity: string): string {
  return identity.normalize("NFKC").trim().toLowerCase();
}

/**
 * A signing-in identity that NFKC would change is never a candidate:
 * `"Kate".toLowerCase()` is already `"kate"` (Kelvin sign), so folding
 * alone would let a look-alike account an IdP accepted match a listed `kate`.
 */
function isNfkcStable(identity: string): boolean {
  return identity.normalize("NFKC") === identity;
}

/** The identities in `METIS_BOOTSTRAP_ADMINS`, folded; empty when unset. */
export function bootstrapAdminIdentities(
  raw: string | undefined = process.env.METIS_BOOTSTRAP_ADMINS,
): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map(foldIdentity)
      .filter((entry) => entry.length > 0),
  );
}

/**
 * Whether any of a signing-in user's identities is listed. `identities` holds
 * only values the identity provider vouches for (the account's username, and an
 * e-mail the provider asserts) — never request input.
 */
export function isBootstrapAdminCandidate(
  identities: readonly (string | null | undefined)[],
  listed: Set<string> = bootstrapAdminIdentities(),
): boolean {
  if (listed.size === 0) return false;
  return identities.some(
    (identity) =>
      typeof identity === "string" && isNfkcStable(identity) && listed.has(foldIdentity(identity)),
  );
}

function claimString(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The identities a SAML assertion states as-is: `upn`, `uid`, the e-mail
 * attributes and the NameID. Never the username METIS derives when those are
 * absent — that is the e-mail's local part, so `jdoe@other.example` would match
 * a listed `jdoe`.
 */
export function samlAssertedIdentities(claims: Record<string, unknown>): string[] {
  return [
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
    "uid",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "email",
    "nameID",
  ]
    .map((name) => claimString(claims, name))
    .filter((v): v is string => v !== null);
}

/**
 * The one OIDC identity that counts: the `email` CLAIM, and only when the IdP
 * marks it `email_verified: true`. Not the username (`preferred_username` is
 * often user-editable; without it METIS uses the e-mail's local part), and not
 * METIS's `email` field, which falls back to `preferred_username` or `sub`.
 */
export function oidcAssertedIdentities(claims: Record<string, unknown>): string[] {
  const email = claimString(claims, "email");
  return email && claims.email_verified === true ? [email] : [];
}
