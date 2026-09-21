/**
 * SSO Auth Provider Shim — adapter that implements the AuthProvider interface
 * for SSO modes (SAML/OIDC).
 *
 * SSO flows don't use username/password authentication directly; login is
 * handled via browser redirect to the IdP. This shim provides a graceful error
 * when the username/password endpoint is called for an SSO-configured system.
 */
import type { AuthProvider, AuthResult } from "./types.js";
import type { SSOMode } from "./sso-types.js";

export class SSOAuthProviderShim implements AuthProvider {
  readonly name: string;
  private readonly mode: SSOMode;

  constructor(mode: SSOMode) {
    this.mode = mode;
    this.name = mode;
  }

  async authenticate(_username: string, _password: string): Promise<AuthResult> {
    return {
      success: false,
      error: `Direct username/password login is not available when AUTH_MODE=${this.mode}. Use the SSO login flow instead.`,
    };
  }
}
