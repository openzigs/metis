/**
 * Epic #70 (Epic 12: DR Playbook + Cross-Region Replication) — sub-issue #76.
 *
 * DR health check: measures Postgres streaming-replication lag on the standby
 * region and decides whether the standby is healthy enough to serve as a
 * failover target. Consumed by `server/scripts/dr-check.ts` (the `pnpm dr:check`
 * CLI) which exits non-zero when lag exceeds the configured threshold so it can
 * gate a drill / alert on-call.
 *
 * Rescoped 2026-06-30 (post multi-replica epic #518): Postgres is the production
 * database (#539) and ALSO hosts the pgvector vector store (#543). A single
 * Postgres streaming-replication stream therefore covers BOTH application data
 * and RAG vectors — there is no separate "LanceDB manifest" to check. This
 * module measures WAL replay lag only.
 *
 * Design note: all Postgres access is funnelled through an injected
 * {@link ReplicationQuerier}. Production wires it to Prisma's raw-query API; unit
 * tests pass a fake, so this module (and its 80% coverage) needs no live DB.
 */

/** Default lag threshold (seconds) before the standby is considered unhealthy. */
export const DEFAULT_LAG_THRESHOLD_SECONDS = 600; // 10 minutes — matches epic AC #2.

/** Environment variable that overrides {@link DEFAULT_LAG_THRESHOLD_SECONDS}. */
export const LAG_THRESHOLD_ENV = "DR_MAX_REPLICATION_LAG_SECONDS";

/**
 * Minimal seam over the standby Postgres. Implemented in production by a thin
 * Prisma `$queryRawUnsafe` wrapper; in tests by an in-memory fake. Kept
 * deliberately tiny so the check logic is pure and fully unit-testable.
 */
export interface ReplicationQuerier {
  /**
   * Run the standby-status query and return the single status row, or `null`
   * when the target is a primary / not in recovery (no standby to measure).
   */
  fetchStandbyStatus(): Promise<RawStandbyStatus | null>;
}

/**
 * Raw shape returned by the standby-status SQL. Field names mirror the Postgres
 * functions they come from:
 *   - `in_recovery`   ← `pg_is_in_recovery()`
 *   - `lag_seconds`   ← `EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))`
 *   - `receive_lsn`   ← `pg_last_wal_receive_lsn()`
 *   - `replay_lsn`    ← `pg_last_wal_replay_lsn()`
 * `lag_seconds` is `null` when no transaction has been replayed yet (a freshly
 * bootstrapped, fully-caught-up standby with no write traffic).
 */
export interface RawStandbyStatus {
  in_recovery: boolean;
  lag_seconds: number | null;
  receive_lsn: string | null;
  replay_lsn: string | null;
}

/** Overall DR health classification. */
export type DrStatus = "healthy" | "lagging" | "no-standby" | "error";

/** Structured result of a DR replication check. */
export interface ReplicationCheckResult {
  status: DrStatus;
  /** Replay lag in seconds, or `null` when unknown / not applicable. */
  lagSeconds: number | null;
  /** Threshold used for the healthy/lagging decision. */
  thresholdSeconds: number;
  /** WAL LSN the standby has received from the primary. */
  receiveLsn: string | null;
  /** WAL LSN the standby has replayed (applied). */
  replayLsn: string | null;
  /** Human-readable summary suitable for CLI output / alert text. */
  message: string;
  /** True when the caller should exit non-zero (drift or failure). */
  ok: boolean;
}

/**
 * Resolve the effective lag threshold. Reads {@link LAG_THRESHOLD_ENV}, falling
 * back to {@link DEFAULT_LAG_THRESHOLD_SECONDS}. Rejects non-positive /
 * non-finite overrides by falling back to the default so a fat-fingered env var
 * cannot silently disable the gate.
 */
export function resolveThresholdSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[LAG_THRESHOLD_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_LAG_THRESHOLD_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LAG_THRESHOLD_SECONDS;
  }
  return parsed;
}

/**
 * Evaluate DR replication health against a threshold.
 *
 * Decision table:
 *   - query throws / returns error      → `error`      (ok=false)
 *   - no row OR `in_recovery === false` → `no-standby` (ok=false — a DR check
 *                                          that finds no standby is a failure:
 *                                          the standby is missing / this is the
 *                                          primary and DR is not configured)
 *   - `lag_seconds === null`            → `healthy`    (ok=true — caught up, no
 *                                          replayed txn yet)
 *   - lag <= threshold                  → `healthy`    (ok=true)
 *   - lag  > threshold                  → `lagging`    (ok=false)
 */
export async function checkReplication(
  querier: ReplicationQuerier,
  thresholdSeconds: number = DEFAULT_LAG_THRESHOLD_SECONDS,
): Promise<ReplicationCheckResult> {
  let row: RawStandbyStatus | null;
  try {
    row = await querier.fetchStandbyStatus();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      lagSeconds: null,
      thresholdSeconds,
      receiveLsn: null,
      replayLsn: null,
      message: `DR check failed to query standby status: ${detail}`,
      ok: false,
    };
  }

  if (row === null || row.in_recovery !== true) {
    return {
      status: "no-standby",
      lagSeconds: null,
      thresholdSeconds,
      receiveLsn: row?.receive_lsn ?? null,
      replayLsn: row?.replay_lsn ?? null,
      message:
        "No standby in recovery mode — target is a primary or replication is not configured. " +
        "DR failover is NOT available until a streaming standby is attached (see docs/DR_RUNBOOK.md).",
      ok: false,
    };
  }

  const lag = row.lag_seconds;

  if (lag === null) {
    return {
      status: "healthy",
      lagSeconds: null,
      thresholdSeconds,
      receiveLsn: row.receive_lsn,
      replayLsn: row.replay_lsn,
      message:
        "Standby is in recovery and fully caught up (no replayed transaction yet). " +
        `Threshold ${thresholdSeconds}s.`,
      ok: true,
    };
  }

  const lagging = lag > thresholdSeconds;
  return {
    status: lagging ? "lagging" : "healthy",
    lagSeconds: lag,
    thresholdSeconds,
    receiveLsn: row.receive_lsn,
    replayLsn: row.replay_lsn,
    message: lagging
      ? `Standby replication lag ${lag.toFixed(1)}s EXCEEDS threshold ${thresholdSeconds}s — failover readiness DEGRADED.`
      : `Standby replication lag ${lag.toFixed(1)}s within threshold ${thresholdSeconds}s — healthy.`,
    ok: !lagging,
  };
}

/**
 * SQL that reads standby replication status in one round-trip. Postgres returns
 * `pg_last_xact_replay_timestamp()` as `null` on a caught-up standby with no
 * write traffic and on a primary; we also expose `pg_is_in_recovery()` so the
 * caller can distinguish "primary" from "lagging standby".
 */
export const STANDBY_STATUS_SQL = `
  SELECT
    pg_is_in_recovery() AS in_recovery,
    EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag_seconds,
    pg_last_wal_receive_lsn()::text AS receive_lsn,
    pg_last_wal_replay_lsn()::text AS replay_lsn
`;

/** Loosely-typed raw row the SQL above returns before normalization. */
interface RawSqlRow {
  in_recovery?: unknown;
  lag_seconds?: unknown;
  receive_lsn?: unknown;
  replay_lsn?: unknown;
}

/** Minimal contract satisfied by Prisma's raw-query surface. */
export interface RawQueryExecutor {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

/**
 * Normalize a raw SQL row (Postgres may hand back `bigint`/string numerics) into
 * a typed {@link RawStandbyStatus}. Exported for direct unit testing of the
 * coercion edges without a live driver.
 */
export function normalizeStandbyRow(row: RawSqlRow | undefined | null): RawStandbyStatus | null {
  if (!row) return null;
  const lagRaw = row.lag_seconds;
  const lag = lagRaw === null || lagRaw === undefined ? null : Number(lagRaw);
  return {
    in_recovery: row.in_recovery === true,
    lag_seconds: lag !== null && Number.isFinite(lag) ? lag : null,
    receive_lsn: row.receive_lsn == null ? null : String(row.receive_lsn),
    replay_lsn: row.replay_lsn == null ? null : String(row.replay_lsn),
  };
}

/**
 * Build a {@link ReplicationQuerier} backed by a Prisma-style raw executor. The
 * production CLI passes the real Prisma client; tests can pass a fake executor.
 */
export function createPrismaReplicationQuerier(db: RawQueryExecutor): ReplicationQuerier {
  return {
    async fetchStandbyStatus() {
      const rows = await db.$queryRawUnsafe<RawSqlRow[]>(STANDBY_STATUS_SQL);
      return normalizeStandbyRow(Array.isArray(rows) ? rows[0] : null);
    },
  };
}
