/**
 * #1904 — racing login claims on a REAL Postgres through `@prisma/adapter-pg`.
 *
 * `resolveLoginUser` claims a legacy row and binds the identity in one
 * serializable transaction, and retries a lost race. Postgres reports a lost
 * race in two shapes on the pg adapter, and the retry must catch both:
 *
 * - a STATEMENT the database refuses (two claims of one row: the loser's
 *   `updateMany` meets a row changed since its snapshot) arrives as Prisma's
 *   `P2034`, because the query engine wraps it;
 * - a COMMIT the database refuses (two claims of DIFFERENT rows, each of which
 *   read the identities table the other then wrote: a read/write cycle that
 *   SERIALIZABLE aborts when the second commits) arrives as a
 *   `DriverAdapterError` whose `cause.kind` is `TransactionWriteConflict`, with
 *   no Prisma code. A check for `P2034` alone never retried it, so that sign-in
 *   got a raw error (a 500) for a row nobody else wanted.
 *
 * The interleavings are FORCED, not raced (#1395's suite races eight claims of
 * one row and passes whether or not they overlap). Each racer's transaction
 * client is held at a barrier until every racer reaches it: before the claim's
 * `updateMany`, after a `SELECT 1` that fixes the snapshot (the first case), or
 * after the identity's `create`, before the commit (the second). The retry's
 * transaction is not held. A barrier that never fills opens after a fallback,
 * and the test then fails on `arrivedAtOpen`, so a lost interleaving cannot
 * pass for a proof. Every outcome is read back from the rows.
 *
 * #2425 — a refused commit's retry used to start while the WINNER's commit was
 * still being flushed: Postgres had already judged the cycle (so it refused the
 * loser) but had not yet made the winner visible, so the retry read the
 * winner's row as in flight, became a pivot again and was refused again — three
 * times inside the old 60–100 ms of backoff, ending in `503 SIGN_IN_CONFLICT`.
 * It took one slow WAL flush on a CI runner to show. The second case now forces
 * that window: each held transaction sets `commit_delay` (a superuser setting,
 * as the CI and local `metis` roles are), so the winner's commit takes at least
 * {@link COMMIT_DELAY_MS}, and the test checks it did before trusting the result.
 * `commit_delay` sleeps only while `fsync` is on: a server started with
 * `-c fsync=off` skips the delay and fails the window check (never passes).
 * CI and `docker-compose` leave fsync on.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { resolveLoginUser } = await import("../src/lib/auth/login-identity.js");

const RACERS = 2;
const FALLBACK_MS = 5_000;
/** #2425 — how long the winner's commit is held in its WAL flush: `commit_delay`'s maximum. */
const COMMIT_DELAY_MS = 100;

interface Barrier {
  remaining: number;
  arrived: number;
  /** How many racers had arrived when the barrier opened; `null` while closed. */
  arrivedAtOpen: number | null;
  /** When the barrier opened (`performance.now()`); `null` while closed. */
  openedAt: number | null;
  open: Promise<void>;
  release: () => void;
}

function newBarrier(): Barrier {
  let resolve!: () => void;
  const open = new Promise<void>((r) => (resolve = r));
  const barrier: Barrier = {
    remaining: RACERS,
    arrived: 0,
    arrivedAtOpen: null,
    openedAt: null,
    open,
    release: () => {
      barrier.arrivedAtOpen ??= barrier.arrived;
      barrier.openedAt ??= performance.now();
      resolve();
    },
  };
  return barrier;
}

async function arrive(barrier: Barrier): Promise<void> {
  barrier.arrived += 1;
  if (barrier.arrived === RACERS) barrier.release();
  const timer = setTimeout(barrier.release, FALLBACK_MS);
  await barrier.open;
  clearTimeout(timer);
}

/** Where a racer's transaction waits for the others. */
type Hold = "before-claim" | "before-commit";

/** One `$transaction` a claim opened: whether it was held, and how it ended. */
interface TxRecord {
  held: boolean;
  committed: boolean | null;
  settledAt: number | null;
}

/** `tx` with the first `RACERS` holds of `hold` taken at `barrier`. */
function heldTx(tx: PrismaClient, barrier: Barrier, hold: Hold, record: TxRecord): PrismaClient {
  const [model, method] =
    hold === "before-claim" ? ["user", "updateMany"] : ["userIdentity", "create"];
  const delegate = Reflect.get(tx, model) as object;
  const wrapped = new Proxy(delegate, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== method || typeof value !== "function") return value;
      const call = (args: unknown[]) =>
        (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      return async (...args: unknown[]) => {
        if (barrier.remaining === 0) return call(args);
        barrier.remaining -= 1;
        record.held = true;
        if (hold === "before-claim") {
          await tx.$queryRaw`SELECT 1`;
          await arrive(barrier);
          return call(args);
        }
        const result = await call(args);
        // #2425 — this transaction's commit, if Postgres accepts it, sleeps in
        // its WAL flush: judged, but not yet visible to a retry that starts now.
        await tx.$executeRaw`SET LOCAL commit_siblings = 0`;
        await tx.$executeRaw`SET LOCAL commit_delay = 100000`; // µs: COMMIT_DELAY_MS
        await arrive(barrier);
        return result;
      };
    },
  });
  return new Proxy(tx, {
    get: (target, prop, receiver) =>
      prop === model ? wrapped : (Reflect.get(target, prop, receiver) as unknown),
  });
}

function held(
  client: PrismaClient,
  barrier: Barrier,
  hold: Hold,
  records: TxRecord[] = [],
): PrismaClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver) as unknown;
      return async (fn: (tx: PrismaClient) => Promise<unknown>, opts?: unknown) => {
        const record: TxRecord = { held: false, committed: null, settledAt: null };
        records.push(record);
        try {
          const result = await target.$transaction(
            (tx) => fn(heldTx(tx as PrismaClient, barrier, hold, record)),
            opts as never,
          );
          record.committed = true;
          return result;
        } catch (error) {
          record.committed = false;
          throw error;
        } finally {
          record.settledAt = performance.now();
        }
      };
    },
  });
}

describe.runIf(enabled)("#1904 login claim races on the Postgres adapter (integration)", () => {
  let db: PrismaClient;
  const suffix = randomUUID().slice(0, 8);
  const issuer = `https://idp1904-${suffix}.test`;
  const legacyName = (n: string) => `legacy1904-${n}-${suffix}`;

  beforeAll(() => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
  });

  afterAll(async () => {
    await db.user.deleteMany({
      where: { username: { startsWith: "legacy1904-", endsWith: suffix } },
    });
    await db.$disconnect();
  });

  const legacyRow = (name: string) =>
    db.user.create({
      data: { username: name, displayName: "L", email: `${name}@corp.test`, authSource: "oidc" },
    });

  const claim = (name: string, subject: string) =>
    resolveLoginUser({
      identity: { provider: "oidc", issuer, subject: `${subject}-${suffix}` },
      profile: { username: name, displayName: "L", email: `${name}@corp.test` },
      primaryKind: "ldap",
    });

  it("two claims of ONE row: the loser's refused statement is retried and refused with a 409", async () => {
    const name = legacyName("one");
    const row = await legacyRow(name);
    const barrier = newBarrier();
    state.db = held(db, barrier, "before-claim");

    const results = await Promise.allSettled([claim(name, "a"), claim(name, "b")]);

    expect(barrier.arrivedAtOpen).toBe(RACERS);
    expect(await db.userIdentity.count({ where: { userId: row.id } })).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: expect.objectContaining({ id: row.id }) },
    ]);
    expect(results.filter((r) => r.status === "rejected")).toMatchObject([
      {
        reason: {
          statusCode: 409,
          code: "ACCOUNT_LINK_REQUIRED",
          details: { reason: "other_subject" },
        },
      },
    ]);
  });

  it("claims of TWO rows: the commit Postgres refuses is retried, and both sign in", async () => {
    const names = [legacyName("x"), legacyName("y")];
    const rows = await Promise.all(names.map(legacyRow));
    const barrier = newBarrier();
    const txs: TxRecord[] = [];
    state.db = held(db, barrier, "before-commit", txs);

    const results = await Promise.allSettled([claim(names[0], "x"), claim(names[1], "y")]);

    expect(barrier.arrivedAtOpen).toBe(RACERS);
    // The window was open: one held commit was refused (so its claim retried),
    // and the other took at least COMMIT_DELAY_MS to land after the barrier.
    const heldTxs = txs.filter((t) => t.held);
    expect(heldTxs.map((t) => t.committed).sort()).toEqual([false, true]);
    const winner = heldTxs.find((t) => t.committed)!;
    expect(
      winner.settledAt! - barrier.openedAt!,
      "the winner's commit did not take commit_delay: is the role a superuser, and is fsync on?",
    ).toBeGreaterThanOrEqual(COMMIT_DELAY_MS);
    expect(results).toEqual(
      rows.map((row) => ({ status: "fulfilled", value: expect.objectContaining({ id: row.id }) })),
    );
    for (const row of rows) {
      expect(await db.userIdentity.count({ where: { userId: row.id } })).toBe(1);
    }
  });
});
