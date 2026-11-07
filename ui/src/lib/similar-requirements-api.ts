/**
 * Issue #1838 — typed wrappers around the similar-requirements API (#1837).
 * The shapes are the shared `SimilarRequirementsResponse`, so the UI stays in
 * lockstep with the server.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  BorrowCitationsInput,
  BorrowCitationsResult,
  SimilarRequirementsResponse,
} from "@metis/shared";

/** Items shown per list: the section's "up to 5". */
export const SIMILAR_REQUIREMENTS_SHOWN = 5;

export const similarRequirementsApi = {
  forRequirement: (projectId: string, requirementId: string, signal?: AbortSignal) =>
    apiFetch<SimilarRequirementsResponse>(
      `/projects/${projectId}/requirements/${requirementId}/similar`,
      { params: { limit: SIMILAR_REQUIREMENTS_SHOWN }, signal },
    ),

  forDraft: (projectId: string, text: string, signal?: AbortSignal) =>
    apiFetch<SimilarRequirementsResponse>(`/projects/${projectId}/requirements/similar`, {
      method: "POST",
      body: { text, limit: SIMILAR_REQUIREMENTS_SHOWN },
      signal,
    }),

  notDuplicate: (projectId: string, requirementId: string, otherRequirementId: string) =>
    apiFetch<{ notDuplicate: true }>(
      `/projects/${projectId}/requirements/${requirementId}/similar/${otherRequirementId}/not-duplicate`,
      { method: "POST" },
    ),

  /** #1840 — copy a similar requirement's saved code links onto this one, as borrowed (#1839). */
  borrowCitations: (projectId: string, requirementId: string, body: BorrowCitationsInput) =>
    apiFetch<BorrowCitationsResult>(
      `/projects/${projectId}/requirements/${requirementId}/borrow-citations`,
      { method: "POST", body },
    ),
};
