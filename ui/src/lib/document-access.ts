import type { AclSubject, AclUserName, DocumentAccess } from "@/lib/projects-api";

/**
 * #2547 / #2546 — whether the caller cannot read `row` under its current
 * access list: either marker says so (`access.canRead === false` and the
 * #2546 `restricted: true` row are sent together).
 */
export function isUnreadableDocument(row: {
  restricted?: boolean;
  access?: DocumentAccess;
}): boolean {
  return row.restricted === true || row.access?.canRead === false;
}

/** #2555 — what a `user` subject the server named no one for is called. */
export const UNKNOWN_ACL_PERSON = "a person not in this project";

/**
 * #2555 — a subject as an analyst reads it: a person by their display name
 * (from `users`, the people the server named for this list), a role or a
 * legacy group by its name. Never an internal user id: a `user` subject the
 * server did not name (someone outside the project, or disabled) is
 * {@link UNKNOWN_ACL_PERSON}.
 */
export function aclSubjectLabel(
  subject: AclSubject,
  users: readonly AclUserName[] | undefined,
): string {
  if (subject.kind === "user") {
    return users?.find((u) => u.id === subject.value)?.displayName ?? UNKNOWN_ACL_PERSON;
  }
  return `the ${subject.value} ${subject.kind}`;
}
