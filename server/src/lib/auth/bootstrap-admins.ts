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

/** The identities in `METIS_BOOTSTRAP_ADMINS`, folded; empty when unset. */
export function bootstrapAdminIdentities(
  raw: string | undefined = process.env.METIS_BOOTSTRAP_ADMINS,
): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
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
    (identity) => typeof identity === "string" && listed.has(identity.trim().toLowerCase()),
  );
}
