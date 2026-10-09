/**
 * Issue #1001 — the "Continue with a larger budget" action reaches the code
 * agent's regenerate endpoint with `extendBudget`, as an object `apiFetch`
 * serialises (never a pre-stringified body, which it would encode twice).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const { analysisApi } = await import("../src/lib/analysis-api");

describe("analysisApi.continueCodeInvestigation (#1001)", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("POSTs extendBudget to the code agent's regenerate endpoint", async () => {
    mockApiFetch.mockResolvedValue({ accepted: true });
    await analysisApi.continueCodeInvestigation("an-1");
    expect(mockApiFetch).toHaveBeenCalledWith("/analyses/an-1/agents/code/regenerate", {
      method: "POST",
      body: { extendBudget: true },
    });
  });
});
