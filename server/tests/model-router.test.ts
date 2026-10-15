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
  LEGACY_SONNET_MODEL_ID,
  ModelNotServedError,
  tierModelFor,
  projectRunModel,
  haikuVersion,
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

// #978 — a forced tier the provider cannot serve is refused, never remapped.
describe("ModelRouter.assertServable (#978)", () => {
  const deepSeek: RouterProvider = {
    key: "anthropic",
    model: "deepseek-flash",
    servesRouterModel: () => false,
  };
  const claude: RouterProvider = {
    key: "bedrock-gateway",
    model: SONNET_MODEL_ID,
    servesRouterModel: () => true,
  };

  it.each(["force-haiku", "force-sonnet", "force-fable", "force-opus"])(
    "rejects %s on a provider that does not serve Claude tiers",
    (override) => {
      const router = new ModelRouter({ provider: deepSeek });
      expect(() => router.assertServable(override)).toThrow(ModelNotServedError);
    },
  );

  it.each([SONNET_MODEL_ID, OPUS_MODEL_ID, LEGACY_SONNET_MODEL_ID])(
    "rejects the raw tier id %s on that provider too",
    (id) => {
      expect(() => new ModelRouter({ provider: deepSeek }).assertServable(id)).toThrow(
        ModelNotServedError,
      );
    },
  );

  it("names the provider, the refused model and the model it does run", () => {
    try {
      new ModelRouter({ provider: deepSeek }).assertServable("force-opus");
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as InstanceType<typeof ModelNotServedError>;
      expect(e.requested).toBe("force-opus");
      expect(e.configuredModel).toBe("deepseek-flash");
      expect(e.message).toContain("Opus");
      expect(e.message).toContain("deepseek-flash");
    }
  });

  it("accepts auto, no model, and the provider's own configured model", () => {
    const router = new ModelRouter({ provider: deepSeek });
    expect(() => router.assertServable(undefined)).not.toThrow();
    expect(() => router.assertServable("auto")).not.toThrow();
    expect(() => router.assertServable("deepseek-flash")).not.toThrow();
  });

  it("accepts a forced tier on a provider that serves it", () => {
    expect(() => new ModelRouter({ provider: claude }).assertServable("force-opus")).not.toThrow();
  });

  // The model preferences list the tiers on the offline stub (and its e2e
  // replay wrapper), so the panel offers them there: the check must agree.
  it.each<RouterProvider>([
    { key: "offline-stub", model: "offline-stub", offline: false },
    { key: "openai", model: "stub", offline: true },
  ])("accepts a forced tier on the offline stub (%o)", (stub) => {
    const router = new ModelRouter({ provider: { ...stub, servesRouterModel: () => false } });
    expect(() => router.assertServable("force-opus")).not.toThrow();
  });

  it("accepts anything when no provider is attached", () => {
    expect(() => new ModelRouter().assertServable("force-opus")).not.toThrow();
  });
});
// #1145 — Auto with the project's model known: no reasoning-depth tier routing.
describe("ModelRouter autoModel (#1145)", () => {
  const anthropicApi: RouterProvider = {
    key: "anthropic",
    model: "claude-sonnet-5",
    servesRouterModel: () => true,
  };

  it.each([simpleProfile, moderateProfile, complexProfile])(
    "runs the project's model for a $reasoningDepth task",
    (profile) => {
      const router = new ModelRouter({
        provider: anthropicApi,
        autoModel: "claude-sonnet-5-5",
      });
      const sel = router.select(profile);
      expect(sel.modelId).toBe("claude-sonnet-5-5");
      expect(sel.rationale).toContain("claude-sonnet-5-5");
      // No rate for it in the router: no borrowed Claude estimate.
      expect(sel.estimatedCost).toBeNull();
    },
  );

  it("prefers the project's default model preference", () => {
    const router = new ModelRouter({
      provider: anthropicApi,
      autoModel: "claude-sonnet-5-5",
      preferences: { defaultModel: OPUS_MODEL_ID },
    });
    expect(router.select(simpleProfile).modelId).toBe(OPUS_MODEL_ID);
  });

  it("honours a task-type override naming one of the provider's own models", () => {
    const router = new ModelRouter({
      provider: anthropicApi,
      autoModel: "claude-sonnet-5-5",
      preferences: { taskTypeOverrides: { summarization: "claude-haiku-5-5" } },
      acceptedModelIds: new Set(["claude-haiku-5-5"]),
    });
    expect(router.select(simpleProfile).modelId).toBe("claude-haiku-5-5");
    expect(router.select(complexProfile).modelId).toBe("claude-sonnet-5-5");
  });

  it("ignores a task-type override naming a model nobody accepted", () => {
    const router = new ModelRouter({
      provider: anthropicApi,
      autoModel: "claude-sonnet-5-5",
      preferences: { taskTypeOverrides: { summarization: "claude-haiku-5-5" } },
    });
    expect(router.select(simpleProfile).modelId).toBe("claude-sonnet-5-5");
  });

  // #1145 — the budget downgrade is decided once per Auto run, from the run's
  // model, so every call of the run gets the same model (re-review of PR #1150).
  describe("run-level budget downgrade", () => {
    const served = new Set(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
    const overBudget = (
      autoModel: string,
      extra: { defaultModel?: string; taskTypeOverrides?: Record<string, string> } = {},
      opts: { provider?: RouterProvider; accepted?: ReadonlySet<string> } = {},
    ) =>
      new ModelRouter({
        provider: opts.provider ?? anthropicApi,
        autoModel,
        acceptedModelIds: opts.accepted ?? served,
        preferences: { budgetDowngradeThreshold: 100, ...extra },
        currentMonthTokens: 1_000,
      });

    it("downgrades the run's Sonnet 5.5 to the provider's Haiku 5.5, for every task", () => {
      const router = overBudget("claude-sonnet-5-5");
      expect(router.runBudgetDowngrade()).toBe("claude-haiku-5-5");
      for (const profile of [simpleProfile, moderateProfile, complexProfile]) {
        const sel = router.select(profile);
        expect(sel.modelId).toBe("claude-haiku-5-5");
        expect(sel.wasDowngraded).toBe(true);
        // A served model with no router rate: no borrowed Sonnet estimate.
        expect(sel.estimatedCost).toBeNull();
      }
      expect(router.select(moderateProfile).rationale).toBe(
        "Budget threshold exceeded (1,000 >= 100 tokens): the run is downgraded from claude-sonnet-5-5 to claude-haiku-5-5",
      );
    });

    it("takes precedence over the Models-page default and task-type overrides", () => {
      const router = overBudget("claude-sonnet-5-5", {
        defaultModel: "claude-opus-5-5",
        taskTypeOverrides: { summarization: "claude-opus-5-5" },
      });
      expect(router.select(simpleProfile).modelId).toBe("claude-haiku-5-5");
      expect(router.select(moderateProfile).modelId).toBe("claude-haiku-5-5");
    });

    it("never downgrades one Auto call on its own: a Sonnet default under a non-Sonnet run model", () => {
      const router = overBudget("claude-opus-5-5", { defaultModel: "claude-sonnet-5-5" });
      expect(router.runBudgetDowngrade()).toBeUndefined();
      const sel = router.select(simpleProfile);
      expect(sel.modelId).toBe("claude-sonnet-5-5");
      expect(sel.wasDowngraded).toBe(false);
    });

    it("downgrades the Sonnet tier id and its legacy alias to the Haiku tier id", () => {
      const gateway: RouterProvider = {
        key: "bedrock-gateway",
        model: SONNET_MODEL_ID,
        servesRouterModel: () => true,
      };
      for (const model of [SONNET_MODEL_ID, LEGACY_SONNET_MODEL_ID]) {
        const router = overBudget(model, {}, { provider: gateway, accepted: new Set() });
        expect(router.runBudgetDowngrade()).toBe(HAIKU_MODEL_ID);
        expect(router.select(complexProfile).modelId).toBe(HAIKU_MODEL_ID);
      }
    });

    it.each([
      ["4.5 listed first", ["claude-haiku-4-5", "claude-haiku-5-5"]],
      ["5.5 listed first", ["claude-haiku-5-5", "claude-haiku-4-5"]],
    ])("picks the newest served Haiku by version (%s)", (_label, haikus) => {
      const accepted = new Set(["claude-sonnet-5-5", ...haikus]);
      expect(overBudget("claude-sonnet-5-5", {}, { accepted }).runBudgetDowngrade()).toBe(
        "claude-haiku-5-5",
      );
    });

    it("leaves the run alone under the threshold", () => {
      const router = new ModelRouter({
        provider: anthropicApi,
        autoModel: "claude-sonnet-5-5",
        acceptedModelIds: served,
        preferences: { budgetDowngradeThreshold: 100 },
        currentMonthTokens: 99,
      });
      expect(router.runBudgetDowngrade()).toBeUndefined();
      const sel = router.select(moderateProfile);
      expect(sel.modelId).toBe("claude-sonnet-5-5");
      expect(sel.wasDowngraded).toBe(false);
    });

    it("does not downgrade a run model that is not Sonnet-class", () => {
      expect(overBudget("claude-opus-5-5").select(moderateProfile).modelId).toBe("claude-opus-5-5");
    });

    it("does not downgrade when the provider serves no Haiku-class model", () => {
      const router = overBudget(
        "claude-sonnet-5-5",
        {},
        { accepted: new Set(["claude-sonnet-5-5", "claude-opus-5-5"]) },
      );
      expect(router.runBudgetDowngrade()).toBeUndefined();
      expect(router.select(moderateProfile).modelId).toBe("claude-sonnet-5-5");
    });

    it("does not downgrade on a provider whose served set is only declared (a BILLS_AS proxy)", () => {
      const proxy: RouterProvider = { ...anthropicApi, routerModelsInferred: true };
      const router = overBudget("claude-sonnet-5-5", {}, { provider: proxy });
      expect(router.runBudgetDowngrade()).toBeUndefined();
      expect(router.select(moderateProfile).modelId).toBe("claude-sonnet-5-5");
    });

    it("is undefined without a run model", () => {
      expect(
        new ModelRouter({
          provider: anthropicApi,
          preferences: { budgetDowngradeThreshold: 100 },
          currentMonthTokens: 1_000,
        }).runBudgetDowngrade(),
      ).toBeUndefined();
    });
  });

  it("haikuVersion reads the release, not the snapshot date", () => {
    expect(haikuVersion("claude-haiku-5-5")).toEqual([5, 5]);
    expect(haikuVersion(HAIKU_MODEL_ID)).toEqual([4, 5]);
    expect(haikuVersion("claude-sonnet-5-5")).toEqual([]);
  });

  it("does not price a served model the router has no rate for at the Sonnet rate", () => {
    const sel = new ModelRouter({
      provider: anthropicApi,
      autoModel: "claude-sonnet-5-5",
      acceptedModelIds: new Set(["claude-haiku-5-5"]),
      preferences: { defaultModel: "claude-haiku-5-5" },
    }).select(moderateProfile);
    expect(sel.modelId).toBe("claude-haiku-5-5");
    expect(sel.estimatedCost).toBeNull();
  });

  it("does not remap the project's model on a provider that serves no tier ids", () => {
    const deepSeek: RouterProvider = {
      key: "anthropic",
      model: "deepseek-chat",
      servesRouterModel: () => false,
    };
    const sel = new ModelRouter({
      provider: deepSeek,
      autoModel: "deepseek-chat",
    }).select(complexProfile);
    expect(sel.modelId).toBe("deepseek-chat");
    expect(sel.rationale).toMatch(/project's model/);
  });

  it("runs an explicit model id override as named", () => {
    const sel = new ModelRouter({ provider: anthropicApi }).select(
      simpleProfile,
      "claude-opus-5-5",
    );
    expect(sel.modelId).toBe("claude-opus-5-5");
    expect(sel.rationale).toBe("User override: claude-opus-5-5");
  });
});

describe("projectRunModel (#1145)", () => {
  const provider = { key: "anthropic" } as const;

  it("is the project's aiModel when no provider override names another", () => {
    expect(projectRunModel({ aiModel: "claude-sonnet-5-5" }, provider)).toBe("claude-sonnet-5-5");
    expect(
      projectRunModel({ aiModel: "claude-sonnet-5-5", aiProviderId: "anthropic" }, provider),
    ).toBe("claude-sonnet-5-5");
  });

  it("is undefined for no aiModel, a blank one, or one set for another provider", () => {
    expect(projectRunModel(null, provider)).toBeUndefined();
    expect(projectRunModel({ aiModel: "  " }, provider)).toBeUndefined();
    expect(
      projectRunModel({ aiModel: "gpt-4.1", aiProviderId: "openai" }, provider),
    ).toBeUndefined();
  });
});
