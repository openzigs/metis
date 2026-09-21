/**
 * Typed wrappers around the requirement ↔ data-mapping endpoints
 * (Epic #889, issues #892/#893).
 *
 * Mirrors the shared DTOs so the UI stays in lockstep with the server.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  CreateRequirementDataMappingInput,
  RequirementDataMappingDetail,
  SuggestDataMappingsResult,
} from "@metis/shared";

type Id = string;

const base = (projectId: Id, requirementId: Id) =>
  `/projects/${projectId}/requirements/${requirementId}/data-mappings`;

export const dataMappingsApi = {
  list: (projectId: Id, requirementId: Id) =>
    apiFetch<RequirementDataMappingDetail[]>(base(projectId, requirementId)),

  create: (projectId: Id, requirementId: Id, body: CreateRequirementDataMappingInput) =>
    apiFetch<RequirementDataMappingDetail>(base(projectId, requirementId), {
      method: "POST",
      body,
    }),

  remove: (projectId: Id, requirementId: Id, mappingId: Id) =>
    apiFetch<void>(`${base(projectId, requirementId)}/${mappingId}`, { method: "DELETE" }),

  suggest: (projectId: Id, requirementId: Id) =>
    apiFetch<SuggestDataMappingsResult>(`${base(projectId, requirementId)}/suggest`, {
      method: "POST",
    }),
};
