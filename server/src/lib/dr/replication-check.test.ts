import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAG_THRESHOLD_SECONDS,
  LAG_THRESHOLD_ENV,
  STANDBY_STATUS_SQL,
  checkReplication,
  createPrismaReplicationQuerier,
  normalizeStandbyRow,
  resolveThresholdSeconds,
  type RawQueryExecutor,
  type RawStandbyStatus,
  type ReplicationQuerier,
} from "./replication-check.js";

function querierReturning(row: RawStandbyStatus | null): ReplicationQuerier {
  return { fetchStandbyStatus: async () => row };
}

function querierThrowing(err: unknown): ReplicationQuerier {
  return {
    fetchStandbyStatus: async () => {
      throw err;
    },
  };
}

describe("resolveThresholdSeconds", () => {
  it("returns the default when the env var is unset", () => {
    expect(resolveThresholdSeconds({})).toBe(DEFAULT_LAG_THRESHOLD_SECONDS);
  });

  it("returns the default for an empty / whitespace override", () => {
    expect(resolveThresholdSeconds({ [LAG_THRESHOLD_ENV]: "   " })).toBe(
      DEFAULT_LAG_THRESHOLD_SECONDS,
    );
  });

  it("honours a valid positive override", () => {
    expect(resolveThresholdSeconds({ [LAG_THRESHOLD_ENV]: "120" })).toBe(120);
  });

  it("falls back to the default for a non-numeric override", () => {
    expect(resolveThresholdSeconds({ [LAG_THRESHOLD_ENV]: "abc" })).toBe(
      DEFAULT_LAG_THRESHOLD_SECONDS,
    );
  });

  it("falls back to the default for a non-positive override", () => {
    expect(resolveThresholdSeconds({ [LAG_THRESHOLD_ENV]: "0" })).toBe(
      DEFAULT_LAG_THRESHOLD_SECONDS,
    );
    expect(resolveThresholdSeconds({ [LAG_THRESHOLD_ENV]: "-5" })).toBe(
      DEFAULT_LAG_THRESHOLD_SECONDS,
    );
  });

  it("defaults to process.env when no map is passed", () => {
    const prev = process.env[LAG_THRESHOLD_ENV];
    delete process.env[LAG_THRESHOLD_ENV];
    try {
      expect(resolveThresholdSeconds()).toBe(DEFAULT_LAG_THRESHOLD_SECONDS);
    } finally {
      if (prev !== undefined) process.env[LAG_THRESHOLD_ENV] = prev;
    }
  });
});

describe("checkReplication", () => {
  const standby = (overrides: Partial<RawStandbyStatus> = {}): RawStandbyStatus => ({
    in_recovery: true,
    lag_seconds: 5,
    receive_lsn: "0/3000000",
    replay_lsn: "0/2FFFF00",
    ...overrides,
  });

  it("reports healthy when lag is under the threshold (exit 0)", async () => {
    const res = await checkReplication(querierReturning(standby({ lag_seconds: 30 })), 600);
    expect(res.status).toBe("healthy");
    expect(res.ok).toBe(true);
    expect(res.lagSeconds).toBe(30);
    expect(res.thresholdSeconds).toBe(600);
    expect(res.receiveLsn).toBe("0/3000000");
    expect(res.replayLsn).toBe("0/2FFFF00");
    expect(res.message).toContain("healthy");
  });

  it("treats lag exactly at the threshold as healthy (boundary)", async () => {
    const res = await checkReplication(querierReturning(standby({ lag_seconds: 600 })), 600);
    expect(res.status).toBe("healthy");
    expect(res.ok).toBe(true);
  });

  it("reports lagging when lag exceeds the threshold (non-zero exit)", async () => {
    const res = await checkReplication(querierReturning(standby({ lag_seconds: 601 })), 600);
    expect(res.status).toBe("lagging");
    expect(res.ok).toBe(false);
    expect(res.lagSeconds).toBe(601);
    expect(res.message).toContain("EXCEEDS");
    expect(res.message).toContain("DEGRADED");
  });

  it("treats a caught-up standby with null lag as healthy", async () => {
    const res = await checkReplication(querierReturning(standby({ lag_seconds: null })), 600);
    expect(res.status).toBe("healthy");
    expect(res.ok).toBe(true);
    expect(res.lagSeconds).toBeNull();
    expect(res.message).toContain("caught up");
  });

  it("reports no-standby when the row is null", async () => {
    const res = await checkReplication(querierReturning(null), 600);
    expect(res.status).toBe("no-standby");
    expect(res.ok).toBe(false);
    expect(res.lagSeconds).toBeNull();
    expect(res.receiveLsn).toBeNull();
    expect(res.message).toContain("NOT available");
  });

  it("reports no-standby when the target is a primary (not in recovery)", async () => {
    const res = await checkReplication(
      querierReturning(standby({ in_recovery: false, lag_seconds: null })),
      600,
    );
    expect(res.status).toBe("no-standby");
    expect(res.ok).toBe(false);
    // LSNs from the row are still surfaced for diagnostics.
    expect(res.receiveLsn).toBe("0/3000000");
  });

  it("reports error and exits non-zero when the query throws (Error)", async () => {
    const res = await checkReplication(querierThrowing(new Error("connection refused")), 600);
    expect(res.status).toBe("error");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("connection refused");
  });

  it("reports error for a non-Error throw", async () => {
    const res = await checkReplication(querierThrowing("boom"), 600);
    expect(res.status).toBe("error");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("boom");
  });

  it("uses the default threshold when none is supplied", async () => {
    const res = await checkReplication(querierReturning(standby({ lag_seconds: 1 })));
    expect(res.thresholdSeconds).toBe(DEFAULT_LAG_THRESHOLD_SECONDS);
    expect(res.ok).toBe(true);
  });
});

describe("normalizeStandbyRow", () => {
  it("returns null for null / undefined", () => {
    expect(normalizeStandbyRow(null)).toBeNull();
    expect(normalizeStandbyRow(undefined)).toBeNull();
  });

  it("coerces numeric-string lag and string LSNs", () => {
    const norm = normalizeStandbyRow({
      in_recovery: true,
      lag_seconds: "12.5",
      receive_lsn: "0/1",
      replay_lsn: "0/2",
    });
    expect(norm).toEqual({
      in_recovery: true,
      lag_seconds: 12.5,
      receive_lsn: "0/1",
      replay_lsn: "0/2",
    });
  });

  it("maps null lag and null LSNs through", () => {
    const norm = normalizeStandbyRow({
      in_recovery: false,
      lag_seconds: null,
      receive_lsn: null,
      replay_lsn: null,
    });
    expect(norm).toEqual({
      in_recovery: false,
      lag_seconds: null,
      receive_lsn: null,
      replay_lsn: null,
    });
  });

  it("treats a non-finite lag as null", () => {
    const norm = normalizeStandbyRow({
      in_recovery: true,
      lag_seconds: "not-a-number",
      receive_lsn: "0/1",
      replay_lsn: "0/1",
    });
    expect(norm?.lag_seconds).toBeNull();
  });

  it("coerces a truthy-but-non-true in_recovery to false", () => {
    const norm = normalizeStandbyRow({
      in_recovery: 1,
      lag_seconds: 0,
      receive_lsn: null,
      replay_lsn: null,
    });
    expect(norm?.in_recovery).toBe(false);
  });
});

describe("createPrismaReplicationQuerier", () => {
  it("runs the standby-status SQL and returns the first normalized row", async () => {
    let seenSql = "";
    const db: RawQueryExecutor = {
      async $queryRawUnsafe<T>(sql: string): Promise<T> {
        seenSql = sql;
        return [
          {
            in_recovery: true,
            lag_seconds: 3.2,
            receive_lsn: "0/5",
            replay_lsn: "0/4",
          },
        ] as unknown as T;
      },
    };
    const querier = createPrismaReplicationQuerier(db);
    const row = await querier.fetchStandbyStatus();
    expect(seenSql).toBe(STANDBY_STATUS_SQL);
    expect(row).toEqual({
      in_recovery: true,
      lag_seconds: 3.2,
      receive_lsn: "0/5",
      replay_lsn: "0/4",
    });
  });

  it("returns null when the driver yields a non-array result", async () => {
    const db: RawQueryExecutor = {
      async $queryRawUnsafe<T>(): Promise<T> {
        return null as unknown as T;
      },
    };
    const row = await createPrismaReplicationQuerier(db).fetchStandbyStatus();
    expect(row).toBeNull();
  });

  it("returns null when the driver yields an empty array", async () => {
    const db: RawQueryExecutor = {
      async $queryRawUnsafe<T>(): Promise<T> {
        return [] as unknown as T;
      },
    };
    const row = await createPrismaReplicationQuerier(db).fetchStandbyStatus();
    expect(row).toBeNull();
  });
});
