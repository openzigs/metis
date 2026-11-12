"use client";

/**
 * #29 (epic #26) — the project Overview: where each pipeline stage stands and
 * the one thing to do next in it.
 *
 * #2349 — one numbered checklist for every project, new or not, in the
 * analyst's terms: Add knowledge → Ready: ask a question → New change request →
 * Review → Deliverable, with Publish shown as optional. Each step's action names
 * the project tab it opens, as the tab bar names it (`project-tabs.tsx`).
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
import { useActiveJobs, useFollowJobs } from "@/hooks/use-active-jobs";
import { useProjectDriftCount } from "@/hooks/use-drift-count";
import { useAuth } from "@/lib/auth-context";
import {
  derivePipelineStages,
  isChecklistComplete,
  isDocumentIngesting,
  isGeneratedDocRunning,
  isIngestRunning,
  isProjectRepoIngestJob,
  latestCompletedAnalysisId,
  type PipelineFacts,
  type PipelineStage,
  type PipelineStageId,
  type PipelineStageState,
} from "@/lib/project-pipeline";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DriftBadge } from "@/components/sync/drift-badge";
import { getProjectTabModel, resolveActiveProjectTab } from "@/components/projects/project-tabs";
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
  if (state === "done") return <CheckCircle2 className={cn(cls, "text-success")} aria-hidden />;
  if (state === "running")
    return <Loader2 className={cn(cls, "text-info motion-safe:animate-spin")} aria-hidden />;
  if (state === "attention")
    return <AlertTriangle className={cn(cls, "text-warning")} aria-hidden />;
  return <Circle className={cn(cls, "text-muted-foreground")} aria-hidden />;
}

/**
 * #78 — the pending-drift count, rendered beside the stage it belongs to.
 * `DriftBadge` was in the tree but imported by nothing, so drift detected by the
 * sync reconciler was invisible unless an operator already knew to open
 * `/projects/:id/sync`. Publish is the stage that produced the external issues
 * drift is measured against, so that is where it goes.
 */
const DRIFT_STAGE: PipelineStageId = "publish";

/**
 * #113 — the badge sits BESIDE the `<h3>`, not inside it: inside, its accessible
 * name became part of the heading's ("Publish View 3 pending drift events"), so
 * heading navigation read a control's label as the stage name.
 */
function StageHeading({
  stage,
  projectId,
  driftCount,
  prefix,
}: {
  stage: PipelineStage;
  projectId: string;
  driftCount: number;
  prefix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <h3 className="font-medium">
        {prefix ? <span className="mr-2 text-muted-foreground">{prefix}</span> : null}
        {stage.title}
        {stage.optional ? " (optional)" : null}
      </h3>
      {stage.id === DRIFT_STAGE ? <DriftBadge projectId={projectId} count={driftCount} /> : null}
    </div>
  );
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

/**
 * #2349 — the tab a link opens, by the tab bar's own name for it, so the
 * checklist's wording can never drift from the tabs (#2334 renames them).
 */
function projectTabNameFor(projectId: string, href: string): string | null {
  const path = href.split(/[?#]/)[0];
  return resolveActiveProjectTab(path, getProjectTabModel(projectId))?.section.label ?? null;
}

function StageAction({ stage, projectId }: { stage: PipelineStage; projectId: string }) {
  const tab = projectTabNameFor(projectId, stage.action.href);
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
      {tab ? (
        <span className="text-xs text-muted-foreground" data-testid={`pipeline-tab-${stage.id}`}>
          in {tab}
        </span>
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
  // #78 — surfaces the pending-drift count here rather than only on /sync.
  const driftCount = useProjectDriftCount(projectId);
  const { progressMap } = useConnectorProgress(projectId);
  // #273 — a Deep Ingest started before this page mounted (the New-project
  // wizard's) is known only to the shared active-jobs store.
  const activeJobs = useActiveJobs();
  const repoIngestJobIds = activeJobs
    .filter((j) => isProjectRepoIngestJob(j, projectId))
    .map((j) => j.jobId);
  useFollowJobs(repoIngestJobIds);
  const ingestInProgress = isIngestRunning(progressMap) || repoIngestJobIds.length > 0;

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
    refetchInterval: (q) => (q.state.data?.some(isGeneratedDocRunning) ? LIVE_POLL_MS : false),
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
      <ProjectChecklist stages={stages} projectId={projectId} driftCount={driftCount} />
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

function ProjectChecklist({
  stages,
  projectId,
  driftCount,
}: {
  stages: PipelineStage[];
  projectId: string;
  driftCount: number;
}) {
  const required = stages.filter((s) => !s.optional);
  const done = required.filter((s) => s.state === "done").length;
  const complete = isChecklistComplete(stages);
  return (
    <Card className="space-y-3 p-4" data-testid="project-checklist">
      <div>
        <h2 id="pipeline-heading" className="text-lg font-semibold">
          {complete ? "Every step done" : "Get started"}
        </h2>
        <p className="text-sm text-muted-foreground" data-testid="checklist-progress">
          {done} of {required.length} steps done. Publishing is optional.
        </p>
      </div>
      <ol className="space-y-3">
        {stages.map((stage) => (
          <li
            key={stage.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            data-testid={`pipeline-stage-${stage.id}`}
          >
            <div className="space-y-1">
              <StageHeading
                stage={stage}
                projectId={projectId}
                driftCount={driftCount}
                prefix={stage.optional ? undefined : `${required.indexOf(stage) + 1}.`}
              />
              <StageStatus stage={stage} />
            </div>
            <StageAction stage={stage} projectId={projectId} />
          </li>
        ))}
      </ol>
    </Card>
  );
}
