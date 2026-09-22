"use client";

/**
 * #29 (epic #26) — the project Overview: where each pipeline stage stands and
 * the one thing to do next in it. A brand-new project gets a numbered first-run
 * checklist instead, each step deep-linked to the page where it is done.
 *
 * Every fact comes from an existing read endpoint (see `lib/project-pipeline`).
 * Status stays live two ways: socket pushes (`job:lifecycle` invalidates the
 * analyses and generated-docs lists; `connector:progress` marks an ingest
 * running) and, as the degraded fallback, polling while anything is running.
 */
import { useEffect, useRef } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle, Circle, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { analysisApi } from "@/lib/analysis-api";
import { dbConnectorsApi, repoConnectorsApi } from "@/lib/connectors-api";
import { documentsApi } from "@/lib/projects-api";
import { publishingApi } from "@/lib/publishing-api";
import { queryKeys } from "@/lib/query-keys";
import { useProjectJobEvents } from "@/hooks/use-job-events";
import { useConnectorProgress } from "@/hooks/use-connector-events";
import { useAuth } from "@/lib/auth-context";
import {
  FIRST_RUN_STEPS,
  derivePipelineStages,
  isDocumentIngesting,
  isFirstRun,
  isIngestRunning,
  latestCompletedAnalysisId,
  type PipelineFacts,
  type PipelineStage,
  type PipelineStageState,
} from "@/lib/project-pipeline";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Fallback poll cadence while a stage is running and the socket may be down. */
const LIVE_POLL_MS = 5_000;

/** `GET /documents` caps a page at 100; the Overview reads the newest page. */
const DOCUMENT_PAGE = 100;

const STATE_LABEL: Record<PipelineStageState, string> = {
  todo: "Not started",
  running: "In progress",
  done: "Done",
  attention: "Needs attention",
};

function StateIcon({ state }: { state: PipelineStageState }) {
  const cls = "h-4 w-4 shrink-0";
  if (state === "done") return <CheckCircle2 className={cn(cls, "text-emerald-500")} aria-hidden />;
  if (state === "running")
    return <Loader2 className={cn(cls, "text-blue-500 motion-safe:animate-spin")} aria-hidden />;
  if (state === "attention")
    return <AlertTriangle className={cn(cls, "text-amber-500")} aria-hidden />;
  return <Circle className={cn(cls, "text-muted-foreground")} aria-hidden />;
}

function StageStatus({ stage }: { stage: PipelineStage }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <StateIcon state={stage.state} />
      <span>
        <span className="sr-only">{STATE_LABEL[stage.state]}: </span>
        <span data-testid={`pipeline-status-${stage.id}`}>{stage.status}</span>
      </span>
    </p>
  );
}

function StageAction({ stage }: { stage: PipelineStage }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm" variant={stage.state === "done" ? "outline" : "default"}>
        <Link href={stage.action.href} data-testid={`pipeline-action-${stage.id}`}>
          {stage.action.label}
        </Link>
      </Button>
      {stage.secondaryAction ? (
        <Button asChild size="sm" variant="outline">
          <Link
            href={stage.secondaryAction.href}
            data-testid={`pipeline-secondary-action-${stage.id}`}
          >
            {stage.secondaryAction.label}
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

export function ProjectPipelineOverview({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  // `GET /publishing/batches` needs `issue.preview`, which `reader` lacks.
  const canReadBatches = user?.permissions.includes("issue.preview") ?? false;
  useProjectJobEvents(projectId);
  const { progressMap } = useConnectorProgress(projectId);
  const ingestInProgress = isIngestRunning(progressMap);

  const repos = useQuery({
    queryKey: ["connectors", "repos", projectId],
    queryFn: () => repoConnectorsApi.list(projectId),
  });
  const dbs = useQuery({
    queryKey: ["connectors", "dbs", projectId],
    queryFn: () => dbConnectorsApi.list(projectId),
  });
  const documents = useQuery({
    // Its own key under the project's prefix: the Documents page caches a
    // 25-row page at `forProject`, and invalidating `forProject` still hits this.
    queryKey: [...queryKeys.documents.forProject(projectId), "pipeline"],
    queryFn: () => documentsApi.list(projectId, { limit: DOCUMENT_PAGE }),
    refetchInterval: (q) =>
      // #66 — a quarantined document is waiting for review, not ingesting.
      q.state.data?.items.some(isDocumentIngesting) ? LIVE_POLL_MS : false,
  });
  const analyses = useQuery({
    queryKey: queryKeys.analyses.forProject(projectId),
    queryFn: () => analysisApi.listForProject(projectId),
    refetchInterval: (q) =>
      ["pending", "running"].includes(q.state.data?.items[0]?.status ?? "") ? LIVE_POLL_MS : false,
  });
  const docs = useQuery({
    queryKey: queryKeys.generatedDocs.forProject(projectId),
    queryFn: () => apiFetch<Array<{ status: string }>>(`/projects/${projectId}/docs`),
    refetchInterval: (q) =>
      q.state.data?.some((d) => d.status === "pending" || d.status === "generating")
        ? LIVE_POLL_MS
        : false,
  });
  const batches = useQuery({
    queryKey: ["publishing", "batches", projectId],
    queryFn: () => publishingApi.listBatches(projectId),
    enabled: canReadBatches,
    refetchInterval: (q) =>
      ["pending", "running"].includes(q.state.data?.[0]?.status ?? "") ? LIVE_POLL_MS : false,
  });

  const analysisItems = analyses.data?.items ?? [];
  const reviewId = latestCompletedAnalysisId({ analyses: analysisItems });
  const review = useQuery({
    queryKey: queryKeys.analyses.detail(reviewId ?? ""),
    queryFn: () => analysisApi.get(reviewId as string),
    enabled: Boolean(reviewId),
  });

  // When a live ingest finishes, re-read what it wrote: the connector's
  // `lastIngestAt` and the document list. Without this the stage would drop
  // back from "Ingesting" to whatever was cached before the run.
  const wasIngesting = useRef(false);
  useEffect(() => {
    if (wasIngesting.current && !ingestInProgress) {
      void qc.invalidateQueries({ queryKey: ["connectors", "repos", projectId] });
      void qc.invalidateQueries({ queryKey: queryKeys.documents.forProject(projectId) });
    }
    wasIngesting.current = ingestInProgress;
  }, [ingestInProgress, projectId, qc]);

  const core = [repos, dbs, documents, analyses, docs, batches];
  if (core.some((q) => q.isLoading)) {
    return (
      <p role="status" className="text-sm text-muted-foreground" data-testid="pipeline-loading">
        Loading project status…
      </p>
    );
  }

  const facts: PipelineFacts = {
    repos: repos.data ?? [],
    databases: dbs.data?.length ?? 0,
    documents: documents.data ?? { total: 0, items: [] },
    ingestInProgress,
    analyses: analysisItems,
    awaitingReview: review.data
      ? review.data.requirements.filter((r) => r.reviewStatus === "draft").length
      : null,
    docs: docs.data ?? [],
    batches: canReadBatches ? (batches.data ?? []) : null,
  };
  const stages = derivePipelineStages(projectId, facts);
  const partial = core.some((q) => q.isError);

  return (
    <section
      aria-labelledby="pipeline-heading"
      className="space-y-4"
      data-testid="project-pipeline"
    >
      {partial ? (
        <p role="alert" className="text-sm text-destructive" data-testid="pipeline-partial">
          Some stages could not be loaded; their status may be incomplete.
        </p>
      ) : null}
      {isFirstRun(facts) ? <FirstRunChecklist stages={stages} /> : <StageGrid stages={stages} />}
      <p className="text-sm text-muted-foreground">
        The code summary lives under Code:{" "}
        <Link
          href={`/projects/${projectId}/overview`}
          className="underline"
          data-testid="pipeline-code-overview-link"
        >
          Code Overview
        </Link>
        .
      </p>
    </section>
  );
}

function FirstRunChecklist({ stages }: { stages: PipelineStage[] }) {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const steps = FIRST_RUN_STEPS.map((id) => byId.get(id) as PipelineStage);
  return (
    <Card className="space-y-3 p-4" data-testid="first-run-checklist">
      <div>
        <h2 id="pipeline-heading" className="text-lg font-semibold">
          Get started
        </h2>
        <p className="text-sm text-muted-foreground">
          Five steps take a project from empty to published issues.
        </p>
      </div>
      <ol className="space-y-3">
        {steps.map((stage, i) => (
          <li
            key={stage.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            data-testid={`first-run-step-${stage.id}`}
          >
            <div className="space-y-1">
              <h3 className="font-medium">
                <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                {stage.title}
              </h3>
              <StageStatus stage={stage} />
            </div>
            <StageAction stage={stage} />
          </li>
        ))}
      </ol>
    </Card>
  );
}

function StageGrid({ stages }: { stages: PipelineStage[] }) {
  return (
    <div className="space-y-3">
      <h2 id="pipeline-heading" className="text-lg font-semibold">
        Pipeline
      </h2>
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {stages.map((stage) => (
          <li key={stage.id} data-testid={`pipeline-stage-${stage.id}`}>
            <Card className="flex h-full flex-col justify-between gap-3 p-4">
              <div className="space-y-1">
                <h3 className="font-medium">{stage.title}</h3>
                <StageStatus stage={stage} />
              </div>
              <div>
                <StageAction stage={stage} />
              </div>
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}
