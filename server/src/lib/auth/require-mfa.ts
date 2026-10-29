/**
 * MFA passthrough middleware — inspects SSO session for MFA confirmation.
 *
 * Epic #748, Issue #754: MFA passthrough via `amr` claim.
 * Issue #1554: mounted on the security-sensitive actions only — state-changing
 * admin routes (including SSO configuration), revealing and rotating vault
 * secrets, and changing a user's role or workspace role. Read-only pages,
 * analysis, chat, review and publishing are not gated.
 */
import type { RequestHandler } from "express";
import type { AuthPayload } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";

/**
 * The 403 message. The UI shows its own copy for the `MFA_REQUIRED` code; this
 * one is for API clients, and says the same: what is wrong and who can fix it.
 */
export const MFA_REQUIRED_MESSAGE =
  "This action needs a sign-in with multi-factor authentication (MFA). Sign out and sign in " +
  "again with MFA. If your sign-in did not ask for a second factor, your identity provider " +
  "administrator must require MFA for METIS (in Microsoft Entra ID, a Conditional Access " +
  "policy requiring MFA for the METIS app).";

/**
 * Throw 403 `MFA_REQUIRED` unless the session may perform an MFA-gated action.
 *
 * An SSO sign-in records the IdP's verdict as `mfaPassed` (#1552) and the
 * session keeps it across refreshes; a refresh of an SSO session from before
 * #1552 records `false` (`refreshAccessToken`), so it must sign in again. A
 * password sign-in (mock, LDAP: the local break-glass path) makes no MFA claim
 * and is not gated.
 */
export function assertMfa(user: AuthPayload | undefined): void {
  if (!user) {
    throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  }
  if (user.mfaPassed === false) {
    throw new AppError(403, "MFA_REQUIRED", MFA_REQUIRED_MESSAGE);
  }
}

/** {@link assertMfa} as route middleware; mount it after the route's authorization checks. */
export const requireMfa: RequestHandler = (req, _res, next) => {
  try {
    assertMfa(req.user as AuthPayload | undefined);
    next();
  } catch (err) {
    next(err);
  }
};
