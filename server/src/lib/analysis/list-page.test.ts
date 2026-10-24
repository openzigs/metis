import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_PAGE_SIZE,
  MAX_LIST_PAGE_SIZE,
  parseListPageQuery,
  sliceListPage,
} from "./list-page.js";

describe("#1137 — parseListPageQuery", () => {
  it("defaults to the first page of ten", () => {
    expect(parseListPageQuery({})).toEqual({ page: 1, pageSize: DEFAULT_LIST_PAGE_SIZE });
  });

  it("reads page and pageSize, capping the size", () => {
    expect(parseListPageQuery({ page: "3", pageSize: "20" })).toEqual({ page: 3, pageSize: 20 });
    expect(parseListPageQuery({ pageSize: "5000" }).pageSize).toBe(MAX_LIST_PAGE_SIZE);
  });

  it("falls back on malformed values", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "", "99999999"]) {
      expect(parseListPageQuery({ page: bad, pageSize: bad })).toEqual({
        page: 1,
        pageSize: DEFAULT_LIST_PAGE_SIZE,
      });
    }
    expect(parseListPageQuery({ page: ["2"] as unknown as string })).toEqual({
      page: 1,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
  });
});

describe("#1137 — sliceListPage", () => {
  const items = Array.from({ length: 33 }, (_, i) => i);

  it("returns the requested page and the total", () => {
    const { items: slice, page } = sliceListPage(items, { page: 2, pageSize: 10 });
    expect(slice).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(page).toEqual({ page: 2, pageSize: 10, total: 33 });
  });

  it("clamps a page past the end to the last page", () => {
    const { items: slice, page } = sliceListPage(items, { page: 9, pageSize: 10 });
    expect(slice).toEqual([30, 31, 32]);
    expect(page.page).toBe(4);
  });

  it("returns page 1 of an empty list", () => {
    expect(sliceListPage([], { page: 3, pageSize: 10 })).toEqual({
      items: [],
      page: { page: 1, pageSize: 10, total: 0 },
    });
  });
});
