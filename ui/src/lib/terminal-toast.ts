"use client";

/**
 * Canonical terminal-toast utility — Issue #425 (Epic #406, terminal layer).
 *
 * Epic #406 added per-surface progress + terminal toasts (PR-review #421, scan
 * #422, embeddings/Spec Kit/overview #423, import/sync #424). Each surface only
 * toasts when its OWN detail page is mounted, so doc-gen / analysis jobs
 * still fail SILENTLY for a user merely watching a LIST view. #425
 * closes that gap with a single global `job:lifecycle` consumer (see
 * {@link useGlobalJobToasts}) — but that introduces a NEW hazard: a job whose
 * terminal event is observed by BOTH its detail surface AND the global layer
 * would toast twice.
 *
 * The per-hook `useRef` guard in `use-job-toast.ts` cannot prevent a cross-
 * component double-toast (each hook instance has its own ref). This module fixes
 * that with a process-wide, **module-level** dedup keyed by `jobId`: the FIRST
 * caller to report a job's terminal transition fires exactly one sonner toast;
 * every later caller for the same `jobId` is a no-op. This guarantees the #425
 * invariant — **exactly one terminal toast per op** — no matter which surface or
 * the global layer observes the event first.
 *
 * Error text never leaks: `failed` uses the event's `error`, which the server
 * already renders as a generic, user-safe string (`GENERIC_FAILURE_MESSAGE`,
 * #254 / OWASP — the bus never carries raw error/stack). `completed` uses the
 * event's human `message`, which preserves the Spec Kit grounded-completion line
 * ("Generated spec.md (v3) … grounded on 8 retrieved chunks.") verbatim.
 */
import { toast } from "sonner";
import type { JobLifecycleEvent, JobNotificationEvent } from "@metis/shared";
import { analystCopy } from "./analyst-copy";
import { safeInAppHref } from "./notifications";

/** Generic, user-safe fallbacks used when the event omits a message/error. */
export const GENERIC_SUCCESS_TOAST = "Done.";
export const GENERIC_FAILURE_TOAST = "The operation failed. Please try again.";

/**
 * Module-level dedup guard. A `jobId` is added the instant its terminal toast is
 * fired (or explicitly claimed), so any later observer of the same terminal
 * event — a sibling surface, the global layer, a socket re-delivery on reconnect
 * — skips it. Shared across every component/hook in the bundle, which the
 * per-instance `useRef` guard cannot achieve.
 */
const toastedJobIds = new Set<string>();

/**
 * #2343 — the sonner id of the toast each job fired, so the job's
 * `job:notification` (which names the change request or document and links to
 * it) can rewrite that toast in place instead of adding a second one.
 */
const toastIdByJob = new Map<string, string | number>();

/** #2343 — the `job:notification`s already shown, by saved row id. */
const seenNotifications = new Set<string>();

/**
 * #2343 — one toast per RUN of a job across TABS too. The module-level state
 * dedupes within one tab; two tabs of the same user each hear the job (the
 * project room in one, the personal `user:{id}` room in both), so the first
 * tab to toast claims the run in `localStorage`, which every tab of the origin
 * shares, and the others stay quiet.
 *
 * A document's id is the job id of every regeneration of it, so the claim
 * names the run, not the job: it holds the server time (`ts`) of the event
 * that was toasted, and whether that was the run's lifecycle end (`l`) or its
 * notification (`n`). A run's lifecycle end is emitted before its
 * notification, and a later run's events are later still, so a claim for an
 * earlier run never silences the next one.
 */
export const CROSS_TAB_CLAIM_PREFIX = "metis.jobToast.";
/** How long after a lifecycle toast in another tab its run's notification may follow. */
export const CROSS_TAB_CLAIM_TTL_MS = 10 * 60_000;

type ClaimBy = "l" | "n";

function readClaim(raw: string | null): { by: ClaimBy; ts: number } | null {
  const match = /^([ln]):(\d+)$/.exec(raw ?? "");
  return match ? { by: match[1] as ClaimBy, ts: Number(match[2]) } : null;
}

/** Whether another tab already toasted the run this event belongs to. */
function heldElsewhere(held: { by: ClaimBy; ts: number } | null, by: ClaimBy, ts: number): boolean {
  if (!held) return false;
  // This run's end or notification (or a later run's) was already toasted.
  if (by === "l") return held.ts >= ts;
  // This notification itself was already shown.
  if (held.by === "n") return held.ts >= ts;
  // This run's lifecycle end was toasted there; that tab rewrites it in place.
  return held.ts <= ts && ts - held.ts < CROSS_TAB_CLAIM_TTL_MS;
}

function claimAcrossTabs(jobId: string, by: ClaimBy, ts: number): boolean {
  try {
    const storage = window.localStorage;
    const key = `${CROSS_TAB_CLAIM_PREFIX}${jobId}`;
    if (heldElsewhere(readClaim(storage.getItem(key)), by, ts)) return false;
    storage.setItem(key, `${by}:${ts}`);
    return true;
  } catch {
    // No storage (private mode, a server render): this tab's own dedup only.
    return true;
  }
}

/** Record across tabs that this run's notification has been shown. */
function markAnnouncedAcrossTabs(jobId: string, ts: number): void {
  try {
    window.localStorage.setItem(`${CROSS_TAB_CLAIM_PREFIX}${jobId}`, `n:${ts}`);
  } catch {
    /* no storage */
  }
}

/**
 * #2343 — per job, the server time of the last `job:notification` this tab
 * handled. That notification ends a run: every lifecycle event up to it
 * belongs to a run already announced, and anything later is the next run (a
 * document regenerated), which toasts on its own.
 */
const announcedThrough = new Map<string, number>();

/** The run is over: the next one of this job starts with nothing of it. */
function endRun(jobId: string, ts: number): void {
  announcedThrough.set(jobId, ts);
  toastIdByJob.delete(jobId);
  toastTextByJob.delete(jobId);
}

/** Where a toast's "Open" goes. The header registers the app router (#2343). */
let navigate: (href: string) => void = (href) => {
  window.location.assign(href);
};

/** #2343 — route a toast's "Open" through the app router rather than a full load. */
export function setTerminalToastNavigator(fn: (href: string) => void): void {
  navigate = fn;
}

/**
 * #2343 — the text each job's lifecycle toast showed. A rewrite keeps it: a
 * failure's lifecycle text can be its specific, user-safe reason (#2369, "This
 * document type needs connected source code"), which the bell item's generic
 * line does not carry.
 */
const toastTextByJob = new Map<string, string>();

function remember(jobId: string, id: unknown, text?: string): void {
  if (typeof id === "string" || typeof id === "number") toastIdByJob.set(jobId, id);
  if (text) toastTextByJob.set(jobId, text);
}

/** Two lines as one description, each ending its sentence. */
function sentences(first: string, second: string): string {
  const a = first.trim();
  if (!a) return second;
  return `${/[.!?]$/.test(a) ? a : `${a}.`} ${second}`;
}

/**
 * #1580 — how old a REPLAYED terminal event may be and still toast. The server
 * replays a job's last event to a socket that joins its room late; the replay
 * exists for a job that finished inside the trigger's round-trip (seconds), so
 * anything older is a finished job being reopened, not one the user just ran.
 */
export const STALE_REPLAY_TOAST_MS = 60_000;

/** A server replay (`replayAgeMs` set) of an event older than {@link STALE_REPLAY_TOAST_MS}. */
export function isStaleReplay(event: Pick<JobLifecycleEvent, "replayAgeMs">): boolean {
  return typeof event.replayAgeMs === "number" && event.replayAgeMs > STALE_REPLAY_TOAST_MS;
}

/** A lifecycle phase that ends the job (drives the terminal toast). */
export function isTerminalJobStatus(status: JobLifecycleEvent["status"]): boolean {
  return status === "completed" || status === "failed";
}

/**
 * Pick the terminal toast kind + text for a job event.
 *
 * `completed` → the server's human `message` (the grounded-completion line for
 * Spec Kit, the symbol count for overview, the reindexed-chunk summary for
 * embeddings), falling back to a generic success label when absent; a warning
 * rather than a success when the event reports a non-zero `failureCount` (#432).
 * `failed` → the event's `error`, already a generic, user-safe string (#254),
 * falling back to a generic failure label. Exported for unit testing.
 */
export function terminalToastText(event: JobLifecycleEvent): {
  kind: "success" | "warning" | "error";
  text: string;
} {
  if (event.status === "failed") {
    return { kind: "error", text: analystCopy(event.error || GENERIC_FAILURE_TOAST) };
  }
  // #432 — a job that completed with failures (e.g. a partial Deep Ingest) is
  // not a success; it reports the count so this never parses the message.
  const kind = (event.failureCount ?? 0) > 0 ? "warning" : "success";
  // #2337 — server lines name the old controls ("Deep ingest complete: …").
  return { kind, text: analystCopy(event.message || GENERIC_SUCCESS_TOAST) };
}

/**
 * Fire the canonical terminal toast for a job EXACTLY ONCE, deduped by `jobId`
 * across the whole app. Safe to call from any surface hook AND the global layer:
 * whichever observes the terminal event first wins, the rest are no-ops.
 *
 * Non-terminal events (`started`/`progress`) and malformed events (no `jobId`)
 * are ignored. Returns `true` when this call actually fired a toast, `false`
 * when it was deduped/ignored — handy for tests and for callers that want to run
 * a side effect only on the canonical transition.
 */
export function fireTerminalToast(event: JobLifecycleEvent | null | undefined): boolean {
  if (!event || typeof event.jobId !== "string" || !event.jobId) return false;
  if (!isTerminalJobStatus(event.status)) return false;
  // #2343 — a job whose run was already announced: an event up to that
  // announcement is a re-delivery of it; a later one is the job's next run (a
  // document regenerated), which is news of its own.
  const through = announcedThrough.get(event.jobId);
  if (through !== undefined) {
    if (event.ts <= through) return false;
    announcedThrough.delete(event.jobId);
    toastedJobIds.delete(event.jobId);
  }
  if (toastedJobIds.has(event.jobId)) return false;
  toastedJobIds.add(event.jobId);
  // #1580 — a replay of an old terminal event is state, not news: a deep link
  // into a run that finished hours ago toasted "Analysis complete — 13
  // requirement(s) awaiting approval" long after the checkpoint was resolved.
  // The job is still marked, so a later re-delivery stays quiet too.
  if (isStaleReplay(event)) return false;
  if (!claimAcrossTabs(event.jobId, "l", event.ts)) return false;
  const { kind, text } = terminalToastText(event);
  if (kind === "success") remember(event.jobId, toast.success(text), text);
  else if (kind === "warning") remember(event.jobId, toast.warning(text), text);
  else remember(event.jobId, toast.error(text), text);
  return true;
}

/**
 * #2343 — the toast for a job the user started: its `job:notification` names
 * the change request or document, says how it ended in plain words, and links
 * to the result (or, after a failure, to where it can be run again).
 *
 * The same job may already have toasted from its `job:lifecycle` (the project
 * room usually delivers first): that toast is rewritten in place, so there is
 * still one. Otherwise this is the job's one toast, deduped by `jobId` in this
 * tab and across tabs exactly like {@link fireTerminalToast}. Returns whether a
 * toast was shown or rewritten.
 */
export function fireJobNotificationToast(event: JobNotificationEvent | null | undefined): boolean {
  if (!event || typeof event.jobId !== "string" || !event.jobId) return false;
  // A re-delivery of the same notification is not news.
  const seenKey = event.notificationId ?? `${event.jobId}:${event.kind}:${event.ts}`;
  if (seenNotifications.has(seenKey)) return false;
  seenNotifications.add(seenKey);
  const href = safeInAppHref(event.href);
  const options = {
    description: event.message,
    ...(href ? { action: { label: "Open", onClick: () => navigate(href) } } : {}),
  };
  const show =
    event.kind === "job_failed"
      ? toast.error
      : event.kind === "job_awaiting_review"
        ? toast.warning
        : toast.success;
  const through = announcedThrough.get(event.jobId);
  // An earlier notification of this job ended a run at or after this one.
  if (through !== undefined && event.ts <= through) return false;
  // This run already toasted here from its lifecycle end (no notification of
  // it handled yet): rewrite that toast in place.
  if (through === undefined && toastedJobIds.has(event.jobId)) {
    const id = toastIdByJob.get(event.jobId);
    // Keep what THIS run's lifecycle toast said (a failure's reason), then the
    // next step; the run's entries are dropped below, so a later run of the
    // same document never inherits them.
    const said = toastTextByJob.get(event.jobId);
    endRun(event.jobId, event.ts);
    if (id === undefined) return false;
    markAnnouncedAcrossTabs(event.jobId, event.ts);
    show(event.title, {
      ...options,
      description: said ? sentences(said, event.message) : event.message,
      id,
    });
    return true;
  }
  toastedJobIds.add(event.jobId);
  endRun(event.jobId, event.ts);
  if (!claimAcrossTabs(event.jobId, "n", event.ts)) return false;
  show(event.title, options);
  return true;
}

/**
 * Reserve a `jobId` so the global layer will NOT toast it, WITHOUT firing a
 * toast here. Used by surfaces that must build their own toast text from an
 * awaited HTTP response rather than the bus event — e.g. the overview regenerate
 * and Spec Kit command callbacks, whose pages are not in the job's socket room
 * when the terminal event fires, so the awaited response is the only reliable
 * source of the (grounded) success line. Marking the job claimed here keeps the
 * one-toast-per-op invariant if that page ever DOES sit in the project room.
 *
 * Returns `true` if this call claimed the job (caller should toast), `false` if
 * it was already claimed/fired (caller should stay silent).
 */
export function claimTerminalToast(jobId: string | null | undefined): boolean {
  if (!jobId) return false;
  if (toastedJobIds.has(jobId)) return false;
  toastedJobIds.add(jobId);
  return true;
}

/**
 * #1583 — give a claimed `jobId` back, so the global layer may toast it again.
 * For a surface that claimed a job while it watched it and stopped watching
 * before the end (the Spec Kit page, left mid-command): the job's outcome is
 * then nobody's to announce unless the claim is released.
 */
export function releaseTerminalToast(jobId: string | null | undefined): void {
  if (jobId) toastedJobIds.delete(jobId);
}

/**
 * Test-only reset so specs start from an empty dedup set. `keepStorage` keeps
 * the cross-tab claims, so a spec can stand in for a second tab.
 */
export function __resetTerminalToastsForTests(opts: { keepStorage?: boolean } = {}): void {
  toastedJobIds.clear();
  toastIdByJob.clear();
  toastTextByJob.clear();
  seenNotifications.clear();
  announcedThrough.clear();
  if (opts.keepStorage) return;
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(CROSS_TAB_CLAIM_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    /* no storage */
  }
}
