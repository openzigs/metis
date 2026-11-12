/**
 * #2348 — "My work" for Home: the caller's change requests that need them,
 * grouped by state, and the reviews waiting on the caller's decision.
 *
 * A change request is today's analysis run (epic #2328). Its state is derived
 * here from data that already exists, so Home, a sidebar count and a change
 * request's own header can read ONE derivation instead of three queries that
 * can disagree:
 *
 * - `waiting_on_me` — its clarification dialog is not complete and the current
 *   round has questions with no answer ({@link countOpenQuestions});
 * - otherwise the LATEST non-closed formal review covering any of its
 *   requirements decides: `in_review`, `rejected`, or `approved` →
 *   `ready_to_hand_off`. A review being revised (back in `draft`) lists the
 *   change request under nothing, as an older verdict no longer stands.
 *
 * Access (OWASP A01): the caller comes from the session and every query is
 * filtered in the database on `startedById` / `reviewerId` AND the project
 * visibility rule (`workspaceScopeWhere`), plus `deletedAt: null` on the
 * project for admins, whom that rule does not constrain.
 */
import type { MyWorkChangeRequest, MyWorkResponse, MyWorkReview, MyWorkState } from "@metis/shared";
import { prisma } from "../prisma.js";
import { workspaceScopeWhere, type ProjectScopeActor } from "../auth/project-scope.js";

/** Rows returned per list: Home shows what needs the caller, not an archive. */
export const MY_WORK_LIMIT = 100;

/**
 * Most recent dialogs / reviews read to derive states. A bound on the work one
 * request does; a change request untouched behind this many newer ones is not
 * what Home is for.
 */
const SCAN_LIMIT = 500;

/** Review statuses that can decide a change request's state. */
const DECIDING_REVIEW_STATUSES = ["draft", "in_review", "rejected", "approved"] as const;

interface QuestionRound {
  questions?: Array<{ id?: unknown }>;
  answers?: Array<{ questionId?: unknown; answer?: unknown }>;
}

/**
 * Unanswered questions in a persisted clarification dialog
 * (`ClarificationDialogState.state`, a JSON `ClarificationState`): 0 once the
 * dialog is complete, otherwise the current round's questions with no
 * non-blank answer. Unreadable state counts as nothing waiting.
 */
export function countOpenQuestions(rawState: string): number {
  let state: { completed?: unknown; rounds?: unknown };
  try {
    state = JSON.parse(rawState) as typeof state;
  } catch {
    return 0;
  }
  if (!state || typeof state !== "object" || state.completed === true) return 0;
  if (!Array.isArray(state.rounds) || state.rounds.length === 0) return 0;
  const round = state.rounds[state.rounds.length - 1] as QuestionRound;
  const answered = new Set(
    (round.answers ?? [])
      .filter((a) => typeof a.answer === "string" && a.answer.trim() !== "")
      .map((a) => a.questionId),
  );
  return (round.questions ?? []).filter((q) => !answered.has(q.id)).length;
}

export interface ReviewSignal {
  id: string;
  status: string;
  updatedAt: Date;
  decidedAt: Date | null;
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
  const since = latest.decidedAt ?? latest.updatedAt;
  switch (latest.status) {
    case "in_review":
      return { state: "in_review", since: latest.updatedAt, reviewId: latest.id };
    case "rejected":
      return { state: "rejected", since, reviewId: latest.id };
    case "approved":
      return { state: "ready_to_hand_off", since, reviewId: latest.id };
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

/** The projects `actor` may open, live ones only (admins included). */
function projectScope(actor: ProjectScopeActor) {
  return { ...workspaceScopeWhere(actor), deletedAt: null };
}

/**
 * Reviews waiting on `actor`'s decision: assigned to them, still pending, in a
 * review that is `in_review`, in a project they can open. Exported so any
 * other count of "reviews assigned to me" (the sidebar, #2332) uses the same
 * predicate as Home.
 */
export function assignedReviewWhere(actor: ProjectScopeActor) {
  return {
    reviewerId: actor.userId,
    decision: "pending",
    reviewRequest: { status: "in_review", project: projectScope(actor) },
  };
}

export async function getMyWork(actor: ProjectScopeActor): Promise<MyWorkResponse> {
  const project = projectScope(actor);
  const mine = { startedById: actor.userId, deletedAt: null, project };

  const [dialogs, reviews, assignments, projectCount] = await Promise.all([
    prisma.analysis.findMany({
      where: { ...mine, clarificationDialog: { isNot: null } },
      orderBy: { clarificationDialog: { updatedAt: "desc" } },
      take: SCAN_LIMIT,
      select: { id: true, clarificationDialog: { select: { state: true, updatedAt: true } } },
    }),
    prisma.reviewRequest.findMany({
      where: {
        status: { in: [...DECIDING_REVIEW_STATUSES] },
        project,
        items: { some: { requirement: { is: { deletedAt: null, analysis: mine } } } },
      },
      orderBy: { updatedAt: "desc" },
      take: SCAN_LIMIT,
      select: {
        id: true,
        status: true,
        updatedAt: true,
        decidedAt: true,
        items: {
          where: { requirement: { is: { deletedAt: null, analysis: mine } } },
          select: { requirement: { select: { analysisId: true } } },
        },
      },
    }),
    prisma.reviewerAssignment.findMany({
      where: assignedReviewWhere(actor),
      orderBy: { updatedAt: "desc" },
      take: MY_WORK_LIMIT,
      select: {
        updatedAt: true,
        reviewRequest: {
          select: {
            id: true,
            title: true,
            projectId: true,
            project: { select: { name: true } },
            requestedBy: { select: { displayName: true, username: true } },
          },
        },
      },
    }),
    prisma.project.count({ where: project }),
  ]);

  const openByRun = new Map<string, { count: number; since: Date }>();
  for (const run of dialogs) {
    const dialog = run.clarificationDialog;
    if (!dialog) continue;
    const count = countOpenQuestions(dialog.state);
    if (count > 0) openByRun.set(run.id, { count, since: dialog.updatedAt });
  }
  const reviewsByRun = new Map<string, ReviewSignal[]>();
  for (const review of reviews) {
    const runIds = new Set(review.items.map((i) => i.requirement?.analysisId).filter(Boolean));
    for (const runId of runIds as Set<string>) {
      const list = reviewsByRun.get(runId) ?? [];
      list.push(review);
      reviewsByRun.set(runId, list);
    }
  }

  const derived = new Map<string, DerivedState>();
  for (const runId of new Set([...openByRun.keys(), ...reviewsByRun.keys()])) {
    const open = openByRun.get(runId);
    const state = deriveChangeRequestState({
      openQuestions: open?.count ?? 0,
      questionsSince: open?.since ?? null,
      reviews: reviewsByRun.get(runId) ?? [],
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

  const assigned: MyWorkReview[] = assignments.map((a) => ({
    id: a.reviewRequest.id,
    title: a.reviewRequest.title,
    projectId: a.reviewRequest.projectId,
    projectName: a.reviewRequest.project.name,
    requestedBy: a.reviewRequest.requestedBy.displayName || a.reviewRequest.requestedBy.username,
    since: a.updatedAt.toISOString(),
  }));

  return { changeRequests, reviews: assigned, projectCount };
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
