/**
 * Inference-profile API client (Epic #594 / Issue #604, UI consumer #127).
 *
 * Thin typed wrapper around:
 *   GET|PUT /api/projects/:projectId/inference-profile
 *
 * The Bedrock inference profile is surfaced read/write per project. This client
 * only moves the existing value to/from the server — it does not influence
 * provider selection or request shaping for Bedrock or local-gemma.
 */
import { apiFetch } from "@/lib/api-client";

export interface InferenceProfile {
  id: string;
  projectId: string;
  arn: string;
  modelId: string;
  costCenter: string | null;
  environment: string | null;
  tags: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface InferenceProfileInput {
  arn: string;
  modelId: string;
  costCenter?: string;
  environment?: string;
  tags?: Record<string, string>;
}

export const inferenceProfileApi = {
  get: (projectId: string) =>
    apiFetch<{ profile: InferenceProfile | null }>(`/projects/${projectId}/inference-profile`),

  update: (projectId: string, body: InferenceProfileInput) =>
    apiFetch<{ profile: InferenceProfile }>(`/projects/${projectId}/inference-profile`, {
      method: "PUT",
      body,
    }),
};
