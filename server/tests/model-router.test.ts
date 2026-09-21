/**
 * Epic #593 / Issue #603 — Model Router unit tests.
 */
import { describe, expect, it } from "vitest";
import { ModelRouter, HAIKU_MODEL_ID, SONNET_MODEL_ID } from "../src/lib/ai/model-router.js";
import type { TaskProfile } from "../src/lib/ai/types.js";

const simpleProfile: TaskProfile = {
  tokenEstimate: 500,
  reasoningDepth: "simple",
  latencySLA: "interactive",
  taskType: "summarization",
};

const moderateProfile: TaskProfile = {
  tokenEstimate: 5_000,
  reasoningDepth: "moderate",
  latencySLA: "standard",
  taskType: "analysis",
};

const complexProfile: TaskProfile = {
  tokenEstimate: 15_000,
  reasoningDepth: "complex",
  latencySLA: "background",
  taskType: "synthesis",
};

describe("ModelRouter", () => {
  describe("select — reasoning-depth routing", () => {
    it("routes simple tasks to Haiku", () => {
      const router = new ModelRouter();
      const result = router.select(simpleProfile);
      expect(result.modelId).toBe(HAIKU_MODEL_ID);
      expect(result.modelName).toBe("Claude Haiku 4.5");
      expect(result.wasDowngraded).toBe(false);
    });

    it("routes complex tasks to Sonnet", () => {
      const router = new ModelRouter();
      const result = router.select(complexProfile);
      expect(result.modelId).toBe(SONNET_MODEL_ID);
      expect(result.modelName).toBe("Claude Sonnet 5");
      expect(result.wasDowngraded).toBe(false);
    });

    it("routes moderate tasks to Sonnet by default", () => {
      const router = new ModelRouter();
      const result = router.select(moderateProfile);
      expect(result.modelId).toBe(SONNET_MODEL_ID);
    });
  });

  describe("select — user overrides", () => {
    it("force-haiku overrides complex profile", () => {
      const router = new ModelRouter();
      const result = router.select(complexProfile, "force-haiku");
      expect(result.modelId).toBe(HAIKU_MODEL_ID);
      expect(result.rationale).toContain("User override");
    });

    it("force-sonnet overrides simple profile", () => {
      const router = new ModelRouter();
      const result = router.select(simpleProfile, "force-sonnet");
      expect(result.modelId).toBe(SONNET_MODEL_ID);
      expect(result.rationale).toContain("User override");
    });

    it("auto lets the router decide", () => {
      const router = new ModelRouter();
      const result = router.select(simpleProfile, "auto");
      expect(result.modelId).toBe(HAIKU_MODEL_ID);
    });
  });

  describe("select — project preferences", () => {
    it("uses project default model for moderate tasks", () => {
      const router = new ModelRouter({
        preferences: { defaultModel: HAIKU_MODEL_ID },
      });
      const result = router.select(moderateProfile);
      expect(result.modelId).toBe(HAIKU_MODEL_ID);
      expect(result.rationale).toContain("project default");
    });

    it("uses task-type override when available", () => {
      const router = new ModelRouter({
        preferences: {
          taskTypeOverrides: { analysis: HAIKU_MODEL_ID },
        },
      });
      const result = router.select(moderateProfile);
      expect(result.modelId).toBe(HAIKU_MODEL_ID);
      expect(result.rationale).toContain("task-type override");
    });

    it("ignores invalid task-type override values", () => {
      const router = new ModelRouter({
        preferences: {
          taskTypeOverrides: { analysis: "invalid-model" },
        },
      });
      const result = router.select(moderateProfile);
      // Should fall through to default routing
      expect(result.modelId).toBe(SONNET_MODEL_ID);
    });
  });

  describe("select — budget-aware downgrade", () => {
    it("downgrades Sonnet to Haiku when budget threshold exceeded", () => {
      const router = new ModelRouter({
        preferences: { budgetDowngradeThreshold: 100_000 },
        currentMonthTokens: 150_000,
      });
      const result = router.select(complexProfile);
      expect(result.modelId).toBe(HAIKU_MODEL_ID);
      expect(result.wasDowngraded).toBe(true);
      expect(result.rationale).toContain("Budget threshold exceeded");
    });

    it("does not downgrade when under threshold", () => {
      const router = new ModelRouter({
        preferences: { budgetDowngradeThreshold: 100_000 },
        currentMonthTokens: 50_000,
      });
      const result = router.select(complexProfile);
      expect(result.modelId).toBe(SONNET_MODEL_ID);
      expect(result.wasDowngraded).toBe(false);
    });

    it("does not downgrade Haiku (already cheapest)", () => {
      const router = new ModelRouter({
        preferences: { budgetDowngradeThreshold: 100_000 },
        currentMonthTokens: 150_000,
      });
      const result = router.select(simpleProfile);
      expect(result.modelId).toBe(HAIKU_MODEL_ID);
      expect(result.wasDowngraded).toBe(false);
    });

    it("does not downgrade when threshold is null", () => {
      const router = new ModelRouter({
        preferences: { budgetDowngradeThreshold: null },
        currentMonthTokens: 999_999,
      });
      const result = router.select(complexProfile);
      expect(result.modelId).toBe(SONNET_MODEL_ID);
      expect(result.wasDowngraded).toBe(false);
    });
  });

  describe("select — estimated cost", () => {
    it("returns a positive estimated cost", () => {
      const router = new ModelRouter();
      const result = router.select(moderateProfile);
      expect(result.estimatedCost).toBeGreaterThan(0);
    });

    it("Haiku has lower estimated cost than Sonnet for same profile", () => {
      const router = new ModelRouter();
      const haiku = router.select(moderateProfile, "force-haiku");
      const sonnet = router.select(moderateProfile, "force-sonnet");
      expect(haiku.estimatedCost).toBeLessThan(sonnet.estimatedCost);
    });
  });

  describe("select — rationale", () => {
    it("includes task type in rationale for auto selection", () => {
      const router = new ModelRouter();
      const result = router.select(simpleProfile);
      expect(result.rationale).toContain("summarization");
    });

    it("includes budget info in downgrade rationale", () => {
      const router = new ModelRouter({
        preferences: { budgetDowngradeThreshold: 1000 },
        currentMonthTokens: 2000,
      });
      const result = router.select(complexProfile);
      expect(result.rationale).toContain("2,000");
      expect(result.rationale).toContain("1,000");
    });
  });

  describe("constructor defaults", () => {
    it("works with no options", () => {
      const router = new ModelRouter();
      const result = router.select(simpleProfile);
      expect(result.modelId).toBe(HAIKU_MODEL_ID);
    });

    it("works with empty preferences", () => {
      const router = new ModelRouter({ preferences: {} });
      const result = router.select(moderateProfile);
      expect(result.modelId).toBe(SONNET_MODEL_ID);
    });
  });
});
