/**
 * Typed wrappers around the requirement-link endpoints — Epic #610 (#624/#625).
 *
 * Mirrors the serialized shapes returned by `requirement-link-service.ts`
 * (`createdAt` arrives as an ISO string over JSON, not a `Date`). The link-type
 * vocabulary itself is the shared `RequirementLinkType` so the UI stays in
 * lockstep with the server + model.
 */
import { apiFetch } from "@/lib/api-client";
import type { RequirementLinkType } from "@metis/shared";

type Id = string;

/** The counterpart endpoint's rendering context returned alongside a link. */
export interface LinkedRequirementRef {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
}

/** A single typed link, from the perspective of the requirement being viewed. */
export interface RequirementLinkView {
  id: string;
  type: RequirementLinkType;
  createdAt: string;
  sourceRequirementId: string;
  targetRequirementId: string;
  /** The OTHER endpoint (target for outgoing, source for incoming). */
  requirement: LinkedRequirementRef;
}

/** Both directions of a requirement's links. */
export interface RequirementLinksResult {
  outgoing: RequirementLinkView[];
  incoming: RequirementLinkView[];
}

/** Paginated workspace-scoped requirement search results. */
export interface RequirementSearchResult {
  items: LinkedRequirementRef[];
  page: number;
  pageSize: number;
  total: number;
}

export interface SearchRequirementsParams {
  q?: string;
  /** Exclude a whole project (e.g. the current requirement's project). */
  excludeProject?: string;
  page?: number;
  pageSize?: number;
}

export const requirementLinksApi = {
  list: (requirementId: Id) =>
    apiFetch<RequirementLinksResult>(`/requirements/${requirementId}/links`),

  create: (requirementId: Id, body: { targetRequirementId: Id; type: RequirementLinkType }) =>
    apiFetch<RequirementLinkView>(`/requirements/${requirementId}/links`, {
      method: "POST",
      body,
    }),

  remove: (linkId: Id) =>
    apiFetch<{ removed: boolean }>(`/requirement-links/${linkId}`, { method: "DELETE" }),

  search: (workspaceId: Id, params: SearchRequirementsParams = {}) =>
    apiFetch<RequirementSearchResult>(`/workspaces/${workspaceId}/requirements/search`, {
      params: {
        q: params.q || undefined,
        excludeProject: params.excludeProject,
        page: params.page,
        pageSize: params.pageSize,
      },
    }),
};
