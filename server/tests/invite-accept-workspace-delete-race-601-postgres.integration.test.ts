/**
 * #601 — a workspace soft delete committing mid-accept is seen by the accept (Postgres).
 *
 * The accept route consumes the invite with a guarded `updateMany` whose
 * `workspace.deletedAt: null` condition is an EXISTS over `workspaces` (#580).
 * On Postgres READ COMMITTED, a statement blocked on a row lock re-checks only
 * the row it locked (EvalPlanQual); the EXISTS keeps the statement's snapshot.
 * So a DELETE committing while the accept runs was invisible to the guard,
 * leaving a member in an already-deleted workspace. The DELETE now voids the
 * workspace's outstanding invites in its own transaction, so the two writes
 * conflict on the invite row the guard does re-check.
 *
 * Proven through the REAL workspaces router, against the production database:
 *
 *   - the DELETE's transaction is held open just before its commit; the accept
 *     (whose pre-check read ran before the delete) issues its guarded consume
 *     and is seen blocked on a lock in `pg_locks`; the delete then commits. The
 *     accept must answer 410 "This workspace no longer exists" and no
 *     membership row may exist.
 *   - the reverse order: an accept that consumed first holds the DELETE until
 *     it commits. Both succeed (the member joined before the delete), nothing
 *     deadlocks, and the invite keeps the accept's consume time.
 *   - a positive control on a live workspace through the same harness.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
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
// The caller is injected below; workspace RBAC runs for real against the database.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { workspacesRouter } = await import("../src/routes/workspaces.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");

const SUFFIX = randomUUID().slice(0, 8);
const OWNER = `u-601pg-owner-${SUFFIX}`;
const INVITEE = `u-601pg-invitee-${SUFFIX}`;

/** A promise with its resolver exposed. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe.skipIf(!enabled)(
  "#601 — a workspace delete committing mid-accept is seen by the accept (Postgres)",
  () => {
    let db: PrismaClient;
    // A second client for observation, so polling never queues behind the pool under test.
    let observer: PrismaClient;
    const workspaces: string[] = [];

    /**
     * The next interactive transaction started through the route's client runs
     * its body, reports `entered`, and waits for `commit` before it may commit.
     */
    let hold: { entered: () => void; commit: Promise<void> } | null = null;
    /** Runs once, right after the route's first `workspaceInvite.findUnique`. */
    let afterFirstInviteRead: (() => Promise<void>) | null = null;

    const routeClient = () => {
      const extended = db.$extends({
        query: {
          workspaceInvite: {
            async findUnique({ args, query }) {
              const result = await query(args);
              const hook = afterFirstInviteRead;
              afterFirstInviteRead = null;
              if (hook) await hook();
              return result;
            },
          },
        },
      });
      return new Proxy(extended, {
        get(target, prop, receiver) {
          if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
          return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
            const held = hold;
            hold = null;
            return (target.$transaction as (...a: unknown[]) => Promise<unknown>)(
              async (tx: unknown) => {
                const out = await fn(tx);
                if (held) {
                  held.entered();
                  await held.commit;
                }
                return out;
              },
              // Held transactions outlive Prisma's 5s interactive default.
              { timeout: 60_000, maxWait: 30_000, ...(opts as object) },
            );
          };
        },
      });
    };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        req.user = { userId: OWNER, role: "developer" } as never;
        next();
      });
      a.use("/api/workspaces", workspacesRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const del = (workspaceId: string) => request(app()).delete(`/api/workspaces/${workspaceId}`);
    const accept = (token: string) =>
      request(app()).post(`/api/workspaces/invites/${token}/accept`);

    async function seedInvite(): Promise<{ workspaceId: string; token: string }> {
      const workspaceId = `ws-601pg-${SUFFIX}-${workspaces.length + 1}`;
      const token = `token-601pg-${SUFFIX}-${workspaces.length + 1}`;
      workspaces.push(workspaceId);
      await db.workspace.create({
        data: { id: workspaceId, name: workspaceId, slug: workspaceId },
      });
      await db.workspaceMember.create({ data: { workspaceId, userId: OWNER, role: "owner" } });
      await db.workspaceInvite.create({
        data: {
          workspaceId,
          email: `${INVITEE}@example.test`,
          role: "member",
          token,
          invitedById: OWNER,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      return { workspaceId, token };
    }

    const membership = (workspaceId: string) =>
      observer.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: INVITEE } },
      });

    /**
     * Resolves once some backend is waiting on a lock while running an UPDATE of
     * `workspace_invites` — the named request's guarded statement, blocked on a
     * row the other transaction holds. Resolves early if `settled` does, so a
     * statement that never blocks fails on its assertions, not a timeout.
     */
    async function blockedOnInvite(settled: Promise<unknown>): Promise<"blocked" | "settled"> {
      let done = false;
      void settled.finally(() => (done = true));
      for (let i = 0; i < 400; i += 1) {
        if (done) return "settled";
        const rows = await observer.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query ILIKE 'UPDATE%workspace_invites%'`;
        if (Number(rows[0]?.n ?? 0) > 0) return "blocked";
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("neither blocked on the invite row nor settled within 10s");
    }

    beforeAll(async () => {
      db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
      observer = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
      for (const id of [OWNER, INVITEE]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
    });

    beforeEach(() => {
      hold = null;
      afterFirstInviteRead = null;
      state.db = routeClient();
    });

    afterAll(async () => {
      if (db) {
        // The database is shared and outlives the run: remove what this run wrote.
        await db.workspaceInvite.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.workspaceMember.deleteMany({ where: { workspaceId: { in: workspaces } } });
        await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
        await db.user.deleteMany({ where: { id: { in: [OWNER, INVITEE] } } });
        await db.$disconnect();
      }
      await observer?.$disconnect();
    });

    it("refuses the accept, with no membership, when the delete commits while its consume is in flight", async () => {
      const { workspaceId, token } = await seedInvite();
      const deleteHeld = deferred();
      const releaseDelete = deferred();
      let deleteRes: Promise<request.Response> | null = null;

      // After the accept's pre-check read (workspace still live), start the real
      // DELETE and hold its transaction open with its writes done, uncommitted.
      afterFirstInviteRead = async () => {
        hold = { entered: deleteHeld.resolve, commit: releaseDelete.promise };
        deleteRes = del(workspaceId).then((r) => r);
        // A DELETE that commits without a transaction never reaches the hold.
        await Promise.race([deleteHeld.promise, deleteRes]);
        hold = null; // never lend it to the accept's own transaction
      };

      const acceptRes = accept(token).then((r) => r);
      // The accept's guarded consume starts while the delete is uncommitted: it
      // must wait on the invite row, not run past the delete on its snapshot.
      const phase = await blockedOnInvite(acceptRes);
      releaseDelete.resolve();

      const [res, delRes] = await Promise.all([acceptRes, deleteRes!]);
      expect(delRes.status, JSON.stringify(delRes.body)).toBe(200);
      expect(res.status, JSON.stringify(res.body)).toBe(410);
      expect(res.body.error.message).toBe("This workspace no longer exists");
      expect(await membership(workspaceId)).toBeNull();
      // The race was real: the consume waited on the delete, not on a committed row.
      expect(phase).toBe("blocked");
      const ws = await observer.workspace.findUnique({ where: { id: workspaceId } });
      expect(ws?.deletedAt).toBeInstanceOf(Date);
    });

    it("lets an accept that consumed first finish, then the delete lands (no deadlock)", async () => {
      const { workspaceId, token } = await seedInvite();
      const acceptHeld = deferred();
      const releaseAccept = deferred();
      hold = { entered: acceptHeld.resolve, commit: releaseAccept.promise };

      const acceptRes = accept(token).then((r) => r);
      await acceptHeld.promise; // consumed + member written, uncommitted
      const deleteRes = del(workspaceId).then((r) => r);
      // The delete's invite void waits on the row the accept consumed.
      expect(await blockedOnInvite(deleteRes)).toBe("blocked");
      releaseAccept.resolve();

      const [res, delRes] = await Promise.all([acceptRes, deleteRes]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(delRes.status, JSON.stringify(delRes.body)).toBe(200);
      expect(await membership(workspaceId)).toMatchObject({ role: "member" });
      const invite = await observer.workspaceInvite.findUnique({ where: { token } });
      const ws = await observer.workspace.findUnique({ where: { id: workspaceId } });
      // The accept's consume stands; the delete's void skipped the spent row.
      expect(invite?.consumedAt).toBeInstanceOf(Date);
      expect(invite!.consumedAt!.getTime()).toBeLessThan(ws!.deletedAt!.getTime());
    });

    it("accepts an invite to a live workspace through the same harness", async () => {
      const { workspaceId, token } = await seedInvite();
      const res = await accept(token);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await membership(workspaceId)).toMatchObject({ role: "member" });
    });
  },
);
