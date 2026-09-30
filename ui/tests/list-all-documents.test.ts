/**
 * Issue #32 — the Workbench panel loads every document, not the first 50.
 * Issue #440 — it follows the server's cursor rather than computing offsets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/projects-api", () => ({ documentsApi: { list: vi.fn(), listAfter: vi.fn() } }));

import { documentsApi, type DocumentRow } from "@/lib/projects-api";
import {
  DOCUMENT_PAGE_SIZE,
  MAX_PANEL_DOCUMENTS,
  listAllDocuments,
} from "@/lib/list-all-documents";

const listMock = vi.mocked(documentsApi.list);
const afterMock = vi.mocked(documentsApi.listAfter);

function rows(from: number, count: number): DocumentRow[] {
  return Array.from({ length: count }, (_, i) => ({ id: `d${from + i}` }) as DocumentRow);
}

/**
 * A fake server over a MUTABLE list, paged the way the real route pages it: the
 * cursor is the last id seen, and the next page starts right after that row
 * wherever it now sits — so the fake behaves like keyset paging, not offsets.
 */
function serve(all: DocumentRow[]) {
  const pageAfter = (index: number, limit: number) => {
    const page = all.slice(index, index + limit);
    const more = index + limit < all.length;
    return { items: page, nextCursor: more ? page[page.length - 1].id : null };
  };
  listMock.mockImplementation(async (_projectId, params) => {
    // Honours `offset` too, so an offset reader runs against it (and skips).
    const limit = params?.limit ?? 25;
    const offset = params?.offset ?? 0;
    return { ...pageAfter(offset, limit), total: all.length, limit, offset };
  });
  afterMock.mockImplementation(async (_projectId, cursor, params) => {
    const limit = params?.limit ?? 25;
    const last = all.findIndex((d) => d.id === cursor);
    return { ...pageAfter(last + 1, limit), limit };
  });
  return all;
}

beforeEach(() => {
  listMock.mockReset();
  afterMock.mockReset();
});

describe("listAllDocuments", () => {
  it("returns a single page without further requests", async () => {
    serve(rows(0, 3));
    const out = await listAllDocuments("p1");
    expect(out.items.map((d) => d.id)).toEqual(["d0", "d1", "d2"]);
    expect(out.total).toBe(3);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith("p1", { limit: DOCUMENT_PAGE_SIZE });
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("reads every page, in order, past the old 50-row cap", async () => {
    serve(rows(0, 5000));
    const out = await listAllDocuments("p1");
    expect(out.items).toHaveLength(5000);
    expect(out.items[0].id).toBe("d0");
    expect(out.items[4999].id).toBe("d4999");
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(afterMock).toHaveBeenCalledTimes(49);
    expect(afterMock).toHaveBeenNthCalledWith(1, "p1", "d99", { limit: DOCUMENT_PAGE_SIZE });
    expect(afterMock).toHaveBeenNthCalledWith(2, "p1", "d199", { limit: DOCUMENT_PAGE_SIZE });
  });

  it("does not skip a row when one already read is deleted mid-read (#440)", async () => {
    const all = serve(rows(0, 250));
    const first = listMock.getMockImplementation()!;
    listMock.mockImplementation(async (...args) => {
      const page = await first(...args);
      all.splice(5, 1); // a row on the first page is deleted after it is read
      return page;
    });
    const out = await listAllDocuments("p1");
    const ids = out.items.map((d) => d.id);
    expect(ids).toContain("d100"); // offset=100 would have skipped the row that moved up
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
  });

  it("stops at the ceiling and reports the real total", async () => {
    serve(rows(0, MAX_PANEL_DOCUMENTS + 250));
    const out = await listAllDocuments("p1");
    expect(out.items).toHaveLength(MAX_PANEL_DOCUMENTS);
    expect(out.total).toBe(MAX_PANEL_DOCUMENTS + 250);
    expect(listMock.mock.calls.length + afterMock.mock.calls.length).toBe(
      MAX_PANEL_DOCUMENTS / DOCUMENT_PAGE_SIZE,
    );
  });

  it("treats a page without a total or cursor as the whole list", async () => {
    listMock.mockResolvedValue({ items: rows(0, 2) } as never);
    const out = await listAllDocuments("p1");
    expect(out).toEqual({ items: rows(0, 2), total: 2 });
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(afterMock).not.toHaveBeenCalled();
  });
});
