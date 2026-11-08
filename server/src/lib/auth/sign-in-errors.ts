/**
 * #1977 — the sign-in error more than one login-path module raises.
 *
 * `login-identity.ts` (claiming the account) and `durable-roles.ts` (the
 * sign-in's role reconciliation) both answer an exhausted write-conflict retry
 * with the same 503. Kept here, a leaf, so neither imports the other for it.
 */
import { AppError } from "../../middleware/error-handler.js";

export const SIGN_IN_CONFLICT = "SIGN_IN_CONFLICT";

/**
 * #1959 — every attempt lost a write conflict. Transient, and no account
 * conflict, so it is not audited as one.
 */
export function signInConflict(): AppError {
  return new AppError(
    503,
    SIGN_IN_CONFLICT,
    "This sign-in collided with others made at the same moment and was not completed. " +
      "Try signing in again.",
  );
}
