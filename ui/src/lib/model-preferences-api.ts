/**
 * Typed wrappers around the model preference + recommendation endpoints
 * (Epic #593 / Issues #600, #602).
 */
import type { ModelCatalogEntry } from "@metis/shared";
import { apiFetch } from "@/lib/api-client";

export type ModelOverride = "auto" | "force-haiku" | "force-sonnet" | "force-fable" | "force-opus";

export interface ModelPreferencesData {
  projectId: string;
  defaultModel: string | null;
  taskTypeOverrides: Record<string, string>;
  budgetDowngradeThreshold: number | null;
  /**
   * #135 — the router's selectable models, described by the server's model
   * catalog. The settings picker renders from this list only.
   */
  availableModels: Array<{
    id: string;
    name: string;
    tier: string;
    contextWindow?: number | null;
    price?: ModelCatalogEntry["price"];
    capabilities?: ModelCatalogEntry["capabilities"];
  }>;
}

export interface ModelPreferencesInput {
  defaultModel?: string | null;
  taskTypeOverrides?: Record<string, string>;
  budgetDowngradeThreshold?: number | null;
}

/**
 * Issue #1095 — the recommendation now describes the run the user is about to
 * start. `tokenEstimate`/`estimatedCost` are NULLABLE: with no completed run to
 * learn from there is no honest number, and the UI shows none rather than the
 * old constant "~16 tokens · ~$0.0000".
 */
export interface ModelRecommendationData {
  profile: {
    tokenEstimate: number | null;
    reasoningDepth: "simple" | "moderate" | "complex";
    latencySLA: "interactive" | "standard" | "background";
    taskType: string;
  };
  selection: {
    modelId: string;
    modelName: string;
    rationale: string;
    estimatedCost: number | null;
    wasDowngraded: boolean;
  };
  estimate: {
    tokens: number | null;
    basis: "prior-runs" | "no-history";
    sampleSize: number;
    perAgentTokens: number | null;
  };
}

/** The planned run, POSTed so a long requirement paste is never URL-truncated. */
export interface ModelRecommendationInput {
  override?: ModelOverride;
  agentKeys?: string[];
  requirementText?: string;
}

export const modelPreferencesApi = {
  get: (projectId: string) =>
    apiFetch<ModelPreferencesData>(`/projects/${projectId}/model-preferences`),

  update: (projectId: string, body: ModelPreferencesInput) =>
    apiFetch<ModelPreferencesData>(`/projects/${projectId}/model-preferences`, {
      method: "PUT",
      body,
    }),

  getRecommendation: (projectId: string, input: ModelRecommendationInput = {}) =>
    apiFetch<ModelRecommendationData>(`/projects/${projectId}/analyses/model-recommendation`, {
      method: "POST",
      body: {
        override: input.override ?? "auto",
        agentKeys: input.agentKeys ?? [],
        requirementText: input.requirementText ?? "",
      },
    }),
};
