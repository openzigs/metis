/**
 * Module-local singleton for the PR-reviewer worker handle.
 *
 * The webhook router (`routes/webhooks-github.ts`) is constructed inside
 * `createApp()` long before `createServer()` has had a chance to spin up
 * the worker, so we cannot pass the queue in via the router factory
 * without restructuring boot order. Instead the bootstrap sets the
 * singleton after `startWorker()` returns and the webhook handler reads
 * it on every delivery.
 *
 * Tests that don't want the real worker simply skip the setter — the
 * webhook router falls back to its inline path (or to an injected
 * `deps.queue`) exactly as before.
 */
import type { PrReviewWorkerHandle } from "./worker.js";
import { createChildLogger } from "../../logger.js";

const log = createChildLogger("pr-review-worker-singleton");

let current: PrReviewWorkerHandle | null = null;

/**
 * Install the active worker handle. If a previous singleton was set
 * (typical in tests that call `createServer()` repeatedly), its
 * `shutdown()` is invoked first so the periodic `setInterval` purge
 * timer + any in-flight processors are cleaned up before the new
 * handle takes over. Failures are logged but never thrown — the new
 * handle MUST be installed even if the old one's shutdown rejects.
 */
export function setPrReviewWorker(handle: PrReviewWorkerHandle | null): void {
  const previous = current;
  current = handle;
  if (previous && previous !== handle) {
    Promise.resolve(previous.shutdown()).catch((err) => {
      log.warn("pr_review.previous_worker_shutdown_failed", {
        error: (err as Error).message,
      });
    });
  }
}

export function getPrReviewWorker(): PrReviewWorkerHandle | null {
  return current;
}
