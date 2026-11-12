/**
 * #2348 — "My work" for Home: the caller's change requests that need them,
 * grouped by state, and the reviews waiting on the caller's decision.
 *
 * A change request is today's analysis run (epic #2328). Its state is derived
 * here from data that already exists, so Home, a sidebar count and a change
 * request's own header can read ONE derivation instead of three queries that
 * can disagree:
 *
 * - `waiting_on_me` — a completed run with open clarifying questions, counted
 *   by `openQuestionCount` (`@metis/shared`), the function the run's own
 *   Questions tab counts with. No run pauses for its questions (#2330, live):
 *   it completes with them open, and the analyst may never have opened the
 *   Questions tab, so the run's metadata decides, not a dialog row;
 * - otherwise the LATEST non-closed formal review covering any of its
 *   requirements decides: `in_review`, `rejected`, or `approved` →
 *   `ready_to_hand_off`. A review being revised (back in `draft`) lists the
 *   change request under nothing, as an older verdict no longer stands.
 *
 * Settled states leave Home (panel finding on PR #2365): a ready change
 * request leaves once any of its requirements is published as an issue (an
 * issue draft `published`, or a non-failed `PublishedIssue` row), and a
 * rejected or ready one leaves {@link SETTLED_STATE_MAX_AGE_DAYS} days after
 * its verdict.
 *
 * Access (OWASP A01): the caller comes from the session and every query is
 * filtered in the database on `startedById` / the caller's assignment AND the
 * project visibility rule (`workspaceScopeWhere`), plus `deletedAt: null` on
 * the project for admins, whom that rule does not constrain.
 */
import {
  openQuestionCount,
  type MyWorkChangeRequest,
  type MyWorkResponse,
  type MyWorkReview,
  type MyWorkState,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { workspaceScopeWhere, type ProjectScopeActor } from "../auth/project-scope.js";
import { awaitingDecisionWhere } from "../reviews/awaiting-decision.js";

/** Rows returned per list: Home shows what needs the caller, not an archive. */
export const MY_WORK_LIMIT = 100;

/**
 * Most recent reviews read to derive states. A bound on the work one request
 * does; a change request untouched behind this many newer ones is not what
 * Home is for.
 */
const SCAN_LIMIT = 500;

/**
 * Most recent clarification-enabled runs read for open questions. Each carries
 * its metadata JSON, so this bound is tighter than {@link SCAN_LIMIT}.
 */
const QUESTION_SCAN_LIMIT = 200;

/**
 * A rejected or ready-to-hand-off change request is listed this many days
 * after its verdict, then leaves Home. Neither state ends on its own: a
 * rejection someone abandoned, or an approval handed off by a route METIS does
 * not record (a copy-paste, a document export), would otherwise stay forever.
 */
export const SETTLED_STATE_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Review statuses that can decide a change request's state. */
const DECIDING_REVIEW_STATUSES = ["draft", "in_review", "rejected", "approved"] as const;

/** Audit actions that put a review into `in_review` (`review-service.ts`). */
const SUBMIT_ACTIONS = ["review.submit", "review.reopen"] as const;

/**
 * Prefilter for runs that asked for clarification. Run metadata is written by
 * `JSON.stringify` (`persistAnalysisEnhancement`), so the flag appears exactly
 * like this; `openQuestionCount` then reads the parsed object.
 */
const CLARIFICATION_FLAG = '"enableClarification":true';

export interface ReviewSignal {
  id: string;
  status: string;
  updatedAt: Date;
  decidedAt: Date | null;
  /** When the review last entered `in_review` (its submit or re-review). */
  submittedAt?: Date | null;
}

export interface DerivedState {
  state: MyWorkState;
  since: Date;
  openQuestions?: number;
  reviewId?: string;
}

/**
 * The state a change request is listed under, or `null` when nothing about it
 * needs the caller. Questions waiting outrank any review state: the analyst
 * owes an answer before the review means anything.
 */
export function deriveChangeRequestState(input: {
  openQuestions: number;
  questionsSince: Date | null;
  reviews: ReviewSignal[];
  /** Any of its requirements published as an issue: handed off. */
  handedOff?: boolean;
  now?: Date;
}): DerivedState | null {
  if (input.openQuestions > 0 && input.questionsSince) {
    return {
      state: "waiting_on_me",
      since: input.questionsSince,
      openQuestions: input.openQuestions,
    };
  }
  const latest = [...input.reviews].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  )[0];
  if (!latest) return null;
  const decided = latest.decidedAt ?? latest.updatedAt;
  const now = input.now ?? new Date();
  const settledTooLong = now.getTime() - decided.getTime() > SETTLED_STATE_MAX_AGE_DAYS * DAY_MS;
  switch (latest.status) {
    case "in_review":
      return {
        state: "in_review",
        since: latest.submittedAt ?? latest.updatedAt,
        reviewId: latest.id,
      };
    case "rejected":
      return settledTooLong ? null : { state: "rejected", since: decided, reviewId: latest.id };
    case "approved":
      return settledTooLong || input.handedOff
        ? null
        : { state: "ready_to_hand_off", since: decided, reviewId: latest.id };
    default:
      return null;
  }
}

/**
 * A readable title until change requests carry their own (#2341): the first
 * source document's file name, else the first imported item's title, else the
 * run's start date.
 */
export function changeRequestTitle(
  metadata: string | null,
  documentNames: ReadonlyMap<string, string>,
  createdAt: Date,
): string {
  let meta: { documentIds?: unknown; sourceRequirements?: unknown } = {};
  try {
    meta = metadata ? (JSON.parse(metadata) as typeof meta) : {};
  } catch {
    meta = {};
  }
  const docIds = Array.isArray(meta.documentIds)
    ? meta.documentIds.filter((id): id is string => typeof id === "string")
    : [];
  const named = docIds.map((id) => documentNames.get(id)).filter((n): n is string => !!n);
  if (named.length > 0) {
    return named.length === 1 ? named[0] : `${named[0]} and ${named.length - 1} more`;
  }
  const items = Array.isArray(meta.sourceRequirements) ? meta.sourceRequirements : [];
  const first = items[0] as { title?: unknown } | undefined;
  if (first && typeof first.title === "string" && first.title.trim() !== "") {
    return first.title.trim();
  }
  return `Analysis of ${createdAt.toISOString().slice(0, 10)}`;
}

/** Open questions on a run, from its raw metadata JSON (0 when unreadable). */
export function runOpenQuestions(metadata: string | null): number {
  let parsed: unknown;
  try {
    parsed = metadata ? JSON.parse(metadata) : null;
  } catch {
    return 0;
  }
  return openQuestionCount(parsed) ?? 0;
}

/** The projects `actor` may open, live ones only (admins included). */
function projectScope(actor: ProjectScopeActor) {
  return { ...workspaceScopeWhere(actor), deletedAt: null };
}

export async function getMyWork(
  actor: ProjectScopeActor,
  now: Date = new Date(),
): Promise<MyWorkResponse> {
  const project = projectScope(actor);
  const mine = { startedById: actor.userId, deletedAt: null, project };
  const liveRequirementOfMine = { deletedAt: null, analysis: mine };

  const [questionRuns, reviews, assignedReviews, projectCount] = await Promise.all([
    prisma.analysis.findMany({
      where: { ...mine, status: "completed", metadata: { contains: CLARIFICATION_FLAG } },
      orderBy: { createdAt: "desc" },
      take: QUESTION_SCAN_LIMIT,
      select: {
        id: true,
        metadata: true,
        completedAt: true,
        updatedAt: true,
        clarificationDialog: { select: { updatedAt: true } },
      },
    }),
    prisma.reviewRequest.findMany({
      where: {
        status: { in: [...DECIDING_REVIEW_STATUSES] },
        project,
        items: { some: { requirement: { is: liveRequirementOfMine } } },
      },
      orderBy: { updatedAt: "desc" },
      take: SCAN_LIMIT,
      select: {
        id: true,
        status: true,
        updatedAt: true,
        decidedAt: true,
        items: {
          where: { requirement: { is: liveRequirementOfMine } },
          select: { requirement: { select: { analysisId: true } } },
        },
      },
    }),
    prisma.reviewRequest.findMany({
      where: awaitingDecisionWhere(actor.userId, project),
      orderBy: { updatedAt: "desc" },
      take: MY_WORK_LIMIT,
      select: {
        id: true,
        title: true,
        projectId: true,
        updatedAt: true,
        project: { select: { name: true } },
        requestedBy: { select: { displayName: true, username: true } },
        assignments: { where: { reviewerId: actor.userId }, select: { updatedAt: true } },
      },
    }),
    prisma.project.count({ where: project }),
  ]);

  const openByRun = new Map<string, { count: number; since: Date }>();
  for (const run of questionRuns) {
    const count = runOpenQuestions(run.metadata);
    if (count <= 0) continue;
    // Since the analyst last answered, else since the run finished.
    const since = run.clarificationDialog?.updatedAt ?? run.completedAt ?? run.updatedAt;
    openByRun.set(run.id, { count, since });
  }

  const submittedAt = await loadSubmittedAt(
    reviews.filter((r) => r.status === "in_review").map((r) => r.id),
  );
  const reviewsByRun = new Map<string, ReviewSignal[]>();
  for (const review of reviews) {
    const signal: ReviewSignal = {
      id: review.id,
      status: review.status,
      updatedAt: review.updatedAt,
      decidedAt: review.decidedAt,
      submittedAt: submittedAt.get(review.id) ?? null,
    };
    const runIds = new Set(review.items.map((i) => i.requirement?.analysisId).filter(Boolean));
    for (const runId of runIds as Set<string>) {
      const list = reviewsByRun.get(runId) ?? [];
      list.push(signal);
      reviewsByRun.set(runId, list);
    }
  }

  const handedOff = await loadHandedOffRuns(
    [...reviewsByRun.keys()].filter((id) => !openByRun.has(id)),
  );

  const derived = new Map<string, DerivedState>();
  for (const runId of new Set([...openByRun.keys(), ...reviewsByRun.keys()])) {
    const open = openByRun.get(runId);
    const state = deriveChangeRequestState({
      openQuestions: open?.count ?? 0,
      questionsSince: open?.since ?? null,
      reviews: reviewsByRun.get(runId) ?? [],
      handedOff: handedOff.has(runId),
      now,
    });
    if (state) derived.set(runId, state);
  }

  const runIds = [...derived.entries()]
    .sort((a, b) => b[1].since.getTime() - a[1].since.getTime())
    .slice(0, MY_WORK_LIMIT)
    .map(([id]) => id);
  const runs =
    runIds.length === 0
      ? []
      : await prisma.analysis.findMany({
          // `mine` again: the ids came from this caller's rows, but the read
          // that returns titles and project names re-applies the scope.
          where: { ...mine, id: { in: runIds } },
          select: {
            id: true,
            projectId: true,
            metadata: true,
            createdAt: true,
            project: { select: { name: true } },
          },
        });

  const documentNames = await loadDocumentNames(runs);
  const changeRequests: MyWorkChangeRequest[] = runs
    .map((run) => {
      const d = derived.get(run.id)!;
      return {
        id: run.id,
        title: changeRequestTitle(run.metadata, documentNames, run.createdAt),
        projectId: run.projectId,
        projectName: run.project.name,
        state: d.state,
        since: d.since.toISOString(),
        ...(d.openQuestions !== undefined ? { openQuestions: d.openQuestions } : {}),
        ...(d.reviewId !== undefined ? { reviewId: d.reviewId } : {}),
      };
    })
    .sort((a, b) => b.since.localeCompare(a.since));

  const assigned: MyWorkReview[] = assignedReviews
    .map((r) => ({
      id: r.id,
      title: r.title,
      projectId: r.projectId,
      projectName: r.project.name,
      requestedBy: r.requestedBy.displayName || r.requestedBy.username,
      // The assignment is reset to pending on every (re-)submit: when the
      // caller was asked to decide.
      since: (r.assignments[0]?.updatedAt ?? r.updatedAt).toISOString(),
    }))
    .sort((a, b) => b.since.localeCompare(a.since));

  return { changeRequests, reviews: assigned, projectCount };
}

/**
 * When each review last entered `in_review`: its latest submit or re-review
 * in the audit log. `ReviewRequest.updatedAt` moves on any edit, so it is only
 * the fallback.
 */
async function loadSubmittedAt(reviewIds: string[]): Promise<Map<string, Date>> {
  if (reviewIds.length === 0) return new Map();
  const rows = await prisma.auditLog.findMany({
    where: {
      targetType: "review_request",
      targetId: { in: reviewIds },
      action: { in: [...SUBMIT_ACTIONS] },
    },
    orderBy: { ts: "desc" },
    select: { targetId: true, ts: true },
  });
  const latest = new Map<string, Date>();
  for (const row of rows) if (!latest.has(row.targetId)) latest.set(row.targetId, row.ts);
  return latest;
}

/** Runs with a live requirement published as an issue (GitHub or Jira). */
async function loadHandedOffRuns(runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await prisma.requirement.findMany({
    where: {
      analysisId: { in: runIds },
      deletedAt: null,
      drafts: {
        some: {
          deletedAt: null,
          OR: [
            { status: "published" },
            { publishedIssues: { some: { status: { not: "failed" } } } },
          ],
        },
      },
    },
    select: { analysisId: true },
  });
  return new Set(rows.map((r) => r.analysisId));
}

/** File names of the runs' source documents, from each run's own project only. */
async function loadDocumentNames(
  runs: Array<{ projectId: string; metadata: string | null }>,
): Promise<Map<string, string>> {
  const wanted = new Map<string, string>(); // documentId -> projectId
  for (const run of runs) {
    try {
      const ids = (JSON.parse(run.metadata ?? "{}") as { documentIds?: unknown }).documentIds;
      if (Array.isArray(ids)) {
        for (const id of ids) if (typeof id === "string") wanted.set(id, run.projectId);
      }
    } catch {
      // Unreadable metadata: the title falls back to the next source.
    }
  }
  if (wanted.size === 0) return new Map();
  const docs = await prisma.document.findMany({
    where: { id: { in: [...wanted.keys()] }, deletedAt: null },
    select: { id: true, filename: true, projectId: true },
  });
  return new Map(
    docs.filter((d) => wanted.get(d.id) === d.projectId).map((d) => [d.id, d.filename]),
  );
}
