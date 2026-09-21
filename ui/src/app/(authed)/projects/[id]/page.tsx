"use client";

/**
 * Project overview — project settings + knowledge search. Documents now live at
 * a dedicated `/projects/[id]/documents` route (N3 #141).
 */
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { knowledgeApi, projectsApi, type RetrievedChunk } from "@/lib/projects-api";
import { useAuth } from "@/lib/auth-context";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AiProviderPicker } from "@/components/projects/ai-provider-picker";
import { AiModelPicker } from "@/components/projects/ai-model-picker";
import { PrimaryRepoCard } from "@/components/projects/primary-repo-card";
import { SafetySettingsCard } from "@/components/projects/safety-settings-card";
import { BudgetSettingsCard } from "@/components/projects/budget-settings-card";
import { AutopilotSettingsCard } from "@/components/projects/autopilot-settings-card";
import { DatabaseAwareAnalysisSettingsCard } from "@/components/projects/database-aware-analysis-settings-card";
import { SqlLineageSettingsCard } from "@/components/projects/sql-lineage-settings-card";
import { AgentsMdCard } from "@/components/projects/agents-md-card";
import { CustomAgentsEnablementCard } from "@/components/projects/custom-agents-enablement-card";
import { InferenceProfileCard } from "@/components/projects/inference-profile-card";
import { QuarantinePanel } from "@/components/projects/quarantine-panel";
import { ChroniclePanel } from "@/components/projects/chronicle-panel";

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEditBudget = user?.role === "admin";

  const project = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => projectsApi.get(id),
    enabled: Boolean(id),
  });

  const archive = useMutation({
    mutationFn: () => projectsApi.archive(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.all }),
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
  const isArchived = p.status === "archived";

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="project-overview-root">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
          <p className="text-sm text-muted-foreground">
            <code>{p.slug}</code> · {p.status}
          </p>
          {p.description ? <p className="mt-2 max-w-prose">{p.description}</p> : null}
        </div>
        {!isArchived ? (
          <Button
            variant="outline"
            onClick={() => archive.mutate()}
            disabled={archive.isPending}
            data-testid="archive-button"
          >
            {archive.isPending ? "Archiving…" : "Archive"}
          </Button>
        ) : null}
      </header>

      <Card className="space-y-4 p-4">
        <h2 className="text-lg font-semibold">Settings</h2>
        <AiProviderPicker projectId={id} current={p.aiProviderId} />
        <AiModelPicker projectId={id} current={p.aiModel} />
        <PrimaryRepoCard projectId={id} />
        <InferenceProfileCard projectId={id} />
        <SafetySettingsCard projectId={id} current={p.safetyMode} />
        <BudgetSettingsCard projectId={id} current={p.monthlyTokenBudget} canEdit={canEditBudget} />
        <AutopilotSettingsCard
          projectId={id}
          enabled={p.autopilotEnabled}
          costCeilingCents={p.autopilotCostCeilingCents}
        />
        <DatabaseAwareAnalysisSettingsCard projectId={id} />
        <SqlLineageSettingsCard projectId={id} />
        <AgentsMdCard projectId={id} />
        <CustomAgentsEnablementCard projectId={id} />
        <p className="text-xs text-muted-foreground">
          <Link
            href={`/projects/${id}/settings/models`}
            className="underline"
            data-testid="model-settings-link"
          >
            Configure model preferences →
          </Link>
        </p>
      </Card>

      <QuarantinePanel projectId={id} />

      <ChroniclePanel projectId={id} />

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
