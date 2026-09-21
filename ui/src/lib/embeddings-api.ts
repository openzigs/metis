/**
 * Epic #930 — pluggable embeddings backends admin API client.
 *
 * Talks to the `/api/admin/embeddings` surface: the active backend's
 * capabilities + health, a per-project coverage report (how many chunks were
 * embedded with which model/dimension), and a reindex trigger that re-embeds a
 * project at the active backend's dimension.
 */
import { apiFetch } from "@/lib/api-client";

export interface EmbedBackendDescriptor {
  key: string;
  label: string;
  requiresEgress: boolean;
  offlineCapable: boolean;
}

export interface ActiveEmbedBackend {
  key: string;
  model: string;
  dimension: number;
  requiresEgress: boolean;
  healthy: boolean;
  error: string | null;
}

export interface EmbeddingsStatus {
  active: ActiveEmbedBackend;
  backends: EmbedBackendDescriptor[];
}

export interface EmbeddingsCoverageReport {
  totalChunks: number;
  modelCounts: Record<string, number>;
  currentModel: string;
  currentDimension: number;
  matchingChunks: number;
  mismatchedModels: string[];
  needsReindex: boolean;
}

/**
 * Final reindex outcome. As of Issue #423 the reindex is async, so this shape is
 * no longer the HTTP response — it is delivered (as a humanized message) over the
 * `embeddings-reindex` job:lifecycle `completed` event. Kept exported for the
 * worker contract / tests.
 */
export interface ReindexResult {
  projectId: string;
  totalChunks: number;
  reindexedChunks: number;
  previousModels: string[];
  currentModel: string;
  currentDimension: number;
  durationMs: number;
}

/**
 * Issue #423 — the reindex POST is now fire-and-forget: it enqueues the
 * re-embed and returns `202 { jobId }` promptly (no gateway/idle-timeout risk on
 * large corpora). The caller subscribes to that `jobId` on the job bus
 * (`useJobToast`) for live progress + a terminal toast.
 */
export interface ReindexEnqueued {
  jobId: string;
  projectId: string;
  status: "started";
}

export const embeddingsApi = {
  status: () => apiFetch<EmbeddingsStatus>("/admin/embeddings"),
  coverage: (projectId: string) =>
    apiFetch<EmbeddingsCoverageReport>(
      `/admin/embeddings/projects/${encodeURIComponent(projectId)}/coverage`,
    ),
  reindex: (projectId: string, body: { batchSize?: number } = {}) =>
    apiFetch<ReindexEnqueued>(
      `/admin/embeddings/projects/${encodeURIComponent(projectId)}/reindex`,
      {
        method: "POST",
        body,
      },
    ),
};
