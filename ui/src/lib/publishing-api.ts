/**
 * Typed wrappers around the Phase 9 publishing REST endpoints.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  ArchivePublishBatchInput,
  CreatePublishBatchInput,
  DryRunPlan,
  IssueDraft,
  PublishBatch,
  PublishedIssue,
  ReviewGateConfig,
} from "@metis/shared";

type Id = string;

const base = (projectId: Id) => `/projects/${projectId}/publishing`;

export interface GenerateDraftsResponse {
  summary: {
    total: number;
    epics: number;
    features: number;
    upserted: number;
    refreshed: number;
  };
}

export interface BatchExecuteResponse {
  batch: PublishBatch & { publishedIssues: PublishedIssue[] };
  run: { status: string };
}

export const publishingApi = {
  listDrafts: (projectId: Id) => apiFetch<IssueDraft[]>(`${base(projectId)}/drafts`),
  generateDrafts: (
    projectId: Id,
    body: { analysisId: string; targetOwner: string; targetRepo: string; defaultLabels?: string[] },
  ) =>
    apiFetch<GenerateDraftsResponse>(`${base(projectId)}/drafts/generate`, {
      method: "POST",
      body,
    }),
  approveDraft: (projectId: Id, draftId: Id) =>
    apiFetch<IssueDraft>(`${base(projectId)}/drafts/${draftId}/approve`, { method: "POST" }),
  listBatches: (projectId: Id, includeArchived = false) =>
    apiFetch<PublishBatch[]>(
      `${base(projectId)}/batches?includeArchived=${includeArchived ? "true" : "false"}`,
    ),
  getBatch: (projectId: Id, id: Id) =>
    apiFetch<PublishBatch & { publishedIssues: PublishedIssue[] }>(
      `${base(projectId)}/batches/${id}`,
    ),
  createBatch: (projectId: Id, body: Omit<CreatePublishBatchInput, "projectId">) =>
    apiFetch<BatchExecuteResponse>(`${base(projectId)}/batches`, {
      method: "POST",
      body,
    }),
  /**
   * #1104 (D) — what the SAME body would write, without writing it. Backs the
   * pre-publish confirmation; creates no batch and makes no GitHub calls.
   */
  previewBatch: (projectId: Id, body: Omit<CreatePublishBatchInput, "projectId">) =>
    apiFetch<DryRunPlan>(`${base(projectId)}/batches/preview`, {
      method: "POST",
      body,
    }),
  /** #1104 (F) — settle a stranded batch (local record only; no rollback). */
  cancelBatch: (projectId: Id, id: Id) =>
    apiFetch<PublishBatch>(`${base(projectId)}/batches/${id}/cancel`, { method: "POST" }),
  archiveBatch: (projectId: Id, id: Id, body: ArchivePublishBatchInput) =>
    apiFetch<PublishBatch>(`${base(projectId)}/batches/${id}/archive`, {
      method: "POST",
      body,
    }),
};

/**
 * Epic #609 (#619) — per-project publish/export approval gate setting.
 * Reading needs `project.read`; updating needs `review.admin`.
 */
export const reviewGateApi = {
  get: (projectId: Id) => apiFetch<ReviewGateConfig>(`/projects/${projectId}/review-gate`),
  update: (projectId: Id, body: ReviewGateConfig) =>
    apiFetch<ReviewGateConfig>(`/projects/${projectId}/review-gate`, {
      method: "PATCH",
      body,
    }),
};
