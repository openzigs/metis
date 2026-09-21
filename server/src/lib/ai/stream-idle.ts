/**
 * #1366 — idle-timeout guard for a provider stream.
 *
 * `/api/ai/stream` already had a 60s socket timeout, a 15s heartbeat and a 5min
 * hard ceiling. None of them caught the observed failure: streaming halted after
 * 215 characters, mid-word, and stayed frozen for 13+ minutes with no toast, no
 * console error and no failed request. The socket timeout could not fire because
 * the heartbeat keeps writing, and the hard ceiling is a TOTAL-duration cap — it
 * cannot tell a stalled stream from a slow but progressing one, and a stall
 * inside a long turn simply waits out the remaining budget.
 *
 * What was missing is an IDLE cap: no token for N seconds. That is what this
 * wraps around the provider's async iterable. Each chunk resets the clock, so a
 * genuinely slow answer is never cut off, while silence is bounded.
 *
 * Partial output is preserved by construction: every chunk already yielded has
 * been written to the socket before the timeout throws.
 */

export const STREAM_IDLE_TIMEOUT_CODE = "STREAM_IDLE_TIMEOUT";

export class StreamIdleTimeoutError extends Error {
  readonly code = STREAM_IDLE_TIMEOUT_CODE;
  readonly idleMs: number;
  constructor(idleMs: number) {
    super(`Stream produced no output for ${idleMs}ms`);
    this.name = "StreamIdleTimeoutError";
    this.idleMs = idleMs;
  }
}

/** Sentinel distinguishable from any provider chunk. */
const IDLE = Symbol("idle");

/**
 * Yield from `source`, throwing {@link StreamIdleTimeoutError} if more than
 * `idleMs` passes without a chunk. `onTimeout` runs first so the caller can
 * abort the upstream request before the error propagates.
 *
 * `idleMs <= 0` disables the guard and passes the source straight through, so a
 * deployment can turn it off without a code path change.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onTimeout?: () => void,
): AsyncGenerator<T> {
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    yield* source;
    return;
  }
  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<typeof IDLE>((resolve) => {
      timer = setTimeout(() => resolve(IDLE), idleMs);
      timer.unref?.();
    });
    let winner: IteratorResult<T> | typeof IDLE;
    try {
      winner = await Promise.race([iterator.next(), idle]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (winner === IDLE) {
      onTimeout?.();
      // Deliberately NOT awaited: `return()` on a generator with a pending
      // `next()` is queued behind it, so awaiting here would hang for exactly
      // as long as the stall we are escaping.
      void Promise.resolve(iterator.return?.(undefined as never)).catch(() => {});
      throw new StreamIdleTimeoutError(idleMs);
    }
    if (winner.done) return;
    yield winner.value;
  }
}
