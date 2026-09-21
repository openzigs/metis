/**
 * Typed wrappers around the change analysis REST endpoints — Epic #557.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  ChangeAnalysis,
  ChangeAnalysisDetail,
  RequirementChange,
  TriggerChangeAnalysisInput,
  ReviewChangeInput,
  PublishDestinationConfig,
} from "@metis/shared";

type Id = string;

const base = (projectId: Id) => `/projects/${projectId}/change-analyses`;

export const changeAnalysisApi = {
  trigger: (projectId: Id, body: TriggerChangeAnalysisInput) =>
    apiFetch<ChangeAnalysis>(base(projectId), {
      method: "POST",
      body,
    }),

  list: (projectId: Id) => apiFetch<ChangeAnalysis[]>(base(projectId)),

  get: (projectId: Id, id: Id) => apiFetch<ChangeAnalysisDetail>(`${base(projectId)}/${id}`),

  reviewChange: (projectId: Id, analysisId: Id, changeId: Id, body: ReviewChangeInput) =>
    apiFetch<RequirementChange>(`${base(projectId)}/${analysisId}/changes/${changeId}/review`, {
      method: "POST",
      body,
    }),
};

// ---- Publishing destination config -----------------------------------------

export const publishDestinationApi = {
  get: (projectId: Id) =>
    apiFetch<PublishDestinationConfig>(`/projects/${projectId}/publish-destination`),

  update: (projectId: Id, body: PublishDestinationConfig) =>
    apiFetch<PublishDestinationConfig>(`/projects/${projectId}/publish-destination`, {
      method: "PATCH",
      body,
    }),
};
