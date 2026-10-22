/**
 * Authentication provider contracts.
 *
 * Each backend (mock, LDAP, future SAML/OIDC) implements `AuthProvider` so the
 * login route can stay unaware of the concrete identity store.
 */
import type { RoleKey } from "@metis/shared";

export interface AuthenticatedUser {
  username: string;
  displayName: string;
  email: string;
  role: RoleKey;
  /** Optional group claims (LDAP/AD). Mock provider returns []. */
  groups?: string[];
  /**
   * #1395 — the directory's canonical id for this account (`ldapSubject`).
   * Absent (mock): the folded username stands in (`directoryNameSubject`).
   */
  subject?: string;
}

export type AuthResult =
  | { success: true; user: AuthenticatedUser }
  | {
      success: false;
      error: string;
      /**
       * #1385 — `invalid_credentials` when the directory refused THIS password.
       * Only that counts against the per-account sign-in cap; an outage or a
       * misconfiguration must not lock out users whose password is right.
       */
      reason?: "invalid_credentials";
    };

export interface AuthProvider {
  /** Stable name used in logs and the `/auth/me` payload. */
  readonly name: string;
  authenticate(username: string, password: string): Promise<AuthResult>;
}
