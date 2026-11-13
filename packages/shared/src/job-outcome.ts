/**
 * Issue #2343 (epic #2328) — telling the analyst that a long job finished, and
 * where its result is.
 *
 * Three jobs end with something the analyst is waiting for: an analysis (a
 * change request), a generated document and an ingested document. When one of
 * them ends, the person who started it gets a toast and a bell item that name
 * it and link to the result (or, after a failure, to where it can be run
 * again). The server builds the bell item (`server/src/lib/notifications/
 * job-notify.ts`) and the UI builds the toast (`ui/src/lib/terminal-toast.ts`)
 * from the functions here, so the two say the same thing and land on the same
 * page.
 *
 * Every link is a relative in-app path built from ids only; every title quotes
 * at most the change request's or document's own name, never requirement text
 * (#2343, OWASP A01).
 */

/** The jobs whose end is announced to the person who started them. */
export const ANNOUNCED_JOB_KINDS = ["analysis", "doc-generation", "document-ingest"] as const;

export type AnnouncedJobKind = (typeof ANNOUNCED_JOB_KINDS)[number];

/**
 * How an announced job ended. `awaiting-review` is an ingest whose document
 * is held in quarantine until someone approves it: finished, but still
 * waiting on a person (#2330).
 */
export type JobOutcome = "completed" | "failed" | "awaiting-review";

/** The `Notification.type` a job outcome is stored under. */
export type JobNotificationType = "job_completed" | "job_failed" | "job_awaiting_review";

export function isAnnouncedJobKind(kind: unknown): kind is AnnouncedJobKind {
  return typeof kind === "string" && (ANNOUNCED_JOB_KINDS as readonly string[]).includes(kind);
}

export function jobNotificationType(outcome: JobOutcome): JobNotificationType {
  if (outcome === "failed") return "job_failed";
  if (outcome === "awaiting-review") return "job_awaiting_review";
  return "job_completed";
}

/**
 * Where the result of a job is. A failed job lands where it can be run again,
 * which for all three kinds is the same page as its result: the change
 * request (its error, and the start form), the document (Regenerate), the
 * documents list (upload again).
 * A document held in quarantine lands on the quarantine queue.
 */
export function jobOutcomeHref(
  kind: AnnouncedJobKind,
  projectId: string,
  jobId: string,
  outcome: JobOutcome,
): string {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  if (kind === "analysis") return `${base}/analysis?analysisId=${encodeURIComponent(jobId)}`;
  if (kind === "doc-generation") return `${base}/documentation?doc=${encodeURIComponent(jobId)}`;
  if (outcome === "awaiting-review") return `${base}/settings#quarantine`;
  return `${base}/documents`;
}

/** Longest name quoted in a title; a longer one is cut with an ellipsis. */
export const JOB_SUBJECT_MAX = 80;

/**
 * A change request's or document's name, made safe to quote in one line:
 * control characters become spaces, runs of whitespace collapse, and a long
 * name is cut on a code-point boundary (never through an emoji).
 */
export function jobSubject(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const flat = name
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  const points = Array.from(flat);
  return points.length <= JOB_SUBJECT_MAX
    ? flat
    : `${points.slice(0, JOB_SUBJECT_MAX - 1).join("")}…`;
}

const NOUN: Record<AnnouncedJobKind, string> = {
  analysis: "Change request",
  "doc-generation": "Document",
  "document-ingest": "Document",
};

/**
 * One line saying which job ended and how, in plain words:
 * `Change request "Checkout redesign" is ready`, `Document "Spec" failed to
 * generate`. Without a name, the kind alone (`Your change request is ready`).
 */
export function jobOutcomeTitle(
  kind: AnnouncedJobKind,
  outcome: JobOutcome,
  subject: string | null | undefined,
): string {
  const name = jobSubject(subject);
  const what = name ? `${NOUN[kind]} "${name}"` : `Your ${NOUN[kind].toLowerCase()}`;
  if (outcome === "failed") {
    if (kind === "analysis") return `${what} failed`;
    if (kind === "doc-generation") return `${what} failed to generate`;
    return `${what} could not be read`;
  }
  if (outcome === "awaiting-review") return `${what} is waiting for review`;
  if (kind === "document-ingest") return `${what} is ready to use`;
  return `${what} is ready`;
}

/** `Questions waiting (3)`: the one wording every surface uses for open questions. */
export function questionsWaitingLabel(count: number): string {
  return `Questions waiting (${count})`;
}

/**
 * The bell item's second line: what to do next. Never quotes requirement text.
 * `openQuestions` is the change request's open clarifying questions, when it
 * completed with some.
 */
export function jobOutcomeMessage(
  kind: AnnouncedJobKind,
  outcome: JobOutcome,
  openQuestions = 0,
): string {
  if (outcome === "failed") {
    if (kind === "analysis")
      return "The analysis failed. Open the change request to see why and start it again.";
    if (kind === "doc-generation")
      return "The document could not be generated. Open it to regenerate.";
    return "The document could not be read. Open Documents to upload it again.";
  }
  if (outcome === "awaiting-review") return "It is held in quarantine until someone approves it.";
  if (kind === "analysis") {
    return openQuestions > 0
      ? `${questionsWaitingLabel(openQuestions)}: open the change request to answer them.`
      : "Open the change request to review its requirements.";
  }
  if (kind === "doc-generation") return "Open the document to read it.";
  return "It is indexed and can be searched.";
}
