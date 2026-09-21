/**
 * Issue #798 — the wall-clock budget for the reindex CUT-OVER transaction, and the
 * strict env parsing that guards it.
 *
 * A LEAF module on purpose. Two modules need this number and they must not disagree:
 *
 *   - `vector-store-pgvector.ts` uses it as the interactive transaction's `timeout`
 *     (how long the swap may run before Prisma kills it), and
 *   - `reindex-lease.ts` uses it to decide how far to push `expires_at` when the swap's
 *     fence renews the lease INSIDE that transaction (how long the lease must stay valid
 *     to cover the swap).
 *
 * Those two are the SAME quantity viewed from either side — "how long may the cut-over
 * take?". If the lease extension were shorter than the transaction deadline, a swap could
 * outlive its own lease and be stolen out from under itself at COMMIT (see
 * {@link reindexSwapLeaseExtensionMs}). Keeping the knob here, rather than importing the
 * pgvector store into the lease module, makes them share one definition with no import
 * cycle.
 */
import { createChildLogger } from "../logger.js";

const log = createChildLogger("reindex-swap-budget");

/**
 * Issue #798 — the wall-clock budget for the reindex CUT-OVER transaction.
 *
 * The swap is an INTERACTIVE `$transaction` (it has to be: the lease fence and the
 * cut-over must be one atomic fact — see `PgVectorStore.swapTable`), and Prisma's
 * interactive transactions carry a CLIENT-SIDE deadline: `timeout` (default **5 s**,
 * wall-clock for the whole callback) and `maxWait` (default 2 s, to get a connection).
 * `lib/prisma.ts` sets no `transactionOptions`, so those defaults would apply. The
 * BATCH `$transaction([...])` form this replaced had no such deadline — so adopting the
 * interactive form silently put a 5-second fuse on the swap.
 *
 * 5 s is an OLTP default and is nowhere near the right order of magnitude here. The
 * callback does `DELETE … WHERE project_id = live` + `UPDATE … SET project_id = live`
 * across an entire corpus: every relabelled row is an MVCC tuple rewrite, and each new
 * tuple version costs an insert into the HNSW index as well as the two btree indexes.
 * At a conservative ~1 ms/vector of HNSW maintenance, a 200k-chunk project is already
 * ~200 s. Under a 5 s deadline that reindex burns its ENTIRE embed loop and then dies at
 * the last step with `P2028 Transaction already closed` — repeatably, unclearably, on
 * exactly the large-corpus migration #787 exists to perform.
 *
 * So: 10 minutes, ~120× the default, chosen to clear a corpus an order of magnitude
 * larger than anything METIS holds today with room to spare. It is a BACKSTOP against a
 * hung transaction, not a performance target — the cost of setting it too high is a
 * pathological swap holding its locks longer, and the cost of setting it too low is
 * permanent data-migration failure, which is much worse. Tunable for operators with
 * corpora (or disks) that make even this tight.
 *
 * NOTE for the runbook: for the duration of this transaction the swap holds
 * `RowExclusiveLock` on the live project's `rag_vectors` rows, so concurrent ingest
 * upserts into the LIVE namespace block behind it. That was equally true of the batch
 * form, but a longer explicit deadline makes the worst-case window longer.
 */
export const DEFAULT_REINDEX_SWAP_TIMEOUT_MS = 600_000;

/**
 * Hard ceiling on the swap budget (1 hour).
 *
 * The budget is a BACKSTOP against a hung transaction, and a backstop you can set to
 * `Number.MAX_SAFE_INTEGER` is not a backstop. For the whole of this transaction the swap
 * holds `RowExclusiveLock` on the live project's rows (blocking concurrent ingest) and an
 * exclusive lock on the lease row (blocking the heartbeat and any steal), and it pins a
 * pooled connection. An operator who fat-fingers a trailing zero should not be able to
 * turn that into a day-long outage — they should get a loud clamp instead.
 */
export const MAX_REINDEX_SWAP_TIMEOUT_MS = 3_600_000;

/** Ceiling on the wait for a pooled connection to start the swap transaction. */
export const DEFAULT_REINDEX_SWAP_MAX_WAIT_MS = 30_000;

/** Hard ceiling on `maxWait` — waiting >5 min for a connection is a broken pool, not patience. */
export const MAX_REINDEX_SWAP_MAX_WAIT_MS = 300_000;

/**
 * Parse a positive-integer millisecond env var, STRICTLY.
 *
 * `Number.parseInt` is lenient: it parses the longest numeric PREFIX and discards the
 * rest, so `parseInt("10min", 10)` is `10` — and a well-meaning `REINDEX_SWAP_TIMEOUT_MS=10min`
 * would have configured a **10-millisecond** cut-over deadline, reintroducing (far worse
 * than) the P2028 bug this budget exists to fix, silently. Same for `"600s"` → 600 ms,
 * `"10_000"` → 10, `"1e6"` → 1. Every one of those is a plausible thing to type and every
 * one of them is a catastrophe.
 *
 * So: accept ONLY an unadorned run of digits. Anything else is a misconfiguration, and
 * misconfiguration is LOUD (warn + documented fallback), never silently reinterpreted.
 * Values above `max` are clamped, also loudly.
 */
export function parsePositiveIntMs(
  raw: string | undefined,
  opts: { name: string; fallback: number; max: number },
): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return opts.fallback;

  // Digits only. No units, no separators, no exponents, no sign, no decimal point.
  if (!/^\d+$/.test(trimmed)) {
    log.warn("ignoring a malformed duration env var — it must be a whole number of MILLISECONDS", {
      env: opts.name,
      value: trimmed,
      hint: `Units and separators are NOT supported: "10min"/"600s"/"10_000" would parse as 10/600/10 ms. Use digits only, e.g. ${opts.fallback}.`,
      usingFallbackMs: opts.fallback,
    });
    return opts.fallback;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    log.warn("ignoring an out-of-range duration env var", {
      env: opts.name,
      value: trimmed,
      usingFallbackMs: opts.fallback,
    });
    return opts.fallback;
  }

  if (parsed > opts.max) {
    log.warn("clamping a duration env var to its maximum", {
      env: opts.name,
      requestedMs: parsed,
      clampedToMs: opts.max,
    });
    return opts.max;
  }

  return parsed;
}

/** `REINDEX_SWAP_TIMEOUT_MS` override for {@link DEFAULT_REINDEX_SWAP_TIMEOUT_MS}. */
export function reindexSwapTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntMs(env.REINDEX_SWAP_TIMEOUT_MS, {
    name: "REINDEX_SWAP_TIMEOUT_MS",
    fallback: DEFAULT_REINDEX_SWAP_TIMEOUT_MS,
    max: MAX_REINDEX_SWAP_TIMEOUT_MS,
  });
}

/** `REINDEX_SWAP_MAX_WAIT_MS` override for {@link DEFAULT_REINDEX_SWAP_MAX_WAIT_MS}. */
export function reindexSwapMaxWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntMs(env.REINDEX_SWAP_MAX_WAIT_MS, {
    name: "REINDEX_SWAP_MAX_WAIT_MS",
    fallback: DEFAULT_REINDEX_SWAP_MAX_WAIT_MS,
    max: MAX_REINDEX_SWAP_MAX_WAIT_MS,
  });
}

/**
 * Safety margin added to the swap budget when the fence renews the lease. Covers the
 * clock skew between the app server (which computes `expires_at`) and any other replica
 * (which compares it against ITS `Date.now()`), plus the COMMIT itself.
 */
export const REINDEX_SWAP_LEASE_MARGIN_MS = 60_000;

/**
 * How far into the future the swap's fence must push `expires_at`.
 *
 * ## Why the lease has to be extended AT ALL
 *
 * The fence takes an exclusive lock on the lease row and holds it until the cut-over
 * COMMITS. That is the whole point — a concurrent steal must block behind the commit
 * rather than race it. But it cuts BOTH ways: the run's own heartbeat `UPDATE` would
 * block on that same lock, so **the lease cannot be renewed for the duration of the
 * swap** (which is why the heartbeat is paused across it — see
 * `ReindexLease.withHeartbeatPaused`). A swap that outruns the 120 s TTL would therefore
 * reach COMMIT with an EXPIRED lease, and the steal queued behind the row lock would win
 * the instant the lock dropped — fencing the run at its post-swap `renew()` and skipping
 * delta re-apply / orphan deletes / retag.
 *
 * The fix is to renew AS the fence: one `UPDATE … WHERE holder = me RETURNING holder`
 * takes the identical row lock (so the blocking that closes the window is preserved
 * verbatim), still returns 0 rows iff we were fenced, AND leaves the lease valid for as
 * long as the transaction it guards may possibly run. Hence: the swap's own deadline,
 * plus a margin.
 *
 * ## Why this cannot wedge a crashed pod's lease for 10 minutes
 *
 * The extension is written by a statement INSIDE the swap's transaction, so it is subject
 * to the same atomicity as the cut-over: if the pod is SIGKILLed mid-swap, Postgres rolls
 * the transaction back and the extension **goes with it**. The lease reverts to whatever
 * `expires_at` the heartbeat last committed, and lapses on the ordinary TTL. The longer
 * expiry becomes visible to other replicas ONLY on a COMMIT — i.e. only when the run
 * really did still hold the lease and really did just cut over, which is precisely the
 * case where it needs the extra time.
 */
export function reindexSwapLeaseExtensionMs(env: NodeJS.ProcessEnv = process.env): number {
  return reindexSwapTimeoutMs(env) + REINDEX_SWAP_LEASE_MARGIN_MS;
}
