"use client";

/**
 * Project Overview (#29, epic #26) — where each pipeline stage stands and what
 * to do next, plus knowledge search. The settings form that used to live here
 * moved behind the ⚙ tab (`/projects/[id]/settings`); the code summary is Code →
 * Code Overview. This is the only page in a project named "Overview".
 */
import { notFound, useParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { knowledgeApi, projectsApi, type RetrievedChunk } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProjectPipelineOverview } from "@/components/projects/pipeline-overview";

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const project = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => projectsApi.get(id),
    enabled: Boolean(id),
  });

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RetrievedChunk[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const search = useMutation({
    mutationFn: () => knowledgeApi.search(id, { query, k: 5 }),
    onSuccess: (data) => {
      setHits(data.hits);
      setSearchError(null);
    },
    onError: (err: unknown) => {
      setHits([]);
      setSearchError(err instanceof ApiError ? err.message : "Search failed");
    },
  });

  if (!id) return <div className="p-6">Invalid project id.</div>;
  if (project.isLoading) return <div className="p-6">Loading…</div>;
  // A missing project (404) must render the shared not-found boundary (#143),
  // not an ad-hoc inline string. notFound() throws to the nearest not-found.tsx.
  if (project.error instanceof ApiError && project.error.status === 404) {
    notFound();
  }
  if (project.error || !project.data) {
    return <div className="p-6 text-destructive">Project not found.</div>;
  }
  const p = project.data;

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="project-overview-root">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Overview</p>
          <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
          <p className="text-sm text-muted-foreground">
            <code>{p.slug}</code> · {p.status}
          </p>
          {p.description ? <p className="mt-2 max-w-prose">{p.description}</p> : null}
        </div>
      </header>

      <ProjectPipelineOverview projectId={id} />

      <Card className="space-y-4 p-4">
        <h2 className="text-lg font-semibold">Knowledge search</h2>{" "}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) search.mutate();
          }}
        >
          <div className="flex-1 space-y-2">
            <Label htmlFor="query">Query</Label>
            <Input
              id="query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What does this codebase know about…"
              data-testid="search-query-input"
            />
          </div>
          <Button type="submit" disabled={search.isPending} data-testid="search-submit">
            {search.isPending ? "Searching…" : "Search"}
          </Button>
        </form>
        {searchError ? (
          <p className="text-sm text-destructive" role="alert">
            {searchError}
          </p>
        ) : null}
        {hits.length > 0 ? (
          <ul className="space-y-2" data-testid="search-hits">
            {hits.map((h) => (
              <li key={h.chunkId} className="rounded-md border p-3 text-sm">
                <p className="text-xs text-muted-foreground">
                  {h.filename}#{h.position} · score {h.score.toFixed(3)}
                </p>
                <pre className="mt-2 whitespace-pre-wrap text-sm">{h.text}</pre>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}
