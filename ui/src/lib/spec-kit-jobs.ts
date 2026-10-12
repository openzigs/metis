/**
 * #1059 — running a Spec Kit command from the page.
 *
 * A command that makes a model call is started as a background job
 * (`POST …/commands/:cmd/jobs`, answered at once) and then WATCHED: the job is
 * read every few seconds until it is terminal. Its result is the payload the
 * synchronous route returns and its failure carries the same status and code,
 * so the page renders both exactly as it always has.
 *
 * The job lives on the server, so nothing here depends on one request staying
 * open — that was the bug: a `/speckit.plan` longer than the proxy's five
 * minutes showed "Internal Server Error" while the server finished. The id of
 * the job this tab is watching is kept in session storage, so a reload or a
 * trip to another page re-attaches to it ({@link findSpecKitJobToAttach}).
 *
 * This replaces `spec-kit-recovery.ts` (#1069), which polled the ARTIFACTS for
 * a newer version after a lost response and so could not tell this command's
 * write from anyone else's. The job says what happened; there is one source of
 * truth and no second recovery path.
 *
 * The three commands that are not jobs (`speckit.constitution`,
 * `speckit.implement`, `speckit.taskstoissues`) still answer on the request.
 * When that response is lost their outcome is unknown, and is reported as
 * unknown ({@link SpecKitCommandPendingError}) rather than as a failure.
 */
import {
  isSpecKitJobActive,
  isSpecKitJobCommand,
  isSpecKitNamespacedCommand,
  type SpecKitJobDto,
  type SpecKitNamespacedCommand,
} from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { specKitApi, type SpecKitCommandResult, type SpecKitRunOptions } from "@/lib/spec-kit-api";

/** Wait between two reads of a running job. */
export const SPEC_KIT_JOB_POLL_INTERVAL_MS = 3_000;
/** Consecutive failed reads before the page stops watching: 20 × 3 s = 1 minute. */
export const SPEC_KIT_JOB_MAX_READ_FAILURES = 20;

/**
 * A lost response this soon after a request was sent is a failed send, not a
 * lost result: a refused connection or an API server that is down answers at
 * once. Such a failure is shown as it is.
 */
export const SPEC_KIT_FAILED_SEND_MS = 3_000;

/** Shown when a request/response command's response was lost. */
export const SPEC_KIT_COMMAND_PENDING =
  "The command's response was lost, so its outcome is unknown. It may still be running: check again shortly before running it again.";

/** The response of a command that is not a job was lost: unknown, not failed. */
export class SpecKitCommandPendingError extends Error {
  constructor() {
    super(SPEC_KIT_COMMAND_PENDING);
    this.name = "SpecKitCommandPendingError";
  }
}

export const SPEC_KIT_JOB_UNREACHABLE =
  "Lost contact with the server while the command was running. The command carries on there: reload this page to pick its progress up again.";

/** The job could not be read for a minute. It is still running on the server. */
export class SpecKitJobUnreachableError extends Error {
  constructor() {
    super(SPEC_KIT_JOB_UNREACHABLE);
    this.name = "SpecKitJobUnreachableError";
  }
}

export const SPEC_KIT_JOB_CANCELLED =
  "The command was cancelled. Nothing was saved; the previous version is kept.";

/** The job was cancelled before it saved anything. */
export class SpecKitJobCancelledError extends Error {
  constructor() {
    super(SPEC_KIT_JOB_CANCELLED);
    this.name = "SpecKitJobCancelledError";
  }
}

/** The page was left while it was watching. The job itself carries on. */
export class SpecKitJobAbandonedError extends Error {
  constructor() {
    super("The page stopped watching the Spec Kit job.");
    this.name = "SpecKitJobAbandonedError";
  }
}

/**
 * True when a request's outcome is unknown: it never completed (a failed
 * `fetch` is a `TypeError`), or a 5xx came back without the server's error
 * envelope — a proxy's own "Internal Server Error".
 */
export function isLostResponse(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 && !err.code;
  return err instanceof TypeError;
}

/** True when a lost response means the request never ran: offline, or it failed at once. */
export function isFailedSend(elapsedMs: number): boolean {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return offline || elapsedMs < SPEC_KIT_FAILED_SEND_MS;
}

/** The job this tab is watching, kept so a reload can re-attach to it. */
export interface WatchedSpecKitJob {
  jobId: string;
  command: SpecKitNamespacedCommand;
  featureSlug: string | null;
}

const watchedKey = (projectId: string): string => `metis:spec-kit-job:${projectId}`;

/** The job this tab was watching in the project, or null. */
export function loadWatchedJob(projectId: string): WatchedSpecKitJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(watchedKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WatchedSpecKitJob>;
    if (typeof parsed.jobId !== "string" || typeof parsed.command !== "string") return null;
    if (!isSpecKitNamespacedCommand(parsed.command)) return null;
    return {
      jobId: parsed.jobId,
      command: parsed.command,
      featureSlug: typeof parsed.featureSlug === "string" ? parsed.featureSlug : null,
    };
  } catch {
    return null;
  }
}

/** Remember (or, with null, forget) the job this tab is watching. */
export function saveWatchedJob(projectId: string, job: WatchedSpecKitJob | null): void {
  if (typeof window === "undefined") return;
  try {
    if (job) window.sessionStorage.setItem(watchedKey(projectId), JSON.stringify(job));
    else window.sessionStorage.removeItem(watchedKey(projectId));
  } catch {
    // Storage full or blocked: the job is still found through the active list.
  }
}

export interface SpecKitJobHooks {
  /** Aborted when the page is left: no further read is made. */
  signal?: AbortSignal;
  /** Every state of the job the watch reads, the terminal one included. */
  onUpdate?: (job: SpecKitJobDto) => void;
  /** The viewer, so a job found after a lost start is known to be theirs. */
  userId?: string;
  intervalMs?: number;
  maxReadFailures?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The clock the failed-send threshold is measured on. */
  now?: () => number;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });

/** A read that will not get better by trying again: the job is not there, or not ours to read. */
function isFinalReadError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  );
}

/** A terminal job as the page's command callbacks expect it: a result, or the route's error. */
function settle(job: SpecKitJobDto): SpecKitCommandResult {
  if (job.status === "succeeded") {
    const result = job.result as Partial<SpecKitCommandResult> | null | undefined;
    return { ...(result ?? {}), message: result?.message ?? "" };
  }
  if (job.status === "cancelled") throw new SpecKitJobCancelledError();
  const error = job.error;
  throw new ApiError(
    error?.status ?? 500,
    error?.message ?? "The Spec Kit command failed.",
    error?.code,
    error?.details,
  );
}

/**
 * Watch a job until it is terminal. Resolves with the command's result; rejects
 * with the command's own error (an {@link ApiError} carrying the server's
 * status, code and details) when it failed, with
 * {@link SpecKitJobCancelledError} when it was cancelled, with
 * {@link SpecKitJobUnreachableError} when it could not be read for
 * `maxReadFailures` reads in a row, and with {@link SpecKitJobAbandonedError}
 * once `hooks.signal` aborts. `first` is the job as already known, which saves
 * the first read.
 */
export async function watchSpecKitJob(
  projectId: string,
  jobId: string,
  hooks: SpecKitJobHooks = {},
  first?: SpecKitJobDto,
): Promise<SpecKitCommandResult> {
  const {
    signal,
    onUpdate,
    intervalMs = SPEC_KIT_JOB_POLL_INTERVAL_MS,
    maxReadFailures = SPEC_KIT_JOB_MAX_READ_FAILURES,
    sleep = realSleep,
  } = hooks;
  const abandonIfLeft = (): void => {
    if (signal?.aborted) throw new SpecKitJobAbandonedError();
  };
  let current: SpecKitJobDto | null = first ?? null;
  let failures = 0;
  for (;;) {
    abandonIfLeft();
    if (current === null) {
      try {
        current = (await specKitApi.getJob(projectId, jobId)).job;
        failures = 0;
      } catch (err) {
        abandonIfLeft();
        if (isFinalReadError(err)) {
          saveWatchedJob(projectId, null);
          throw err;
        }
        failures += 1;
        if (failures >= maxReadFailures) throw new SpecKitJobUnreachableError();
      }
      abandonIfLeft();
    }
    if (current !== null) {
      onUpdate?.(current);
      if (!isSpecKitJobActive(current.status)) {
        saveWatchedJob(projectId, null);
        return settle(current);
      }
      current = null;
    }
    await sleep(intervalMs, signal);
  }
}

/** The viewer's running job for this command and feature, after a start whose response was lost. */
async function findStartedJob(
  projectId: string,
  command: SpecKitNamespacedCommand,
  featureSlug: string | undefined,
  userId: string | undefined,
): Promise<SpecKitJobDto | null> {
  try {
    const { jobs } = await specKitApi.listActiveJobs(projectId);
    return (
      jobs.find(
        (job) =>
          job.command === command &&
          job.featureSlug === (featureSlug ?? null) &&
          (userId === undefined || job.startedById === userId),
      ) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Run a Spec Kit command. A model-backed command is started as a job and
 * watched ({@link watchSpecKitJob}); the others are one request. Neither is
 * ever sent twice: when the response to a job's START is lost, the job is
 * looked for among the running ones instead.
 */
export async function runSpecKitCommand(
  projectId: string,
  command: SpecKitNamespacedCommand,
  options: SpecKitRunOptions = {},
  hooks: SpecKitJobHooks = {},
): Promise<SpecKitCommandResult> {
  const now = hooks.now ?? Date.now;
  const sentAt = now();
  if (!isSpecKitJobCommand(command)) {
    try {
      return await specKitApi.runCommand(projectId, command, options);
    } catch (err) {
      if (isLostResponse(err) && !isFailedSend(now() - sentAt)) {
        throw new SpecKitCommandPendingError();
      }
      throw err;
    }
  }
  let job: SpecKitJobDto;
  try {
    job = (await specKitApi.startCommandJob(projectId, command, options)).job;
  } catch (err) {
    if (!isLostResponse(err)) throw err;
    const started = await findStartedJob(projectId, command, options.featureSlug, hooks.userId);
    if (!started) throw err;
    job = started;
  }
  saveWatchedJob(projectId, {
    jobId: job.id,
    command: job.command,
    featureSlug: job.featureSlug,
  });
  return watchSpecKitJob(projectId, job.id, hooks, job);
}

/**
 * The job a freshly opened page should attach to, or null: the viewer's own
 * running job (the one this tab was watching, when there are several), or the
 * job this tab was watching that finished while the page was away — so its
 * result or failure is still shown, once.
 *
 * Only the viewer's own jobs: another member's running command is theirs to
 * watch, and attaching to it would move this viewer's page when it finished.
 */
export async function findSpecKitJobToAttach(
  projectId: string,
  userId: string,
): Promise<SpecKitJobDto | null> {
  const watched = loadWatchedJob(projectId);
  let mine: SpecKitJobDto[] = [];
  try {
    const { jobs } = await specKitApi.listActiveJobs(projectId);
    mine = jobs.filter((job) => job.startedById === userId);
  } catch {
    // The list could not be read; the watched job can still be.
  }
  const running = mine.find((job) => job.id === watched?.jobId) ?? mine[0];
  if (running) {
    saveWatchedJob(projectId, {
      jobId: running.id,
      command: running.command,
      featureSlug: running.featureSlug,
    });
    return running;
  }
  if (!watched) return null;
  try {
    return (await specKitApi.getJob(projectId, watched.jobId)).job;
  } catch (err) {
    // Gone (pruned after a day) or not readable: stop looking for it. Anything
    // else may pass, so the job is kept for the next visit.
    if (isFinalReadError(err)) saveWatchedJob(projectId, null);
    return null;
  }
}
