/**
 * Epic #394 P2 (#403) — In-memory async queue for the PR-reviewer.
 *
 * Replaces the inline LLM call inside the webhook handler with an
 * enqueue → ack → background-process pipeline so the webhook responds in
 * <100ms (well under GitHub's 10s retry threshold).
 *
 * Design choices (per scaffold instructions):
 *   - In-memory queue, NOT BullMQ — deferring the Redis dep until v1.4.
 *     Process-local. Survives node lifetime only — that's acceptable
 *     because (a) GitHub will re-deliver any in-flight events on the
 *     next poke and (b) every job persists its outcome via AgentRun
 *     before the queue forgets about it.
 *   - Per-repo concurrency cap (default 2) to stay under GitHub
 *     secondary rate limits.
 *   - Exponential-backoff retry: 3 attempts, 1s/4s/16s. After the third
 *     failure the job lands in the in-memory DLQ AND an audit row is
 *     emitted so operators can replay manually.
 *   - The processor is injected so the unit tests can drive the queue
 *     without booting the real review agent.
 */

export interface PrReviewJobPayload {
  /** Stable id for logs / dedup audit — typically the X-GitHub-Delivery UUID. */
  deliveryId: string;
  projectId: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** Free-form payload the processor needs (PR object, action, installation id, etc.). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: Record<string, any>;
}

export interface PrReviewJob extends PrReviewJobPayload {
  attempt: number;
  enqueuedAt: number;
}

export type PrReviewProcessor = (job: PrReviewJob) => Promise<void>;

/**
 * Epic #406 (#421) — lifecycle phase for the realtime job-events bus.
 *
 * The queue is the single place that owns the `jobId` returned by
 * {@link PrReviewQueue.enqueue}, so it is also the single place that can emit
 * lifecycle transitions keyed by that SAME id. The webhook path and the manual
 * re-review path both flow through here, so wiring the emit here makes BOTH
 * observable without a second, divergent id.
 *
 *   - `started`   — fired once when a job is first dispatched to the processor.
 *   - `progress`  — fired at meaningful steps while the review runs.
 *   - `completed` — fired once when the processor resolves (progress=100).
 *   - `failed`    — fired ONCE, only after retries are exhausted (the job has
 *                   landed in the DLQ). Intermediate retryable failures do NOT
 *                   emit `failed` so the UI doesn't flash a terminal error that
 *                   a retry then clears.
 */
export type PrReviewLifecyclePhase = "started" | "progress" | "completed" | "failed";

/** A single lifecycle transition the queue reports via {@link PrReviewQueueOptions.onLifecycle}. */
export interface PrReviewLifecycleEvent {
  phase: PrReviewLifecyclePhase;
  /** The same `jobId` that `enqueue()` returned to the caller. */
  jobId: string;
  projectId: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** 0-100 completion when known (`completed` pins to 100). */
  progress?: number;
  /** Raw error message — `failed` only. Mapped to a user-safe string downstream. */
  error?: string;
}

export interface PrReviewQueueOptions {
  processor: PrReviewProcessor;
  /** Per-(owner/repo) concurrency cap. Default 2. */
  concurrencyPerRepo?: number;
  /** Max retry attempts (inclusive of first try). Default 3. */
  maxAttempts?: number;
  /** Backoff schedule in ms: index 0 = delay before attempt 2, etc. */
  backoffMs?: number[];
  /** Override the timer source — tests inject `setTimeout`-like fakes. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** DLQ sink — receives the final-failure job + error. */
  onDeadLetter?: (job: PrReviewJob, err: Error) => void;
  /**
   * Epic #406 (#421) — lifecycle observer. Called with the SAME `jobId`
   * `enqueue()` returned so a single emit site covers both the webhook and
   * manual re-review paths. Best-effort: a throwing callback is swallowed and
   * never crashes the worker loop (mirrors the `onDeadLetter` contract).
   */
  onLifecycle?: (event: PrReviewLifecycleEvent) => void;
}

export interface PrReviewQueue {
  /**
   * Enqueue a job. Returns immediately (sub-100ms target — does not wait
   * for processing). Per-repo serial / capped — multiple enqueues for the
   * same `(owner, repo)` are serialized through a small worker pool.
   */
  enqueue(payload: PrReviewJobPayload): { jobId: string; queueDepth: number };
  /** Inspect queue depth (test introspection). */
  depth(): number;
  /** Inspect dead-letter queue contents (test introspection). */
  deadLetters(): ReadonlyArray<{ job: PrReviewJob; error: string }>;
  /**
   * Resolve when every currently in-flight + queued job has reached a
   * terminal state (completed or DLQ). Used by integration tests + a
   * graceful-shutdown hook in production.
   */
  drain(): Promise<void>;
  /**
   * Graceful shutdown (Epic #394 P2 review F4).
   *   - Marks the queue as shutting down so new enqueues are rejected.
   *   - Cancels the scheduled re-enqueue of any retry timer so the
   *     process can exit without re-firing into a dead worker pool.
   *   - Awaits in-flight processors via `drain()` so the AgentRun row
   *     is finalised before exit.
   *
   * Idempotent. Safe to call from a SIGTERM handler.
   */
  shutdown(): Promise<void>;
  /** True after `shutdown()` has been called. Test introspection. */
  isShuttingDown(): boolean;
}

interface InternalJob extends PrReviewJob {
  jobId: string;
}

const DEFAULT_BACKOFF_MS = [1_000, 4_000, 16_000];
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 3;

export function createPrReviewQueue(opts: PrReviewQueueOptions): PrReviewQueue {
  const concurrency = Math.max(1, opts.concurrencyPerRepo ?? DEFAULT_CONCURRENCY);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoff = opts.backoffMs?.length ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));

  /** Per-repo state: pending jobs + in-flight count. */
  const lanes = new Map<string, { pending: InternalJob[]; inFlight: number }>();
  const dlq: Array<{ job: PrReviewJob; error: string }> = [];
  /** Promises representing every in-flight processor invocation. */
  const inFlightPromises = new Set<Promise<void>>();
  /**
   * Cancellation tokens for retry timers. Each retry that hasn't fired
   * yet has an entry here so `shutdown()` can cancel it before it
   * re-enqueues into a queue that nobody is draining (Epic #394 P2 / C2).
   */
  const pendingRetryCancels = new Set<{ cancel: () => void }>();
  let pendingTotal = 0;
  let nextJobSeq = 0;
  let shuttingDown = false;

  /**
   * Emit a lifecycle transition to the optional observer. Best-effort: a
   * throwing callback is swallowed so socket/transport errors never reach the
   * job's critical path (#421).
   */
  function emitLifecycle(
    phase: PrReviewLifecyclePhase,
    job: InternalJob,
    extra: { progress?: number; error?: string } = {},
  ): void {
    if (!opts.onLifecycle) return;
    try {
      opts.onLifecycle({
        phase,
        jobId: job.jobId,
        projectId: job.projectId,
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        ...extra,
      });
    } catch {
      // never let a lifecycle observer crash the worker loop
    }
  }

  function laneKey(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  function getLane(key: string): { pending: InternalJob[]; inFlight: number } {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { pending: [], inFlight: 0 };
      lanes.set(key, lane);
    }
    return lane;
  }

  function tryDispatch(key: string): void {
    const lane = lanes.get(key);
    if (!lane) return;
    while (lane.inFlight < concurrency && lane.pending.length > 0) {
      const job = lane.pending.shift()!;
      pendingTotal -= 1;
      lane.inFlight += 1;
      const promise = runJob(job).finally(() => {
        lane.inFlight -= 1;
        inFlightPromises.delete(promise);
        // After release, try to dispatch more on this lane.
        tryDispatch(key);
      });
      inFlightPromises.add(promise);
    }
  }

  async function runJob(job: InternalJob): Promise<void> {
    // Emit `started` + an initial `progress` only on the first attempt so a
    // retry doesn't re-announce a fresh "started" to subscribers that have
    // already seen progress. The terminal `completed`/`failed` are emitted
    // exactly once below (on success, or after retries are exhausted).
    if (job.attempt === 1) {
      emitLifecycle("started", job);
      emitLifecycle("progress", job, { progress: 10 });
    }
    try {
      await opts.processor(job);
      emitLifecycle("completed", job, { progress: 100 });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (job.attempt >= maxAttempts) {
        const entry = { job, error: error.message };
        dlq.push(entry);
        // Surface a single terminal `failed` only after the DLQ — intermediate
        // retryable failures stay silent so the UI doesn't flash an error that
        // a retry then clears.
        emitLifecycle("failed", job, { error: error.message });
        try {
          opts.onDeadLetter?.(job, error);
        } catch {
          // never let DLQ side effects crash the worker
        }
        return;
      }
      const delay = backoff[Math.min(job.attempt - 1, backoff.length - 1)];
      const next: InternalJob = { ...job, attempt: job.attempt + 1 };
      // Schedule re-enqueue. We deliberately go through `enqueueInternal`
      // so the per-repo lane is rebuilt and dispatched the same way as a
      // fresh enqueue — this preserves concurrency caps across retries.
      //
      // Track the timer in `pendingRetryCancels` so `shutdown()` can
      // cancel it. We can't rely on the return value of `setTimer`
      // having `.unref()` (the test seam returns `unknown`), so we use
      // a small token closure pattern with a `cancelled` boolean.
      const token: { cancel: () => void; cancelled: boolean } = {
        cancelled: false,
        cancel: () => {
          token.cancelled = true;
        },
      };
      pendingRetryCancels.add(token);
      setTimer(() => {
        pendingRetryCancels.delete(token);
        if (token.cancelled || shuttingDown) return;
        const lane = getLane(laneKey(next.owner, next.repo));
        lane.pending.push(next);
        pendingTotal += 1;
        tryDispatch(laneKey(next.owner, next.repo));
      }, delay);
    }
  }

  function enqueueInternal(payload: PrReviewJobPayload): {
    jobId: string;
    queueDepth: number;
  } {
    if (shuttingDown) {
      // The webhook handler must never crash on a shutdown race — return
      // a sentinel job id and depth=-1 so callers can log + drop without
      // their request hanging. The dedup row is already persisted, so
      // GitHub's redelivery on the next process will pick it up.
      return { jobId: "prr-shutdown-rejected", queueDepth: -1 };
    }
    const key = laneKey(payload.owner, payload.repo);
    const lane = getLane(key);
    nextJobSeq += 1;
    const job: InternalJob = {
      ...payload,
      attempt: 1,
      enqueuedAt: Date.now(),
      jobId: `prr-${nextJobSeq}-${payload.deliveryId || "no-delivery"}`,
    };
    lane.pending.push(job);
    pendingTotal += 1;
    tryDispatch(key);
    return { jobId: job.jobId, queueDepth: pendingTotal };
  }

  return {
    enqueue: enqueueInternal,
    depth: () => pendingTotal,
    deadLetters: () => dlq.slice(),
    drain: async () => {
      // Drain in waves — each wave may schedule retries that add new
      // promises. Loop until both pending + in-flight reach zero.
      // Bound the loop so a misbehaving processor cannot deadlock the
      // shutdown path forever.
      for (let i = 0; i < 1000; i += 1) {
        if (pendingTotal === 0 && inFlightPromises.size === 0) return;
        const snapshot = Array.from(inFlightPromises);
        if (snapshot.length === 0) {
          // Nothing in-flight but we still have pending — yield so any
          // setTimer-scheduled re-enqueues can fire.
          await new Promise<void>((resolve) => setTimer(() => resolve(), 0));
          continue;
        }
        await Promise.allSettled(snapshot);
      }
    },
    shutdown: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Cancel every retry that hasn't fired yet so we don't re-enqueue
      // into a worker pool that the process is about to exit.
      for (const token of pendingRetryCancels) token.cancel();
      pendingRetryCancels.clear();
      // Drop pending (non-in-flight) jobs from each lane. They will be
      // re-delivered by GitHub on the next process boot via the dedup
      // table fall-through.
      for (const lane of lanes.values()) {
        pendingTotal -= lane.pending.length;
        lane.pending.length = 0;
      }
      // Wait for in-flight processors to finish so audit + AgentRun
      // rows are written before exit.
      const snapshot = Array.from(inFlightPromises);
      if (snapshot.length > 0) await Promise.allSettled(snapshot);
    },
    isShuttingDown: () => shuttingDown,
  };
}
