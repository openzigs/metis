/**
 * Issue #122 — AST cache rebuild API client unit tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const { astCacheApi } = await import("../src/lib/ast-cache-api");

describe("astCacheApi", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("POSTs to the rebuild-cache endpoint", async () => {
    mockApiFetch.mockResolvedValue({
      repoId: "r1",
      projectId: "p1",
      message: "Cache rebuild complete",
      stats: { indexedFiles: 3, skippedFiles: 1, totalSymbols: 9, discoveredFiles: 4 },
    });
    const res = await astCacheApi.rebuild("p1", "r1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/repositories/r1/rebuild-cache", {
      method: "POST",
    });
    expect(res.stats.totalSymbols).toBe(9);
  });
});
