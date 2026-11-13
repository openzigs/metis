/**
 * Issue #2343 (epic #2328) — tell the person who started a long job that it
 * ended, wherever they are in the app.
 *
 * An analysis (a change request), a document generation or a document ingest
 * the user started ends in a bell row (`Notification`, persisted so an analyst
 * who was away finds it later) and a `job:notification` event to their personal
 * `user:{id}` room (a toast on whatever page they have open, a fresh tab
 * included). `job:lifecycle` reaches only the job and project rooms
 * (`socket/job-events.ts`), so before this an analyst away from the project
 * heard nothing (#2330).
 *
 * RULES
 * - Preference: gated on `inApp × jobFinished` (Settings → Notifications, on
 *   by default). `shouldNotify` fails open.
 * - Access (OWASP A01, #1447): the recipient must still be able to open the
 *   project when the row is written (`isEligibleAssignee`, the rule every
 *   writer uses; a lookup error sends nothing), and the row stores `projectId`
 *   so every read re-checks it (`applyNotificationAccess`).
 * - Content: the title quotes only the change request's or document's own
 *   name; the message is fixed text plus a count. No requirement text, no raw
 *   error (#254).
 * - Idempotent: a `dedupeKey` naming one run's outcome is stored on the row's
 *   payload; a second call for the same key (a retried completion, a sweep
 *   that records the same end again) writes and emits nothing.
 * - Never throws: every caller is a job's end path, which a notification
 *   failure must not change. {@link dispatchJobOutcome} is fire-and-forget.
 */
import {
  jobNotificationType,
  jobOutcomeHref,
  jobOutcomeMessage,
  jobOutcomeTitle,
  jobSubject,
  openQuestionCount,
  userRoom,
  type AnnouncedJobKind,
  type JobNotificationEvent,
  type JobOutcome,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";
import { isEligibleAssignee } from "../requirements/assignee-eligibility.js";
import { shouldNotify } from "./preferences.js";

const log = createChildLogger("notifications:job");

/** The preference cell every job outcome is gated on. */
export const JOB_FINISHED_PREFERENCE = "jobFinished" as const;

export interface JobOutcomeInput {
  kind: AnnouncedJobKind;
  /** The job's id: the analysis, generated document or document id. */
  jobId: string;
  projectId: string;
  /** Who started the job; nothing is sent without one. */
  userId: string | null | undefined;
  outcome: JobOutcome;
  /**
   * The change request's or document's name. For an analysis it is read from
   * the run when absent, with the run's open questions.
   */
  subject?: string | null;
  /**
   * Names this one run's outcome. Defaults to `kind:jobId:outcome`, right for
   * an analysis (one id per run); a document generation, whose id is reused by
   * every regeneration, passes its run's claim.
   */
  dedupeKey?: string;
}

/** What an analysis adds to its announcement: its title and open questions. */
async function analysisFacts(
  analysisId: string,
  projectId: string,
): Promise<{ title: string | null; openQuestions: number }> {
  const run = await prisma.analysis.findFirst({
    where: { id: analysisId, projectId },
    select: { title: true, metadata: true },
  });
  let metadata: unknown = null;
  try {
    metadata = run?.metadata ? JSON.parse(run.metadata) : null;
  } catch {
    metadata = null;
  }
  return { title: run?.title ?? null, openQuestions: openQuestionCount(metadata) ?? 0 };
}

/** The dedupe marker as it appears in the stored payload JSON. */
function dedupeNeedle(key: string): string {
  return JSON.stringify({ dedupeKey: key }).slice(1, -1);
}

/**
 * Persist the bell row and emit the toast event for one job outcome. Returns
 * the row id, or `null` when nothing was sent (no starter, preference off, no
 * access, already sent, or a failure, which is logged). Never throws.
 */
export async function notifyJobOutcome(input: JobOutcomeInput): Promise<string | null> {
  const { kind, jobId, projectId, outcome } = input;
  const userId = input.userId;
  if (!userId) return null;
  try {
    if (!(await shouldNotify(userId, "inApp", JOB_FINISHED_PREFERENCE))) return null;

    let eligible: boolean;
    try {
      eligible = await isEligibleAssignee(userId, projectId);
    } catch (err) {
      // Unknown is not "yes": never risk a project's names to someone who
      // may no longer open it.
      log.warn("job notification recipient check failed; not sent", { jobId, kind, err });
      return null;
    }
    if (!eligible) return null;

    const type = jobNotificationType(outcome);
    const dedupeKey = input.dedupeKey ?? `${kind}:${jobId}:${outcome}`;
    const already = await prisma.notification.findFirst({
      where: { userId, type, projectId, payload: { contains: dedupeNeedle(dedupeKey) } },
      select: { id: true },
    });
    if (already) return null;

    let subject = input.subject ?? null;
    let openQuestions = 0;
    if (kind === "analysis") {
      const facts = await analysisFacts(jobId, projectId);
      subject = subject ?? facts.title;
      // Counted only into a completion's message (`jobOutcomeMessage`).
      openQuestions = facts.openQuestions;
    }
    const name = jobSubject(subject);
    const title = jobOutcomeTitle(kind, outcome, name);
    const message = jobOutcomeMessage(kind, outcome, openQuestions);
    const href = jobOutcomeHref(kind, projectId, jobId, outcome);
    const ts = Date.now();

    const row = await prisma.notification.create({
      data: {
        userId,
        type: jobNotificationType(outcome),
        title,
        message,
        href,
        payload: JSON.stringify({ dedupeKey, jobKind: kind, jobId, outcome, ts }),
        // #1447 — every read re-checks the reader's access to this project.
        projectId,
      },
      select: { id: true },
    });

    const event: JobNotificationEvent = {
      notificationId: row.id,
      kind: type,
      jobKind: kind,
      jobId,
      projectId,
      subject: name,
      title,
      message,
      href,
      ts,
    };
    try {
      // Literal event name — the shared socket-contract guard scans for it.
      getSocketServer()?.to(userRoom(userId)).emit("job:notification", event);
    } catch (err) {
      log.warn("job notification emit failed", { jobId, kind, err });
    }
    return row.id;
  } catch (err) {
    log.warn("job notification failed", { jobId, kind, outcome, err });
    return null;
  }
}

/** Fire-and-forget {@link notifyJobOutcome}: nothing reaches the caller. */
export function dispatchJobOutcome(input: JobOutcomeInput): void {
  try {
    void notifyJobOutcome(input).catch((err: unknown) => {
      log.error("dispatchJobOutcome rejected", { jobId: input.jobId, err });
    });
  } catch (err) {
    log.error("dispatchJobOutcome synchronous failure", { jobId: input.jobId, err });
  }
}
