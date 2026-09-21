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
}

export type AuthResult =
  | { success: true; user: AuthenticatedUser }
  | { success: false; error: string };

export interface AuthProvider {
  /** Stable name used in logs and the `/auth/me` payload. */
  readonly name: string;
  authenticate(username: string, password: string): Promise<AuthResult>;
}
