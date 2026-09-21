/**
 * Typed wrappers around the inbound-importer REST endpoints — Epic #776.
 *
 *   /api/projects/:projectId/imports/...
 */
import { apiFetch } from "@/lib/api-client";
import type {
  CreateImportSourceRequest,
  ImportPreview,
  ImportPreviewRequest,
  ImportRunView,
  ImportSourceView,
  UpdateImportSyncRequest,
} from "@metis/shared";

type Id = string;

const base = (projectId: Id) => `/projects/${encodeURIComponent(projectId)}/imports`;

export interface CreateImportSourceResult {
  source: ImportSourceView;
  run: ImportRunView;
}

export const importApi = {
  preview: (projectId: Id, body: ImportPreviewRequest) =>
    apiFetch<ImportPreview>(`${base(projectId)}/preview`, { method: "POST", body }),

  listSources: (projectId: Id) => apiFetch<ImportSourceView[]>(`${base(projectId)}/sources`),

  getSource: (projectId: Id, id: Id) =>
    apiFetch<ImportSourceView>(`${base(projectId)}/sources/${encodeURIComponent(id)}`),

  createSource: (projectId: Id, body: CreateImportSourceRequest) =>
    apiFetch<CreateImportSourceResult>(`${base(projectId)}/sources`, { method: "POST", body }),

  runSource: (projectId: Id, id: Id) =>
    apiFetch<ImportRunView>(`${base(projectId)}/sources/${encodeURIComponent(id)}/run`, {
      method: "POST",
    }),

  setSync: (projectId: Id, id: Id, body: UpdateImportSyncRequest) =>
    apiFetch<ImportSourceView>(`${base(projectId)}/sources/${encodeURIComponent(id)}/sync`, {
      method: "PATCH",
      body,
    }),

  deleteSource: (projectId: Id, id: Id) =>
    apiFetch<void>(`${base(projectId)}/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listRuns: (projectId: Id, sourceId?: Id) =>
    apiFetch<ImportRunView[]>(`${base(projectId)}/runs`, {
      params: sourceId ? { sourceId } : undefined,
    }),
};
