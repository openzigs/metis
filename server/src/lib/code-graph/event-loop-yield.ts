/**
 * Issue #16 — keep the event loop turning during a long ingest.
 *
 * With the SQLite driver adapter (`better-sqlite3`, synchronous), every awaited
 * Prisma call settles on the MICROTASK queue. A loop of `await prisma.x.create()`
 * therefore never gives the event loop a turn: timers, sockets and `/healthz` all
 * wait until the whole loop finishes. Deep Ingest of this repository persists
 * ~22k symbols and ~385k edges that way, and the API went dark for minutes.
 *
 * `createEventLoopYielder` returns a `maybeYield()` to call once per unit of
 * work. It is time-sliced rather than count-based — per-item cost varies by
 * orders of magnitude between a symbol insert and a tree-sitter parse — and
 * yields with `setImmediate`, which runs after the poll phase, so pending I/O
 * (incoming requests included) is serviced before the loop resumes.
 */

/** Longest the ingest may hold the event loop between yields, by default. */
export const DEFAULT_YIELD_BUDGET_MS = 50;

export interface EventLoopYielderOptions {
  /** Longest stretch of synchronous work allowed between yields. */
  budgetMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** How to yield, injectable for tests. */
  yieldFn?: () => Promise<void>;
}

export type MaybeYield = () => Promise<void>;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function createEventLoopYielder(options: EventLoopYielderOptions = {}): MaybeYield {
  const budgetMs = options.budgetMs ?? DEFAULT_YIELD_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const yieldFn = options.yieldFn ?? yieldToEventLoop;
  let sliceStart = now();
  return async () => {
    if (now() - sliceStart < budgetMs) return;
    await yieldFn();
    sliceStart = now();
  };
}
