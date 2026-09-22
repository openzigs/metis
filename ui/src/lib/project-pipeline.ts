/**
 * #29 (epic #26) — the project Overview's pipeline model.
 *
 * Pure derivations from facts the existing endpoints already return: the repo
 * and database connectors, the document list, the analyses list plus the latest
 * completed analysis's requirements, the generated docs, and the publish
 * batches. No new endpoint is involved. `ProjectPipelineOverview` gathers the
 * facts; this module decides what each stage says and where its action goes.
 */

export type PipelineStageId = "sources" | "ingest" | "analyze" | "review" | "docs" | "publish";

/** `attention` = something failed or is waiting on the user. */
export type PipelineStageState = "todo" | "running" | "done" | "attention";

export interface PipelineStage {
  id: PipelineStageId;
  title: string;
  state: PipelineStageState;
  /** One line describing where this stage stands. */
  status: string;
  /** The stage's primary action, deep-linked to where it is done. */
  action: { label: string; href: string };
}

type DateLike = string | Date;

export interface PipelineFacts {
  repos: Array<{ status: string; lastIngestAt?: DateLike | null }>;
  databases: number;
  /**
   * One page of `GET /documents` (newest first, at most 100) — `total` is
   * exact, `items` may be partial. Counts taken from a partial page are lower
   * bounds and are only ever reported as such.
   */
  documents: { total: number; items: Array<{ status: string; chunkCount: number }> };
  /** A live `connector:progress` ingest is in flight — see {@link isIngestRunning}. */
  ingestInProgress: boolean;
  /** Newest first, as `GET /projects/:id/analyses` returns them. */
  analyses: Array<{
    id: string;
    status: string;
    startedAt: DateLike;
    completedAt: DateLike | null;
  }>;
  /** Draft requirements in the latest completed analysis; null while unknown. */
  awaitingReview: number | null;
  docs: Array<{ status: string }>;
  /**
   * Newest first, as `GET /publishing/batches` returns them; `null` when the
   * user may not read them (the route needs `issue.preview`, which `reader`
   * lacks), so the stage never claims "nothing published" it cannot know.
   */
  batches: Array<{
    status: string;
    dryRun: boolean;
    publishedCount: number;
    totalDrafts: number;
    startedAt: DateLike;
    completedAt: DateLike | null;
  }> | null;
}

/**
 * The `connector:progress` phases that are an ingest. The server also emits
 * `test`, `metadata` and `introspect` progress with no `current`/`total`, and
 * `useConnectorProgress` clears an entry only on an error or when
 * `current >= total` — so those entries never clear, and counting them left the
 * Ingest stage on "Ingesting…" for good (review of #63).
 */
const INGEST_PHASES = new Set(["ingest", "deep-ingest"]);

/** Whether any connector in the `useConnectorProgress` map is ingesting. */
export function isIngestRunning(progressMap: Record<string, { phase: string }>): boolean {
  return Object.values(progressMap).some((p) => INGEST_PHASES.has(p.phase));
}

/** The numbered first-run checklist: connect → ingest → analyse → review → publish. */
export const FIRST_RUN_STEPS: readonly PipelineStageId[] = [
  "sources",
  "ingest",
  "analyze",
  "review",
  "publish",
];

const RUNNING_DOC_STATUSES = new Set(["pending", "queued", "processing"]);
const RUNNING_GENERATED_DOC_STATUSES = new Set(["pending", "generating"]);
const RUNNING_JOB_STATUSES = new Set(["pending", "running"]);

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : pluralForm}`;
}

function when(value: DateLike): string {
  return new Date(value).toLocaleString();
}

function latestTime(values: Array<DateLike | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const v of values) {
    if (!v) continue;
    const d = new Date(v);
    if (!best || d > best) best = d;
  }
  return best;
}

function sourcesStage(base: string, f: PipelineFacts): PipelineStage {
  const parts: string[] = [];
  if (f.repos.length) parts.push(plural(f.repos.length, "repository", "repositories"));
  if (f.databases) parts.push(plural(f.databases, "database"));
  if (f.documents.total) parts.push(plural(f.documents.total, "document"));
  const href = `${base}/connections`;
  if (parts.length === 0) {
    return {
      id: "sources",
      title: "Connect sources",
      state: "todo",
      status: "No sources connected yet",
      action: { label: "Connect a source", href },
    };
  }
  const errored = f.repos.filter((r) => r.status === "error").length;
  return {
    id: "sources",
    title: "Connect sources",
    state: errored ? "attention" : "done",
    status: errored
      ? `${parts.join(" · ")} — ${errored === 1 ? "1 connection has" : `${errored} connections have`} an error`
      : parts.join(" · "),
    action: { label: "Manage sources", href },
  };
}

function ingestStage(base: string, f: PipelineFacts): PipelineStage {
  const action = { label: "Ingest", href: `${base}/connections` };
  const items = f.documents.items;
  // Every document is on this page, so counts over `items` are the project's.
  const complete = items.length >= f.documents.total;
  const atLeast = complete ? "" : "at least ";
  const processing = items.filter((d) => RUNNING_DOC_STATUSES.has(d.status)).length;
  const failed = items.filter((d) => d.status === "failed").length;
  const ready = items.filter((d) => d.status === "ready");
  const lastRepoIngest = latestTime(f.repos.map((r) => r.lastIngestAt));

  if (f.ingestInProgress || processing > 0) {
    return {
      id: "ingest",
      title: "Ingest",
      state: "running",
      status:
        processing > 0
          ? `Ingesting — ${atLeast}${plural(processing, "document")} processing`
          : "Ingesting…",
      action,
    };
  }

  const parts: string[] = [];
  if (complete) {
    if (ready.length) {
      parts.push(`${plural(ready.length, "document")} ready`);
      parts.push(
        plural(
          ready.reduce((n, d) => n + d.chunkCount, 0),
          "chunk",
        ),
      );
    }
  } else {
    // A ready count or chunk total from one page would understate the project.
    parts.push(plural(f.documents.total, "document"));
  }
  if (lastRepoIngest) parts.push(`repository last ingested ${when(lastRepoIngest)}`);
  if (failed) parts.push(`${atLeast}${plural(failed, "document")} failed`);

  if (parts.length === 0) {
    return { id: "ingest", title: "Ingest", state: "todo", status: "Nothing ingested yet", action };
  }
  return {
    id: "ingest",
    title: "Ingest",
    state: failed ? "attention" : "done",
    status: parts.join(" · "),
    action,
  };
}

function analyzeStage(base: string, f: PipelineFacts): PipelineStage {
  const latest = f.analyses[0];
  const run = { label: "Run analysis", href: `${base}/analysis` };
  if (!latest) {
    return {
      id: "analyze",
      title: "Analyze",
      state: "todo",
      status: "No analysis yet",
      action: run,
    };
  }
  if (RUNNING_JOB_STATUSES.has(latest.status)) {
    return {
      id: "analyze",
      title: "Analyze",
      state: "running",
      status: `Analysis running since ${when(latest.startedAt)}`,
      action: {
        label: "View progress",
        href: `${base}/analysis?analysisId=${encodeURIComponent(latest.id)}`,
      },
    };
  }
  if (latest.status === "completed") {
    return {
      id: "analyze",
      title: "Analyze",
      state: "done",
      status: `Last analysis completed ${when(latest.completedAt ?? latest.startedAt)}`,
      action: run,
    };
  }
  return {
    id: "analyze",
    title: "Analyze",
    state: "attention",
    status: `Last analysis ${latest.status} (${when(latest.startedAt)})`,
    action: run,
  };
}

/** The analysis whose requirements are up for review: the newest completed one. */
export function latestCompletedAnalysisId(f: Pick<PipelineFacts, "analyses">): string | null {
  return f.analyses.find((a) => a.status === "completed")?.id ?? null;
}

function reviewStage(base: string, f: PipelineFacts): PipelineStage {
  const hub = `${base}/requirements`;
  const analysisId = latestCompletedAnalysisId(f);
  if (!analysisId) {
    return {
      id: "review",
      title: "Review requirements",
      state: "todo",
      status: "Run an analysis to produce requirements",
      action: { label: "Open requirements", href: hub },
    };
  }
  if (f.awaitingReview === null) {
    return {
      id: "review",
      title: "Review requirements",
      state: "todo",
      status: "Checking requirements…",
      action: { label: "Open requirements", href: hub },
    };
  }
  if (f.awaitingReview > 0) {
    return {
      id: "review",
      title: "Review requirements",
      state: "attention",
      status: `${plural(f.awaitingReview, "requirement")} awaiting review`,
      action: {
        label: `Review ${plural(f.awaitingReview, "requirement")}`,
        href: `${base}/analysis?analysisId=${encodeURIComponent(analysisId)}`,
      },
    };
  }
  return {
    id: "review",
    title: "Review requirements",
    state: "done",
    status: "All requirements reviewed",
    action: { label: "Open requirements", href: hub },
  };
}

function docsStage(base: string, f: PipelineFacts): PipelineStage {
  const action = { label: "Generate docs", href: `${base}/documentation` };
  const generating = f.docs.filter((d) => RUNNING_GENERATED_DOC_STATUSES.has(d.status)).length;
  const failed = f.docs.filter((d) => d.status === "failed").length;
  if (generating > 0) {
    return {
      id: "docs",
      title: "Documentation",
      state: "running",
      status: `Generating ${plural(generating, "document")}`,
      action: { label: "View progress", href: action.href },
    };
  }
  if (f.docs.length === 0) {
    return {
      id: "docs",
      title: "Documentation",
      state: "todo",
      status: "No documentation generated",
      action,
    };
  }
  return {
    id: "docs",
    title: "Documentation",
    state: failed ? "attention" : "done",
    status: failed
      ? `${plural(f.docs.length, "document")} — ${failed} failed`
      : `${plural(f.docs.length, "document")} generated`,
    action: { label: "Open docs", href: action.href },
  };
}

function publishStage(base: string, f: PipelineFacts): PipelineStage {
  const action = { label: "Publish issues", href: `${base}/publish` };
  if (f.batches === null) {
    return {
      id: "publish",
      title: "Publish",
      state: "todo",
      status: "Publish history is not available to your role",
      action,
    };
  }
  const latest = f.batches[0];
  if (!latest) {
    return {
      id: "publish",
      title: "Publish",
      state: "todo",
      status: "Nothing published yet",
      action,
    };
  }
  const kind = latest.dryRun ? " (dry run)" : "";
  if (RUNNING_JOB_STATUSES.has(latest.status)) {
    return {
      id: "publish",
      title: "Publish",
      state: "running",
      status: `Publishing${kind} — started ${when(latest.startedAt)}`,
      action,
    };
  }
  const counts = `${latest.publishedCount} of ${latest.totalDrafts} published`;
  if (latest.status === "completed") {
    return {
      id: "publish",
      title: "Publish",
      state: "done",
      status: `Last publish${kind} completed ${when(latest.completedAt ?? latest.startedAt)} · ${counts}`,
      action,
    };
  }
  return {
    id: "publish",
    title: "Publish",
    state: "attention",
    status: `Last publish ${latest.status}${kind} · ${counts}`,
    action,
  };
}

/** Every stage, in pipeline order, with its state and primary action. */
export function derivePipelineStages(projectId: string, facts: PipelineFacts): PipelineStage[] {
  const base = `/projects/${projectId}`;
  return [
    sourcesStage(base, facts),
    ingestStage(base, facts),
    analyzeStage(base, facts),
    reviewStage(base, facts),
    docsStage(base, facts),
    publishStage(base, facts),
  ];
}

/**
 * A project is on its first run until it has an analysis or a publish — the
 * checklist keeps guiding through connect and ingest, which are the steps a new
 * user is least likely to find on their own.
 */
export function isFirstRun(facts: PipelineFacts): boolean {
  return facts.analyses.length === 0 && (facts.batches ?? []).length === 0;
}
