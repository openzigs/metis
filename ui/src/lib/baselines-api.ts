/**
 * Epic #609 / Issue #620 — requirement-baseline API client.
 *
 * Server surface: `server/src/routes/baselines.ts`. A baseline is a named,
 * IMMUTABLE set of `(requirementId, version)` pins — the client exposes no
 * update or delete call by design. Payload shapes mirror
 * `server/src/lib/reviews/baseline-service.ts`.
 */
import { apiFetch } from "@/lib/api-client";
import type { ChangedFields } from "@/lib/history-api";

// ---- Types ------------------------------------------------------------------

export interface BaselineUserRef {
  id: string;
  username: string;
  displayName: string;
}

export interface BaselineReviewRef {
  id: string;
  title: string;
  status: string;
}

export interface BaselineSummary {
  id: string;
  projectId: string;
  /** Producing review for auto-created baselines; null for manual ones. */
  reviewRequestId: string | null;
  name: string;
  description: string;
  createdAt: string;
  createdBy: BaselineUserRef;
  reviewRequest: BaselineReviewRef | null;
  itemCount: number;
}

export interface BaselineListPage {
  baselines: BaselineSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/** Tracked requirement fields reconstructed AS OF the pinned version. */
export interface BaselineItemSnapshot {
  title: string | null;
  body: string | null;
  priority: string | null;
  type: string | null;
  labels: string | null;
  storyPoints: number | null;
  reviewStatus: string | null;
}

export interface BaselineItem {
  requirementId: string;
  /** The pinned Requirement.version counter. */
  version: number;
  snapshot: BaselineItemSnapshot | null;
  /** Where the requirement is NOW — drift context, never shown as content. */
  current: { version: number; deleted: boolean } | null;
}

export interface BaselineContents {
  baseline: Omit<BaselineSummary, "itemCount">;
  items: BaselineItem[];
}

export interface BaselineRef {
  id: string;
  name: string;
  createdAt: string;
}

export interface BaselineCompareEntry {
  requirementId: string;
  version: number;
  /** Title as of the relevant pinned version. */
  title: string;
}

export interface BaselineChangedEntry {
  requirementId: string;
  fromVersion: number;
  toVersion: number;
  title: string;
  /** Field-level diff between the two pinned snapshots. */
  changedFields: ChangedFields;
}

export interface BaselineCompareResult {
  baselineA: BaselineRef;
  baselineB: BaselineRef;
  added: BaselineCompareEntry[];
  removed: BaselineCompareEntry[];
  changed: BaselineChangedEntry[];
  unchanged: BaselineCompareEntry[];
}

export interface CreateBaselineInput {
  name: string;
  description?: string;
  /** Optional subset; omitted = every requirement in the project. */
  requirementIds?: string[];
}

// ---- API --------------------------------------------------------------------

export const baselinesApi = {
  /** Project baselines, newest first. */
  list(projectId: string, page?: number, pageSize?: number): Promise<BaselineListPage> {
    return apiFetch<BaselineListPage>(`/projects/${projectId}/baselines`, {
      params: { page, pageSize },
    });
  },

  /** Baseline contents — each requirement rendered AS OF its pinned version. */
  get(baselineId: string): Promise<BaselineContents> {
    return apiFetch<BaselineContents>(`/baselines/${baselineId}`);
  },

  /** Compare two baselines (A → B): added / removed / changed / unchanged. */
  compare(baselineIdA: string, baselineIdB: string): Promise<BaselineCompareResult> {
    return apiFetch<BaselineCompareResult>(`/baselines/${baselineIdA}/compare/${baselineIdB}`);
  },

  /** Manual baseline pinning CURRENT versions (review.admin only). */
  create(projectId: string, input: CreateBaselineInput): Promise<BaselineContents["baseline"]> {
    return apiFetch(`/projects/${projectId}/baselines`, { method: "POST", body: input });
  },
};
