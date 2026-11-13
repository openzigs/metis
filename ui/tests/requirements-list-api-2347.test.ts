/**
 * Issue #2347 — the list client builds its query from the filters only: an
 * empty filter is left out, the search is trimmed, and the project id is
 * encoded into the path.
 */
import { describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch }));

import { requirementListPath, requirementsListApi } from "@/lib/requirements-list-api";

describe("requirements list client (#2347)", () => {
  it("leaves out empty filters and trims the search", () => {
    expect(requirementListPath("p1", { page: 1, pageSize: 25 })).toBe(
      "/projects/p1/requirements?page=1&pageSize=25",
    );
    expect(requirementListPath("p1", { q: "   ", page: 2, pageSize: 10 })).toBe(
      "/projects/p1/requirements?page=2&pageSize=10",
    );
    expect(
      requirementListPath("p/1", {
        analysisId: "cr 1",
        status: "approved",
        q: " card & co ",
        page: 1,
        pageSize: 25,
      }),
    ).toBe(
      "/projects/p%2F1/requirements?analysisId=cr+1&status=approved&q=card+%26+co&page=1&pageSize=25",
    );
  });

  it("reads the page through apiFetch", async () => {
    apiFetch.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    await requirementsListApi.list("p1", { page: 1, pageSize: 25 });
    expect(apiFetch).toHaveBeenCalledWith("/projects/p1/requirements?page=1&pageSize=25");
  });
});
