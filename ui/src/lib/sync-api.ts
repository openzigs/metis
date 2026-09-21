/**
 * Epic #739 — Sync / Drift API client.
 */
import { apiFetch } from "./api-client";
import type { DriftEventRow, DriftResolutionAction } from "@metis/shared";

export interface DriftListResponse {
  items: DriftEventRow[];
  total: number;
}

export interface DriftCountResponse {
  count: number;
}

export async function fetchDriftEvents(
  projectId: string,
  opts: { status?: string; requirementId?: string; page?: number; perPage?: number } = {},
): Promise<DriftListResponse> {
  return apiFetch<DriftListResponse>("/sync/drift", {
    params: {
      projectId,
      status: opts.status,
      requirementId: opts.requirementId,
      page: opts.page,
      perPage: opts.perPage,
    },
  });
}

export async function fetchDriftCount(projectId: string): Promise<number> {
  const result = await apiFetch<DriftCountResponse>("/sync/drift/count", {
    params: { projectId },
  });
  return result.count;
}

export async function resolveDrift(
  driftId: string,
  action: DriftResolutionAction,
): Promise<DriftEventRow> {
  return apiFetch<DriftEventRow>(`/sync/drift/${driftId}/resolve`, {
    method: "POST",
    body: { action },
  });
}
