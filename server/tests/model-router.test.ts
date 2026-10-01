/**
 * Epic #593 / Issue #603 — Model Router unit tests.
 */
import { describe, expect, it } from "vitest";
import {
  ModelRouter,
  FABLE_MODEL_ID,
  HAIKU_MODEL_ID,
  OPUS_MODEL_ID,
  SONNET_MODEL_ID,
  tierModelFor,
  type RouterProvider,
} from "../src/lib/ai/model-router.js";
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
      expect(haiku.estimatedCost).toBeLessThan(sonnet.estimatedCost!);
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

/**
 * #512 — tier routing assumes a Claude provider. The router's ids are Claude
 * tier ids (`us.anthropic.claude-*`); on a provider that cannot serve them the
 * selection must be the provider's configured model, so the Model card and the
 * auto-mode specialist agents name the model the run really uses.
 */
describe("ModelRouter — active provider (#512)", () => {
  const claudeProvider: RouterProvider = {
    key: "bedrock-gateway",
    model: SONNET_MODEL_ID,
    servesRouterModel: () => true,
  };
  const deepSeek: RouterProvider = {
    key: "anthropic",
    model: "deepseek-chat",
    servesRouterModel: () => false,
  };

  it("keeps tier routing on a provider that serves Claude tier ids", () => {
    const router = new ModelRouter({ provider: claudeProvider });
    expect(router.select(simpleProfile).modelId).toBe(HAIKU_MODEL_ID);
    const complex = router.select(complexProfile);
    expect(complex.modelId).toBe(SONNET_MODEL_ID);
    expect(complex.modelName).toBe("Claude Sonnet 5");
    expect(complex.estimatedCost).not.toBeNull();
  });

  it("falls back to the provider's configured model when it cannot serve tier ids", () => {
    const router = new ModelRouter({ provider: deepSeek });
    for (const profile of [simpleProfile, moderateProfile, complexProfile]) {
      const result = router.select(profile);
      expect(result.modelId).toBe("deepseek-chat");
      expect(result.modelName).toBe("deepseek-chat");
      expect(result.rationale).toContain("anthropic");
      expect(result.rationale).toContain("deepseek-chat");
      // No Claude rate is quoted for a model that is not Claude.
      expect(result.estimatedCost).toBeNull();
      expect(result.wasDowngraded).toBe(false);
    }
  });

  it("a forced tier on a non-Claude provider still runs the configured model", () => {
    const router = new ModelRouter({ provider: deepSeek });
    const result = router.select(complexProfile, "force-opus");
    expect(result.modelId).toBe("deepseek-chat");
  });

  it("a budget downgrade on a non-Claude provider is not reported as a downgrade", () => {
    const router = new ModelRouter({
      provider: deepSeek,
      preferences: { budgetDowngradeThreshold: 1000 },
      currentMonthTokens: 2000,
    });
    const result = router.select(complexProfile);
    expect(result.modelId).toBe("deepseek-chat");
    expect(result.wasDowngraded).toBe(false);
  });

  it("asks the provider per model id: a served tier id is kept, an unserved one falls back", () => {
    const partial: RouterProvider = {
      key: "openai",
      model: "stub-model",
      servesRouterModel: (id: string) => id === HAIKU_MODEL_ID,
    };
    const router = new ModelRouter({ provider: partial });
    expect(router.select(simpleProfile).modelId).toBe(HAIKU_MODEL_ID);
    expect(router.select(complexProfile).modelId).toBe("stub-model");
  });

  it("treats a provider that cannot answer (no servesRouterModel) as non-Claude", () => {
    const router = new ModelRouter({ provider: { key: "offline-stub", model: "stub" } });
    expect(router.select(complexProfile).modelId).toBe("stub");
  });
});

/**
 * Review of PR #523 (#512) — the run path resolves a `force-*` override the same
 * way the Model card does, so the card and the run name the same model.
 */
describe("ModelRouter.resolveRunModel (#512)", () => {
  it.each([
    ["force-haiku", HAIKU_MODEL_ID],
    ["force-sonnet", SONNET_MODEL_ID],
    ["force-fable", FABLE_MODEL_ID],
    ["force-opus", OPUS_MODEL_ID],
  ])("maps %s to its tier id on a Claude-serving provider", (override, tierId) => {
    const router = new ModelRouter({
      provider: { key: "bedrock-gateway", model: SONNET_MODEL_ID, servesRouterModel: () => true },
    });
    expect(router.resolveRunModel(override)).toBe(tierId);
  });

  it("maps a forced tier to the provider's configured model when it cannot serve it", () => {
    const router = new ModelRouter({
      provider: { key: "openai", model: "gpt-4.1", servesRouterModel: () => false },
    });
    expect(router.resolveRunModel("force-opus")).toBe("gpt-4.1");
    expect(router.resolveRunModel("force-haiku")).toBe("gpt-4.1");
  });

  it("maps a forced tier to its tier id when no provider is attached", () => {
    expect(new ModelRouter().resolveRunModel("force-sonnet")).toBe(SONNET_MODEL_ID);
  });

  it("returns an explicit model id, or none, unchanged", () => {
    const router = new ModelRouter({
      provider: { key: "openai", model: "gpt-4.1", servesRouterModel: () => false },
    });
    expect(router.resolveRunModel("gpt-4.1-mini")).toBe("gpt-4.1-mini");
    expect(router.resolveRunModel(undefined)).toBeUndefined();
    // An inherited Object property is not an override.
    expect(router.resolveRunModel("toString")).toBe("toString");
  });
});

/**
 * #532 — call sites that hard-code a Claude tier id (deep-dive, grounding,
 * clarification, scanner) resolve it against the active provider the same way
 * the router does.
 */
describe("tierModelFor (#532)", () => {
  it("keeps the tier id on a provider that serves it", () => {
    const bedrock: RouterProvider = {
      key: "bedrock-gateway",
      model: SONNET_MODEL_ID,
      servesRouterModel: () => true,
    };
    expect(tierModelFor(bedrock, HAIKU_MODEL_ID)).toBe(HAIKU_MODEL_ID);
  });

  it("uses the provider's configured model when it cannot serve the tier id", () => {
    const deepSeek: RouterProvider = {
      key: "anthropic",
      model: "deepseek-chat",
      servesRouterModel: () => false,
    };
    expect(tierModelFor(deepSeek, HAIKU_MODEL_ID)).toBe("deepseek-chat");
  });

  it("asks about the exact tier id it was given", () => {
    const partial: RouterProvider = {
      key: "openai",
      model: "stub-model",
      servesRouterModel: (id: string) => id === HAIKU_MODEL_ID,
    };
    expect(tierModelFor(partial, HAIKU_MODEL_ID)).toBe(HAIKU_MODEL_ID);
    expect(tierModelFor(partial, SONNET_MODEL_ID)).toBe("stub-model");
  });

  it("treats a provider that cannot answer (no servesRouterModel) as non-Claude", () => {
    expect(tierModelFor({ key: "openai", model: "gpt-4.1" }, HAIKU_MODEL_ID)).toBe("gpt-4.1");
  });
});
