/**
 * Issue #2347 — typed client for `GET /api/projects/:projectId/requirements`:
 * the project's requirements across every change request, filtered and paged
 * on the server.
 */
import { apiFetch } from "@/lib/api-client";

export type RequirementListStatus = "draft" | "approved" | "rejected" | "deferred";

export interface RequirementListRow {
  id: string;
  title: string;
  body: string;
  version: number;
  reviewStatus: RequirementListStatus;
  updatedAt: string;
  changeRequest: { id: string; title: string };
  /** The latest standing formal review covering it; null when none. */
  review: { id: string; title: string; status: string } | null;
  /**
   * #2452 — the viewer wrote or edited it and the project does not allow
   * self-approval, so their Approve would be refused. Omitted otherwise.
   */
  selfApprovalForbidden?: true;
}

export interface RequirementListPage {
  items: RequirementListRow[];
  total: number;
  /** The title search matched more than the server keeps: `total` is a floor. */
  totalIsLowerBound?: boolean;
  page: number;
  pageSize: number;
}

export interface RequirementListQuery {
  analysisId?: string;
  status?: RequirementListStatus;
  q?: string;
  page: number;
  pageSize: number;
}

export function requirementListPath(projectId: string, query: RequirementListQuery): string {
  const params = new URLSearchParams();
  if (query.analysisId) params.set("analysisId", query.analysisId);
  if (query.status) params.set("status", query.status);
  const q = query.q?.trim();
  if (q) params.set("q", q);
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));
  return `/projects/${encodeURIComponent(projectId)}/requirements?${params.toString()}`;
}

export const requirementsListApi = {
  list: (projectId: string, query: RequirementListQuery) =>
    apiFetch<RequirementListPage>(requirementListPath(projectId, query)),
};
