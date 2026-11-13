/**
 * #29 (epic #26) — the project Overview's pipeline model.
 *
 * Pure derivations from facts the existing endpoints already return: the repo
 * and database connectors, the document list, the analyses list plus the latest
 * completed analysis's requirements, the generated docs, and the publish
 * batches. No new endpoint is involved. `ProjectPipelineOverview` gathers the
 * facts; this module decides what each stage says and where its action goes.
 *
 * #2349 — the stages read as the analyst's job, as one checklist:
 * Add knowledge → Ready: ask a question → New change request → Review →
 * Deliverable, then Publish, which is optional. The ids are the original
 * pipeline's (`sources` is "Add knowledge", `ingest` is "Ready: ask a question",
 * `analyze` is "New change request", `docs` is "Deliverable"); they stay because
 * deep links, test ids and the drift badge are keyed on them.
 */
import { openQuestionCount } from "@metis/shared";

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
  /** A second thing waiting in this stage, when there is one. */
  secondaryAction?: { label: string; href: string };
  /** #2349 — shown, but never holds the checklist at incomplete (Publish). */
  optional?: true;
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
  documents: {
    total: number;
    items: Array<{ status: string; chunkCount: number; indexState?: string | null }>;
  };
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
  /**
   * #2367 — that analysis's approval checkpoints still pending (`ticketStatus`
   * of `GET /approvals`); null while unknown, `"unreadable"` when the read
   * failed. Pending approvals are not requirements yet, so `awaitingReview`
   * alone read 0 and the stage said "All requirements reviewed".
   */
  pendingApprovals: number | null | "unreadable";
  /**
   * #2367 — its clarifying questions still open, as the Questions tab counts
   * them. #2376 — `"unreadable"` when structured extraction failed, so there
   * are no questions to count (#1081); see {@link openQuestionsFact}.
   */
  openQuestions: number | "unreadable";
  /** #2367 — its requirements a reviewer rejected. */
  rejectedRequirements: number;
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
 * `test`, `metadata` and `introspect` progress with no `current`/`total`; those
 * are not an ingest, and counting them left the Ingest stage on "Ingesting…"
 * (review of #63). `useConnectorProgress` now also clears such an entry after
 * a few idle seconds (#762).
 */
const INGEST_PHASES = new Set(["ingest", "deep-ingest"]);

/** Whether any connector in the `useConnectorProgress` map is ingesting. */
export function isIngestRunning(progressMap: Record<string, { phase: string }>): boolean {
  return Object.values(progressMap).some((p) => INGEST_PHASES.has(p.phase));
}

/**
 * #273 — an active-jobs store entry that is a Deep Ingest of this project. The
 * New-project wizard puts its job there before navigating, because the job's
 * `started` event went out before the Overview joined the project's room.
 */
export function isProjectRepoIngestJob(
  job: { kind: string; projectId: string | null },
  projectId: string,
): boolean {
  return job.kind === "repo-ingest" && job.projectId === projectId;
}

/**
 * #2349 — where "New change request" starts: the Change requests tab's run
 * page, whose start form takes document uploads (it opens by itself on a
 * project with no runs yet). The one place to repoint when that intake moves.
 */
export function newChangeRequestHref(projectId: string): string {
  return `/projects/${projectId}/analysis`;
}

/** Where the Overview's knowledge search is, to ask a question of what was ingested. */
export const KNOWLEDGE_SEARCH_ANCHOR = "knowledge-search";

const RUNNING_DOC_STATUSES = new Set(["pending", "queued", "processing"]);

/**
 * #66 — a document held in quarantine: processed and chunked, waiting for a
 * reviewer. It keeps `status = processing` (the documents list and the
 * approve/reject flow read it that way), so status alone reads as ingesting.
 */
export function isDocumentAwaitingReview(d: { indexState?: string | null }): boolean {
  return d.indexState === "quarantined";
}

/** A document that is still being ingested — not one only waiting for review. */
export function isDocumentIngesting(d: { status: string; indexState?: string | null }): boolean {
  return RUNNING_DOC_STATUSES.has(d.status) && !isDocumentAwaitingReview(d);
}

/** Where quarantined documents are approved or rejected. */
export function quarantineHref(projectId: string): string {
  return `/projects/${projectId}/settings#quarantine`;
}
// #867 — `cancelling` is still running: the run is winding down and will
// record its final state, so the view keeps reading it as live.
const RUNNING_GENERATED_DOC_STATUSES = new Set(["pending", "generating", "cancelling"]);

/** A generated document whose generation has not reached a final state yet. */
export function isGeneratedDocRunning(d: { status: string }): boolean {
  return RUNNING_GENERATED_DOC_STATUSES.has(d.status);
}
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

/** #2349 — the checklist's wording, in the analyst's terms. */
const TITLE: Record<PipelineStageId, string> = {
  sources: "Add knowledge",
  ingest: "Ready: ask a question",
  analyze: "New change request",
  review: "Review",
  docs: "Deliverable",
  publish: "Publish",
};

function sourcesStage(base: string, f: PipelineFacts): PipelineStage {
  const parts: string[] = [];
  if (f.repos.length) parts.push(plural(f.repos.length, "repository", "repositories"));
  if (f.databases) parts.push(plural(f.databases, "database"));
  if (f.documents.total) parts.push(plural(f.documents.total, "document"));
  const href = `${base}/connections`;
  if (parts.length === 0) {
    return {
      id: "sources",
      title: TITLE.sources,
      state: "todo",
      status: "No documents, repositories or databases yet",
      action: { label: "Add knowledge", href },
    };
  }
  const errored = f.repos.filter((r) => r.status === "error").length;
  return {
    id: "sources",
    title: TITLE.sources,
    state: errored ? "attention" : "done",
    status: errored
      ? `${parts.join(" · ")} — ${errored === 1 ? "1 connection has" : `${errored} connections have`} an error`
      : parts.join(" · "),
    action: { label: "Manage knowledge", href },
  };
}

function ingestStage(base: string, f: PipelineFacts): PipelineStage {
  const action = { label: "Ingest", href: `${base}/connections` };
  const items = f.documents.items;
  // Every document is on this page, so counts over `items` are the project's.
  const complete = items.length >= f.documents.total;
  const atLeast = complete ? "" : "at least ";
  const processing = items.filter(isDocumentIngesting).length;
  const awaitingReview = items.filter(isDocumentAwaitingReview).length;
  const failed = items.filter((d) => d.status === "failed").length;
  const ready = items.filter((d) => d.status === "ready");
  const lastRepoIngest = latestTime(f.repos.map((r) => r.lastIngestAt));

  if (f.ingestInProgress || processing > 0) {
    return {
      id: "ingest",
      title: TITLE.ingest,
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
          // #2337 — "chunks" is system jargon.
          "section indexed",
          "sections indexed",
        ),
      );
    }
  } else {
    // A ready count or chunk total from one page would understate the project.
    parts.push(plural(f.documents.total, "document"));
  }
  if (lastRepoIngest) parts.push(`repository last ingested ${when(lastRepoIngest)}`);
  if (awaitingReview) parts.push(`${atLeast}${plural(awaitingReview, "document")} awaiting review`);
  if (failed) parts.push(`${atLeast}${plural(failed, "document")} failed`);

  if (parts.length === 0) {
    return {
      id: "ingest",
      title: TITLE.ingest,
      state: "todo",
      status: "Nothing ingested yet",
      action,
    };
  }
  if (failed) {
    return {
      id: "ingest",
      title: TITLE.ingest,
      state: "attention",
      status: parts.join(" · "),
      action,
    };
  }
  // #2349 — once something is ingested, the step's action is the question itself.
  return {
    id: "ingest",
    title: TITLE.ingest,
    state: "done",
    status: parts.join(" · "),
    action: { label: "Ask a question", href: `${base}#${KNOWLEDGE_SEARCH_ANCHOR}` },
  };
}

function analyzeStage(projectId: string, f: PipelineFacts): PipelineStage {
  const base = `/projects/${projectId}`;
  const latest = f.analyses[0];
  const run = { label: "New change request", href: newChangeRequestHref(projectId) };
  if (!latest) {
    return {
      id: "analyze",
      title: TITLE.analyze,
      state: "todo",
      status: "No change request yet",
      action: run,
    };
  }
  if (RUNNING_JOB_STATUSES.has(latest.status)) {
    return {
      id: "analyze",
      title: TITLE.analyze,
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
      title: TITLE.analyze,
      state: "done",
      status: `Last analysis completed ${when(latest.completedAt ?? latest.startedAt)}`,
      action: run,
    };
  }
  return {
    id: "analyze",
    title: TITLE.analyze,
    state: "attention",
    status: `Last analysis ${latest.status} (${when(latest.startedAt)})`,
    action: run,
  };
}

/**
 * #2376 — the open-question fact for a run's metadata. `openQuestionCount`
 * answers `undefined` both when the run asked nothing (clarification off) and
 * when structured extraction failed (#1081); only the first is "none open".
 * A failed extraction prepared no questions or approval checkpoints, whatever
 * the clarification setting, so it is `"unreadable"`.
 */
export function openQuestionsFact(metadata: unknown): number | "unreadable" {
  const failed =
    !!metadata &&
    typeof metadata === "object" &&
    !!(metadata as { structuredExtractionFailure?: unknown }).structuredExtractionFailure;
  if (failed) return "unreadable";
  return openQuestionCount(metadata) ?? 0;
}

/** The analysis whose requirements are up for review: the newest completed one. */
export function latestCompletedAnalysisId(f: Pick<PipelineFacts, "analyses">): string | null {
  return f.analyses.find((a) => a.status === "completed")?.id ?? null;
}

function requirementsReview(base: string, f: PipelineFacts): PipelineStage {
  const hub = `${base}/requirements`;
  const analysisId = latestCompletedAnalysisId(f);
  const checking: PipelineStage = {
    id: "review",
    title: TITLE.review,
    state: "todo",
    status: "Checking requirements…",
    action: { label: "Open requirements", href: hub },
  };
  if (!analysisId) {
    return { ...checking, status: "Start a change request to produce requirements" };
  }
  if (f.awaitingReview === null) return checking;
  // #2376 — wait for the approvals too: naming the Requirements or Questions
  // action first, then switching to "Resolve N approvals", read as a flicker.
  if (f.pendingApprovals === null) return checking;

  const run = `${base}/analysis?analysisId=${encodeURIComponent(analysisId)}`;
  // #2367 — everything in this run still waiting on a person, most blocking
  // first: the first is the stage's action, and the status names them all.
  const waiting: Array<{ status: string; action: { label: string; href: string } }> = [];
  if (f.awaitingReview > 0) {
    waiting.push({
      status: `${plural(f.awaitingReview, "requirement")} awaiting review`,
      action: { label: `Review ${plural(f.awaitingReview, "requirement")}`, href: run },
    });
  }
  if (typeof f.pendingApprovals === "number" && f.pendingApprovals > 0) {
    waiting.push({
      status: `${plural(f.pendingApprovals, "approval")} pending`,
      action: {
        label: `Resolve ${plural(f.pendingApprovals, "approval")}`,
        href: `${run}&tab=approvals`,
      },
    });
  }
  if (f.openQuestions === "unreadable") {
    waiting.push({
      status: "Clarifying questions could not be prepared",
      action: { label: "See why", href: `${run}&tab=questions` },
    });
  } else if (f.openQuestions > 0) {
    waiting.push({
      status: `${plural(f.openQuestions, "clarifying question")} open`,
      action: {
        label: `Answer ${plural(f.openQuestions, "question")}`,
        href: `${run}&tab=questions`,
      },
    });
  }
  if (f.rejectedRequirements > 0) {
    waiting.push({
      status: `${plural(f.rejectedRequirements, "requirement")} rejected`,
      action: {
        label: `Revisit ${plural(f.rejectedRequirements, "rejected requirement")}`,
        href: `${run}&tab=requirements`,
      },
    });
  }
  if (waiting.length > 0) {
    return {
      id: "review",
      title: TITLE.review,
      state: "attention",
      status: waiting.map((w) => w.status).join(" · "),
      action: waiting[0].action,
    };
  }
  if (f.pendingApprovals === "unreadable") {
    // A failed read must not pass for "nothing pending".
    return {
      id: "review",
      title: TITLE.review,
      state: "attention",
      status: "Could not check this run's approvals",
      action: { label: "Open approvals", href: `${run}&tab=approvals` },
    };
  }
  return {
    id: "review",
    title: TITLE.review,
    state: "done",
    status: "All requirements reviewed",
    action: { label: "Open requirements", href: hub },
  };
}

/**
 * #66 — quarantined documents wait on a reviewer too. They join the Review
 * stage, linked to the quarantine queue, alongside the requirements.
 */
function reviewStage(base: string, projectId: string, f: PipelineFacts): PipelineStage {
  const stage = requirementsReview(base, f);
  const items = f.documents.items;
  const quarantined = items.filter(isDocumentAwaitingReview).length;
  if (quarantined === 0) return stage;
  const atLeast = items.length >= f.documents.total ? "" : "at least ";
  const quarantine = {
    label: `Review ${plural(quarantined, "quarantined document")}`,
    href: quarantineHref(projectId),
  };
  const requirementsWaiting = stage.state === "attention";
  return {
    ...stage,
    state: "attention",
    status: `${stage.status} · ${atLeast}${plural(quarantined, "document")} awaiting review in quarantine`,
    action: requirementsWaiting ? stage.action : quarantine,
    secondaryAction: requirementsWaiting ? quarantine : stage.action,
  };
}

function docsStage(base: string, f: PipelineFacts): PipelineStage {
  const action = { label: "Generate a deliverable", href: `${base}/documentation` };
  const generating = f.docs.filter(isGeneratedDocRunning).length;
  const failed = f.docs.filter((d) => d.status === "failed").length;
  if (generating > 0) {
    return {
      id: "docs",
      title: TITLE.docs,
      state: "running",
      status: `Generating ${plural(generating, "document")}`,
      action: { label: "View progress", href: action.href },
    };
  }
  if (f.docs.length === 0) {
    return {
      id: "docs",
      title: TITLE.docs,
      state: "todo",
      status: "No deliverable generated yet",
      action,
    };
  }
  return {
    id: "docs",
    title: TITLE.docs,
    state: failed ? "attention" : "done",
    status: failed
      ? `${plural(f.docs.length, "document")} — ${failed} failed`
      : `${plural(f.docs.length, "document")} generated`,
    action: { label: "Open deliverables", href: action.href },
  };
}

function publishStage(base: string, f: PipelineFacts): PipelineStage {
  const action = { label: "Publish issues", href: `${base}/publish` };
  if (f.batches === null) {
    return {
      id: "publish",
      title: TITLE.publish,
      state: "todo",
      status: "Publish history is not available to your role",
      action,
    };
  }
  const latest = f.batches[0];
  if (!latest) {
    return {
      id: "publish",
      title: TITLE.publish,
      state: "todo",
      status: "Nothing published yet",
      action,
    };
  }
  const kind = latest.dryRun ? " (dry run)" : "";
  if (RUNNING_JOB_STATUSES.has(latest.status)) {
    return {
      id: "publish",
      title: TITLE.publish,
      state: "running",
      status: `Publishing${kind} — started ${when(latest.startedAt)}`,
      action,
    };
  }
  const counts = `${latest.publishedCount} of ${latest.totalDrafts} published`;
  if (latest.status === "completed") {
    return {
      id: "publish",
      title: TITLE.publish,
      state: "done",
      status: `Last publish${kind} completed ${when(latest.completedAt ?? latest.startedAt)} · ${counts}`,
      action,
    };
  }
  return {
    id: "publish",
    title: TITLE.publish,
    state: "attention",
    status: `Last publish ${latest.status}${kind} · ${counts}`,
    action,
  };
}

/** Every stage, in checklist order, with its state and primary action. */
export function derivePipelineStages(projectId: string, facts: PipelineFacts): PipelineStage[] {
  const base = `/projects/${projectId}`;
  return [
    sourcesStage(base, facts),
    ingestStage(base, facts),
    analyzeStage(projectId, facts),
    reviewStage(base, projectId, facts),
    docsStage(base, facts),
    // #2349 — not every analyst publishes issues; a deliverable is the job's end.
    { ...publishStage(base, facts), optional: true },
  ];
}

/**
 * #2349 — the checklist is complete when every step but the optional ones is
 * done. Each state comes from the project's existing data, so a project that
 * already did the work reads as done the first time this checklist shows it.
 */
export function isChecklistComplete(stages: readonly PipelineStage[]): boolean {
  return stages.every((s) => s.optional || s.state === "done");
}
