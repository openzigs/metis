/**
 * #1137 — paging for the analysis Traceability tab's per-requirement lists.
 *
 * The gap report and the current-vs-proposed diff returned every requirement
 * at once: 588 KB and 250 KB for a 33-requirement run, which the tab rendered
 * as about a million characters. Each now returns one page. `page` is 1-based
 * and clamped to the last page, so a stale page number still shows something.
 */
import type { ListPageInfo } from "@metis/shared";

export const DEFAULT_LIST_PAGE_SIZE = 10;
export const MAX_LIST_PAGE_SIZE = 50;

export interface ListPageRequest {
  page: number;
  pageSize: number;
}

function positiveInt(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : null;
}

/** Read `?page` and `?pageSize` from a query; malformed values fall back to the defaults. */
export function parseListPageQuery(query: Record<string, unknown>): ListPageRequest {
  const page = positiveInt(query.page) ?? 1;
  const pageSize = Math.min(
    positiveInt(query.pageSize) ?? DEFAULT_LIST_PAGE_SIZE,
    MAX_LIST_PAGE_SIZE,
  );
  return { page, pageSize };
}

/** The requested page of `items`, clamped into range, and where it sits. */
export function sliceListPage<T>(
  items: readonly T[],
  request: ListPageRequest,
): { items: T[]; page: ListPageInfo } {
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / request.pageSize));
  const page = Math.min(Math.max(1, request.page), lastPage);
  const start = (page - 1) * request.pageSize;
  return {
    items: items.slice(start, start + request.pageSize),
    page: { page, pageSize: request.pageSize, total },
  };
}
