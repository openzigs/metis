/**
 * #1059 — Spec Kit commands as background jobs.
 *
 * A command used to be awaited inside the HTTP request that started it. A
 * `/speckit.plan` (five model calls) regularly ran past the UI proxy's five
 * minutes: the browser saw "Internal Server Error" while the server carried on
 * and saved the plan. A job is the same command, run after the response has
 * gone: `startSpecKitJob` inserts a `spec_kit_jobs` row and returns, and the
 * client reads the row until it is terminal.
 *
 * Built on what docs generation already does (#50, #855) rather than on the
 * `background_runs` runner, whose restart recovery RE-QUEUES a stale run — a
 * restarted server would spend model tokens nobody asked for again:
 *
 *   - **Fire and forget, with a durable row.** The row, not the request, is the
 *     job's state. A client that disconnects changes nothing.
 *   - **One writer per artifact set.** `activeKey` (`<project>:<feature>`) is
 *     UNIQUE while the job is live, so the database refuses a second start, on
 *     any replica. The refusal names the job that holds the set.
 *   - **Heartbeat, not "this process just started".** A live job refreshes its
 *     row; a live row whose heartbeat stopped has no process, and is failed as
 *     interrupted by the sweeper, by the next read of it, or by the next start
 *     that needs its key. Never resumed: see above.
 *   - **Stop before saving, never during.** Cancel and the time limit abort the
 *     in-flight model call and are honoured until the command's first artifact
 *     write (`specKitJobCommitPoint`). From there the job cannot be stopped, so
 *     a command that writes five artifacts writes five or none (#1065).
 *   - **Same errors.** A failure is stored as the status, code, message and
 *     details the synchronous route answers with, so a client shows both alike.
 *
 * Budget, safety, usage recording and audit are untouched: the job runs the
 * same command functions, which call `runSpecKitAgent` as before.
 */
import { randomUUID } from "node:crypto";
import {
  SPEC_KIT_JOB_INTERRUPTED_CODE,
  SPEC_KIT_JOB_TIMEOUT_CODE,
  type SpecKitJobDto,
  type SpecKitJobError,
  type SpecKitJobStatus,
  type SpecKitNamespacedCommand,
} from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { audit } from "../audit/audit-service.js";
import { getConfigService, type ConfigService } from "../config/config-service.js";
import { jobEvents, genericFailureMessage } from "../socket/job-events.js";
import { recordJobScope } from "../socket/job-scope-store.js";
import {
  SpecKitJobStopError,
  withSpecKitJobScope,
  type SpecKitJobScope,
  type SpecKitJobStopReason,
} from "./job-scope.js";
import * as store from "./job-store.js";
import type { JobOutcome, SpecKitJobRow } from "./job-store.js";

const log = createChildLogger("spec-kit-jobs");

/** How often a running job refreshes its row. */
export const SPEC_KIT_JOB_HEARTBEAT_MS = 15_000;
/**
 * A live row whose heartbeat is older than this has no process. Six missed
 * beats, so a long synchronous stretch or a slow write never fails a live job.
 */
export const SPEC_KIT_JOB_STALE_MS = 90_000;
/** How often the sweeper runs after its startup pass. */
export const SPEC_KIT_JOB_SWEEP_INTERVAL_MS = 30_000;
/** A finished job (and its stored result) is kept this long, then pruned. */
export const SPEC_KIT_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Registry key: the longest one Spec Kit job may run, in milliseconds. */
export const SPEC_KIT_JOB_TIMEOUT_KEY = "SPEC_KIT_JOB_TIMEOUT_MS";
/**
 * 30 minutes. `/speckit.plan` is five model calls in sequence and ran 5 to 8
 * minutes in #706 run 7; each call may also be continued twice (#944).
 */
export const DEFAULT_SPEC_KIT_JOB_TIMEOUT_MS = 30 * 60_000;
export const MIN_SPEC_KIT_JOB_TIMEOUT_MS = 60_000;
export const MAX_SPEC_KIT_JOB_TIMEOUT_MS = 6 * 60 * 60_000;

/** The configured time limit. A missing, non-numeric or out-of-range value is the default. */
export function resolveSpecKitJobTimeoutMs(config: ConfigService = getConfigService()): number {
  const raw = config.getNumber(SPEC_KIT_JOB_TIMEOUT_KEY, DEFAULT_SPEC_KIT_JOB_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_SPEC_KIT_JOB_TIMEOUT_MS;
  if (raw < MIN_SPEC_KIT_JOB_TIMEOUT_MS || raw > MAX_SPEC_KIT_JOB_TIMEOUT_MS) {
    return DEFAULT_SPEC_KIT_JOB_TIMEOUT_MS;
  }
  return Math.floor(raw);
}

/** Stored on a job whose server stopped; user-safe, no internal detail. */
export const SPEC_KIT_JOB_INTERRUPTED_ERROR: SpecKitJobError = {
  status: 503,
  code: SPEC_KIT_JOB_INTERRUPTED_CODE,
  message:
    "The command was interrupted before it finished: the server restarted or stopped while it was running. Nothing more was saved; the previous version is kept. Run the command again.",
};

/** Stored on a job stopped by its time limit. */
export const SPEC_KIT_JOB_TIMEOUT_ERROR: SpecKitJobError = {
  status: 504,
  code: SPEC_KIT_JOB_TIMEOUT_CODE,
  message:
    "The command ran past its time limit and was stopped before saving anything; the previous version is kept. Run it again, split the request, or raise SPEC_KIT_JOB_TIMEOUT_MS.",
};

/** Stored when a command threw something no mapping recognises. Never the raw message. */
export const SPEC_KIT_JOB_INTERNAL_ERROR: SpecKitJobError = {
  status: 500,
  code: "INTERNAL_ERROR",
  message: "An unexpected error occurred",
};

export const SPEC_KIT_JOB_CANCELLED_MESSAGE =
  "The command was cancelled. Nothing was saved; the previous version is kept.";

/** Start refused: `holder` is the live job that owns the artifact set. */
export class SpecKitJobConflictError extends Error {
  constructor(readonly holder: SpecKitJobDto | null) {
    super(
      holder
        ? `/${holder.command} is already running${holder.featureSlug ? ` on ${holder.featureSlug}` : ""}. Wait for it to finish, or cancel it.`
        : "Another Spec Kit command is already running here. Wait for it to finish.",
    );
    this.name = "SpecKitJobConflictError";
  }
}

/** Cancel refused: the job is already writing its artifacts. */
export class SpecKitJobSavingError extends Error {
  constructor() {
    super("The command is already saving its result and can no longer be cancelled.");
    this.name = "SpecKitJobSavingError";
  }
}

/**
 * The human-readable completion line of a command result (Epic #406, #423):
 * the grounded-completion string each command returns on `message`, surfaced
 * verbatim as the terminal `job:lifecycle` message. `fallback` when a result
 * carries none.
 */
export function extractCompletionMessage(result: unknown, fallback: string): string {
  if (
    result &&
    typeof result === "object" &&
    "message" in result &&
    typeof (result as { message: unknown }).message === "string" &&
    (result as { message: string }).message.length > 0
  ) {
    return (result as { message: string }).message;
  }
  return fallback;
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A stored row as the API returns it. */
export function toSpecKitJobDto(row: SpecKitJobRow): SpecKitJobDto {
  const status = row.status as SpecKitJobStatus;
  const error = status === "failed" ? (parseJson(row.error) as SpecKitJobError | undefined) : null;
  return {
    id: row.id,
    projectId: row.projectId,
    command: row.command as SpecKitNamespacedCommand,
    featureSlug: row.featureSlug,
    status,
    phase: row.phase,
    startedById: row.startedById,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    ...(status === "succeeded" ? { result: parseJson(row.result) ?? null } : {}),
    ...(status === "failed" ? { error: error ?? SPEC_KIT_JOB_INTERNAL_ERROR } : {}),
  };
}

/** The key one artifact set is locked under: a feature's, or the project-level set. */
export function specKitJobActiveKey(projectId: string, featureSlug: string | null): string {
  return `${projectId}:${featureSlug ?? ""}`;
}

const MAX_PHASE_CHARS = 200;

/** One live job in this process: its stop switch and its saving latch. */
class SpecKitJobControl implements SpecKitJobScope {
  private readonly controller = new AbortController();
  private stopped: SpecKitJobStopError | null = null;
  private saving = false;
  private rejectStopped: (err: SpecKitJobStopError) => void = () => undefined;
  /** Rejects with the stop error the moment the job is stopped. */
  readonly whenStopped: Promise<never>;

  constructor(
    readonly jobId: string,
    readonly projectId: string,
    private readonly onPhase: (text: string, progress?: number) => void,
  ) {
    this.whenStopped = new Promise<never>((_resolve, reject) => {
      this.rejectStopped = reject;
    });
    // Nothing may be waiting when a job is stopped after it settled.
    this.whenStopped.catch(() => undefined);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  stopError(): SpecKitJobStopError | null {
    return this.stopped;
  }

  /**
   * Stop the job. True when it is (now or already) stopped; false when it is
   * saving and can no longer be. The first reason wins.
   */
  stop(reason: SpecKitJobStopReason): boolean {
    if (this.stopped) return true;
    if (this.saving) return false;
    this.stopped = new SpecKitJobStopError(reason);
    this.controller.abort(this.stopped);
    this.rejectStopped(this.stopped);
    return true;
  }

  commitPoint(): void {
    if (this.stopped) throw this.stopped;
    this.saving = true;
  }

  phase(text: string, progress?: number): void {
    if (this.stopped) return;
    this.onPhase(text.slice(0, MAX_PHASE_CHARS), progress);
  }
}

// Every job this process is running, by id.
const live = new Map<string, SpecKitJobControl>();

/** How many jobs this process is running (tests, diagnostics). */
export function liveSpecKitJobCount(): number {
  return live.size;
}

/** Test seam — stop and forget every job this process is running. */
export function _resetSpecKitJobs(): void {
  for (const control of live.values()) control.stop("superseded");
  live.clear();
}

function isStale(row: SpecKitJobRow, now: Date): boolean {
  return (
    store.LIVE_STATUSES.includes(row.status) &&
    now.getTime() - row.heartbeatAt.getTime() > SPEC_KIT_JOB_STALE_MS
  );
}

/**
 * Fail one job whose heartbeat stopped, compare-and-set on the status and
 * heartbeat it was read with: a job that beat (or finished) in between is left
 * alone. A job that died after a cancel was asked for is simply cancelled.
 */
async function failStaleJob(row: SpecKitJobRow, now: Date): Promise<boolean> {
  const cancelled = row.status === "cancelling";
  const failed = await store.finishJob(
    row.id,
    cancelled
      ? { status: "cancelled" }
      : { status: "failed", error: JSON.stringify(SPEC_KIT_JOB_INTERRUPTED_ERROR) },
    now,
    { status: row.status, heartbeatAt: row.heartbeatAt },
  );
  if (!failed) return false;
  // A job of THIS process that stalled long enough to be swept has lost its row.
  live.get(row.id)?.stop("superseded");
  if (cancelled) {
    jobEvents.completed("spec-kit", row.id, row.projectId, SPEC_KIT_JOB_CANCELLED_MESSAGE);
  } else {
    jobEvents.failed("spec-kit", row.id, row.projectId, genericFailureMessage("spec-kit"));
  }
  return true;
}

export interface StartSpecKitJobInput {
  projectId: string;
  command: SpecKitNamespacedCommand;
  /** The feature the command runs on; `null` for the project-level set. */
  featureSlug: string | null;
  actorId: string | null;
  /** The command as the caller typed it, for progress text. Default `/<command>`. */
  label?: string;
  /** The command itself. Runs inside the job's scope, after this call returned. */
  run: () => Promise<unknown>;
  /** Turn what `run` threw into the error a client is shown. Default: a generic 500. */
  mapError?: (err: unknown) => SpecKitJobError;
  /** Default {@link resolveSpecKitJobTimeoutMs}. */
  timeoutMs?: number;
  /** Default {@link SPEC_KIT_JOB_HEARTBEAT_MS}. */
  heartbeatMs?: number;
}

export interface StartedSpecKitJob {
  /** The job as it was started (`running`). */
  job: SpecKitJobDto;
  /** Resolves with the terminal job. Never rejects. */
  done: Promise<SpecKitJobDto>;
}

/**
 * Start a command as a job. Resolves once the row exists and the job's scope is
 * recorded, so the id is usable the moment it leaves the server; the command
 * runs on after that. Throws {@link SpecKitJobConflictError} when a live job
 * already holds the same artifact set.
 */
export async function startSpecKitJob(input: StartSpecKitJobInput): Promise<StartedSpecKitJob> {
  const now = new Date();
  const activeKey = specKitJobActiveKey(input.projectId, input.featureSlug);
  const fresh = {
    id: randomUUID(),
    projectId: input.projectId,
    command: input.command,
    featureSlug: input.featureSlug,
    activeKey,
    startedById: input.actorId,
    now,
  };
  let row = await store.createJob(fresh);
  if (!row) {
    // The key is held. A holder with no process behind it is failed here, so a
    // restart never blocks a feature until the sweeper next runs.
    let holder = await store.findJobByActiveKey(activeKey);
    if (holder && isStale(holder, now)) {
      await failStaleJob(holder, now);
      holder = null;
    }
    // No holder: it finished (or was just failed) since the insert. Try once more.
    if (!holder) {
      row = await store.createJob(fresh);
      if (!row) holder = await store.findJobByActiveKey(activeKey);
    }
    if (!row) throw new SpecKitJobConflictError(toSpecKitJobDtoOrNull(holder));
  }
  // #674 — durably, before the id leaves the server, so `subscribe:job` is
  // authorized on any replica.
  await recordJobScope(row.id, "spec-kit", input.projectId);
  return { job: toSpecKitJobDto(row), done: runJob(row, input) };
}

function toSpecKitJobDtoOrNull(row: SpecKitJobRow | null): SpecKitJobDto | null {
  return row ? toSpecKitJobDto(row) : null;
}

function stopOutcome(reason: SpecKitJobStopReason): JobOutcome | null {
  if (reason === "cancelled") return { status: "cancelled" };
  if (reason === "timeout") {
    return { status: "failed", error: JSON.stringify(SPEC_KIT_JOB_TIMEOUT_ERROR) };
  }
  // Superseded: the row is no longer this job's to write.
  return null;
}

/** Run the command to a terminal row. Never rejects. */
async function runJob(row: SpecKitJobRow, input: StartSpecKitJobInput): Promise<SpecKitJobDto> {
  const { id, projectId } = row;
  const label = input.label ?? `/${input.command}`;
  // Phase writes are chained so two quick phases cannot land out of order.
  let phaseWrites: Promise<void> = Promise.resolve();
  const control = new SpecKitJobControl(id, projectId, (text, progress) => {
    phaseWrites = phaseWrites
      .then(() => store.setJobPhase(id, text))
      .catch((err: unknown) => {
        log.warn("could not record a job phase", { id, err: String(err) });
      });
    jobEvents.progress("spec-kit", id, projectId, progress ?? 50, text);
  });
  live.set(id, control);

  const beat = async (): Promise<void> => {
    const status = await store.beatJob(id, new Date());
    if (status === null) control.stop("superseded");
    else if (status === "cancelling") control.stop("cancelled");
  };
  const heartbeat = setInterval(() => {
    beat().catch((err: unknown) => log.warn("job heartbeat failed", { id, err: String(err) }));
  }, input.heartbeatMs ?? SPEC_KIT_JOB_HEARTBEAT_MS);
  heartbeat.unref?.();
  const timeout = setTimeout(
    () => control.stop("timeout"),
    input.timeoutMs ?? resolveSpecKitJobTimeoutMs(),
  );
  timeout.unref?.();

  jobEvents.started("spec-kit", id, projectId, `Running ${label}`);
  let outcome: JobOutcome | null;
  let completion = `${label} completed.`;
  try {
    const work = withSpecKitJobScope(control, input.run);
    // A stopped job stops being waited for; its command may still fail later.
    work.catch(() => undefined);
    const result = await Promise.race([work, control.whenStopped]);
    completion = extractCompletionMessage(result, completion);
    outcome = { status: "succeeded", result: JSON.stringify(result ?? null) };
  } catch (err) {
    const stopped = control.stopError();
    if (stopped) {
      outcome = stopOutcome(stopped.reason);
    } else {
      log.error("Spec Kit job failed", { projectId, jobId: id, label, error: String(err) });
      let mapped = SPEC_KIT_JOB_INTERNAL_ERROR;
      try {
        if (input.mapError) mapped = input.mapError(err);
      } catch (mapErr) {
        log.error("could not map a Spec Kit job error", { jobId: id, error: String(mapErr) });
      }
      outcome = { status: "failed", error: JSON.stringify(mapped) };
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    live.delete(id);
  }

  try {
    await phaseWrites;
    if (outcome && (await store.finishJob(id, outcome, new Date()))) {
      if (outcome.status === "succeeded") {
        jobEvents.completed("spec-kit", id, projectId, completion);
      } else if (outcome.status === "cancelled") {
        jobEvents.completed("spec-kit", id, projectId, SPEC_KIT_JOB_CANCELLED_MESSAGE);
      } else {
        jobEvents.failed("spec-kit", id, projectId, genericFailureMessage("spec-kit"));
      }
    }
    const stored = await store.findJob(projectId, id);
    if (stored) return toSpecKitJobDto(stored);
  } catch (err) {
    // The row stays live with no heartbeat, so the sweeper fails it shortly.
    log.error("could not store a Spec Kit job's outcome", { jobId: id, error: String(err) });
  }
  return {
    ...toSpecKitJobDto(row),
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: SPEC_KIT_JOB_INTERRUPTED_ERROR,
  };
}

/**
 * A job of `projectId`, or `null` — including for another project's job id,
 * which must be indistinguishable from one that never existed. A live job with
 * no process behind it is failed on the way out, so a read never reports a dead
 * job as running.
 */
export async function getSpecKitJob(
  projectId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<SpecKitJobDto | null> {
  const row = await store.findJob(projectId, jobId);
  if (!row) return null;
  if (!isStale(row, now)) return toSpecKitJobDto(row);
  await failStaleJob(row, now);
  return toSpecKitJobDtoOrNull(await store.findJob(projectId, jobId));
}

/** The project's live jobs, oldest first (dead ones are failed and left out). */
export async function listActiveSpecKitJobs(
  projectId: string,
  now: Date = new Date(),
): Promise<SpecKitJobDto[]> {
  const rows = await store.listLiveJobs(projectId);
  const active: SpecKitJobDto[] = [];
  for (const row of rows) {
    if (isStale(row, now)) await failStaleJob(row, now);
    else active.push(toSpecKitJobDto(row));
  }
  return active;
}

/**
 * Cancel a job of `projectId`. Returns the job as it stands (a terminal job is
 * returned unchanged, so cancel is idempotent), `null` when there is no such
 * job in the project, and throws {@link SpecKitJobSavingError} once the job is
 * writing its artifacts.
 *
 * A job of this process is aborted at once. Another replica's is marked
 * `cancelling`, which its heartbeat notices.
 */
export async function cancelSpecKitJob(
  projectId: string,
  jobId: string,
  actorId: string | null,
  now: Date = new Date(),
): Promise<SpecKitJobDto | null> {
  const row = await store.findJob(projectId, jobId);
  if (!row) return null;
  if (!store.LIVE_STATUSES.includes(row.status)) return toSpecKitJobDto(row);
  const control = live.get(jobId);
  if (control) {
    if (!control.stop("cancelled")) throw new SpecKitJobSavingError();
  } else if (isStale(row, now)) {
    await failStaleJob(row, now);
    return toSpecKitJobDtoOrNull(await store.findJob(projectId, jobId));
  }
  await store.markJobCancelling(projectId, jobId);
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "spec_kit.job.cancelled",
    target: { type: "project", id: projectId },
    metadata: { jobId, command: row.command, featureSlug: row.featureSlug },
  });
  return toSpecKitJobDtoOrNull(await store.findJob(projectId, jobId));
}

/**
 * Fail every live job whose heartbeat stopped, and prune jobs that finished
 * more than {@link SPEC_KIT_JOB_RETENTION_MS} ago. Returns how many were failed.
 */
export async function failInterruptedSpecKitJobs(now: Date = new Date()): Promise<number> {
  const stale = await store.findStaleJobs(new Date(now.getTime() - SPEC_KIT_JOB_STALE_MS));
  let failed = 0;
  for (const row of stale) {
    if (await failStaleJob(row, now)) failed += 1;
  }
  if (failed > 0) log.warn("Failed interrupted Spec Kit jobs", { count: failed });
  await store.pruneFinishedJobs(new Date(now.getTime() - SPEC_KIT_JOB_RETENTION_MS));
  return failed;
}

/**
 * Run {@link failInterruptedSpecKitJobs} now and then every
 * {@link SPEC_KIT_JOB_SWEEP_INTERVAL_MS}. Independent of the scheduler, which
 * can be disabled. Returns a stop function.
 */
export function startSpecKitJobSweeper(
  intervalMs: number = SPEC_KIT_JOB_SWEEP_INTERVAL_MS,
): () => void {
  const sweep = (): void => {
    failInterruptedSpecKitJobs().catch((err: unknown) =>
      log.warn("Spec Kit job sweep failed", { err: String(err) }),
    );
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
