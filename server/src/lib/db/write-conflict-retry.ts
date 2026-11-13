/**
 * #1959 — run a SERIALIZABLE transaction again when the database aborts it on a
 * write conflict ({@link isSerializationFailure}: Prisma's `P2034`, or adapter-pg's
 * `TransactionWriteConflict`).
 *
 * Under Postgres's serializable snapshot isolation a conflict is routine, and
 * not always a real one: unrelated transactions that read and write the same
 * index pages can be aborted too. The aborted transaction rolled back, so the
 * only correct answer is to run it again. `run` must therefore open the whole
 * transaction itself and keep no state across attempts that the transaction
 * does not reset.
 *
 * #2425 — the waits double, and the first is long enough to outlast a commit.
 * Postgres refuses the loser of a conflict while the winner's COMMIT is still
 * being made durable: the winner has been judged but is not yet visible, so a
 * retry that starts inside that window reads the winner's write as in flight,
 * becomes the pivot of the same cycle and is refused again. The old linear
 * 20–40 ms then 40–60 ms put every attempt inside one slow WAL flush (measured on
 * a CI runner, reproduced with a 100 ms `commit_delay`), and a sign-in that
 * conflicted with nobody still alive got `503 SIGN_IN_CONFLICT`. The attempts
 * now span at least 300 ms (100–200 ms, then 200–400 ms).
 *
 * That 300 ms is a measured margin, not a guarantee: the window is the winner's
 * commit latency, so a flush that stalls longer than the remaining backoff still
 * ends in the same fail-closed conflict error. If those show up in production,
 * add attempts rather than lengthening the step further.
 */
import { isSerializationFailure } from "./prisma-errors.js";

/** Attempts at the transaction before a write conflict is surfaced. */
export const WRITE_CONFLICT_ATTEMPTS = 3;
/**
 * The first backoff: the wait after attempt `n` is this times `2^(n-1)`, plus up
 * to as much again at random.
 */
export const WRITE_CONFLICT_BACKOFF_MS = 100;

/** How long to wait after losing attempt `attempt` (1-based); `jitter` in [0, 1). */
function writeConflictBackoffMs(attempt: number, jitter: number): number {
  return WRITE_CONFLICT_BACKOFF_MS * 2 ** (attempt - 1) * (1 + jitter);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface WriteConflictRetryOptions {
  /** Total attempts, the first included. */
  attempts?: number;
  /** The error to throw instead of the last conflict once every attempt lost one. */
  exhausted?: (lastConflict: unknown) => Error;
  /** The backoff between attempts (tests); defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Another error this transaction may run again after, besides a write
   * conflict. Only for a transaction whose re-read judges what the other writer
   * left (#1971: a concurrent grant of the same role is a unique violation).
   */
  alsoRetry?: (error: unknown) => boolean;
}

export async function retryOnWriteConflict<T>(
  run: () => Promise<T>,
  options: WriteConflictRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? WRITE_CONFLICT_ATTEMPTS;
  const sleep = options.sleep ?? wait;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isSerializationFailure(error) && !options.alsoRetry?.(error)) throw error;
      if (attempt >= attempts) throw options.exhausted ? options.exhausted(error) : error;
      // Jittered, so transactions that just collided do not retry in step.
      await sleep(writeConflictBackoffMs(attempt, Math.random()));
    }
  }
}
