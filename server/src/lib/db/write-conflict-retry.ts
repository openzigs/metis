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
 */
import { isSerializationFailure } from "./prisma-errors.js";

/** Attempts at the transaction before a write conflict is surfaced. */
export const WRITE_CONFLICT_ATTEMPTS = 3;
/** The backoff step: a retry waits one step per attempt made, plus up to one at random. */
export const WRITE_CONFLICT_BACKOFF_MS = 20;

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
      await sleep(WRITE_CONFLICT_BACKOFF_MS * (attempt + Math.random()));
    }
  }
}
