/**
 * Epic #770 — Requirement version-history API client (history, restore, export).
 */
import { ApiError, apiFetch, streamFetch } from "@/lib/api-client";

// ---- Types ------------------------------------------------------------------

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export type ChangedFields = Record<string, FieldChange>;

/** The tracked subset of a requirement, reconstructed as-of a version. */
export type RequirementVersionSnapshot = Record<string, unknown>;

export interface RequirementHistoryEntry {
  version: number;
  changedFields: ChangedFields;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
  snapshot: RequirementVersionSnapshot;
}

export interface RequirementHistoryPage {
  versions: RequirementHistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
  currentVersion: number;
}

export interface RestoreResult {
  id: string;
  version: number;
  restoredFrom: number;
  updatedAt: string;
  changedFields: ChangedFields;
}

export type ExportFormat = "csv" | "json";

// ---- API --------------------------------------------------------------------

export const historyApi = {
  /** Fetch a page of the version timeline (newest first). */
  list(
    requirementId: string,
    options: { page?: number; pageSize?: number } = {},
  ): Promise<RequirementHistoryPage> {
    return apiFetch<RequirementHistoryPage>(`/requirements/${requirementId}/history`, {
      params: { page: options.page ?? 1, pageSize: options.pageSize ?? 20 },
    });
  },

  /** Restore the requirement to `version`, creating a new version N+1. */
  restore(requirementId: string, version: number, reason?: string): Promise<RestoreResult> {
    return apiFetch<RestoreResult>(`/requirements/${requirementId}/restore/${version}`, {
      method: "POST",
      body: reason ? { reason } : {},
    });
  },

  /**
   * Download the FULL history (all versions) as a CSV or JSON file. Uses
   * `streamFetch` to preserve the auth-refresh chain, then triggers a browser
   * download via a transient object URL.
   */
  async export(requirementId: string, format: ExportFormat): Promise<void> {
    const res = await streamFetch(`/requirements/${requirementId}/history/export`, {
      params: { format },
    });
    if (!res.ok) {
      throw new ApiError(res.status, "History export failed");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `requirement-${requirementId}-history.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
};
