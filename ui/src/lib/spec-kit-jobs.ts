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
 * minutes showed "Internal Server Error" while the server finished. The jobs
 * this tab is watching are kept in session storage, so a reload or a trip to
 * another page picks them up again ({@link findSpecKitJobsOnOpen}).
 *
 * Watching is a read every few seconds. Where the page has a socket it also
 * hears the job's `job:lifecycle` events ({@link SpecKitJobHooks.subscribe}) and
 * reads at once when one arrives; the timed read stays as the fallback, so a
 * socket that is down, late or refused changes nothing but the delay.
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
/**
 * Wait between two reads of the project's running jobs, which is how the page
 * knows a feature is busy with a job it is not watching (another member's, or
 * one started in another tab). 90 reads per 15 minutes per open tab, against a
 * read budget of 6000 per user.
 */
export const SPEC_KIT_ACTIVE_JOBS_POLL_MS = 10_000;
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

/**
 * Where the page was when THIS TAB started a command: the selected feature, or
 * null for the project-level files. A finished command moves the page (opens
 * the artifact it wrote, clears the command box) only when it was started from
 * this tab and the page is still there. It is not always the job's own feature:
 * a `/speckit.specify` started on the project-level files creates a new one.
 */
export interface SpecKitJobOrigin {
  scope: string | null;
}

/** A job this tab is watching, kept so a reload can pick it up again. */
export interface WatchedSpecKitJob {
  jobId: string;
  command: SpecKitNamespacedCommand;
  featureSlug: string | null;
  /** Set when this tab started the job; absent for one it only found running. */
  origin?: SpecKitJobOrigin;
}

const watchedKey = (projectId: string): string => `metis:spec-kit-job:${projectId}`;
/** More than a tab ever watches; bounds what a bug could leave in storage. */
const MAX_WATCHED_JOBS = 20;

function parseWatched(value: unknown): WatchedSpecKitJob | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<WatchedSpecKitJob>;
  if (typeof entry.jobId !== "string" || typeof entry.command !== "string") return null;
  if (!isSpecKitNamespacedCommand(entry.command)) return null;
  const scope = (entry.origin as Partial<SpecKitJobOrigin> | undefined)?.scope;
  return {
    jobId: entry.jobId,
    command: entry.command,
    featureSlug: typeof entry.featureSlug === "string" ? entry.featureSlug : null,
    ...(entry.origin && typeof entry.origin === "object"
      ? { origin: { scope: typeof scope === "string" ? scope : null } }
      : {}),
  };
}

/** The jobs this tab is watching in the project, oldest first. */
export function loadWatchedJobs(projectId: string): WatchedSpecKitJob[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(watchedKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    // A single object is what an earlier build of this page stored.
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.flatMap((entry) => parseWatched(entry) ?? []);
  } catch {
    return [];
  }
}

function storeWatchedJobs(projectId: string, jobs: WatchedSpecKitJob[]): void {
  if (typeof window === "undefined") return;
  try {
    if (jobs.length === 0) window.sessionStorage.removeItem(watchedKey(projectId));
    else {
      window.sessionStorage.setItem(
        watchedKey(projectId),
        JSON.stringify(jobs.slice(-MAX_WATCHED_JOBS)),
      );
    }
  } catch {
    // Storage full or blocked: a running job is still found through the active list.
  }
}

/** Remember a job this tab is watching. An origin already recorded for it is kept. */
export function rememberWatchedJob(projectId: string, job: WatchedSpecKitJob): void {
  const jobs = loadWatchedJobs(projectId);
  const known = jobs.find((entry) => entry.jobId === job.jobId);
  const origin = job.origin ?? known?.origin;
  storeWatchedJobs(projectId, [
    ...jobs.filter((entry) => entry.jobId !== job.jobId),
    {
      jobId: job.jobId,
      command: job.command,
      featureSlug: job.featureSlug,
      ...(origin ? { origin } : {}),
    },
  ]);
}

/** Stop remembering a job: its outcome has been shown, or it is gone. */
export function forgetWatchedJob(projectId: string, jobId: string): void {
  storeWatchedJobs(
    projectId,
    loadWatchedJobs(projectId).filter((entry) => entry.jobId !== jobId),
  );
}

/**
 * How long after a job finished its result is still treated as news: shown as
 * if the page had stayed open. A result older than this, met on opening the
 * page, is shown as something that happened earlier and changes nothing on the
 * page. Measured against the server's `finishedAt`, so a browser clock that is
 * minutes off shifts the window by as much; ten minutes makes that immaterial.
 */
export const SPEC_KIT_FRESH_RESULT_MS = 10 * 60_000;

/** True when a terminal job finished recently enough to be shown as news. */
export function isFreshSpecKitResult(job: SpecKitJobDto, nowMs: number = Date.now()): boolean {
  if (!job.finishedAt) return false;
  const finished = Date.parse(job.finishedAt);
  return Number.isFinite(finished) && nowMs - finished <= SPEC_KIT_FRESH_RESULT_MS;
}

export interface SpecKitJobHooks {
  /** Aborted when the page is left: no further read is made. */
  signal?: AbortSignal;
  /** Every state of the job the watch reads, the terminal one included. */
  onUpdate?: (job: SpecKitJobDto) => void;
  /** Where the page was when it started the command; remembered with the job. */
  origin?: SpecKitJobOrigin;
  /**
   * Hear about the job as it happens (the page's `job:lifecycle` socket
   * events). `onEvent` makes the watch read the job at once instead of at its
   * next timed read. Returns the unsubscribe. Optional: without it, or when no
   * event ever arrives, the timed read alone watches the job.
   */
  subscribe?: (jobId: string, onEvent: () => void) => () => void;
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
  // An event that arrives while a read is in flight is not lost: it is noted,
  // and the next wait ends at once.
  let eventPending = false;
  let wake: (() => void) | null = null;
  const unsubscribe = hooks.subscribe?.(jobId, () => {
    eventPending = true;
    wake?.();
  });
  try {
    for (;;) {
      abandonIfLeft();
      if (current === null) {
        eventPending = false;
        try {
          current = (await specKitApi.getJob(projectId, jobId)).job;
          failures = 0;
        } catch (err) {
          abandonIfLeft();
          if (isFinalReadError(err)) {
            forgetWatchedJob(projectId, jobId);
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
          forgetWatchedJob(projectId, jobId);
          return settle(current);
        }
        current = null;
      }
      if (eventPending) continue;
      // The timed read, cut short by an event or by leaving the page.
      const waiting = new AbortController();
      const stop = (): void => waiting.abort();
      wake = stop;
      signal?.addEventListener("abort", stop);
      try {
        await sleep(intervalMs, waiting.signal);
      } finally {
        wake = null;
        signal?.removeEventListener("abort", stop);
      }
    }
  } finally {
    unsubscribe?.();
  }
}

/**
 * A name for one start, made up here and sent with it
 * (`X-SpecKit-Start-Token`). The server derives the job from it, the user and
 * the project, so the job a start created can be asked for by this token.
 */
export function newSpecKitStartToken(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The job that the start carrying `startToken` created, after its response was
 * lost — running or already finished. Asked of the server by the token, never
 * inferred from a job's command, feature or starter: a `/speckit.specify` that
 * creates a feature runs under a slug the page has not been told yet, and a
 * guess would attach to somebody else's command. `null` when that start
 * created no job, or when it cannot be asked.
 */
async function findStartedJob(
  projectId: string,
  startToken: string,
): Promise<SpecKitJobDto | null> {
  try {
    return (await specKitApi.listActiveJobs(projectId, startToken)).started ?? null;
  } catch {
    return null;
  }
}

/**
 * Run a Spec Kit command. A model-backed command is started as a job and
 * watched ({@link watchSpecKitJob}); the others are one request. Neither is
 * ever sent twice: when the response to a job's START is lost, the job that
 * start created is asked for by the start's token instead.
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
  const startToken = newSpecKitStartToken();
  try {
    job = (await specKitApi.startCommandJob(projectId, command, options, startToken)).job;
  } catch (err) {
    if (!isLostResponse(err)) throw err;
    const started = await findStartedJob(projectId, startToken);
    if (!started) throw err;
    job = started;
  }
  rememberWatchedJob(projectId, {
    jobId: job.id,
    command: job.command,
    featureSlug: job.featureSlug,
    origin: hooks.origin ?? { scope: options.featureSlug ?? null },
  });
  return watchSpecKitJob(projectId, job.id, hooks, job);
}

/** What a freshly opened page finds: see {@link findSpecKitJobsOnOpen}. */
export interface SpecKitJobsOnOpen {
  /**
   * The viewer's own running jobs, each with the origin this tab recorded for
   * it (absent for a job started in another tab or by an API client). The page
   * WATCHES these; it does not move to them and does not stop the viewer
   * running something else.
   */
  running: Array<{ job: SpecKitJobDto; origin?: SpecKitJobOrigin }>;
  /** Jobs this tab was watching that ended while the page was away. */
  finished: Array<{ job: SpecKitJobDto; origin?: SpecKitJobOrigin }>;
}

/**
 * What a freshly opened page picks up: the viewer's running jobs, and the jobs
 * this tab was watching that finished meanwhile.
 *
 * Only the viewer's own jobs are WATCHED: another member's running command is
 * theirs to watch (the page shows it as busy from the active list, which holds
 * no result). And only jobs this tab was watching are reported as finished: a
 * tab that never saw a job has no business announcing its result.
 */
export async function findSpecKitJobsOnOpen(
  projectId: string,
  userId: string,
): Promise<SpecKitJobsOnOpen> {
  const watched = loadWatchedJobs(projectId);
  const originOf = (jobId: string): { origin?: SpecKitJobOrigin } => {
    const origin = watched.find((entry) => entry.jobId === jobId)?.origin;
    return origin ? { origin } : {};
  };
  const found: SpecKitJobsOnOpen = { running: [], finished: [] };
  let listed: SpecKitJobDto[] | null = null;
  try {
    listed = (await specKitApi.listActiveJobs(projectId)).jobs;
  } catch {
    // The list could not be read; the watched jobs can still be, one by one.
  }
  for (const job of listed ?? []) {
    if (job.startedById !== userId) continue;
    found.running.push({ job, ...originOf(job.id) });
    rememberWatchedJob(projectId, {
      jobId: job.id,
      command: job.command,
      featureSlug: job.featureSlug,
    });
  }
  for (const entry of watched) {
    if (found.running.some((r) => r.job.id === entry.jobId)) continue;
    try {
      const { job } = await specKitApi.getJob(projectId, entry.jobId);
      const slot = isSpecKitJobActive(job.status) ? found.running : found.finished;
      slot.push({ job, ...originOf(job.id) });
    } catch (err) {
      // Gone (pruned after a day) or not readable: stop looking for it. Anything
      // else may pass, so the job is kept for the next visit.
      if (isFinalReadError(err)) forgetWatchedJob(projectId, entry.jobId);
    }
  }
  return found;
}

/** The live job that holds a scope's lock: a feature's, or (null) the project-level files'. */
export function specKitJobHolding(
  jobs: readonly SpecKitJobDto[],
  scope: string | null,
): SpecKitJobDto | null {
  return jobs.find((job) => isSpecKitJobActive(job.status) && job.featureSlug === scope) ?? null;
}

/**
 * The scope whose lock a command typed on the page needs: a feature slug, null
 * for the project-level files, or `undefined` when it needs none.
 *
 * `/speckit.specify` typed with no feature selected creates a NEW feature and
 * runs under that feature's own slug, so nothing running holds it up. The
 * constitution is the project's whatever is selected. Everything else runs on
 * the selected feature (or the project-level files).
 */
export function specKitCommandLockScope(
  command: SpecKitNamespacedCommand,
  selectedFeature: string | null,
): string | null | undefined {
  if (command === "speckit.specify" && selectedFeature === null) return undefined;
  if (command === "speckit.constitution") return null;
  return selectedFeature;
}
