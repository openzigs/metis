/**
 * Process-wide FIFO concurrency limiter for the local (Ollama / OpenAI-compatible)
 * provider.
 *
 * WHY: Ollama serves ONE request per loaded model at a time by default
 * (`OLLAMA_NUM_PARALLEL` unset = 1 — a FIFO semaphore in front of llama-server)
 * and sends NO bytes, not even response headers, until the request it is
 * serving produces its first token. METIS issues several concurrent local
 * requests (docs-gen Phase 1 runs three modules at once, plus grounding calls,
 * plus chat), so the extra requests sat in Ollama's own queue while METIS's
 * first-byte clock was already running: a request that was merely QUEUED behind
 * a long generation was aborted as a "stall", and three Phase-1 modules lost
 * their facts that way in one measured run.
 *
 * The fix is to queue INSIDE METIS instead: at most `LOCAL_GEMMA_MAX_CONCURRENCY`
 * (default 1, matching Ollama's default) requests are in flight to one base URL,
 * shared by every caller in the process, and the provider arms its first-byte /
 * idle / request timers only AFTER it holds a slot — so queue time can never be
 * mistaken for a stall.
 */
import { createChildLogger } from "../../logger.js";

const log = createChildLogger("ai-local-concurrency");

/** Env knob: max in-flight requests per local base URL. */
export const LOCAL_MAX_CONCURRENCY_ENV = "LOCAL_GEMMA_MAX_CONCURRENCY";

/** Ollama's own default (`OLLAMA_NUM_PARALLEL` unset). */
export const DEFAULT_LOCAL_MAX_CONCURRENCY = 1;

/**
 * Parse `LOCAL_GEMMA_MAX_CONCURRENCY` STRICTLY: plain decimal digits, value ≥ 1
 * and a safe integer. Unset/blank keeps the default silently; anything else
 * invalid (`0`, `-2`, `1.5`, `2e1`, `abc`) keeps the default and warns.
 */
export function resolveLocalMaxConcurrency(
  raw: string | undefined = process.env[LOCAL_MAX_CONCURRENCY_ENV],
): number {
  if (raw == null || raw.trim().length === 0) return DEFAULT_LOCAL_MAX_CONCURRENCY;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n >= 1) return n;
  }
  log.warn("Ignoring invalid local concurrency limit; keeping the default", {
    env: LOCAL_MAX_CONCURRENCY_ENV,
    value: raw.slice(0, 40),
    default: DEFAULT_LOCAL_MAX_CONCURRENCY,
  });
  return DEFAULT_LOCAL_MAX_CONCURRENCY;
}

/** Releases a held slot. Idempotent: a second call is a no-op. */
export type ReleaseSlot = () => void;

interface Waiter {
  grant: () => void;
  enqueuedAt: number;
}

/**
 * A FIFO counting semaphore. A released slot is handed DIRECTLY to the oldest
 * waiter (the in-flight count never dips), so a late arrival can never barge
 * ahead of a request that has been queueing.
 */
export class FifoSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly limit: number,
    private readonly label: string,
  ) {}

  /** Requests currently holding a slot. */
  get inFlight(): number {
    return this.active;
  }

  /** Requests waiting for a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Wait for a slot. Resolves with an idempotent release function. Rejects with
   * an `AbortError` if `signal` aborts while still queued (the waiter is removed,
   * so it never consumes a slot).
   */
  acquire(signal?: AbortSignal): Promise<ReleaseSlot> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    const position = this.waiters.length + 1;
    log.debug("Local model request waiting for a concurrency slot", {
      target: this.label,
      limit: this.limit,
      inFlight: this.active,
      position,
    });
    return new Promise<ReleaseSlot>((resolve, reject) => {
      const waiter: Waiter = {
        enqueuedAt: Date.now(),
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          log.debug("Local model request acquired a concurrency slot after waiting", {
            target: this.label,
            limit: this.limit,
            waitedMs: Date.now() - waiter.enqueuedAt,
            stillQueued: this.waiters.length,
          });
          resolve(this.releaser());
        },
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the slot straight over — `active` is unchanged.
        next.grant();
      } else {
        this.active--;
      }
    };
  }
}

function abortError(): Error {
  return new DOMException("Aborted", "AbortError");
}

const limiters = new Map<string, FifoSemaphore>();

/**
 * The process-wide limiter for `baseUrl`, created on first use with the limit
 * read from `LOCAL_GEMMA_MAX_CONCURRENCY` at that moment. Every provider
 * instance pointed at the same base URL — docs-gen Phase 1 and 2, the claim
 * extractor, the judge, chat — shares it.
 */
export function localConcurrencyLimiter(baseUrl: string): FifoSemaphore {
  const key = baseUrl.replace(/\/+$/, "");
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new FifoSemaphore(resolveLocalMaxConcurrency(), key);
    limiters.set(key, limiter);
    log.info("Local model concurrency limit in effect", {
      target: key,
      maxConcurrency: limiter.limit,
      env: LOCAL_MAX_CONCURRENCY_ENV,
    });
  }
  return limiter;
}

/** Test-only: forget every limiter so the next use re-reads the env. */
export function resetLocalConcurrencyLimitersForTests(): void {
  limiters.clear();
}
