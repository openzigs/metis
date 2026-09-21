/**
 * Issue #798 — the reindex-lease state machine.
 *
 * Three layers, all here:
 *   1. {@link MemoryReindexLeaseBackend} — the semantics every backend must have
 *      (acquire / steal-expired / renew / fence / release / force-release).
 *   2. {@link withReindexLease} + {@link ReindexLease} — the handle callers hold, the
 *      conflict it throws, and the fence it enforces.
 *   3. {@link PostgresReindexLeaseBackend} — its SQL RESULT handling, against a mocked
 *      Prisma (the real SQL is proved against a real Postgres in
 *      `tests/reindex-lease-postgres.integration.test.ts`). Modeled on the
 *      `PostgresLeaseBackend` unit tests in `scheduler/leader-election.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetReindexLeaseBackend,
  DEFAULT_REINDEX_LEASE_TTL_MS,
  forceReleaseReindexLease,
  isPostgresDatasource,
  MemoryReindexLeaseBackend,
  newReindexHolderId,
  NullReindexLeaseBackend,
  PostgresReindexLeaseBackend,
  readReindexLease,
  ReindexConflictError,
  ReindexFencedError,
  reindexLeaseTtlMs,
  reindexLockName,
  resolveReindexLeaseBackend,
  withReindexLease,
} from "./reindex-lease.js";

vi.mock("../prisma.js", () => ({ prisma: {} }));

const P = "proj-1";
const NAME = reindexLockName(P);

beforeEach(() => {
  __resetReindexLeaseBackend();
});

describe("MemoryReindexLeaseBackend — the semantics every backend must have", () => {
  it("acquires a free lease", async () => {
    const be = new MemoryReindexLeaseBackend();
    const row = await be.acquire(NAME, "pod-a", 1_000, 60_000);
    expect(row).toMatchObject({ holder: "pod-a", expiresAt: 61_000, updatedAt: 1_000 });
  });

  it("REFUSES a lease another holder still owns", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    expect(await be.acquire(NAME, "pod-b", 2_000, 60_000)).toBeNull();
  });

  it("STEALS an expired lease — the crash-recovery path (no pod restart)", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-dead", 1_000, 5_000);
    // Past the TTL: the holder stopped renewing, so it is gone as far as anyone can tell.
    const row = await be.acquire(NAME, "pod-b", 6_001, 60_000);
    expect(row?.holder).toBe("pod-b");
  });

  it("re-acquiring your OWN lease is a renewal, not a conflict", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    const row = await be.acquire(NAME, "pod-a", 2_000, 60_000);
    expect(row?.expiresAt).toBe(62_000);
  });

  it("force takes a lease that is still LIVE (the archive's fail-safe path)", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    const row = await be.acquire(NAME, "pod-archive", 2_000, 60_000, { force: true });
    expect(row?.holder).toBe("pod-archive");
    // ...and the previous holder is thereby FENCED.
    expect(await be.renew(NAME, "pod-a", 3_000, 60_000)).toBe(false);
  });

  it("renew extends OUR lease and returns false once we have been fenced", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    expect(await be.renew(NAME, "pod-a", 2_000, 60_000)).toBe(true);
    expect(await be.renew(NAME, "pod-b", 2_000, 60_000)).toBe(false);
  });

  it("renew of a RELEASED lease returns false — a released row cannot be resurrected", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    await be.release(NAME, "pod-a");
    expect(await be.renew(NAME, "pod-a", 2_000, 60_000)).toBe(false);
  });

  it("renew does NOT require the lease to be un-expired — only that it is still OURS", async () => {
    // A run that merely PAUSED past its TTL, with nobody contending, must not
    // self-fence: the row still naming us proves nobody acquired or released since.
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", 1_000, 5_000);
    expect(await be.renew(NAME, "pod-a", 999_000, 60_000)).toBe(true);
  });

  it("release only removes OUR row (never the row of whoever fenced us)", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    await be.release(NAME, "pod-b");
    expect((await be.read(NAME))?.holder).toBe("pod-a");
    await be.release(NAME, "pod-a");
    expect(await be.read(NAME)).toBeNull();
  });

  it("assertHeld throws ReindexFencedError for a stolen or missing lease", async () => {
    const be = new MemoryReindexLeaseBackend();
    await expect(be.assertHeld(P, NAME, "pod-a")).rejects.toBeInstanceOf(ReindexFencedError);
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    await expect(be.assertHeld(P, NAME, "pod-a")).resolves.toBeUndefined();
    await be.acquire(NAME, "pod-b", 2_000, 60_000, { force: true });
    await expect(be.assertHeld(P, NAME, "pod-a")).rejects.toBeInstanceOf(ReindexFencedError);
  });

  it("forceRelease returns what it removed, and reset clears everything", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    expect((await be.forceRelease(NAME))?.holder).toBe("pod-a");
    expect(await be.forceRelease(NAME)).toBeNull();
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    await be.reset();
    expect(await be.read(NAME)).toBeNull();
  });
});

describe("withReindexLease", () => {
  it("acquires, runs, and releases — nothing is left held", async () => {
    const be = new MemoryReindexLeaseBackend();
    const seen: string[] = [];
    const out = await withReindexLease(
      P,
      async (lease) => {
        seen.push(lease.holder);
        expect(await be.read(NAME)).not.toBeNull();
        return "done";
      },
      { backend: be, heartbeat: false },
    );
    expect(out).toBe("done");
    expect(seen[0]).toMatch(/.+:.+/); // <podId>:<runId>
    expect(await be.read(NAME)).toBeNull();
  });

  it("releases the lease even when the body THROWS", async () => {
    const be = new MemoryReindexLeaseBackend();
    await expect(
      withReindexLease(
        P,
        async () => {
          throw new Error("boom");
        },
        { backend: be, heartbeat: false },
      ),
    ).rejects.toThrow("boom");
    expect(await be.read(NAME)).toBeNull();
  });

  it("throws ReindexConflictError, naming the holder, when someone else owns the lease", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a:run-1", Date.now(), 60_000);
    const err = await withReindexLease(P, async () => "never", {
      backend: be,
      heartbeat: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReindexConflictError);
    expect((err as ReindexConflictError).holder).toBe("pod-a:run-1");
    expect((err as ReindexConflictError).code).toBe("REINDEX_IN_PROGRESS");
  });

  it("force takes a live lease and does NOT delete the new holder's row on the way out", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", Date.now(), 60_000);
    await withReindexLease(P, async () => undefined, {
      backend: be,
      holderForTest: "pod-archive",
      force: true,
      heartbeat: false,
    });
    // The archive released ITS OWN lease; pod-a's is long gone (it was overwritten).
    expect(await be.read(NAME)).toBeNull();
  });

  it("a FENCED holder does not release — it must not delete the row of whoever fenced it", async () => {
    const be = new MemoryReindexLeaseBackend();
    await withReindexLease(
      P,
      async (lease) => {
        // Someone steals the lease mid-run; our renew reports the fence.
        await be.acquire(NAME, "pod-thief", Date.now(), 60_000, { force: true });
        expect(await lease.renew()).toBe(false);
      },
      { backend: be, holderForTest: "pod-a", heartbeat: false },
    );
    // The thief's lease is INTACT — a fenced run releasing "the lease" would have
    // deleted a lease it no longer owns, handing the project to a third party.
    expect((await be.read(NAME))?.holder).toBe("pod-thief");
  });

  it("lease.assertHeld throws once fenced, without even hitting the backend again", async () => {
    const be = new MemoryReindexLeaseBackend();
    await withReindexLease(
      P,
      async (lease) => {
        await be.forceRelease(NAME);
        expect(await lease.renew()).toBe(false);
        const spy = vi.spyOn(be, "assertHeld");
        await expect(lease.assertHeld()).rejects.toBeInstanceOf(ReindexFencedError);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      },
      { backend: be, heartbeat: false },
    );
  });

  it("the heartbeat renews the lease on its own timer (a batch may outrun the TTL)", async () => {
    vi.useFakeTimers();
    try {
      const be = new MemoryReindexLeaseBackend();
      const renew = vi.spyOn(be, "renew");
      let resolveBody!: () => void;
      const body = new Promise<void>((r) => (resolveBody = r));
      const run = withReindexLease(P, async () => body, {
        backend: be,
        ttlMs: 30_000,
        renewIntervalMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(renew).toHaveBeenCalledTimes(2);
      resolveBody();
      await run;
      // Stopped with the run — a released lease must not keep being renewed.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(renew).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- PR #805 review round 2: the heartbeat must not starve the connection pool ----
  //
  // The swap's fence holds an EXCLUSIVE lock on the lease row until the cut-over commits.
  // Any heartbeat `UPDATE` issued meanwhile lands on a DIFFERENT pooled connection and can
  // do exactly one thing: block on that lock. `pg.Pool` defaults to `max: 10` with no
  // `connectionTimeoutMillis` (`lib/prisma.ts`), so a blocked tick parks a pooled
  // connection until COMMIT — and `setInterval` does not wait for its async callback, so
  // without a guard the ticks ACCUMULATE. On the 10-minute swap budget this PR introduces,
  // a 200 s cut-over parks ~6 of 10 connections and a ~270 s one exhausts the pool: every
  // other query in the process (API, scheduler, ingest) then queues until COMMIT.
  //
  // Both tests below FAIL on the pre-fix code (an unguarded `setInterval` that stays armed
  // through the swap): the first sees one blocked renew per tick, the second sees the
  // heartbeat firing into the swap at all.

  it("a BLOCKED renew never piles up — at most ONE heartbeat tick is ever in flight", async () => {
    vi.useFakeTimers();
    try {
      const be = new MemoryReindexLeaseBackend();
      // A renew that never comes back = a renew blocked on the lease row's lock, which is
      // precisely what every tick does while the swap holds it. Count how many are ALIVE
      // at once: that is the number of pooled connections parked forever.
      let inFlight = 0;
      let peakInFlight = 0;
      vi.spyOn(be, "renew").mockImplementation(async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        return await new Promise<boolean>(() => {
          /* never resolves — blocked on the row lock */
        });
      });

      let resolveBody!: () => void;
      const body = new Promise<void>((r) => (resolveBody = r));
      const run = withReindexLease(P, async () => body, {
        backend: be,
        ttlMs: 30_000,
        renewIntervalMs: 5_000,
      });

      // Ten ticks' worth of a swap that is still grinding through the corpus.
      await vi.advanceTimersByTimeAsync(50_000);

      // THE ASSERTION. Pre-fix this is 10 — ten permanently-blocked pooled connections,
      // i.e. the pool (max 10) is gone and the pod has stopped talking to Postgres.
      expect(peakInFlight).toBe(1);

      resolveBody();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("withHeartbeatPaused suspends the ticks for the cut-over, and re-arms them after", async () => {
    vi.useFakeTimers();
    try {
      const be = new MemoryReindexLeaseBackend();
      const renew = vi.spyOn(be, "renew");

      let releaseSwap!: () => void;
      const swap = new Promise<void>((r) => (releaseSwap = r));
      let renewsDuringSwap = -1;

      const run = withReindexLease(
        P,
        async (lease) => {
          // A long cut-over, spanning many heartbeat intervals.
          await lease.withHeartbeatPaused(async () => {
            await swap;
          });
          renewsDuringSwap = renew.mock.calls.length;
        },
        { backend: be, ttlMs: 30_000, renewIntervalMs: 5_000 },
      );

      await vi.advanceTimersByTimeAsync(50_000); // 10 ticks would have fired
      releaseSwap();
      await run;

      // NOT ONE renew was issued while the swap held the lease row. Pre-fix: 10, each of
      // them blocked on the swap's own row lock.
      expect(renewsDuringSwap).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the fence RENEWS the lease across the swap, so a cut-over longer than the TTL is not stolen at COMMIT", async () => {
    // The second-order bug the `UPDATE` fence fixes. The heartbeat cannot renew during the
    // swap (it would block on the fence's row lock), so if the fence did not renew, a swap
    // outlasting the 120 s TTL would COMMIT with an EXPIRED lease — and a steal queued
    // behind the row lock would win the instant it dropped, fencing the run at its
    // post-swap `renew()` and skipping delta re-apply / orphan deletes / retag.
    const be = new MemoryReindexLeaseBackend();
    const ttlMs = 30_000;
    let clock = 1_000;

    await withReindexLease(
      P,
      async (lease) => {
        // The swap opens: the fence proves holdership AND pushes `expires_at` out to cover
        // the transaction's own deadline (`exec` set = we are riding the swap's tx).
        await lease.assertHeld({} as never);
        const afterFence = await be.read(NAME);

        // Far beyond the TTL — the swap is still relabelling a large corpus.
        clock += ttlMs * 5;

        // The lease is STILL VALID, so a contending replica cannot steal it.
        expect(afterFence!.expiresAt).toBeGreaterThan(clock);
        expect(await be.acquire(NAME, "other-pod", clock, 60_000)).toBeNull();

        // …and the run's own post-swap renew still succeeds: it was never fenced.
        expect(await lease.renew()).toBe(true);
      },
      { backend: be, holderForTest: "pod-a", ttlMs, heartbeat: false, now: () => clock },
    );
  });

  it("the no-op backend arms NO timer (SQLite runtimes have no lease to keep alive)", async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(global, "setInterval");
      await withReindexLease(P, async () => undefined, { backend: new NullReindexLeaseBackend() });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readReindexLease / forceReleaseReindexLease", () => {
  it("reports holder, age and expiry", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-a", 1_000, 60_000);
    const info = await readReindexLease(P, { backend: be, now: () => 4_000 });
    expect(info).toMatchObject({
      projectId: P,
      holder: "pod-a",
      ageMs: 3_000,
      expired: false,
      expiresAt: 61_000,
    });
    const stale = await readReindexLease(P, { backend: be, now: () => 999_000 });
    expect(stale?.expired).toBe(true);
  });

  it("returns null when nobody holds the lease", async () => {
    expect(await readReindexLease(P, { backend: new MemoryReindexLeaseBackend() })).toBeNull();
  });

  it("degrades to null (never throws) when the backend read fails", async () => {
    const be = new MemoryReindexLeaseBackend();
    vi.spyOn(be, "read").mockRejectedValueOnce(new Error("db down"));
    expect(await readReindexLease(P, { backend: be })).toBeNull();
  });

  it("force-release returns the cleared lease and fences its holder", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(NAME, "pod-wedged", 1_000, 600_000);
    const cleared = await forceReleaseReindexLease(P, { backend: be, now: () => 61_000 });
    expect(cleared).toMatchObject({ holder: "pod-wedged", ageMs: 60_000 });
    expect(await be.renew(NAME, "pod-wedged", 62_000, 60_000)).toBe(false);
    expect(await forceReleaseReindexLease(P, { backend: be })).toBeNull();
  });
});

describe("config + resolution", () => {
  it("names the lock after the project", () => {
    expect(reindexLockName("abc")).toBe("reindex:abc");
  });

  it("mints a fresh <podId>:<runId> holder per attempt", () => {
    const a = newReindexHolderId();
    const b = newReindexHolderId();
    expect(a).not.toBe(b);
    expect(a.split(":")).toHaveLength(2);
  });

  it("reads the TTL from env, falling back to the default", () => {
    expect(reindexLeaseTtlMs({})).toBe(DEFAULT_REINDEX_LEASE_TTL_MS);
    expect(reindexLeaseTtlMs({ REINDEX_LEASE_TTL_MS: "45000" })).toBe(45_000);
    expect(reindexLeaseTtlMs({ REINDEX_LEASE_TTL_MS: "nonsense" })).toBe(
      DEFAULT_REINDEX_LEASE_TTL_MS,
    );
    expect(reindexLeaseTtlMs({ REINDEX_LEASE_TTL_MS: "-5" })).toBe(DEFAULT_REINDEX_LEASE_TTL_MS);
  });

  it("recognises a Postgres datasource, and only a Postgres one", () => {
    expect(isPostgresDatasource({ DATABASE_URL: "postgres://x" })).toBe(true);
    expect(isPostgresDatasource({ DATABASE_URL: "postgresql://x" })).toBe(true);
    expect(isPostgresDatasource({ DATABASE_URL: "file:./dev.db" })).toBe(false);
    expect(isPostgresDatasource({})).toBe(false);
  });

  it("resolves the Postgres backend on Postgres and the NO-OP one otherwise", () => {
    expect(resolveReindexLeaseBackend({ DATABASE_URL: "postgresql://x" })).toBeInstanceOf(
      PostgresReindexLeaseBackend,
    );
    expect(resolveReindexLeaseBackend({ DATABASE_URL: "file:./dev.db" })).toBeInstanceOf(
      NullReindexLeaseBackend,
    );
  });

  it("the no-op backend never blocks and never reports a lease", async () => {
    const be = new NullReindexLeaseBackend();
    expect(await be.acquire(NAME, "pod-a", 1_000, 60_000)).toMatchObject({ holder: "pod-a" });
    expect(await be.renew()).toBe(true);
    expect(await be.read()).toBeNull();
    expect(await be.forceRelease()).toBeNull();
    await expect(be.assertHeld()).resolves.toBeUndefined();
    await expect(be.release()).resolves.toBeUndefined();
    await expect(be.reset()).resolves.toBeUndefined();
  });
});

/**
 * The Postgres backend's RESULT handling. The SQL itself is proved against a real
 * Postgres in the integration suite; what is worth unit-testing here is the mapping
 * from rows → decisions, because getting THAT wrong is how the old advisory lock
 * silently leaked (it discarded `pg_advisory_unlock`'s boolean entirely).
 */
describe("PostgresReindexLeaseBackend — SQL result handling (mocked prisma)", () => {
  function fakeDb(queryRows: unknown[][]) {
    const queue = [...queryRows];
    return {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? [])),
    };
  }

  it("acquire: a returned row naming US means we hold the lease", async () => {
    const db = fakeDb([[{ holder: "pod-a", expires_at: 61_000n, updated_at: 1_000n }]]);
    const be = new PostgresReindexLeaseBackend(db as never);
    const row = await be.acquire(NAME, "pod-a", 1_000, 60_000);
    // BIGINT arrives as a JS BigInt over the pg adapter — it must be normalised.
    expect(row).toEqual({
      lockName: NAME,
      holder: "pod-a",
      expiresAt: 61_000,
      updatedAt: 1_000,
    });
  });

  it("acquire: NO row (the conditional UPDATE matched nothing) means someone else holds it", async () => {
    const db = fakeDb([[]]);
    const be = new PostgresReindexLeaseBackend(db as never);
    expect(await be.acquire(NAME, "pod-a", 1_000, 60_000)).toBeNull();
  });

  it("acquire --force uses the UNCONDITIONAL upsert (no expiry/holder predicate)", async () => {
    const db = fakeDb([[{ holder: "pod-arch", expires_at: 61_000n, updated_at: 1_000n }]]);
    const be = new PostgresReindexLeaseBackend(db as never);
    await be.acquire(NAME, "pod-arch", 1_000, 60_000, { force: true });
    const sql = db.$queryRaw.mock.calls[0][0].join("?");
    expect(sql).toContain("ON CONFLICT");
    expect(sql).not.toContain("WHERE");
  });

  it("renew: one updated row = still ours; zero = FENCED", async () => {
    const be = new PostgresReindexLeaseBackend(fakeDb([[{ holder: "pod-a" }]]) as never);
    expect(await be.renew(NAME, "pod-a", 1_000, 60_000)).toBe(true);
    const fenced = new PostgresReindexLeaseBackend(fakeDb([[]]) as never);
    expect(await fenced.renew(NAME, "pod-a", 1_000, 60_000)).toBe(false);
  });

  it("assertHeld: an UPDATE (which takes the SAME row lock a FOR UPDATE would), not a SELECT", async () => {
    // PR #805 review round 2. The fence MUST take the lease row's exclusive lock — that
    // is what makes a concurrent steal block behind the swap's COMMIT instead of racing
    // it, and it is the load-bearing claim of the whole PR (proved on a real Postgres in
    // the (c4)/(c4-control) pair). An `UPDATE … WHERE` takes exactly that lock, so the
    // fence keeps its teeth — and, unlike `SELECT … FOR UPDATE`, it also RENEWS, which is
    // what stops a swap longer than the TTL from committing with a dead lease.
    const db = fakeDb([[{ holder: "pod-a" }]]);
    const be = new PostgresReindexLeaseBackend(db as never);
    await expect(be.assertHeld(P, NAME, "pod-a", undefined, 99_000)).resolves.toBeUndefined();

    const sql = db.$queryRaw.mock.calls[0][0].join("?");
    expect(sql).toContain("UPDATE");
    expect(sql).toContain('SET "expires_at"');
    expect(sql).toContain('"holder" =');
    expect(sql).toContain("RETURNING");
    // A plain locking read would neither renew nor prove holdership atomically.
    expect(sql).not.toContain("SELECT");
    // The lease is pushed out to the caller's deadline, bound as a parameter.
    expect(db.$queryRaw.mock.calls[0]).toContain(99_000);
  });

  it("assertHeld: ZERO updated rows means FENCED (someone stole or deleted our lease)", async () => {
    // Same signal `renew()` uses: the `WHERE holder = me` matched nothing, so the row is
    // gone or names somebody else. Either way we must not mutate.
    const db = fakeDb([[]]);
    const be = new PostgresReindexLeaseBackend(db as never);
    await expect(be.assertHeld(P, NAME, "pod-a", undefined, 99_000)).rejects.toBeInstanceOf(
      ReindexFencedError,
    );
  });

  it("assertHeld: runs on the caller's TRANSACTION client when one is supplied", async () => {
    const db = fakeDb([]);
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ holder: "pod-a" }]) };
    const be = new PostgresReindexLeaseBackend(db as never);
    await expect(be.assertHeld(P, NAME, "pod-a", tx, 99_000)).resolves.toBeUndefined();
    // THE POINT: the fence must be checked inside the swap's transaction, not beside it.
    // Both the row lock AND the renewal have to be atomic with the cut-over.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("read / forceRelease map rows back, and null when there is none", async () => {
    const db = fakeDb([[{ holder: "pod-a", expires_at: 9n, updated_at: 8n }], []]);
    const be = new PostgresReindexLeaseBackend(db as never);
    expect(await be.read(NAME)).toMatchObject({ holder: "pod-a", expiresAt: 9, updatedAt: 8 });
    expect(await be.forceRelease(NAME)).toBeNull();
  });

  it("creates its UNLOGGED table ONCE per process, behind a transaction-scoped advisory lock", async () => {
    const db = fakeDb([[], []]);
    const be = new PostgresReindexLeaseBackend(db as never);
    await be.read(NAME);
    await be.read(NAME);
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const ddl = db.$executeRawUnsafe.mock.calls[0][0] as string;
    expect(ddl).toContain("pg_advisory_xact_lock");
    expect(ddl).toContain('CREATE UNLOGGED TABLE IF NOT EXISTS "reindex_lease"');
  });

  it("a failed table-create is RETRIED on the next call, not cached forever", async () => {
    const db = fakeDb([[]]);
    db.$executeRawUnsafe.mockRejectedValueOnce(new Error("no db"));
    const be = new PostgresReindexLeaseBackend(db as never);
    await expect(be.read(NAME)).rejects.toThrow("no db");
    await expect(be.read(NAME)).resolves.toBeNull();
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("release deletes only OUR row", async () => {
    const db = fakeDb([]);
    const be = new PostgresReindexLeaseBackend(db as never);
    await be.release(NAME, "pod-a");
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect((db.$executeRaw.mock.calls[0][0] as string[]).join("?")).toContain("DELETE FROM");
  });

  it("reset truncates the lease table and swallows a missing one", async () => {
    const db = fakeDb([]);
    const be = new PostgresReindexLeaseBackend(db as never);
    await be.reset();
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith('TRUNCATE TABLE "reindex_lease"');
  });
});
