/**
 * The HTTP form of the document-ACL errors `lib/rag/acl.ts` throws. Kept with
 * the routes so the RAG ACL module carries no HTTP status (#2356).
 */
import { AppError } from "../middleware/error-handler.js";
import {
  AclGroupUnsupportedError,
  AclSaveConflictError,
  InactiveAclActorError,
} from "../lib/rag/acl.js";

/**
 * #2261 — the HTTP form of `InactiveAclActorError` for a route whose caller IS
 * the actor: their token outlived their account, so it is a 401
 * `TOKEN_INVALID`, as `refreshAuthenticatedUser` answers, not a 500. Any other
 * error is returned unchanged. Use as `.catch((err) => { throw ... })`.
 */
export function inactiveCallerAsUnauthenticated(err: unknown): unknown {
  if (!(err instanceof InactiveAclActorError)) return err;
  return new AppError(401, "TOKEN_INVALID", "Access token is malformed or invalid");
}

/**
 * #2261 / #2356 — the HTTP form of a refused document-ACL save: a new group
 * subject is a 400 naming the groups; an ACL that kept changing during the
 * save is a 409 the editor can retry. Any other error is returned unchanged.
 */
export function aclSaveErrorAsHttp(err: unknown): unknown {
  if (err instanceof AclGroupUnsupportedError) {
    return new AppError(
      400,
      "ACL_GROUP_UNSUPPORTED",
      "Group subjects are not supported: METIS does not store group membership, so a group would match no one. Use a user or role subject.",
      { groups: err.groups },
    );
  }
  if (err instanceof AclSaveConflictError) {
    return new AppError(
      409,
      "ACL_CONFLICT",
      "Someone else changed this document's access at the same time. Reload it and save again.",
    );
  }
  return err;
}
