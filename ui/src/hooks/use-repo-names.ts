"use client";

/**
 * Issue #23 — resolve `connector:repo:<connectorId>:…` document ids to the
 * repository's name, so labels read `README.md — metis` rather than
 * `README.md — tytwhc` (the connector id's tail).
 *
 * Shares the `["connectors", "repos", projectId]` cache entry with the other
 * pages that list a project's repo connectors, so it costs one request per
 * project, not one per document.
 */
import { useMemo } from "react";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { RepoConnector } from "@metis/shared";
import { repoConnectorsApi } from "@/lib/connectors-api";

export type RepoNameMap = Readonly<Record<string, string>>;

type NamedConnector = Pick<RepoConnector, "id" | "label" | "repoName">;

/**
 * Connector id → repository name, falling back to the connector's label.
 * Anything other than an array yields an empty map, and a malformed element is
 * skipped: a label is cosmetic and must never take down the page that renders it.
 */
export function repoNamesById(connectors: unknown): RepoNameMap {
  const out: Record<string, string> = {};
  if (!Array.isArray(connectors)) return out;
  for (const c of connectors as Array<Partial<NamedConnector> | null>) {
    if (!c || typeof c.id !== "string") continue;
    out[c.id] = c.repoName?.trim() || c.label || c.id;
  }
  return out;
}

export function useRepoNames(projectId: string | null | undefined): RepoNameMap {
  const { data } = useQuery({
    queryKey: ["connectors", "repos", projectId],
    queryFn: () => repoConnectorsApi.list(projectId as string),
    enabled: Boolean(projectId),
  });
  return useMemo(() => repoNamesById(data), [data]);
}

/** Merge several projects' connector lists into one id → name map. */
function mergeRepoNames(results: UseQueryResult<RepoConnector[]>[]): RepoNameMap {
  return Object.assign({}, ...results.map((r) => repoNamesById(r.data)));
}

/**
 * Issue #363 — the cross-project `/documents` list needs the repository names of
 * every project it shows. Each project reads the same cache entry as
 * `useRepoNames`, and connector ids are globally unique, so the maps merge.
 */
export function useRepoNamesForProjects(projectIds: readonly string[]): RepoNameMap {
  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["connectors", "repos", projectId],
      queryFn: () => repoConnectorsApi.list(projectId),
    })),
    combine: mergeRepoNames,
  });
}
