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
import { useQuery } from "@tanstack/react-query";
import type { RepoConnector } from "@metis/shared";
import { repoConnectorsApi } from "@/lib/connectors-api";

export type RepoNameMap = Readonly<Record<string, string>>;

type NamedConnector = Pick<RepoConnector, "id" | "label"> & { repoName?: string | null };

/**
 * Connector id → repository name, falling back to the connector's label.
 * Anything other than an array yields an empty map: a label is cosmetic and
 * must never take down the page that renders it.
 */
export function repoNamesById(connectors: unknown): RepoNameMap {
  const out: Record<string, string> = {};
  if (!Array.isArray(connectors)) return out;
  for (const c of connectors as NamedConnector[]) {
    out[c.id] = c.repoName?.trim() || c.label;
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
