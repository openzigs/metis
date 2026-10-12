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
 *   - **The row decides, not this process.** Every transition is one
 *     conditional UPDATE in `job-store.ts`:
 *
 *         running    -> saving      the job's commit point (id, status, activeKey)
 *         running    -> cancelling  a cancel, from any replica
 *         running    -> failed      the time limit, by the owning process
 *         cancelling -> cancelled   the owner, once it has stopped
 *         running | saving -> succeeded | failed   the owner, at the end
 *         running | cancelling | saving -> failed | cancelled   a sweep that
 *                                    finds the heartbeat stopped
 *         saving     -> failed      the saving deadline, by the owning process
 *
 *     Two of these on one row are serialised by the database and one matches.
 *     So: cancel vs save, time limit vs save and owner-finishes vs sweep each
 *     have exactly one winner, whichever replica each side runs on.
 *   - **Nothing is written without the row.** Every artifact write a job makes
 *     passes `specKitJobCommitPoint`. The first one is `running -> saving`; a
 *     job whose row was cancelled, timed out or failed by another replica's
 *     sweep is refused there and writes nothing, whatever it believes in
 *     memory. Once `saving` a job can no longer be cancelled or timed out, so a
 *     command that writes five artifacts writes five (#1065); each later write
 *     re-checks the row, so a job whose row is taken mid-save stops writing.
 *   - **Heartbeat on one clock.** A live job refreshes its row with the
 *     DATABASE's time, and a heartbeat is judged stale against the database's
 *     time in the same statement. A live row whose heartbeat stopped has no
 *     process, and is failed as interrupted by the sweeper, by the next read of
 *     it, or by the next start that needs its key. Never resumed: see above.
 *   - **Same errors.** A failure is stored as the status, code, message and
 *     details the synchronous route answers with, so a client shows both alike.
 *
 * Budget, safety, usage recording and audit are untouched: the job runs the
 * same command functions, which call `runSpecKitAgent` as before.
 */
import { createHash, randomUUID } from "node:crypto";
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
import { liveSpecKitJobs, type LiveSpecKitJob } from "./job-registry.js";
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
/**
 * The longest a job may stay `saving`. Saving is a handful of database writes
 * and no model call, so it takes seconds; a job still `saving` after this has a
 * write that hung without failing (a lock wait with no statement timeout). It
 * can be neither cancelled nor timed out and its heartbeat keeps it from the
 * sweep, so without this limit it would hold its feature until a restart.
 */
export const SPEC_KIT_JOB_SAVING_LIMIT_MS = 10 * 60_000;
/**
 * Waits between attempts to store a job's outcome (three attempts in all). A
 * single failed write would otherwise leave the feature locked, and the job
 * reported interrupted, until the next sweep.
 */
export const SPEC_KIT_JOB_OUTCOME_RETRY_MS: readonly number[] = [250, 1_000];
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

/**
 * Stored on a job whose server stopped BEFORE its commit point (the row was
 * still `running`). "Nothing was saved" is a fact here, not a hope: no write
 * happens without the `running` -> `saving` transition this row never made.
 */
export const SPEC_KIT_JOB_INTERRUPTED_ERROR: SpecKitJobError = {
  status: 503,
  code: SPEC_KIT_JOB_INTERRUPTED_CODE,
  message:
    "The command was interrupted before it saved anything: the server restarted or stopped while it was running. The previous version is kept. Run the command again.",
};

/** Stored on a job whose server stopped while it was `saving`: it may be part-saved. */
export const SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR: SpecKitJobError = {
  status: 503,
  code: SPEC_KIT_JOB_INTERRUPTED_CODE,
  message:
    "The command was interrupted while it was saving its result: the server restarted or stopped. Some of its files may have been saved and others not. Check the files, then run the command again.",
};

/**
 * Stored on a job that was still `saving` after
 * {@link SPEC_KIT_JOB_SAVING_LIMIT_MS}, while its server was alive: a write
 * hung. The writes it had made stay, and the hung one may yet land.
 */
export const SPEC_KIT_JOB_SAVING_STALLED_ERROR: SpecKitJobError = {
  status: 503,
  code: SPEC_KIT_JOB_INTERRUPTED_CODE,
  message:
    "The command was interrupted while it was saving its result: saving did not finish within its time limit. Some of its files may have been saved and others not. Check the files, then run the command again.",
};

/**
 * Answered to a caller waiting on a job that reached its commit point but
 * whose outcome could not be stored. Never claims that nothing was saved.
 */
export const SPEC_KIT_JOB_UNRECORDED_ERROR: SpecKitJobError = {
  status: 503,
  code: SPEC_KIT_JOB_INTERRUPTED_CODE,
  message:
    "The command ended, but its outcome could not be recorded. Its files may have been saved: check them before running the command again.",
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

/**
 * Start not needed: a job with this start's id already exists in the project —
 * the same start, sent again (`StartSpecKitJobInput.id`). Nothing was started.
 */
export class SpecKitJobAlreadyStartedError extends Error {
  constructor(readonly job: SpecKitJobDto) {
    super("This Spec Kit command was already started.");
    this.name = "SpecKitJobAlreadyStartedError";
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

/**
 * The key one artifact set is locked under: a feature's `specs/<slug>/`, or the
 * project-level `.specify/` set (`featureSlug` null). Exactly as wide as what a
 * job writes: a command that creates a NEW feature is given that feature's own
 * slug before it starts (the route reserves it), so it never holds the
 * project-level key.
 */
export function specKitJobActiveKey(projectId: string, featureSlug: string | null): string {
  return `${projectId}:${featureSlug ?? ""}`;
}

/** What a start token may be: long enough not to be guessed, plain enough to log. */
export const SPEC_KIT_JOB_START_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The id of the job that the start carrying `token` creates: a digest of the
 * project, the user and the token, laid out as a UUID. A start that is sent
 * twice (its first response was lost) therefore names the SAME row, and the
 * primary key — not a lookup that could race — is what refuses the second.
 *
 * The user and the project are part of the digest, so a token is only ever a
 * name for the caller's own start in that project: another user (or the same
 * user in another project) presenting it gets a different id, and no job.
 */
export function specKitJobIdForStart(projectId: string, userId: string, token: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["spec-kit-job-start", projectId, userId, token]))
    .digest("hex");
  // Version 8 ("custom") and the RFC 4122 variant, so it reads as a UUID.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const MAX_PHASE_CHARS = 200;

/**
 * One job this process is running. It holds the abort switch for the job's
 * in-flight model call and performs the commit point. It holds NO authority:
 * `stop` is only ever called after a database transition was won by someone
 * (or after the row was found lost), and the right to save is whatever
 * {@link store.beginSaving} answers.
 */
class SpecKitJobControl implements SpecKitJobScope, LiveSpecKitJob {
  private readonly controller = new AbortController();
  private stopped: SpecKitJobStopError | null = null;
  /** The one `running` → `saving` attempt, shared by concurrent first writes. */
  private commit: Promise<void> | null = null;
  private saving = false;
  private rejectStopped: (err: SpecKitJobStopError) => void = () => undefined;
  /** Rejects with the stop error the moment the job is stopped. */
  readonly whenStopped: Promise<never>;

  constructor(
    readonly jobId: string,
    readonly projectId: string,
    private readonly activeKey: string,
    private readonly onPhase: (text: string, progress?: number) => void,
    /** Called once, when the row has become `saving`. */
    private readonly onSaving: () => void,
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

  /** True once the row is `saving`: the command reached its first artifact write. */
  isSaving(): boolean {
    return this.saving;
  }

  stop(reason: SpecKitJobStopReason): void {
    if (this.stopped) return;
    this.stopped = new SpecKitJobStopError(reason);
    this.controller.abort(this.stopped);
    this.rejectStopped(this.stopped);
  }

  async commitPoint(): Promise<void> {
    if (this.stopped) throw this.stopped;
    if (!this.saving) {
      this.commit ??= this.beginSaving();
      await this.commit;
      return;
    }
    // Already saving: every later write re-checks that the row is still ours.
    if (!(await store.confirmSaving(this.jobId, this.activeKey))) this.stop("superseded");
    if (this.stopped) throw this.stopped;
  }

  /** The commit point proper: one conditional UPDATE decides whether this job may write. */
  private async beginSaving(): Promise<void> {
    if (await store.beginSaving(this.jobId, this.activeKey)) {
      this.saving = true;
      this.onSaving();
      return;
    }
    // Refused. A cancel that won the row leaves it `cancelling` and still ours
    // to close; anything else (timed out, swept, deleted) is no longer ours.
    const row = await store.findJob(this.projectId, this.jobId);
    const cancelled = row?.status === "cancelling" && row.activeKey === this.activeKey;
    this.stop(cancelled ? "cancelled" : "superseded");
    throw this.stopped ?? new SpecKitJobStopError("superseded");
  }

  phase(text: string, progress?: number): void {
    if (this.stopped) return;
    this.onPhase(text.slice(0, MAX_PHASE_CHARS), progress);
  }
}

/** How many jobs this process is running (tests, diagnostics). */
export function liveSpecKitJobCount(): number {
  return liveSpecKitJobs.size;
}

const STALE_OUTCOMES: store.StaleOutcomes = {
  interruptedError: JSON.stringify(SPEC_KIT_JOB_INTERRUPTED_ERROR),
  interruptedWhileSavingError: JSON.stringify(SPEC_KIT_JOB_INTERRUPTED_SAVING_ERROR),
};

/**
 * Fail the live jobs in `scope` whose heartbeat stopped. One statement, judged
 * on the database's clock (`job-store.ts`): a job that beat, finished or began
 * saving in the meantime does not match, and a finished job never does. A job
 * that died after a cancel was asked for is simply cancelled.
 */
async function failStale(scope: store.StaleScope): Promise<number> {
  const swept = await store.failStaleJobs(scope, SPEC_KIT_JOB_STALE_MS, STALE_OUTCOMES);
  for (const job of swept) {
    // A job of THIS process that stalled long enough to be swept has lost its
    // row: its next commit point is refused by the database in any case; this
    // only stops its model call sooner.
    liveSpecKitJobs.get(job.id)?.stop("superseded");
    if (job.status === "cancelled") {
      jobEvents.completed("spec-kit", job.id, job.projectId, SPEC_KIT_JOB_CANCELLED_MESSAGE);
    } else {
      jobEvents.failed("spec-kit", job.id, job.projectId, genericFailureMessage("spec-kit"));
    }
  }
  return swept.length;
}

export interface StartSpecKitJobInput {
  /**
   * The job's id, when the caller derived it from a start token
   * ({@link specKitJobIdForStart}). A start whose id already exists in the
   * project throws {@link SpecKitJobAlreadyStartedError}. Default: a new UUID.
   */
  id?: string;
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
  /** Default {@link SPEC_KIT_JOB_SAVING_LIMIT_MS}. */
  savingLimitMs?: number;
  /** Waits between attempts to store the outcome. Default {@link SPEC_KIT_JOB_OUTCOME_RETRY_MS}. */
  outcomeRetryMs?: readonly number[];
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
 * already holds the same artifact set, and
 * {@link SpecKitJobAlreadyStartedError} when `input.id` is already a job.
 */
export async function startSpecKitJob(input: StartSpecKitJobInput): Promise<StartedSpecKitJob> {
  const activeKey = specKitJobActiveKey(input.projectId, input.featureSlug);
  const fresh = {
    id: input.id ?? randomUUID(),
    projectId: input.projectId,
    command: input.command,
    featureSlug: input.featureSlug,
    activeKey,
    startedById: input.actorId,
  };
  let row = await store.createJob(fresh);
  if (!row && input.id !== undefined) {
    // Refused by the primary key, not by the feature's key: this very start
    // already ran. (A job of another project can never have this id: the
    // project is part of what the id is derived from.)
    const same = await store.findJob(input.projectId, input.id);
    if (same) throw new SpecKitJobAlreadyStartedError(toSpecKitJobDto(same));
  }
  if (!row) {
    // The key is held. A holder with no process behind it is failed here, so a
    // restart never blocks a feature until the sweeper next runs; then try once
    // more (the holder may also simply have finished since the insert).
    await failStale({ activeKey });
    row = await store.createJob(fresh);
    if (!row) {
      throw new SpecKitJobConflictError(
        toSpecKitJobDtoOrNull(await store.findJobByActiveKey(activeKey)),
      );
    }
  }
  try {
    // #674 — durably, before the id leaves the server, so `subscribe:job` is
    // authorized on any replica.
    await recordJobScope(row.id, "spec-kit", input.projectId);
  } catch (err) {
    // The job never started and its id never left: remove the row rather than
    // leave it `running` with no runner, holding the feature until a sweep.
    await storeWithRetry(() => store.discardJob(fresh.id), input.outcomeRetryMs).catch(
      (discardErr: unknown) =>
        log.error("could not discard a Spec Kit job that never started", {
          jobId: fresh.id,
          error: String(discardErr),
        }),
    );
    throw err;
  }
  return { job: toSpecKitJobDto(row), done: runJob(row, activeKey, input) };
}

function toSpecKitJobDtoOrNull(row: SpecKitJobRow | null): SpecKitJobDto | null {
  return row ? toSpecKitJobDto(row) : null;
}

/** Run `write`, and again after each wait in `delays` while it throws. Throws the last error. */
async function storeWithRetry<T>(
  write: () => Promise<T>,
  delays: readonly number[] = SPEC_KIT_JOB_OUTCOME_RETRY_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (err) {
      const wait = delays[attempt];
      if (wait === undefined) throw err;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, wait).unref?.();
      });
    }
  }
}

const SUCCEEDED_OR_FAILED_FROM = ["running", "saving"];

/**
 * Write the job's own outcome, compare-and-set on the statuses it may be left
 * from. Returns the status that was written, or `null` when the row was no
 * longer this job's to write (a sweep or the time limit got there first).
 *
 * A command that ends while the row is `cancelling` — a cancel won the row and
 * the command never reached a commit point to notice — is `cancelled`: nothing
 * was saved, and the cancel was answered "cancelling".
 */
async function writeOutcome(id: string, outcome: JobOutcome): Promise<JobOutcome["status"] | null> {
  if (outcome.status !== "cancelled") {
    if (await store.finishJob(id, outcome, SUCCEEDED_OR_FAILED_FROM)) return outcome.status;
  }
  if (await store.finishJob(id, { status: "cancelled" }, ["cancelling"])) return "cancelled";
  return null;
}

/** Run the command to a terminal row. Never rejects. */
async function runJob(
  row: SpecKitJobRow,
  activeKey: string,
  input: StartSpecKitJobInput,
): Promise<SpecKitJobDto> {
  const { id, projectId } = row;
  const label = input.label ?? `/${input.command}`;
  const heartbeatMs = input.heartbeatMs ?? SPEC_KIT_JOB_HEARTBEAT_MS;
  // Phase writes are chained so two quick phases cannot land out of order.
  let phaseWrites: Promise<void> = Promise.resolve();
  let settled = false;
  // The saving deadline is a row transition too: `saving` → `failed`. It loses
  // to the job's own outcome and to a sweep. When it wins, the feature is free
  // again and the job's next write is refused; a write already in flight (the
  // one that hung) is past its check and may still land, which is what the
  // stored message says.
  let savingDeadline: ReturnType<typeof setTimeout> | undefined;
  const expireSaving = (): void => {
    store
      .finishJob(
        id,
        { status: "failed", error: JSON.stringify(SPEC_KIT_JOB_SAVING_STALLED_ERROR) },
        ["saving"],
      )
      .then((won) => {
        if (!won) return;
        log.error("a Spec Kit job was still saving at its saving deadline", { id, projectId });
        control.stop("superseded");
        jobEvents.failed("spec-kit", id, projectId, genericFailureMessage("spec-kit"));
      })
      .catch((err: unknown) => {
        log.warn("could not apply a Spec Kit job's saving deadline; trying again", {
          id,
          err: String(err),
        });
        if (settled) return;
        savingDeadline = setTimeout(expireSaving, heartbeatMs);
        savingDeadline.unref?.();
      });
  };
  const control: SpecKitJobControl = new SpecKitJobControl(
    id,
    projectId,
    activeKey,
    (text, progress) => {
      phaseWrites = phaseWrites
        .then(() => store.setJobPhase(id, text))
        .catch((err: unknown) => {
          log.warn("could not record a job phase", { id, err: String(err) });
        });
      jobEvents.progress("spec-kit", id, projectId, progress ?? 50, text);
    },
    () => {
      if (settled) return;
      savingDeadline = setTimeout(
        expireSaving,
        input.savingLimitMs ?? SPEC_KIT_JOB_SAVING_LIMIT_MS,
      );
      savingDeadline.unref?.();
    },
  );
  liveSpecKitJobs.set(id, control);

  const beat = async (): Promise<void> => {
    const status = await store.beatJob(id);
    if (status === null) control.stop("superseded");
    else if (status === "cancelling") control.stop("cancelled");
  };
  const heartbeat = setInterval(() => {
    beat().catch((err: unknown) => log.warn("job heartbeat failed", { id, err: String(err) }));
  }, heartbeatMs);
  heartbeat.unref?.();

  // The time limit is a row transition like any other: `running` → `failed`.
  // It loses to a job that is already `saving` (which has its own deadline,
  // above) and to a cancel (which then closes the row itself); when it wins, the
  // job's commit point is refused by the database whatever this process believes.
  let timeout: ReturnType<typeof setTimeout>;
  const expire = (): void => {
    store
      .finishJob(id, { status: "failed", error: JSON.stringify(SPEC_KIT_JOB_TIMEOUT_ERROR) }, [
        "running",
      ])
      .then((won) => {
        if (!won) return;
        control.stop("timeout");
        jobEvents.failed("spec-kit", id, projectId, genericFailureMessage("spec-kit"));
      })
      .catch((err: unknown) => {
        log.warn("could not apply a Spec Kit job's time limit; trying again", {
          id,
          err: String(err),
        });
        if (settled) return;
        timeout = setTimeout(expire, heartbeatMs);
        timeout.unref?.();
      });
  };
  timeout = setTimeout(expire, input.timeoutMs ?? resolveSpecKitJobTimeoutMs());
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
      // Cancelled: the row is `cancelling` and ours to close. Timed out or
      // superseded: somebody else already wrote the row; it is not ours.
      outcome = stopped.reason === "cancelled" ? { status: "cancelled" } : null;
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
    settled = true;
    clearInterval(heartbeat);
    clearTimeout(timeout);
    clearTimeout(savingDeadline);
    liveSpecKitJobs.delete(id);
  }

  try {
    await phaseWrites;
    if (outcome) {
      const final = outcome;
      // Retried: a single failed write here would otherwise leave the feature
      // locked, and the job reported interrupted, until the next sweep.
      const written = await storeWithRetry(() => writeOutcome(id, final), input.outcomeRetryMs);
      if (written === "succeeded") {
        jobEvents.completed("spec-kit", id, projectId, completion);
      } else if (written === "cancelled") {
        jobEvents.completed("spec-kit", id, projectId, SPEC_KIT_JOB_CANCELLED_MESSAGE);
      } else if (written === "failed") {
        jobEvents.failed("spec-kit", id, projectId, genericFailureMessage("spec-kit"));
      }
    }
    const stored = await storeWithRetry(() => store.findJob(projectId, id), input.outcomeRetryMs);
    if (stored) return toSpecKitJobDto(stored);
  } catch (err) {
    // The row stays live with no heartbeat, so the sweeper fails it shortly —
    // as "interrupted while saving" if it had begun to save, which is the truth.
    log.error("could not store a Spec Kit job's outcome", { jobId: id, error: String(err) });
  }
  // What this caller is told must not claim more than is known: a job that
  // reached its commit point may have saved everything.
  return {
    ...toSpecKitJobDto(row),
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: control.isSaving() ? SPEC_KIT_JOB_UNRECORDED_ERROR : SPEC_KIT_JOB_INTERRUPTED_ERROR,
  };
}

/**
 * A job of `projectId`, or `null` — including for another project's job id,
 * which must be indistinguishable from one that never existed (and is never
 * written to). A live job with no process behind it is failed on the way out,
 * so a read never reports a dead job as running.
 */
export async function getSpecKitJob(
  projectId: string,
  jobId: string,
): Promise<SpecKitJobDto | null> {
  const row = await store.findJob(projectId, jobId);
  if (!row) return null;
  if (!store.LIVE_STATUSES.includes(row.status)) return toSpecKitJobDto(row);
  if ((await failStale({ id: jobId, projectId })) === 0) return toSpecKitJobDto(row);
  return toSpecKitJobDtoOrNull(await store.findJob(projectId, jobId));
}

/** The live job that holds a feature (or, `null`, the project-level set), if any. */
export async function specKitJobHolding(
  projectId: string,
  featureSlug: string | null,
): Promise<SpecKitJobDto | null> {
  return toSpecKitJobDtoOrNull(
    await store.findJobByActiveKey(specKitJobActiveKey(projectId, featureSlug)),
  );
}

/** The project's live jobs, oldest first (dead ones are failed and left out). */
export async function listActiveSpecKitJobs(projectId: string): Promise<SpecKitJobDto[]> {
  await failStale({ projectId });
  return (await store.listLiveJobs(projectId)).map(toSpecKitJobDto);
}

/**
 * Cancel a job of `projectId`. Returns the job as it stands (a terminal job, or
 * one somebody already cancelled, is returned unchanged, so cancel is
 * idempotent), `null` when there is no such job in the project, and throws
 * {@link SpecKitJobSavingError} once the job is writing its artifacts.
 *
 * The cancel IS the row transition `running` → `cancelling`. It and the job's
 * commit point (`running` → `saving`) are conditional on the same status, so
 * exactly one of them happens: a cancel that is answered "cancelling" is never
 * followed by a save, on this replica or another. Only a cancel that won the
 * row is audited.
 */
export async function cancelSpecKitJob(
  projectId: string,
  jobId: string,
  actorId: string | null,
): Promise<SpecKitJobDto | null> {
  const row = await store.findJob(projectId, jobId);
  if (!row) return null;
  if (!store.LIVE_STATUSES.includes(row.status)) return toSpecKitJobDto(row);
  // A job with no process behind it is failed, not cancelled.
  if ((await failStale({ id: jobId, projectId })) === 0) {
    if (await store.markJobCancelling(projectId, jobId)) {
      // A job of this process stops its model call now; another replica's
      // notices at its next heartbeat, or at its commit point, whichever is first.
      liveSpecKitJobs.get(jobId)?.stop("cancelled");
      audit({
        actor: actorId ? { id: actorId } : null,
        action: "spec_kit.job.cancelled",
        target: { type: "project", id: projectId },
        metadata: {
          jobId,
          command: row.command,
          featureSlug: row.featureSlug,
          startedById: row.startedById,
        },
      });
    }
  }
  const after = await store.findJob(projectId, jobId);
  if (after?.status === "saving") throw new SpecKitJobSavingError();
  return toSpecKitJobDtoOrNull(after);
}

/**
 * Fail every live job whose heartbeat stopped, and prune jobs that finished
 * more than {@link SPEC_KIT_JOB_RETENTION_MS} ago. Returns how many were failed.
 */
export async function failInterruptedSpecKitJobs(): Promise<number> {
  const failed = await failStale({});
  if (failed > 0) log.warn("Failed interrupted Spec Kit jobs", { count: failed });
  await store.pruneFinishedJobs(SPEC_KIT_JOB_RETENTION_MS);
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
