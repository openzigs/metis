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
export type RouterProvider = Pick<AIProvider, "key" | "model" | "servesRouterModel"> &
  Partial<Pick<AIProvider, "offline">>;

/**
 * #713 — the offline stub, which answers any model id and runs no real model.
 * Two shapes: the stub itself (`offline: true`), and the e2e `AI_REPLAY=1`
 * wrapper around it — a `ReplayProvider` that reports `offline: false` (it is
 * not the stub when a fixture hits) but keeps the stub's `key`
 * (`fixtures/install.ts`). Testing `offline` alone listed only "Offline stub"
 * under replay. #978 — shared with {@link ModelRouter.assertServable}, so the
 * model preferences' `servesTierModels` and the forced-tier check agree.
 */
export function isOfflineStub(provider: RouterProvider): boolean {
  return provider.offline === true || provider.key === "offline-stub";
}

/**
 * #532 — the model to send for a call site that wants Claude tier `tierId`:
 * the tier id when the provider serves it, otherwise the provider's configured
 * model (the same fallback {@link ModelRouter} applies). An adapter that cannot
 * answer is treated as unable.
 */
export function tierModelFor(provider: RouterProvider, tierId: string): string {
  return provider.servesRouterModel?.(tierId) === true ? tierId : provider.model;
}

/**
 * #978 — a run or recommendation forced a Claude tier (a `force-*` override or
 * a raw tier id) onto a provider that cannot serve it. Refused rather than
 * silently remapped onto the provider's configured model: the caller asked for
 * a model this deployment does not run, and the run would not have used it.
 */
export class ModelNotServedError extends Error {
  readonly code = "MODEL_NOT_SERVED";
  constructor(
    readonly requested: string,
    readonly providerKey: string,
    readonly configuredModel: string,
  ) {
    const label = Object.hasOwn(OVERRIDE_LABELS, requested)
      ? OVERRIDE_LABELS[requested as keyof typeof OVERRIDE_LABELS]
      : requested;
    super(
      `The ${providerKey} provider does not serve ${label}; it runs ${configuredModel}. ` +
        `Choose Auto or ${configuredModel}.`,
    );
    this.name = "ModelNotServedError";
  }
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
  /**
   * #1145 — the model Auto runs: the project's own model (its `aiModel`, else
   * the provider's configured model — see {@link projectRunModel}). When set,
   * Auto never routes on reasoning depth to a hard-coded Claude tier: every
   * task runs on the project's default model preference, else on this model.
   * A project task-type override still applies. Omitted: the reasoning-depth
   * tier routing of #599, for callers that do not know the project's model.
   */
  autoModel?: string;
  /**
   * #1145 — further model ids a task-type override may name (the provider's
   * own catalog models, e.g. Claude Sonnet 5.5 on the Anthropic API), beyond
   * the router's tier ids.
   */
  acceptedModelIds?: ReadonlySet<string>;
}

/**
 * #1145 — the model a project's Auto analysis runs on: its `aiModel` when it
 * sets one for the provider the analysis runs on (no provider override, or an
 * override naming that same provider), else `undefined` — the provider's own
 * configured model. An `aiModel` set alongside another provider is a model of
 * THAT provider, which the analysis does not run on, so it is not sent here.
 */
export function projectRunModel(
  project: { aiModel?: string | null; aiProviderId?: string | null } | null | undefined,
  provider: Pick<RouterProvider, "key">,
): string | undefined {
  const model = project?.aiModel?.trim();
  if (!model) return undefined;
  if (project?.aiProviderId && project.aiProviderId !== provider.key) return undefined;
  return model;
}

/**
 * Routes AI tasks to the optimal model based on task complexity,
 * project preferences, and budget constraints.
 */
export class ModelRouter {
  private readonly preferences: ModelPreferences;
  private readonly currentMonthTokens: number;
  private readonly provider: RouterProvider | undefined;
  private readonly autoModel: string | undefined;
  private readonly acceptedModelIds: ReadonlySet<string>;

  constructor(opts: ModelRouterOptions = {}) {
    this.preferences = opts.preferences ?? {};
    this.currentMonthTokens = opts.currentMonthTokens ?? 0;
    this.provider = opts.provider;
    this.autoModel = opts.autoModel;
    this.acceptedModelIds = opts.acceptedModelIds ?? new Set();
  }

  /**
   * Select the optimal model for a given task profile.
   *
   * @param profile   Task profile from the TaskProfiler
   * @param override  Optional user override (force-haiku, force-sonnet, auto),
   *                  or (#1145) an explicit model id the caller has validated
   */
  select(profile: TaskProfile, override: ModelOverride | (string & {}) = "auto"): ModelSelection {
    // #1145 — an explicit model id (one of the provider's own models) runs as named.
    if (override !== "auto" && !Object.hasOwn(OVERRIDE_MODEL_MAP, override)) {
      return this.buildSelection(override, profile, `User override: ${override}`, false, true);
    }
    // User override takes precedence
    if (override !== "auto") {
      const forced = override as keyof typeof OVERRIDE_MODEL_MAP;
      const forcedModel = OVERRIDE_MODEL_MAP[forced];
      return this.buildSelection(
        forcedModel,
        profile,
        `User override: forced ${OVERRIDE_LABELS[forced]}`,
        false,
      );
    }

    // Check task-type overrides from project preferences
    const taskTypeOverride = this.preferences.taskTypeOverrides?.[profile.taskType];
    if (
      taskTypeOverride &&
      (KNOWN_MODEL_IDS.has(taskTypeOverride) || this.acceptedModelIds.has(taskTypeOverride))
    ) {
      return this.buildSelection(
        taskTypeOverride,
        profile,
        `Project task-type override for "${profile.taskType}"`,
        false,
      );
    }

    // #1145 — Auto runs the project's model, never a hard-coded older tier.
    if (this.autoModel !== undefined) {
      const projectDefault = this.preferences.defaultModel;
      const model = projectDefault ?? this.autoModel;
      return this.withBudgetDowngrade(
        model,
        profile,
        projectDefault
          ? `Auto (${profile.taskType}): the project's default model preference (${model})`
          : `Auto (${profile.taskType}): the project's model (${model})`,
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

    return this.withBudgetDowngrade(selectedModel, profile, rationale);
  }

  /** Budget-aware downgrade: if threshold is set and current usage exceeds it. */
  private withBudgetDowngrade(
    selectedModel: string,
    profile: TaskProfile,
    rationale: string,
  ): ModelSelection {
    const threshold = this.preferences.budgetDowngradeThreshold;
    const target =
      threshold != null && threshold > 0 && this.currentMonthTokens >= threshold
        ? this.downgradeTarget(selectedModel)
        : undefined;
    if (target !== undefined) {
      const exceeded = `Budget threshold exceeded (${this.currentMonthTokens.toLocaleString()} >= ${threshold!.toLocaleString()} tokens)`;
      return this.buildSelection(
        target,
        profile,
        selectedModel === SONNET_MODEL_ID
          ? `${exceeded}: downgraded from Sonnet to Haiku`
          : `${exceeded}: downgraded from ${selectedModel} to ${target}`,
        true,
      );
    }

    return this.buildSelection(selectedModel, profile, rationale, false);
  }

  /**
   * The cheaper model a budget downgrade switches `model` to, if any: the Sonnet
   * tier id to the Haiku tier id (#599), and (#1145) any other Sonnet-class
   * model — the project's or the provider's own, e.g. `claude-sonnet-5-5` on the
   * Anthropic API — to the first Haiku-class model the provider serves
   * ({@link ModelRouterOptions.acceptedModelIds}, newest first). No Haiku-class
   * model served, or a model that is not Sonnet-class: no downgrade.
   */
  private downgradeTarget(model: string): string | undefined {
    if (model === SONNET_MODEL_ID) return HAIKU_MODEL_ID;
    if (!/sonnet/i.test(model)) return undefined;
    for (const id of this.acceptedModelIds) {
      if (/haiku/i.test(id)) return id;
    }
    return undefined;
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

  /**
   * #978 — throws {@link ModelNotServedError} when `model` forces a Claude tier
   * (a `force-*` override, or a router tier id sent as-is) that the attached
   * provider cannot serve. Auto, no model, and any other id pass.
   */
  assertServable(model: string | undefined): void {
    if (model === undefined || (this.provider && isOfflineStub(this.provider))) return;
    const tierId = Object.hasOwn(OVERRIDE_MODEL_MAP, model)
      ? OVERRIDE_MODEL_MAP[model as keyof typeof OVERRIDE_MODEL_MAP]
      : KNOWN_MODEL_IDS.has(model)
        ? model
        : undefined;
    if (tierId !== undefined && this.cannotServe(tierId)) {
      throw new ModelNotServedError(model, this.provider!.key, this.provider!.model);
    }
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
    explicit = false,
  ): ModelSelection {
    // #1145 — the project's own model, or a model the caller named explicitly,
    // is what the provider runs: never remapped like a tier id it cannot serve.
    // A model the provider lists as its own (`acceptedModelIds`) counts too.
    const ownModel =
      explicit ||
      (this.autoModel !== undefined && modelId === this.autoModel) ||
      this.acceptedModelIds.has(modelId);
    // #512 — a tier id the active provider cannot run is not what the run
    // uses: DeepSeek maps `claude-*` onto its own models, and an OpenAI-
    // compatible endpoint receives the id verbatim. Report (and run) the
    // provider's configured model, with no Claude rate quoted against it.
    const provider = this.provider;
    if (provider && !ownModel && this.cannotServe(modelId)) {
      return {
        modelId: provider.model,
        modelName: provider.model,
        // #978 — the panel offers only Auto and this model on such a provider,
        // so the rationale names what runs rather than tiers it cannot offer.
        rationale: `Using the ${provider.key} provider's configured model (${provider.model}): tier routing does not apply to it`,
        estimatedCost: null,
        wasDowngraded: false,
      };
    }

    // #1145 — a model the router has no rate for (the project's own model, an
    // explicit provider model) gets no estimate rather than a borrowed Claude rate.
    const costPer1K = COST_PER_1K[modelId] ?? (ownModel ? null : 0.003);
    // #1095 — an unknown token estimate yields an unknown cost. Coercing null to
    // 0 here is what produced the authoritative-looking "~$0.0000" in the UI.
    const estimatedCost =
      profile.tokenEstimate == null || costPer1K == null
        ? null
        : (profile.tokenEstimate / 1_000) * costPer1K;

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
