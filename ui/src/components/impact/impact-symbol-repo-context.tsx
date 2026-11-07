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

/**
 * #1965 — `projectId -> true` for each project with more than one connected
 * repository: there the same path can exist twice, so each file row names its
 * repository. With no provider every project reads false, and the row still
 * names its repository when the item itself spans several.
 */
export type ImpactMultiRepoProjects = Readonly<Record<string, boolean>>;

export const ImpactMultiRepoProjectsContext = createContext<ImpactMultiRepoProjects>({});

/** True when the project connects more than one repository. */
export function useImpactProjectHasManyRepos(projectId: string): boolean {
  return useContext(ImpactMultiRepoProjectsContext)[projectId] === true;
}

/**
 * Which projects connect more than one repository, from the same
 * `["connectors", "repos", projectId]` cache entry as {@link useImpactProjectRepos},
 * so it adds no request. A failed list reads as one repository.
 */
export function useImpactMultiRepoProjects(projectIds: readonly string[]): ImpactMultiRepoProjects {
  const combine = useCallback(
    (results: UseQueryResult<RepoConnector[]>[]): ImpactMultiRepoProjects => {
      const map: Record<string, boolean> = {};
      results.forEach((r, i) => {
        const live = Array.isArray(r.data) ? r.data.filter((c) => c && !c.deletedAt) : [];
        map[projectIds[i]] = live.length > 1;
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
