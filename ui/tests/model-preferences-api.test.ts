/**
 * Epic #593 / Issue #603 — Model preferences API client unit tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock apiFetch before importing the module
const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Import after mock
const { modelPreferencesApi } = await import("../src/lib/model-preferences-api");

describe("modelPreferencesApi", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  describe("get", () => {
    it("calls the correct endpoint", async () => {
      mockApiFetch.mockResolvedValue({
        projectId: "p1",
        defaultModel: null,
        taskTypeOverrides: {},
        budgetDowngradeThreshold: null,
        availableModels: [],
      });

      await modelPreferencesApi.get("p1");
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/model-preferences");
    });
  });

  describe("update", () => {
    it("sends PUT with body", async () => {
      mockApiFetch.mockResolvedValue({
        projectId: "p1",
        defaultModel: "test-model",
        taskTypeOverrides: {},
        budgetDowngradeThreshold: null,
      });

      await modelPreferencesApi.update("p1", { defaultModel: "test-model" });
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/model-preferences", {
        method: "PUT",
        body: { defaultModel: "test-model" },
      });
    });
  });

  describe("getRecommendation", () => {
    const RESPONSE = {
      profile: {
        tokenEstimate: 100,
        reasoningDepth: "simple",
        latencySLA: "interactive",
        taskType: "general",
      },
      selection: {
        modelId: "m1",
        modelName: "M1",
        rationale: "test",
        estimatedCost: 0.001,
        wasDowngraded: false,
      },
      estimate: { tokens: 100, basis: "prior-runs", sampleSize: 1, perAgentTokens: 100 },
    };

    it("POSTs the run shape so a long requirement paste is not URL-truncated (#1095)", async () => {
      mockApiFetch.mockResolvedValue(RESPONSE);
      const requirementText = "Evaluate atomic inventory reservation. ".repeat(200);

      await modelPreferencesApi.getRecommendation("p1", {
        override: "force-haiku",
        agentKeys: ["code", "database"],
        requirementText,
      });

      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/analyses/model-recommendation", {
        method: "POST",
        body: {
          override: "force-haiku",
          agentKeys: ["code", "database"],
          requirementText,
        },
      });
      // The workload description must not be smuggled into the URL.
      expect(mockApiFetch.mock.calls[0][0]).not.toContain("requirementText");
    });

    it("defaults to auto with an empty run shape", async () => {
      mockApiFetch.mockResolvedValue(RESPONSE);

      await modelPreferencesApi.getRecommendation("p1");
      expect(mockApiFetch).toHaveBeenCalledWith("/projects/p1/analyses/model-recommendation", {
        method: "POST",
        body: { override: "auto", agentKeys: [], requirementText: "" },
      });
    });
  });
});
