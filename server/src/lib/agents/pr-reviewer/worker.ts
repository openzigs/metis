/**
 * Epic #394 P2 review F4 — Production worker entrypoint for the
 * PR-reviewer queue.
 *
 * Responsibilities:
 *   1. Construct the in-memory `PrReviewQueue` with a real processor
 *      that re-runs `runPrReview` for each enqueued payload.
 *   2. Wire `onDeadLetter` to a `pr_review.dlq` audit row so DLQ jobs
 *      are observable instead of silently vanishing (review C2 / S3).
 *   3. Schedule periodic `purgeOldDeliveries` so the dedup table cannot
 *      grow unbounded (review F1).
 *
 * Lifecycle:
 *   - `startWorker()` is called once from `server.ts` at boot.
 *   - The returned handle exposes `queue` (so the webhook router can
 *     enqueue against the same instance) and `shutdown()` which cancels
 *     the purge interval, calls `queue.shutdown()`, and waits for any
 *     in-flight processor invocation to finish.
 *
 * Test seams:
 *   - `processor` may be overridden so unit tests can drive the DLQ +
 *     purge plumbing without booting the real review agent.
 *   - `setInterval` is injected so the purge cadence can be advanced
 *     without real wall-clock waits.
 *   - `audit` is injected so tests can capture the emitted DLQ audit
 *     entries directly.
 */
import { audit as defaultAudit } from "../../audit/audit-service.js";
import { createChildLogger } from "../../logger.js";
import {
  jobEvents as defaultJobEvents,
  genericFailureMessage,
  type JobEventEmitter,
} from "../../socket/job-events.js";
import {
  createPrReviewQueue,
  type PrReviewJob,
  type PrReviewQueue,
  type PrReviewProcessor,
} from "./queue.js";
import { purgeOldDeliveries } from "./webhook-dedup.js";
import { executePrReviewJob, type PrReviewJobProject } from "./pr-review-job.js";
import type { JudgeLike, RunPrReviewDeps } from "./agent.js";
import type { OctokitLike } from "./github-review-poster.js";
import type { DiffFetchOctokit } from "./diff-fetcher.js";

const log = createChildLogger("pr-review-worker");

/** Default purge cadence — every 1h. */
export const DEFAULT_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Per-job context resolver — given a queued job, resolves the Metis
 * project (RepoConnection lookup) plus the judge + octokit clients
 * needed to run the review. Injected from `server.ts` so the worker
 * doesn't import production wiring directly. Returning `null` from any
 * field causes the processor to log a structured warn + skip the job
 * instead of throwing (which would push it onto the DLQ).
 */
export interface PrReviewProcessorDeps {
  resolveProject(job: PrReviewJob): Promise<PrReviewJobProject | null>;
  resolveJudge(job: PrReviewJob): Promise<JudgeLike | null>;
  resolveOctokit(job: PrReviewJob): Promise<(OctokitLike & DiffFetchOctokit) | null>;
  /** Optional per-job budget override (test seam). Default: agent's default. */
  resolveBudget?(job: PrReviewJob): Promise<RunPrReviewDeps["budget"] | undefined>;
}

export interface StartWorkerOptions {
  /**
   * Real PR-review processor. Required when `processorDeps` is omitted.
   * When `processorDeps` is provided, this override wins (test seam).
   */
  processor?: PrReviewProcessor;
  /**
   * Production processor wiring. When provided, the worker constructs
   * a default processor that resolves the project + judge + octokit per
   * job and calls `executePrReviewJob`. This is the real PR-review
   * agent entrypoint — without it, enqueued jobs are logged + dropped
   * (see `processor` fallback below).
   */
  processorDeps?: PrReviewProcessorDeps;
  /** Per-(owner/repo) concurrency cap. Default 2. */
  concurrencyPerRepo?: number;
  /** Max retry attempts (inclusive of first try). Default 3. */
  maxAttempts?: number;
  /** Override backoff schedule (ms before attempts 2..N). */
  backoffMs?: number[];
  /** Override the dedup-row purge interval. Default 1h. */
  purgeIntervalMs?: number;
  /** Test seam — override the audit emitter. */
  audit?: typeof defaultAudit;
  /** Test seam — override `setInterval`. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  /** Test seam — override `clearInterval`. */
  clearInterval?: (handle: unknown) => void;
  /** Test seam — override `setTimeout`-like for queue retry timers. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Test seam — override the periodic purge implementation. */
  purge?: () => Promise<number>;
  /**
   * Epic #406 (#421) — realtime job-events emitter. Defaults to the live
   * `jobEvents` bus (resolves the socket.io server lazily via the registry).
   * Injected so unit tests can capture the emitted `pr-review` lifecycle
   * transitions without booting socket.io.
   */
  jobEvents?: JobEventEmitter;
}

export interface PrReviewWorkerHandle {
  /** Live queue — the webhook router enqueues against this. */
  queue: PrReviewQueue;
  /** Cancel the purge interval, shutdown the queue, and wait for in-flight to finish. */
  shutdown(): Promise<void>;
}

/**
 * Wire the queue + DLQ→audit hook + periodic dedup-row purge.
 * Returns a handle suitable for graceful shutdown wiring in `index.ts`.
 */
export function startWorker(opts: StartWorkerOptions): PrReviewWorkerHandle {
  const auditFn = opts.audit ?? defaultAudit;
  const setIntervalFn = opts.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    opts.clearInterval ??
    ((h: unknown) => {
      // node setInterval returns an opaque handle; clearInterval typings
      // accept it directly. The cast keeps the test-seam clean.
      clearInterval(h as ReturnType<typeof setInterval>);
    });
  const purgeFn = opts.purge ?? (() => purgeOldDeliveries());
  const purgeMs = opts.purgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS;

  const processor = opts.processor ?? buildDefaultProcessor(opts.processorDeps);
  const events = opts.jobEvents ?? defaultJobEvents;

  const queue = createPrReviewQueue({
    processor,
    ...(opts.concurrencyPerRepo != null ? { concurrencyPerRepo: opts.concurrencyPerRepo } : {}),
    ...(opts.maxAttempts != null ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.backoffMs != null ? { backoffMs: opts.backoffMs } : {}),
    ...(opts.setTimer != null ? { setTimer: opts.setTimer } : {}),
    // Epic #406 (#421) — bridge the queue's lifecycle transitions onto the
    // realtime `jobEvents` bus under the `pr-review` JobKind. The queue passes
    // the SAME jobId it returned from enqueue(), so the UI subscribing to
    // `job:{jobId}` after the POST response gets live progress + a terminal
    // result. The `failed` payload uses the GENERIC user-safe message
    // (#254 invariant) so a raw error/secret never reaches clients, and the
    // job is scoped to its `project:{projectId}` room so only authorized
    // viewers of that project receive it.
    onLifecycle: (e) => {
      const projectId = e.projectId || null;
      switch (e.phase) {
        case "started":
          events.started("pr-review", e.jobId, projectId, `Reviewing PR #${e.prNumber}`);
          break;
        case "progress":
          events.progress(
            "pr-review",
            e.jobId,
            projectId,
            e.progress ?? 0,
            `Reviewing PR #${e.prNumber}`,
          );
          break;
        case "completed":
          events.completed("pr-review", e.jobId, projectId, `PR #${e.prNumber} review complete`);
          break;
        case "failed":
          // Never leak `e.error` (raw message) to the socket — map to the
          // stable, user-safe string. The raw error stays in the DLQ audit row
          // + worker logs below.
          events.failed("pr-review", e.jobId, projectId, genericFailureMessage("pr-review"));
          break;
      }
    },
    onDeadLetter: (job: PrReviewJob, err: Error) => {
      // Emit `pr_review.dlq` audit row so DLQ jobs are observable.
      // This satisfies #403 AC: "DLQ after final failure with audit row".
      try {
        auditFn({
          actor: { id: null },
          action: "pr_review.dlq",
          target: {
            type: "pull_request",
            id: `${job.owner}/${job.repo}#${job.prNumber}`,
          },
          metadata: {
            jobId: `prr-${job.deliveryId || "no-delivery"}`,
            deliveryId: job.deliveryId,
            projectId: job.projectId,
            repoOwner: job.owner,
            repoName: job.repo,
            prNumber: job.prNumber,
            attempt: job.attempt,
            errorMessage: err.message,
            enqueuedAt: new Date(job.enqueuedAt).toISOString(),
          },
        });
      } catch (auditErr) {
        // The DLQ hook MUST NOT crash the worker — log + continue.
        log.error("pr_review.dlq_audit_failed", {
          error: (auditErr as Error).message,
        });
      }
      log.warn("pr_review.dlq", {
        deliveryId: job.deliveryId,
        prNumber: job.prNumber,
        repo: `${job.owner}/${job.repo}`,
        attempt: job.attempt,
        error: err.message,
      });
    },
  });

  // Periodic purge of the dedup table. Best-effort — failures are
  // logged but never crash the worker.
  const intervalHandle = setIntervalFn(() => {
    purgeFn()
      .then((count) => {
        if (count > 0) {
          log.info("pr_review.dedup_purge", { rowsDeleted: count });
        }
      })
      .catch((err) => {
        log.warn("pr_review.dedup_purge_failed", {
          error: (err as Error).message,
        });
      });
  }, purgeMs);
  // Don't keep the event loop alive purely for the purge timer.
  // Best-effort — `unref` only exists on the node Timeout object.
  if (intervalHandle && typeof (intervalHandle as { unref?: () => void }).unref === "function") {
    (intervalHandle as { unref: () => void }).unref();
  }

  return {
    queue,
    async shutdown() {
      clearIntervalFn(intervalHandle);
      await queue.shutdown();
    },
  };
}

/**
 * Build the default in-process processor that resolves per-job context
 * + delegates to `executePrReviewJob`. When `deps` is omitted (no
 * production wiring) we fall back to a structured warn so an unwired
 * deploy is loudly observable instead of silently dropping reviews.
 */
function buildDefaultProcessor(deps?: PrReviewProcessorDeps): PrReviewProcessor {
  if (!deps) {
    return async (job) => {
      log.warn("pr_review.processor_unconfigured", {
        deliveryId: job.deliveryId,
        repo: `${job.owner}/${job.repo}`,
        prNumber: job.prNumber,
      });
    };
  }
  return async (job) => {
    const project = await deps.resolveProject(job);
    if (!project) {
      log.warn("pr_review.project_unresolved", {
        deliveryId: job.deliveryId,
        repo: `${job.owner}/${job.repo}`,
        prNumber: job.prNumber,
      });
      return;
    }
    const [judge, octokit, budget] = await Promise.all([
      deps.resolveJudge(job),
      deps.resolveOctokit(job),
      deps.resolveBudget?.(job) ?? Promise.resolve(undefined),
    ]);
    if (!judge || !octokit) {
      log.warn("pr_review.deps_unresolved", {
        deliveryId: job.deliveryId,
        repo: `${job.owner}/${job.repo}`,
        prNumber: job.prNumber,
        hasJudge: !!judge,
        hasOctokit: !!octokit,
      });
      return;
    }
    const installationId = (job.context.installationId as string | null | undefined) ?? null;
    const prTitle = (job.context.prTitle as string | undefined) ?? `PR #${job.prNumber}`;
    const prBody = (job.context.prBody as string | undefined) ?? "";
    const prUrl =
      (job.context.prUrl as string | undefined) ??
      `https://github.com/${job.owner}/${job.repo}/pull/${job.prNumber}`;
    await executePrReviewJob(
      {
        job,
        project,
        prTitle,
        prBody,
        prUrl,
        installationId,
        actor: { type: "webhook", id: null },
      },
      { judge, octokit, ...(budget ? { budget } : {}) },
    );
  };
}
