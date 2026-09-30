/**
 * Model Router Service (Epic #593 / Issue #599).
 *
 * Selects the optimal model (Haiku vs Sonnet) based on task profile,
 * project preferences, budget constraints, and user overrides.
 */
import type { AIProvider, ModelOverride, ModelSelection, TaskProfile } from "./types.js";

/** Bedrock model identifiers. */
export const HAIKU_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
export const SONNET_MODEL_ID = "us.anthropic.claude-sonnet-5";
export const FABLE_MODEL_ID = "us.anthropic.claude-fable-5";
export const OPUS_MODEL_ID = "us.anthropic.claude-opus-4-8";
/**
 * Prior Sonnet identifier (the application inference profile ARN it pointed
 * at was repointed to a Sonnet 5 foundation model). Kept resolvable so
 * preferences/task-type overrides persisted before the rename don't silently
 * fall through to the default routing branch.
 */
export const LEGACY_SONNET_MODEL_ID = "us.anthropic.claude-sonnet-4-6";

/** Approximate cost per 1K tokens (USD) — used for estimation only. */
const COST_PER_1K: Record<string, number> = {
  [HAIKU_MODEL_ID]: 0.001,
  [SONNET_MODEL_ID]: 0.003,
  [LEGACY_SONNET_MODEL_ID]: 0.003,
  // Fable/Opus have no published Bedrock rate yet; approximated from the
  // nearest published Anthropic tier (see lib/finops/provider-rates.ts).
  [FABLE_MODEL_ID]: 0.001,
  [OPUS_MODEL_ID]: 0.005,
};

/** Human-readable model names. */
const MODEL_NAMES: Record<string, string> = {
  [HAIKU_MODEL_ID]: "Claude Haiku 4.5",
  [SONNET_MODEL_ID]: "Claude Sonnet 5",
  [LEGACY_SONNET_MODEL_ID]: "Claude Sonnet 5",
  [FABLE_MODEL_ID]: "Claude Fable 5",
  [OPUS_MODEL_ID]: "Claude Opus 4.8",
};

/**
 * Models selectable as an explicit override or project default, in display
 * order. Single source of truth for routes/tests/UI so a model configured
 * via `BEDROCK_MODEL_PROFILES` is never invisible to the picker again.
 */
export const MODEL_REGISTRY: ReadonlyArray<{
  id: string;
  name: string;
  tier: "fast" | "balanced" | "complex";
}> = [
  { id: HAIKU_MODEL_ID, name: MODEL_NAMES[HAIKU_MODEL_ID], tier: "fast" },
  { id: SONNET_MODEL_ID, name: MODEL_NAMES[SONNET_MODEL_ID], tier: "balanced" },
  { id: FABLE_MODEL_ID, name: MODEL_NAMES[FABLE_MODEL_ID], tier: "fast" },
  { id: OPUS_MODEL_ID, name: MODEL_NAMES[OPUS_MODEL_ID], tier: "complex" },
];

/** Model IDs accepted as a task-type override / project default value. */
const KNOWN_MODEL_IDS = new Set<string>([
  ...MODEL_REGISTRY.map((m) => m.id),
  LEGACY_SONNET_MODEL_ID,
]);

/** `force-*` override → concrete model ID. */
export const OVERRIDE_MODEL_MAP: Record<
  "force-haiku" | "force-sonnet" | "force-fable" | "force-opus",
  string
> = {
  "force-haiku": HAIKU_MODEL_ID,
  "force-sonnet": SONNET_MODEL_ID,
  "force-fable": FABLE_MODEL_ID,
  "force-opus": OPUS_MODEL_ID,
};

/** Short label used in the override rationale string. */
const OVERRIDE_LABELS: Record<keyof typeof OVERRIDE_MODEL_MAP, string> = {
  "force-haiku": "Haiku",
  "force-sonnet": "Sonnet",
  "force-fable": "Fable",
  "force-opus": "Opus",
};

export interface ModelPreferences {
  defaultModel?: string;
  taskTypeOverrides?: Record<string, string>;
  budgetDowngradeThreshold?: number | null;
}

/**
 * #512 — the provider the selected model will run on. The router's ids are
 * Claude tier ids, so it asks the provider whether it can run each one as sent
 * (`AIProvider.servesRouterModel`); an adapter that cannot answer is treated as
 * unable.
 */
export type RouterProvider = Pick<AIProvider, "key" | "model" | "servesRouterModel">;

/**
 * #532 — the model to send for a call site that wants Claude tier `tierId`:
 * the tier id when the provider serves it, otherwise the provider's configured
 * model (the same fallback {@link ModelRouter} applies). An adapter that cannot
 * answer is treated as unable.
 */
export function tierModelFor(provider: RouterProvider, tierId: string): string {
  return provider.servesRouterModel?.(tierId) === true ? tierId : provider.model;
}

export interface ModelRouterOptions {
  /** Per-project model preferences. */
  preferences?: ModelPreferences;
  /** Current month's token spend for budget-aware routing. */
  currentMonthTokens?: number;
  /**
   * #512 — the active provider. When set and it cannot serve the selected tier
   * id, the selection is the provider's configured model instead. Omitted:
   * tier routing is reported unchanged.
   */
  provider?: RouterProvider;
}

/**
 * Routes AI tasks to the optimal model based on task complexity,
 * project preferences, and budget constraints.
 */
export class ModelRouter {
  private readonly preferences: ModelPreferences;
  private readonly currentMonthTokens: number;
  private readonly provider: RouterProvider | undefined;

  constructor(opts: ModelRouterOptions = {}) {
    this.preferences = opts.preferences ?? {};
    this.currentMonthTokens = opts.currentMonthTokens ?? 0;
    this.provider = opts.provider;
  }

  /**
   * Select the optimal model for a given task profile.
   *
   * @param profile   Task profile from the TaskProfiler
   * @param override  Optional user override (force-haiku, force-sonnet, auto)
   */
  select(profile: TaskProfile, override: ModelOverride = "auto"): ModelSelection {
    // User override takes precedence
    if (override !== "auto") {
      const forcedModel = OVERRIDE_MODEL_MAP[override];
      return this.buildSelection(
        forcedModel,
        profile,
        `User override: forced ${OVERRIDE_LABELS[override]}`,
        false,
      );
    }

    // Check task-type overrides from project preferences
    const taskTypeOverride = this.preferences.taskTypeOverrides?.[profile.taskType];
    if (taskTypeOverride && KNOWN_MODEL_IDS.has(taskTypeOverride)) {
      return this.buildSelection(
        taskTypeOverride,
        profile,
        `Project task-type override for "${profile.taskType}"`,
        false,
      );
    }

    // Route based on reasoning depth
    let selectedModel: string;
    let rationale: string;

    switch (profile.reasoningDepth) {
      case "simple":
        selectedModel = HAIKU_MODEL_ID;
        rationale = `Simple task (${profile.taskType}): Haiku provides sufficient capability at lower cost`;
        break;
      case "complex":
        selectedModel = SONNET_MODEL_ID;
        rationale = `Complex task (${profile.taskType}): Sonnet required for deep reasoning`;
        break;
      case "moderate":
        // Use project default preference, fallback to Sonnet
        selectedModel = this.preferences.defaultModel ?? SONNET_MODEL_ID;
        rationale = `Moderate task (${profile.taskType}): using ${
          this.preferences.defaultModel ? "project default" : "Sonnet (system default)"
        }`;
        break;
    }

    // Budget-aware downgrade: if threshold is set and current usage exceeds it
    const threshold = this.preferences.budgetDowngradeThreshold;
    if (
      threshold != null &&
      threshold > 0 &&
      this.currentMonthTokens >= threshold &&
      selectedModel === SONNET_MODEL_ID
    ) {
      return this.buildSelection(
        HAIKU_MODEL_ID,
        profile,
        `Budget threshold exceeded (${this.currentMonthTokens.toLocaleString()} >= ${threshold.toLocaleString()} tokens): downgraded from Sonnet to Haiku`,
        true,
      );
    }

    return this.buildSelection(selectedModel, profile, rationale, false);
  }

  /**
   * #512 — the model a run started with `model` actually sends. A `force-*`
   * override resolves through {@link OVERRIDE_MODEL_MAP} and, like the Model
   * card's selection, falls back to the provider's configured model when the
   * provider cannot serve that tier id. Any other value (an explicit model id,
   * or none) is returned unchanged.
   */
  resolveRunModel(model: string | undefined): string | undefined {
    if (model === undefined || !Object.hasOwn(OVERRIDE_MODEL_MAP, model)) return model;
    const tierId = OVERRIDE_MODEL_MAP[model as keyof typeof OVERRIDE_MODEL_MAP];
    return this.cannotServe(tierId) ? this.provider!.model : tierId;
  }

  /** #512 — true when a provider is attached and it cannot run `modelId` as sent. */
  private cannotServe(modelId: string): boolean {
    return this.provider !== undefined && this.provider.servesRouterModel?.(modelId) !== true;
  }

  private buildSelection(
    modelId: string,
    profile: TaskProfile,
    rationale: string,
    wasDowngraded: boolean,
  ): ModelSelection {
    // #512 — a tier id the active provider cannot run is not what the run
    // uses: DeepSeek maps `claude-*` onto its own models, and an OpenAI-
    // compatible endpoint receives the id verbatim. Report (and run) the
    // provider's configured model, with no Claude rate quoted against it.
    const provider = this.provider;
    if (provider && this.cannotServe(modelId)) {
      return {
        modelId: provider.model,
        modelName: provider.model,
        rationale: `The ${provider.key} provider does not serve Claude tier models: using its configured model (${provider.model})`,
        estimatedCost: null,
        wasDowngraded: false,
      };
    }

    const costPer1K = COST_PER_1K[modelId] ?? 0.003;
    // #1095 — an unknown token estimate yields an unknown cost. Coercing null to
    // 0 here is what produced the authoritative-looking "~$0.0000" in the UI.
    const estimatedCost =
      profile.tokenEstimate == null ? null : (profile.tokenEstimate / 1_000) * costPer1K;

    return {
      modelId,
      modelName: MODEL_NAMES[modelId] ?? modelId,
      rationale,
      estimatedCost:
        estimatedCost == null ? null : Math.round(estimatedCost * 1_000_000) / 1_000_000,
      wasDowngraded,
    };
  }
}
