"use client";

/**
 * #728 — the GitHub repo a page's code citations link into. A page that knows
 * its project provides it once (`useCodeCitationRepo`) and every `CodeCitation`
 * below — finding cards, gap report, requirement diff — reads it, instead of
 * threading a prop through each surface. With no provider the value is `null`
 * and citations stay plain text.
 */
import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { selectCodeCitationRepo, type CodeCitationRepo } from "@/lib/code-citation-blob-url";

export const CodeCitationRepoContext = createContext<CodeCitationRepo | null>(null);

export function useCodeCitationRepoContext(): CodeCitationRepo | null {
  return useContext(CodeCitationRepoContext);
}

/**
 * The project's single GitHub repo for citation links. Shares the
 * `["connectors", "repos", projectId]` cache entry with `useRepoNames`, so it
 * adds no request.
 */
export function useCodeCitationRepo(projectId: string | null | undefined): CodeCitationRepo | null {
  const { data } = useQuery({
    queryKey: ["connectors", "repos", projectId],
    queryFn: () => repoConnectorsApi.list(projectId as string),
    enabled: Boolean(projectId),
  });
  return useMemo(() => selectCodeCitationRepo(data), [data]);
}
