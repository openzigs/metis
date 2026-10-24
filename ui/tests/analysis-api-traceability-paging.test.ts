/**
 * #1137 — the Traceability tab asks for one page of the gap report and of the
 * current-vs-proposed diff, and for a requirement's database changes only when
 * the analyst opens them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const { analysisApi } = await import("../src/lib/analysis-api");

describe("analysisApi traceability paging (#1137)", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({});
  });

  it("asks for a page of the gap report, page 1 by default", async () => {
    await analysisApi.getGapReport("p-1", "an-1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p-1/analyses/an-1/gap-report", {
      params: { page: 1 },
    });
    await analysisApi.getGapReport("p-1", "an-1", 3);
    expect(mockApiFetch).toHaveBeenLastCalledWith("/projects/p-1/analyses/an-1/gap-report", {
      params: { page: 3 },
    });
  });

  it("asks for one requirement's database changes, encoding its id", async () => {
    await analysisApi.getGapReportDatabaseChanges("p-1", "an-1", "req/1");
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/p-1/analyses/an-1/gap-report/requirements/req%2F1/database-changes",
    );
  });

  it("asks for a page of the diff, with the base when one is chosen", async () => {
    await analysisApi.getRequirementDiff("p-1", "an-1");
    expect(mockApiFetch).toHaveBeenCalledWith("/projects/p-1/analyses/an-1/requirement-diff", {
      params: { base: undefined, page: 1 },
    });
    await analysisApi.getRequirementDiff("p-1", "an-1", "an-0", 2);
    expect(mockApiFetch).toHaveBeenLastCalledWith("/projects/p-1/analyses/an-1/requirement-diff", {
      params: { base: "an-0", page: 2 },
    });
  });
});
