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
  /**
   * #127 — when given, the FIRST idle clock starts only once this settles (the
   * provider acquired its local concurrency slot), so time queued behind
   * another generation is never counted as a stall. Later chunks are timed
   * from the previous chunk as usual.
   */
  startAfter?: Promise<unknown>,
): AsyncGenerator<T> {
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    yield* source;
    return;
  }
  const iterator = source[Symbol.asyncIterator]();
  let gate: Promise<unknown> | undefined = startAfter;
  // #128 — true once the source itself is finished (it reported `done`, threw,
  // or was already told to stop by the idle path). Anything else that leaves
  // this generator — a consumer that `break`s after the provider's `done`
  // chunk, a `collectStream`, a throw in the consumer's loop body — must pass
  // the stop on to the source, or the provider's `finally` (which releases the
  // local concurrency slot) never runs and every later local call on that base
  // URL queues behind a slot nobody will ever free.
  let sourceFinished = false;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const arm = (resolve: (v: typeof IDLE) => void): void => {
        if (settled) return;
        timer = setTimeout(() => resolve(IDLE), idleMs);
        timer.unref?.();
      };
      const idle = new Promise<typeof IDLE>((resolve) => {
        if (gate)
          void gate.then(
            () => arm(resolve),
            () => arm(resolve),
          );
        else arm(resolve);
      });
      gate = undefined;
      let winner: IteratorResult<T> | typeof IDLE;
      try {
        winner = await Promise.race([iterator.next(), idle]);
      } catch (err) {
        sourceFinished = true; // a source that threw is already closed
        throw err;
      } finally {
        settled = true;
        if (timer) clearTimeout(timer);
      }
      if (winner === IDLE) {
        sourceFinished = true;
        onTimeout?.();
        // Deliberately NOT awaited: `return()` on a generator with a pending
        // `next()` is queued behind it, so awaiting here would hang for exactly
        // as long as the stall we are escaping.
        void Promise.resolve(iterator.return?.(undefined as never)).catch(() => {});
        throw new StreamIdleTimeoutError(idleMs);
      }
      if (winner.done) {
        sourceFinished = true;
        return;
      }
      yield winner.value;
    }
  } finally {
    if (!sourceFinished) {
      // We only get here from a `yield` (the consumer stopped early), so the
      // source has no pending `next()` and `return()` runs its `finally` now.
      // Not awaited, for the same reason as above: a teardown that awaits a
      // stuck socket must not hold the consumer.
      void Promise.resolve(iterator.return?.(undefined as never)).catch(() => {});
    }
  }
}
