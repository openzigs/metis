/**
 * Issue #798 — the reindex lease, against a REAL Postgres, through Prisma's REAL
 * connection pool. The pool is the whole point: the bug being fixed here is invisible
 * to any test that mocks it.
 *
 * What is proved, in the order the issue's acceptance criteria ask for it:
 *
 *   (a) TAKE + RELEASE ARE POOL-AGNOSTIC. This test is the reproduction. Against the
 *       PRE-FIX code (session `pg_try_advisory_lock` taken on one pooled connection,
 *       `pg_advisory_unlock` released on whatever connection the pool handed the next
 *       statement) it FAILS — 8 of 8 locks stayed held after 8 successful-looking
 *       discards, because the unlock returned `false` and the old code discarded that
 *       boolean. With the lease it passes, and no advisory lock is taken at all.
 *
 *   (b) AN INTERRUPTED RUN DOES NOT WEDGE THE NEXT ATTEMPT. A holder that dies without
 *       releasing (SIGKILL / pod eviction) leaves a lease that lapses; the next
 *       attempt takes it. Proved twice: from a synthetic expired lease, and by actually
 *       forking a child process, having it take the lease, and SIGKILLing it.
 *
 *   (c) #787'S MULTI-REPLICA GUARANTEE SURVIVES. A TTL lease alone would REOPEN the
 *       partial-cutover data-loss path (holder stalls → lease lapses → another replica
 *       discards the shadow → the stalled holder resurrects it and swaps a PARTIAL
 *       index into the live name). The fencing token closes it: the fenced run is
 *       refused AT THE UPSERT and AT THE SWAP — and the swap's refusal is enforced
 *       INSIDE the swap's own SQL transaction, so a lease steal cannot slip into the
 *       gap between the check and the cut-over.
 *
 * Gated exactly like leader-election-postgres / rate-limit-store-postgres: runs only
 * when `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (via
 * `pnpm test:integration`). In CI the `postgres-adapter` job provides a real Postgres.
 * The backend self-creates its UNLOGGED table behind an advisory lock, so there is NO
 * migration and no schema setup beyond a reachable Postgres.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensurePgTestSchema,
  isPostgresUrl,
  makeSchemaScopedPrismaClient,
} from "./lib/pg/pg-test-schema.js";
import type { Embedder } from "../src/lib/rag/embedder.js";
import { KnowledgeService, reindexShadowId } from "../src/lib/rag/knowledge-service.js";
import {
  PostgresReindexLeaseBackend,
  ReindexConflictError,
  ReindexFencedError,
  reindexLockName,
} from "../src/lib/rag/reindex-lease.js";
import { PgVectorStore } from "../src/lib/rag/vector-store-pgvector.js";
import {
  LocalVectorStore,
  type RawSqlExecutor,
  type VectorStore,
} from "../src/lib/rag/vector-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgresUrl(databaseUrl);

const here = path.dirname(fileURLToPath(import.meta.url));

// Issue #806 — this suite owns a PRIVATE Postgres schema (its own `reindex_lease` +
// `rag_vectors`), so it shares no state with any other suite. Its vector width is a purely
// LOCAL choice: 8 here vs the vector-store suite's 16 is the PROOF that different-width
// suites now coexist in one CI run. Every client below — including the SIGKILL child
// process — pins `search_path=<schema>,public` at connect time.
const SCHEMA = "metis_it_reindex";
const IT_VECTOR_DIM = 8;

function fakeEmbedder(model = "it-model"): Embedder {
  return {
    model,
    dimension: 4,
    embed: async (texts: string[]) => ({
      vectors: texts.map((t) => [t.charCodeAt(0) || 1, 1, 2, 3]),
      model,
      dimension: 4,
    }),
  } as unknown as Embedder;
}

function tmpRoot(): string {
  return path.join(os.tmpdir(), `it-798-${Math.random().toString(36).slice(2)}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A promise a test can resolve by hand — used to hold the swap's transaction OPEN. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.runIf(enabled)("Issue #798 — the reindex lease on a real Postgres", () => {
  // An OBSERVER on its own client, pinned to this suite's private schema (#806): what the
  // CLUSTER sees, independent of the pooled client the service under test uses.
  const observer = makeSchemaScopedPrismaClient(SCHEMA, databaseUrl);
  // Separately-constructed backends over ONE database = separate pods (the pattern
  // `leader-election-postgres.integration.test.ts` established).
  const backendA = new PostgresReindexLeaseBackend(observer);
  const backendB = new PostgresReindexLeaseBackend(observer);
  // A THIRD client with its OWN pool = the stealing pod's connection. It must not share
  // `observer`'s pool with the swap transaction under test: the swap PINS a connection
  // for the whole of its callback, and the point of (c4) is that the steal blocks on a
  // ROW LOCK in Postgres — not on a client-side connection queue in Node. It is pinned to
  // the SAME private schema (#806) so it operates on the same `reindex_lease` row.
  const stealerDb = makeSchemaScopedPrismaClient(SCHEMA, databaseUrl);
  const stealer = new PostgresReindexLeaseBackend(stealerDb);
  const roots: string[] = [];

  beforeAll(async () => {
    // Create the private schema + the DATABASE-scoped `vector` extension in `public`,
    // before any store or backend runs its lazy `ensureSchema()`.
    await ensurePgTestSchema(SCHEMA, databaseUrl);
  });

  beforeEach(async () => {
    await backendA.reset();
  });

  afterAll(async () => {
    await backendA.reset();
    await Promise.all([observer.$disconnect(), stealerDb.$disconnect()]);
    await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
  });

  function makeStore(): VectorStore {
    const root = tmpRoot();
    roots.push(root);
    return new LocalVectorStore({ root });
  }

  /** The store that actually runs in the multi-replica deployment (c4/c5/c6). */
  function pgStore(): PgVectorStore {
    return new PgVectorStore({ db: observer, dimension: IT_VECTOR_DIM });
  }

  async function resetVectors(store: PgVectorStore, projectId: string): Promise<void> {
    await store.dropTable(projectId);
    await store.dropTable(reindexShadowId(projectId));
  }

  /**
   * Is some backend currently BLOCKED waiting for another transaction's row lock?
   *
   * `wait_event_type = 'Lock'` + `wait_event = 'transactionid'` is Postgres' own word for
   * "this statement has queued behind an uncommitted transaction that holds the tuple it
   * wants" — which is precisely what the fence does to a steal. Asserting on this turns
   * (c4) from "the steal hadn't come back after a second, so we infer it is blocked" into
   * a direct observation of the mechanism.
   *
   * Polled, because the stealer's `acquire` has to be dispatched, parsed and planned
   * before it reaches the lock and reports the wait.
   */
  async function waitingOnRowLock(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await observer.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*) AS waiting
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND state = 'active'
           AND wait_event_type = 'Lock'
           AND wait_event = 'transactionid'`;
      if (Number(rows[0]?.waiting ?? 0) > 0) return true;
      if (Date.now() >= deadline) return false;
      await sleep(50);
    }
  }

  /** Is a SESSION advisory lock still held anywhere for this project's old reindex key? */
  async function advisoryLockHeld(projectId: string): Promise<boolean> {
    const rows = await observer.$queryRaw<Array<{ held: boolean }>>`
      SELECT EXISTS (
        SELECT 1
          FROM pg_locks
         WHERE locktype = 'advisory'
           AND granted
           AND objsubid = 1
           AND classid = (((hashtext('reindex:' || ${projectId})::bigint >> 32) & 4294967295))::oid
           AND objid   = (((hashtext('reindex:' || ${projectId})::bigint) & 4294967295))::oid
      ) AS held`;
    return rows[0]?.held === true;
  }

  // ---- (a) the leak ---------------------------------------------------------

  it("(a) take + release are POOL-AGNOSTIC — nothing is left held after the work completes", async () => {
    const svc = new KnowledgeService({ embedder: fakeEmbedder(), vectorStore: makeStore() });
    const stamp = Date.now();
    // Eight projects locked + unlocked CONCURRENTLY through the SHARED pooled Prisma
    // client. The concurrency is what makes this deterministic: the pool serves the
    // eight acquires on eight different backends and then serves the eight releases in
    // whatever order idle connections pop, so the chance that every release happens to
    // land back on the backend that took its lock is ~1/8! ≈ 0.00002.
    //
    // PRE-FIX this failed with all 8 projects still locked — and every discard had
    // logged "reindex shadow discarded", because `pg_advisory_unlock`'s `false` return
    // was thrown away. That is the wedge: every later reindex of those projects would
    // 409 until the pod restarted.
    const projects = Array.from({ length: 8 }, (_, i) => `it798-leak-${stamp}-${i}`);

    // `discardReindexShadow` is the shortest path through take → work → release.
    await Promise.all(projects.map((p) => svc.discardReindexShadow(p)));

    // NOTE (PR #805 review) — this assertion is the REPRODUCTION, not a regression guard.
    // Post-fix nothing in the reindex path takes a session advisory lock at all, so it
    // can never fail again whatever the lease code does. The assertion carrying weight
    // GOING FORWARD is the `read(...) === null` loop below: the release really happened,
    // on whatever pooled connection served it.
    const stillHeld: string[] = [];
    for (const p of projects) {
      if (await advisoryLockHeld(p)) stillHeld.push(p);
    }
    expect(stillHeld).toEqual([]);

    // And the lease rows really are gone from the table (the release was a DELETE that
    // any connection can serve, which is the entire fix).
    for (const p of projects) {
      expect(await backendA.read(reindexLockName(p))).toBeNull();
    }
  });

  // ---- (b) an interrupted run does not wedge the next attempt ---------------

  it("(b1) an ABANDONED lease (holder SIGKILLed, never released) is stolen by the next attempt", async () => {
    const projectId = `it798-abandoned-${Date.now()}`;
    const name = reindexLockName(projectId);
    // Exactly the row a killed pod leaves behind: held, never released, TTL lapsed.
    await backendA.acquire(name, "pod-dead:run-0", Date.now() - 600_000, 1_000);
    expect((await backendA.read(name))?.holder).toBe("pod-dead:run-0");

    // A fresh acquirer (another pod, or the same pod after a restart) simply wins.
    const row = await backendB.acquire(name, "pod-live:run-1", Date.now(), 60_000);
    expect(row?.holder).toBe("pod-live:run-1");
    await backendB.release(name, "pod-live:run-1");
  });

  it("(b2) a lease held by a SIGKILLed CHILD PROCESS does not wedge the next reindex", async () => {
    const projectId = `it798-sigkill-${Date.now()}`;
    const name = reindexLockName(projectId);

    // A REAL separate process (a real pod) takes the lease with a short TTL and then
    // parks forever — the pod-eviction / OOM-kill shape.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(here, "fixtures", "reindex-lease-holder.ts")],
      {
        env: {
          ...process.env,
          REINDEX_LEASE_PROJECT_ID: projectId,
          REINDEX_LEASE_HOLDER: "child-pod:run-kill",
          REINDEX_LEASE_TTL_MS: "3000",
          // #806 — the child is a SEPARATE process with its OWN pool; it must pin the same
          // private schema at connect time or it would take the lease in `public` instead.
          REINDEX_LEASE_SCHEMA: SCHEMA,
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    try {
      // Wait for the child to report that it holds the lease.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child never acquired the lease")), 30_000);
        child.stdout.on("data", (buf: Buffer) => {
          if (buf.toString().includes("ACQUIRED")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`child exited early with code ${String(code)}`));
        });
      });
      expect(
        (
          await observer.$queryRaw<Array<{ holder: string }>>`
        SELECT "holder" FROM "reindex_lease" WHERE "lock_name" = ${name}`
        )[0]?.holder,
      ).toBe("child-pod:run-kill");

      // KILL IT. No shutdown hook runs; the lease is never released; the connection
      // simply dies. With the OLD session advisory lock this is the case that also
      // released the lock (on TCP close) — but ONLY because the lock was still on a
      // live connection; the leaked-lock case (this issue) had no such escape, and the
      // project stayed wedged until the SERVER pod restarted.
      child.kill("SIGKILL");
      await new Promise<void>((r) => child.on("exit", () => r()));
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }

    // The abandoned lease is still there — and that is FINE, because it expires.
    const abandoned = await backendA.read(name);
    expect(abandoned?.holder).toBe("child-pod:run-kill");

    // Wait out the (deliberately short) TTL, then run a REAL reindex on this project:
    // it takes the dead holder's lease and completes. No pod restart, no `unlock`.
    await vi.waitFor(
      async () => {
        const row = await backendA.read(name);
        expect(row && row.expiresAt <= Date.now()).toBe(true);
      },
      { timeout: 15_000, interval: 500 },
    );

    const svc = new KnowledgeService({
      embedder: fakeEmbedder(),
      vectorStore: makeStore(),
      reindexLeaseBackend: backendA,
    });
    await expect(svc.reindexProject(projectId)).resolves.toMatchObject({ projectId });
    expect(await backendA.read(name)).toBeNull();
  });

  // ---- (c) #787's guarantee, under fencing ----------------------------------

  it("(c) a FENCED run is refused at the UPSERT gate and at the SWAP gate — no partial cut-over", async () => {
    const projectId = `it798-fence-${Date.now()}`;
    const name = reindexLockName(projectId);
    const store = makeStore();

    // Pod B is mid-reindex and its lease has LAPSED (a stall, a partition, a long GC).
    // Pod A's discard is entirely legitimate — as far as the cluster can tell, B is
    // dead — and it takes the free lease and drops B's shadow. Model B's stall by
    // giving B's run a lease that A can steal.
    await backendB.acquire(name, "pod-b:run-1", Date.now() - 600_000, 1_000); // B, expired
    const stolen = await backendA.acquire(name, "pod-a:discard", Date.now(), 60_000);
    expect(stolen?.holder).toBe("pod-a:discard");

    // Now B wakes up holding a token the database no longer recognises.
    const bLease = {
      holder: "pod-b:run-1",
      renew: () => backendB.renew(name, "pod-b:run-1", Date.now(), 60_000),
      assertHeld: () => backendB.assertHeld(projectId, name, "pod-b:run-1"),
    };

    // GATE 1 — the per-batch fence. B's renew fails, so B aborts BEFORE its upsert:
    // it cannot even RECREATE the shadow that A just discarded.
    expect(await bLease.renew()).toBe(false);

    // GATE 2 — the swap fence. Even if B somehow reached the cut-over, the swap is
    // refused: the lease row names pod-a, not pod-b.
    await expect(bLease.assertHeld()).rejects.toBeInstanceOf(ReindexFencedError);

    // And the store-level guard refuses the swap outright, leaving the live index as
    // it was. (Seed a live index + a partial shadow, exactly the state the data-loss
    // path needed: pre-#798 this swap would have SUCCEEDED and cut a 1-chunk shadow
    // over a 2-chunk live index.)
    await store.upsert(projectId, [
      vecRow("live-1", "the live index"),
      vecRow("live-2", "the live index"),
    ]);
    await store.upsert(reindexShadowId(projectId), [vecRow("partial-1", "a PARTIAL shadow")]);

    const fencedGuard = {
      assertHeld: () => backendB.assertHeld(projectId, name, "pod-b:run-1"),
    };
    await expect(
      store.swapTable(projectId, reindexShadowId(projectId), fencedGuard),
    ).rejects.toBeInstanceOf(ReindexFencedError);

    const live = await store.listChunkRefs(projectId);
    expect(live.map((r) => r.chunkId).sort()).toEqual(["live-1", "live-2"]);

    await backendA.release(name, "pod-a:discard");
  });

  it("(c2) a discard is REFUSED (409) while another replica holds a LIVE lease", async () => {
    const projectId = `it798-conflict-${Date.now()}`;
    const name = reindexLockName(projectId);
    await backendB.acquire(name, "pod-b:run-1", Date.now(), 60_000);

    const svc = new KnowledgeService({
      embedder: fakeEmbedder(),
      vectorStore: makeStore(),
      reindexLeaseBackend: backendA,
    });

    const err = await svc.discardReindexShadow(projectId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReindexConflictError);
    expect((err as ReindexConflictError).holder).toBe("pod-b:run-1");

    await backendB.release(name, "pod-b:run-1");
  });

  // ---- (c4/c5) the FOR UPDATE fence, against a REAL PgVectorStore ------------
  //
  // PR #805 review, BLOCKING #2. The claim the whole PR rests on is:
  //
  //   the guard's `SELECT … FOR UPDATE` on the lease row, run INSIDE the swap's own
  //   transaction, makes a replica trying to steal the lease BLOCK behind the swap's
  //   COMMIT rather than race it — so the half-open window (renew → long pause →
  //   swap) is CLOSED, not merely narrowed.
  //
  // Test (c) above proves fencing against `LocalVectorStore`, which has no SQL
  // transaction at all, and the unit test proves it against a fake whose `$transaction`
  // is `fn(this)`. Neither can observe a row lock. Only a real Postgres can, and
  // `PgVectorStore` is the store that actually runs in the multi-replica deployment
  // #787 is about. So: prove it here, on the real thing.

  it("(c4) the swap's fence ROW LOCK makes a concurrent lease STEAL BLOCK until the cut-over commits", async () => {
    const projectId = `it798-forupdate-${Date.now()}`;
    const name = reindexLockName(projectId);
    const store = pgStore();
    await resetVectors(store, projectId);

    // Pod B's lease has LAPSED (a stall, a partition, a long GC), so pod A's steal is
    // entirely legitimate and would succeed THE INSTANT it is not blocked. That is what
    // makes this the dangerous interleaving and not a contrived one.
    await backendB.acquire(name, "pod-b:run-1", Date.now() - 600_000, 1_000);

    // The state the data-loss path needs: a live index, and a shadow B is about to cut
    // over. (Whether B *should* still be swapping is not the question — `renew()` has no
    // expiry predicate by design, so a lapsed-but-unstolen lease still swaps. The
    // question is whether A's steal can interleave INTO the cut-over.)
    await store.upsert(projectId, [vecRow("live-1", "live"), vecRow("live-2", "live")]);
    await store.upsert(reindexShadowId(projectId), [vecRow("new-1", "the new index")]);

    // Hold the swap's transaction OPEN after the fence has taken the row lock, so the
    // race is observable rather than a microsecond wide.
    const fenceTaken = deferred();
    const releaseSwap = deferred();
    const guard = {
      assertHeld: async (exec?: RawSqlExecutor) => {
        // THE STATEMENT UNDER TEST: the fence's row-locking `UPDATE` on `exec` = the
        // swap's tx. (It was a `SELECT … FOR UPDATE` until the round-2 review; an `UPDATE`
        // takes the SAME exclusive row lock, which is why this test is unchanged — the
        // blocking it asserts is the whole point and MUST survive that swap of statement.)
        await backendB.assertHeld(projectId, name, "pod-b:run-1", exec, Date.now() + 60_000);
        fenceTaken.resolve();
        await releaseSwap.promise;
      },
    };

    let swapCommitted = false;
    const swap = store.swapTable(projectId, reindexShadowId(projectId), guard).then(() => {
      swapCommitted = true;
    });

    await fenceTaken.promise; // the lease row is now locked by the OPEN swap transaction

    // Pod A steals, from a SEPARATE client = a separate pod on a separate connection.
    let stealReturned = false;
    const steal = stealer
      .acquire(name, "pod-a:steal", Date.now(), 60_000)
      .then((row) => ((stealReturned = true), row));

    let outcome: string;
    let committedDuringRace = true;
    let provedWaitingOnLock = false;
    // #813 — sample "the steal has NOT come back" WHILE the swap transaction is still
    // open, synchronised on the lock being HELD (below), NOT after the finally releases
    // it. The post-commit reading this replaced was a foot-race: the steal is correctly
    // blocked for the whole open transaction, but the instant the swap COMMITs it unblocks
    // and resolves (to `null` — it takes nothing), and whether its `.then` had run by the
    // time the synchronous `expect` fired depended purely on the event-loop ordering of
    // two independent post-COMMIT socket reads (the swap's COMMIT ack vs the steal's
    // result). Nothing ordered them, so `expect(stealReturned).toBe(false)` failed ~1/100
    // under load (PR #810's `postgres-adapter`) while `outcome`, fixed back at t=1 s, still
    // read "steal-blocked" — the contradiction in the report. The fence itself never
    // wavered: measured over 100 iterations this sample was false 100/100.
    let stealBlockedWhileTxOpen = false;
    try {
      // THE ASSERTION. A's `INSERT … ON CONFLICT DO UPDATE` must take the same row lock
      // the swap holds, so it cannot make progress while the swap transaction is open.
      outcome = await Promise.race([
        steal.then(() => "steal-won-the-race" as const),
        sleep(1_000).then(() => "steal-blocked" as const),
      ]);
      committedDuringRace = swapCommitted; // must be false: the tx is still open
      // …and PROVE it is blocked rather than merely slow. "It hadn't finished after 1 s"
      // is a wall-clock inference; Postgres will tell us the truth if we ask. A backend
      // waiting on `Lock`/`transactionid` is one that has queued behind another
      // transaction's row lock — i.e. exactly the fence doing its job, on the record.
      provedWaitingOnLock = await waitingOnRowLock();
      // The deterministic reading of "the steal is still blocked": Postgres has just told
      // us (line above) that the stealer's backend is parked on `Lock`/`transactionid`. A
      // backend blocked on the row lock has not returned a result, so `stealReturned` here
      // is false as a LOGICAL CONSEQUENCE of `provedWaitingOnLock`, not by luck of timing —
      // there is no `await` between that observation and this read, so nothing can flip it.
      // The swap tx is still open (released only in the finally), so the lock still stands.
      stealBlockedWhileTxOpen = !stealReturned;
    } finally {
      // ALWAYS commit, even on assertion failure. An abandoned open transaction keeps
      // its row lock, and the next test's `reset()` TRUNCATE would then block on it —
      // turning one honest failure into a suite-wide 60 s hang.
      releaseSwap.resolve();
      await swap.catch(() => {});
    }
    expect(outcome).toBe("steal-blocked");
    // Blocked for the whole open transaction — sampled while the lock was demonstrably
    // held, not raced against the commit that releases it. See the #813 note above.
    expect(stealBlockedWhileTxOpen).toBe(true);
    expect(committedDuringRace).toBe(false);
    // Not "it looked slow" — Postgres reported the stealer parked on a row lock.
    expect(provedWaitingOnLock).toBe(true);

    // The steal is released by the COMMIT, not before it.
    const stolen = await steal;
    expect(swapCommitted).toBe(true);

    // …and when it finally runs, it takes NOTHING.
    //
    // This is the round-2 review's second-order fix, visible from the other side. Until
    // the fence learned to RENEW, the lease it locked was left EXPIRED (B acquired it
    // 600 s ago with a 1 s TTL), so the steal queued behind the row lock won the instant
    // that lock dropped — fencing B at its post-swap `renew()` and silently skipping
    // delta re-apply / orphan deletes / retag on a cut-over that had just SUCCEEDED.
    // The fence's `UPDATE … SET expires_at` now extends the lease inside the swap's own
    // transaction, so A's `ON CONFLICT … WHERE expires_at <= now OR holder = me` matches
    // nothing and A gets a correct 409: B is demonstrably alive and has just cut over.
    //
    // (This assertion read `.toBe("pod-a:steal")` before the round-2 fix — i.e. the test
    // was faithfully DOCUMENTING the bug. The blocking assertions above are unchanged,
    // which is the point: the fence still blocks, it just no longer leaves a dead lease
    // behind for the blocked stealer to collect.)
    expect(stolen).toBeNull();
    expect((await backendB.read(name))?.holder).toBe("pod-b:run-1");

    // And the cut-over is WHOLE: the live namespace is exactly the shadow's rows. The
    // steal landed strictly AFTER it — never inside it, which is the only outcome the
    // half-open window could have produced.
    const live = await store.listChunkRefs(projectId);
    expect(live.map((r) => r.chunkId ?? r.id).sort()).toEqual(["new-1"]);
    expect(await store.count(reindexShadowId(projectId))).toBe(0);

    await resetVectors(store, projectId);
  });

  it("(c4-control) WITHOUT the FOR UPDATE, the same steal races the cut-over — the fence is what blocks it", async () => {
    // The anti-tautology control for (c4). If the harness could not OBSERVE a steal
    // completing mid-swap, (c4)'s "steal-blocked" would be worth nothing. Same
    // interleaving, same open transaction, same timings — the ONLY difference is that
    // this guard does not run `SELECT … FOR UPDATE`. The steal now sails straight
    // through while the swap transaction is still open: exactly the half-open window,
    // reproduced.
    const projectId = `it798-nofence-${Date.now()}`;
    const name = reindexLockName(projectId);
    const store = pgStore();
    await resetVectors(store, projectId);

    await backendB.acquire(name, "pod-b:run-1", Date.now() - 600_000, 1_000);
    await store.upsert(projectId, [vecRow("live-1", "live")]);
    await store.upsert(reindexShadowId(projectId), [vecRow("new-1", "the new index")]);

    const entered = deferred();
    const releaseSwap = deferred();
    const unfencedGuard = {
      assertHeld: async () => {
        entered.resolve();
        await releaseSwap.promise; // holds the tx open, takes NO row lock
      },
    };

    let swapCommitted = false;
    const swap = store.swapTable(projectId, reindexShadowId(projectId), unfencedGuard).then(() => {
      swapCommitted = true;
    });
    await entered.promise;

    let stolen: Awaited<ReturnType<typeof stealer.acquire>>;
    let committedDuringSteal = true;
    try {
      stolen = await stealer.acquire(name, "pod-a:steal", Date.now(), 60_000);
      committedDuringSteal = swapCommitted;
    } finally {
      releaseSwap.resolve();
      await swap.catch(() => {});
    }
    // The steal COMPLETED while the cut-over transaction was still open and uncommitted.
    expect(stolen?.holder).toBe("pod-a:steal");
    expect(committedDuringSteal).toBe(false);

    await resetVectors(store, projectId);
  });

  it("(c5) a FENCED swap through PgVectorStore is REFUSED, and the live rows survive untouched", async () => {
    // The inverse of (c4): the steal lands BEFORE the swap opens. Same assertion test (c)
    // makes against LocalVectorStore — but through the `FOR UPDATE` path, so it is the
    // real fence being exercised, not the store-level guard call.
    const projectId = `it798-pgfenced-${Date.now()}`;
    const name = reindexLockName(projectId);
    const store = pgStore();
    await resetVectors(store, projectId);

    await backendB.acquire(name, "pod-b:run-1", Date.now() - 600_000, 1_000);
    const stolen = await backendA.acquire(name, "pod-a:discard", Date.now(), 60_000);
    expect(stolen?.holder).toBe("pod-a:discard");

    await store.upsert(projectId, [vecRow("live-1", "live"), vecRow("live-2", "live")]);
    await store.upsert(reindexShadowId(projectId), [vecRow("partial-1", "a PARTIAL shadow")]);

    const fencedGuard = {
      assertHeld: (exec?: RawSqlExecutor) =>
        backendB.assertHeld(projectId, name, "pod-b:run-1", exec, Date.now() + 60_000),
    };
    await expect(
      store.swapTable(projectId, reindexShadowId(projectId), fencedGuard),
    ).rejects.toBeInstanceOf(ReindexFencedError);

    // Pre-#798 this swap SUCCEEDED and cut a 1-chunk shadow over a 2-chunk live index.
    const live = await store.listChunkRefs(projectId);
    expect(live.map((r) => r.chunkId ?? r.id).sort()).toEqual(["live-1", "live-2"]);
    // The transaction rolled back, so the shadow is intact and still resumable.
    expect(await store.count(reindexShadowId(projectId))).toBe(1);

    await backendA.release(name, "pod-a:discard");
    await resetVectors(store, projectId);
  });

  it("(c6) a swap that OUTLIVES the TTL still owns its lease at COMMIT — the queued steal LOSES", async () => {
    // PR #805 review round 2, the SECOND-ORDER bug.
    //
    // The fence's row lock is held until the cut-over commits, so for that whole window
    // the run's own heartbeat CANNOT renew — its `UPDATE` would just block on the same
    // lock (which is why the heartbeat is now suspended across the swap rather than
    // parking a pooled connection every 30 s until the pool is gone).
    //
    // That leaves a hole if the fence does not renew: a swap longer than the 120 s TTL
    // reaches COMMIT with an EXPIRED lease, and the steal queued behind the row lock —
    // whose `WHERE expires_at <= now` is now satisfied — wins the instant the lock drops.
    // The run is then fenced at its post-swap `renew()` and silently skips delta re-apply,
    // orphan deletes and the model retag. On a large corpus under any contention that
    // stops being an edge case and becomes the EXPECTED outcome.
    //
    // The fix: the fence RENEWS as it proves (one `UPDATE … WHERE holder = me`), pushing
    // `expires_at` out to cover the transaction's own deadline. Same row lock, same
    // 0-rows-means-fenced signal — plus a lease that survives its own cut-over.
    //
    // PRE-FIX (`SELECT … FOR UPDATE`, no renewal) this test goes red on the FIRST
    // assertion: the steal returns pod-a's row instead of null.
    const projectId = `it798-ttl-outlived-${Date.now()}`;
    const name = reindexLockName(projectId);
    const store = pgStore();
    await resetVectors(store, projectId);

    // A deliberately TINY TTL so a swap can outlive it inside a test's patience. 500 ms
    // here plays the part of "120 s TTL, 200 s cut-over" in production.
    const ttlMs = 500;
    await backendB.acquire(name, "pod-b:run-1", Date.now(), ttlMs);

    await store.upsert(projectId, [vecRow("live-1", "live"), vecRow("live-2", "live")]);
    await store.upsert(reindexShadowId(projectId), [vecRow("new-1", "the new index")]);

    const fenceTaken = deferred();
    const releaseSwap = deferred();
    const guard = {
      assertHeld: async (exec?: RawSqlExecutor) => {
        // Exactly what `ReindexLease.assertHeld(exec)` does: extend to cover the swap's
        // own budget, not the ordinary TTL.
        await backendB.assertHeld(projectId, name, "pod-b:run-1", exec, Date.now() + 60_000);
        fenceTaken.resolve();
        await releaseSwap.promise;
      },
    };

    const swap = store.swapTable(projectId, reindexShadowId(projectId), guard);
    await fenceTaken.promise;

    // The cut-over grinds on, well past the ORIGINAL TTL — the swap is relabelling a large
    // corpus and the heartbeat cannot renew (it would block on the fence's own row lock).
    await sleep(ttlMs * 3);

    // ONLY NOW does pod A try to take over — and this ORDERING IS THE TEST. `acquire`
    // evaluates `WHERE expires_at <= $now` against the `now` it is CALLED with, so a steal
    // issued BEFORE the lease lapsed carries a timestamp that predates the expiry and
    // would fail to steal for a reason that has nothing to do with the fence. The
    // dangerous, realistic case — and the one the review describes — is the pod that comes
    // along AFTER the TTL has visibly lapsed, sees a lease it is fully entitled to take,
    // and blocks on the row lock with a `now` that is already past `expires_at`. That
    // steal succeeds the instant the lock drops, unless the fence has renewed.
    const steal = stealer.acquire(name, "pod-a:steal", Date.now(), 60_000);
    expect(await waitingOnRowLock()).toBe(true); // queued behind the cut-over, as (c4) proves

    releaseSwap.resolve();
    await swap;

    // THE ASSERTION. The steal unblocked at COMMIT — and found the lease still VALID and
    // still pod-b's, so its `ON CONFLICT … WHERE expires_at <= now OR holder = me` matched
    // nothing and it took nothing. A 409 for pod A, which is correct: pod B is alive and
    // has just cut over.
    expect(await steal).toBeNull();

    // …so pod B is NOT fenced, and its post-swap work (delta re-apply, orphan deletes,
    // retag — `knowledge-service.ts` right after `swapTable`) proceeds.
    expect(await backendB.renew(name, "pod-b:run-1", Date.now(), ttlMs)).toBe(true);

    // And the cut-over itself is whole, as always.
    const live = await store.listChunkRefs(projectId);
    expect(live.map((r) => r.chunkId ?? r.id).sort()).toEqual(["new-1"]);

    await backendB.release(name, "pod-b:run-1");
    await resetVectors(store, projectId);
  });

  it("(c3) only ONE of three contending replicas wins the lease", async () => {
    const name = reindexLockName(`it798-race-${Date.now()}`);
    const now = Date.now();
    const results = await Promise.all([
      backendA.acquire(name, "pod-a", now, 60_000),
      backendB.acquire(name, "pod-b", now, 60_000),
      new PostgresReindexLeaseBackend(observer).acquire(name, "pod-c", now, 60_000),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  // ---- the operator escape hatch (AC 3) -------------------------------------

  it("an operator can OBSERVE a wedged lease and CLEAR it without restarting the pod", async () => {
    const projectId = `it798-unlock-${Date.now()}`;
    const svc = new KnowledgeService({
      embedder: fakeEmbedder(),
      vectorStore: makeStore(),
      reindexLeaseBackend: backendA,
    });
    // A holder that will never come back, with a long TTL — the wedge, as an operator
    // finds it.
    await backendB.acquire(
      reindexLockName(projectId),
      "pod-gone:run-1",
      Date.now() - 30_000,
      3_600_000,
    );

    // OBSERVE (`embeddings:migrate lock-status --project <id>`).
    const status = await svc.reindexLockStatus(projectId);
    expect(status).toMatchObject({ holder: "pod-gone:run-1", expired: false });
    expect(status?.ageMs).toBeGreaterThanOrEqual(30_000);
    // While it is held, a reindex is refused — this is the trap #798 is about.
    await expect(svc.reindexProject(projectId)).rejects.toBeInstanceOf(ReindexConflictError);

    // CLEAR (`embeddings:migrate unlock --project <id> --force`).
    const cleared = await svc.forceReleaseReindexLock(projectId);
    expect(cleared?.holder).toBe("pod-gone:run-1");

    // The project is immediately usable again, and the cleared holder is FENCED.
    expect(
      await backendB.renew(reindexLockName(projectId), "pod-gone:run-1", Date.now(), 60_000),
    ).toBe(false);
    await expect(svc.reindexProject(projectId)).resolves.toMatchObject({ projectId });
  });

  it("the lease table is created lazily, with NO Prisma model and NO migration", async () => {
    const rows = await observer.$queryRaw<Array<{ relpersistence: string }>>`
      SELECT c.relpersistence::text
        FROM pg_class c
       WHERE c.relname = 'reindex_lease'`;
    // 'u' = UNLOGGED. Deliberate: on Postgres crash-recovery restart the table is
    // truncated and every lease vanishes — fail-OPEN for new acquirers, so no wedge.
    // A pod with a reconnecting pool CAN survive that restart mid-reindex, so a live
    // holder whose row was truncated away is reachable; it is fenced anyway, because
    // `renew()` then matches 0 rows and `assertHeld` finds none. See the module header.
    expect(rows[0]?.relpersistence).toBe("u");
  });
});

function vecRow(id: string, text: string) {
  return {
    id,
    // Must match the `rag_vectors` column both Postgres suites share — so DERIVE the
    // width, never re-type it. (LocalVectorStore, used by the other tests here, is
    // width-agnostic, so this is only load-bearing for c4/c5/c6.)
    vector: Array.from({ length: IT_VECTOR_DIM }, (_v, i) => i + 1),
    metadata: {
      chunkId: id,
      documentId: "d1",
      filename: "f.md",
      position: 0,
      text,
      embeddingModel: "it-model",
    },
  };
}
