/**
 * Issue #32 — every document in a project, not the first page.
 *
 * The Workbench panel used to ask for `{ limit: 50 }` and stop, so in a project
 * with more documents than that the rest (often the uploads) could never be
 * attached. The list endpoint caps a page at 100 (`server/src/routes/documents.ts`),
 * so this reads the first page, learns `total`, and fetches the remaining pages
 * a few at a time. Rows are de-duplicated by id: offset paging over a list that
 * gains a row mid-read repeats one.
 */
import { documentsApi, type DocumentRow } from "@/lib/projects-api";

export const DOCUMENT_PAGE_SIZE = 100;
/** A hard ceiling on what the panel will load; past it the panel says so. */
export const MAX_PANEL_DOCUMENTS = 10_000;
const CONCURRENCY = 4;

export interface AllDocuments {
  items: DocumentRow[];
  /** The server's count, which exceeds `items.length` only past the ceiling. */
  total: number;
}

export async function listAllDocuments(projectId: string): Promise<AllDocuments> {
  const first = await documentsApi.list(projectId, { limit: DOCUMENT_PAGE_SIZE, offset: 0 });
  const pages: DocumentRow[][] = [first.items];
  const total = typeof first.total === "number" ? first.total : first.items.length;
  const end = Math.min(total, MAX_PANEL_DOCUMENTS);

  const offsets: number[] = [];
  for (let offset = DOCUMENT_PAGE_SIZE; offset < end; offset += DOCUMENT_PAGE_SIZE) {
    offsets.push(offset);
  }
  for (let i = 0; i < offsets.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      offsets
        .slice(i, i + CONCURRENCY)
        .map((offset) => documentsApi.list(projectId, { limit: DOCUMENT_PAGE_SIZE, offset })),
    );
    for (const page of batch) pages.push(page.items);
  }

  const seen = new Set<string>();
  const items: DocumentRow[] = [];
  for (const page of pages) {
    for (const doc of page) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      items.push(doc);
    }
  }
  return { items: items.slice(0, MAX_PANEL_DOCUMENTS), total: Math.max(total, items.length) };
}
