/**
 * Typed wrappers around the stakeholder + project-context endpoints
 * (Epic #208, issues #230/#233).
 *
 * Mirrors the shared `@metis/shared` DTOs so the UI stays in lockstep with the
 * server.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  CreateStakeholderInput,
  LinkStakeholderInput,
  ProjectContext,
  ProjectContextInput,
  Stakeholder,
  StakeholderPriority,
  UpdateStakeholderInput,
} from "@metis/shared";

type Id = string;

/** A stakeholder attributed to a requirement, with the per-link metadata. */
export interface RequirementStakeholderLink extends Stakeholder {
  priority: StakeholderPriority;
  linkViewpoint: string;
}

export const stakeholderApi = {
  /** List a project's stakeholders. */
  list: (projectId: Id) => apiFetch<Stakeholder[]>(`/projects/${projectId}/stakeholders`),

  /** Create a stakeholder. */
  create: (projectId: Id, input: CreateStakeholderInput) =>
    apiFetch<Stakeholder>(`/projects/${projectId}/stakeholders`, {
      method: "POST",
      body: input,
    }),

  /** Update a stakeholder. */
  update: (projectId: Id, stakeholderId: Id, patch: UpdateStakeholderInput) =>
    apiFetch<Stakeholder>(`/projects/${projectId}/stakeholders/${stakeholderId}`, {
      method: "PATCH",
      body: patch,
    }),

  /** Delete a stakeholder. */
  remove: (projectId: Id, stakeholderId: Id) =>
    apiFetch<void>(`/projects/${projectId}/stakeholders/${stakeholderId}`, {
      method: "DELETE",
    }),

  /** Read the project's context model. */
  getContext: (projectId: Id) => apiFetch<ProjectContext>(`/projects/${projectId}/context`),

  /** Create-or-update the project's context model. */
  upsertContext: (projectId: Id, input: ProjectContextInput) =>
    apiFetch<ProjectContext>(`/projects/${projectId}/context`, {
      method: "PUT",
      body: input,
    }),

  /** List the stakeholders attributed to a requirement. */
  listForRequirement: (projectId: Id, requirementId: Id) =>
    apiFetch<RequirementStakeholderLink[]>(
      `/projects/${projectId}/requirements/${requirementId}/stakeholders`,
    ),

  /** Attribute a requirement to a stakeholder. */
  link: (projectId: Id, requirementId: Id, input: LinkStakeholderInput) =>
    apiFetch<void>(`/projects/${projectId}/requirements/${requirementId}/stakeholders`, {
      method: "POST",
      body: input,
    }),

  /** Detach a requirement↔stakeholder attribution. */
  unlink: (projectId: Id, requirementId: Id, stakeholderId: Id) =>
    apiFetch<void>(
      `/projects/${projectId}/requirements/${requirementId}/stakeholders/${stakeholderId}`,
      { method: "DELETE" },
    ),
};
