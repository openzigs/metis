import type { DocumentAccess } from "@/lib/projects-api";

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
