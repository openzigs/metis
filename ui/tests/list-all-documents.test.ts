/**
 * Issue #32 — the Workbench panel loads every document, not the first 50.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/projects-api", () => ({ documentsApi: { list: vi.fn() } }));

import { documentsApi, type DocumentRow } from "@/lib/projects-api";
import {
  DOCUMENT_PAGE_SIZE,
  MAX_PANEL_DOCUMENTS,
  listAllDocuments,
} from "@/lib/list-all-documents";

const listMock = vi.mocked(documentsApi.list);

function rows(from: number, count: number): DocumentRow[] {
  return Array.from({ length: count }, (_, i) => ({ id: `d${from + i}` }) as DocumentRow);
}

/** A fake server holding `total` rows, paged as the real route pages them. */
function serve(total: number, all = rows(0, total)) {
  listMock.mockImplementation(async (_projectId, params) => {
    const limit = params?.limit ?? 25;
    const offset = params?.offset ?? 0;
    return { items: all.slice(offset, offset + limit), total, limit, offset };
  });
}

beforeEach(() => listMock.mockReset());

describe("listAllDocuments", () => {
  it("returns a single page without further requests", async () => {
    serve(3);
    const out = await listAllDocuments("p1");
    expect(out.items.map((d) => d.id)).toEqual(["d0", "d1", "d2"]);
    expect(out.total).toBe(3);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith("p1", { limit: DOCUMENT_PAGE_SIZE, offset: 0 });
  });

  it("reads every page, in order, past the old 50-row cap", async () => {
    serve(5000);
    const out = await listAllDocuments("p1");
    expect(out.items).toHaveLength(5000);
    expect(out.items[0].id).toBe("d0");
    expect(out.items[4999].id).toBe("d4999");
    expect(listMock).toHaveBeenCalledTimes(50);
  });

  it("drops a row repeated across pages", async () => {
    // A row inserted mid-read shifts the next page by one.
    const all = [...rows(0, 100), { id: "d99" } as DocumentRow, ...rows(100, 49)];
    serve(150, all);
    const out = await listAllDocuments("p1");
    expect(out.items).toHaveLength(149);
    expect(new Set(out.items.map((d) => d.id)).size).toBe(149);
  });

  it("stops at the ceiling and reports the real total", async () => {
    serve(MAX_PANEL_DOCUMENTS + 250);
    const out = await listAllDocuments("p1");
    expect(out.items).toHaveLength(MAX_PANEL_DOCUMENTS);
    expect(out.total).toBe(MAX_PANEL_DOCUMENTS + 250);
    expect(listMock).toHaveBeenCalledTimes(MAX_PANEL_DOCUMENTS / DOCUMENT_PAGE_SIZE);
  });

  it("treats a page without a total as the whole list", async () => {
    listMock.mockResolvedValue({ items: rows(0, 2) } as never);
    const out = await listAllDocuments("p1");
    expect(out).toEqual({ items: rows(0, 2), total: 2 });
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});
