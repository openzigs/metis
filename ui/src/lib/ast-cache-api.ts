/**
 * AST cache rebuild API client (Epic #596 / Issue #616, UI consumer #122).
 *
 * Wraps POST /api/projects/:projectId/repositories/:repoId/rebuild-cache, which
 * rebuilds the AST summary cache from the connector's clone directory and
 * returns real rebuild statistics.
 */
import { apiFetch } from "@/lib/api-client";

export interface AstCacheRebuildStats {
  indexedFiles: number;
  skippedFiles: number;
  totalSymbols: number;
  discoveredFiles: number;
}

export interface AstCacheRebuildResult {
  repoId: string;
  projectId: string;
  message: string;
  stats: AstCacheRebuildStats;
}

export const astCacheApi = {
  rebuild: (projectId: string, repoId: string) =>
    apiFetch<AstCacheRebuildResult>(`/projects/${projectId}/repositories/${repoId}/rebuild-cache`, {
      method: "POST",
    }),
};
