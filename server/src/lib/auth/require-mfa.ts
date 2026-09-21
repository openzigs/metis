/**
 * MFA passthrough middleware — inspects SSO session for MFA confirmation.
 *
 * Epic #748, Issue #754: MFA passthrough via `amr` claim.
 * Blocks sensitive actions when MFA has not been confirmed.
 */
import type { RequestHandler } from "express";
import type { AuthPayload } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";

/**
 * Middleware that requires MFA to have been confirmed in the current session.
 * For SSO sessions, this is set when the OIDC `amr` claim or SAML
 * AuthnContextClassRef indicates multi-factor authentication was performed.
 *
 * For non-SSO sessions (mock/LDAP), MFA is considered always-passed unless
 * SSO is configured and the user logged in via SSO.
 */
export const requireMfa: RequestHandler = (req, _res, next) => {
  try {
    const user = req.user as AuthPayload | undefined;
    if (!user) {
      throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    }

    // If the session has explicit mfaPassed=false from an SSO flow, block.
    // Non-SSO sessions (mock/LDAP) won't have mfaPassed set, so they pass through.
    if (user.mfaPassed === false) {
      throw new AppError(
        403,
        "MFA_REQUIRED",
        "Multi-factor authentication is required for this action",
      );
    }

    next();
  } catch (err) {
    next(err);
  }
};
