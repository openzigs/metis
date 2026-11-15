import type { DocumentAccess } from "@/lib/projects-api";
import { defaultRolesHolding } from "@/lib/permission-hints";

/** #2548 — why Delete is disabled for a role without `document.delete`. */
export const DELETE_DOCUMENT_HINT = `Deleting a document needs the document.delete permission (${defaultRolesHolding("document.delete")} by default).`;

/** #2548 — why Delete is disabled on a document restricted from the viewer. */
export const DELETE_RESTRICTED_HINT =
  "You don't have access to this document, so you can't delete it.";

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
