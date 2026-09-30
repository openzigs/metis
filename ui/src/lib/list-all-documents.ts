/**
 * Issue #32 — every document in a project, not the first page.
 *
 * The Workbench panel used to ask for `{ limit: 50 }` and stop, so in a project
 * with more documents than that the rest (often the uploads) could never be
 * attached. The list endpoint caps a page at 100 (`server/src/routes/documents.ts`),
 * so this reads the first page, learns `total`, and follows `nextCursor` to the end.
 *
 * #440 — the pages are read by cursor, not offset. Offset paging over a list
 * that loses a row mid-read (a delete) shifts every later row up by one and
 * skips the row that crosses a page boundary; a cursor names the last row seen,
 * so a concurrent insert or delete cannot skip one. Cursor pages also skip the
 * server's `count(*)`, which offset paging paid on every request.
 */
import { documentsApi, type DocumentRow } from "@/lib/projects-api";

export const DOCUMENT_PAGE_SIZE = 100;
/** A hard ceiling on what the panel will load; past it the panel says so. */
export const MAX_PANEL_DOCUMENTS = 10_000;

export interface AllDocuments {
  items: DocumentRow[];
  /** The server's count, which exceeds `items.length` only past the ceiling. */
  total: number;
}

export async function listAllDocuments(projectId: string): Promise<AllDocuments> {
  const first = await documentsApi.list(projectId, { limit: DOCUMENT_PAGE_SIZE });
  const items: DocumentRow[] = [...first.items];
  let cursor = first.nextCursor ?? null;
  while (cursor && items.length < MAX_PANEL_DOCUMENTS) {
    const page = await documentsApi.listAfter(projectId, cursor, { limit: DOCUMENT_PAGE_SIZE });
    items.push(...page.items);
    cursor = page.nextCursor;
  }
  const total = typeof first.total === "number" ? first.total : items.length;
  return { items: items.slice(0, MAX_PANEL_DOCUMENTS), total: Math.max(total, items.length) };
}
