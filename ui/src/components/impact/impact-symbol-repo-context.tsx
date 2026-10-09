"use client";

/**
 * #992 — the GitHub repo each project's impacted symbols link into.
 *
 * One impact analysis spans several projects, so unlike the single-project
 * `CodeCitationRepoContext` (#728) this carries a `projectId -> repo` map. The
 * detail page provides it once ({@link useImpactProjectRepos}); every
 * `ChangedRequirementGroup` below — per-project sections and the matrix
 * drill-down alike — looks up its own item's project. With no provider the map
 * is empty and symbols stay plain text, so the presentational components need
 * no QueryClient.
 */
import { createContext, useCallback, useContext } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import type { RepoConnector } from "@metis/shared";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { selectCodeCitationRepo, type CodeCitationRepo } from "@/lib/code-citation-blob-url";

export type ImpactSymbolRepos = Readonly<Record<string, CodeCitationRepo | null>>;

export const ImpactSymbolRepoContext = createContext<ImpactSymbolRepos>({});

/** The repo a project's impacted symbols link into, or `null` (plain text). */
export function useImpactSymbolRepo(projectId: string): CodeCitationRepo | null {
  return useContext(ImpactSymbolRepoContext)[projectId] ?? null;
}

/**
 * Fetch each project's repo connectors and pick its single GitHub / GitHub
 * Enterprise repo. Shares the `["connectors", "repos", projectId]` cache entry
 * with `useCodeCitationRepo` / `useRepoNames`, so it adds no request where the
 * list is already cached. A failed list degrades that project to plain text.
 */
export function useImpactProjectRepos(projectIds: readonly string[]): ImpactSymbolRepos {
  const combine = useCallback(
    (results: UseQueryResult<RepoConnector[]>[]): ImpactSymbolRepos => {
      const map: Record<string, CodeCitationRepo | null> = {};
      results.forEach((r, i) => {
        map[projectIds[i]] = selectCodeCitationRepo(r.data);
      });
      return map;
    },
    [projectIds],
  );
  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["connectors", "repos", projectId],
      queryFn: () => repoConnectorsApi.list(projectId),
      retry: false,
    })),
    combine,
  });
}
