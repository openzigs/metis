/**
 * #1959 — every SERIALIZABLE transaction on the login and SCIM paths runs again
 * when the database aborts it on a write conflict, on a REAL database. Shared by
 * the SQLite test (`write-conflict-retry-1959.sqlite.test.ts`) and its Postgres
 * twin (`write-conflict-retry-1959-postgres.integration.test.ts`).
 *
 * Before #1959 `durable-roles.ts`, `role-reconciliation.ts` and `routes/scim.ts`
 * did not retry at all, so a conflict was a 500 (at sign-in, for
 * `reconcileTrustedLoginRole`); and `resolveLoginUser` retried a conflict once,
 * then answered a second one with `409 ACCOUNT_LINK_REQUIRED` and an
 * `identity_conflict:unique_conflict` audit entry — while adapter-pg's shape of
 * the error (`TransactionWriteConflict`, no Prisma code) was not retried at all.
 *
 * Conflicts are INJECTED, in both shapes: the suite hands the code a client
 * whose next N transactions run their work for real, inside a real transaction,
 * and are then refused, so the database rolls every write back exactly as it
 * does when Postgres refuses a commit. Every outcome is read back from the rows.
 * A last case races two first sign-ins of one user for real (forced to read
 * before either writes): on Postgres one of them is aborted (40001), and must
 * land on its retry.
 *
 * The calling file must `vi.mock` `lib/prisma.js` (so `prisma` returns
 * `state.db`), `lib/audit/audit-service.js` (handing its `audit` mock in as
 * `audited`), `lib/auth/jwt.js` and `lib/socket/user-disconnect.js`, before
 * importing this module.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock } from "vitest";
import { reconcileTrustedLoginRole } from "../../src/lib/auth/durable-roles.js";
import { resolveLoginUser } from "../../src/lib/auth/login-identity.js";
import { confirmRoleState, inspectRoleState } from "../../src/lib/auth/role-reconciliation.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { __resetScimTokens, addScimTokenForTest, scimRouter } from "../../src/routes/scim.js";

export interface WriteConflictState {
  db: unknown;
}

type Shape = "P2034" | "adapter-pg";
const SHAPES: readonly Shape[] = ["P2034", "adapter-pg"];

/** The two errors a refused serializable commit reaches the code as. */
function conflictError(shape: Shape): Error {
  return shape === "P2034"
    ? Object.assign(new Error("Transaction failed due to a write conflict or a deadlock"), {
        code: "P2034",
      })
    : Object.assign(new Error("TransactionWriteConflict"), {
        name: "DriverAdapterError",
        cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
      });
}

interface Conflicting {
  client: PrismaClient;
  /** Transactions opened through the client. */
  opened: () => number;
}

/** `db`, whose next `refuse` transactions do their work and are then aborted with `shape`. */
function conflicting(db: PrismaClient, refuse: number, shape: Shape): Conflicting {
  let opened = 0;
  const client = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver) as unknown;
      return (work: (tx: unknown) => Promise<unknown>, options?: unknown) => {
        opened += 1;
        const refused = opened <= refuse;
        return target.$transaction(async (tx) => {
          const result = await work(tx);
          if (refused) throw conflictError(shape);
          return result;
        }, options as never);
      };
    },
  });
  return { client, opened: () => opened };
}

interface Barrier {
  size: number;
  arrived: number;
  arrivedAtOpen: number | null;
  open: Promise<void>;
  release: () => void;
}

function newBarrier(size: number): Barrier {
  let resolve!: () => void;
  const open = new Promise<void>((r) => (resolve = r));
  const barrier: Barrier = {
    size,
    arrived: 0,
    arrivedAtOpen: null,
    open,
    release: () => {
      barrier.arrivedAtOpen ??= barrier.arrived;
      resolve();
    },
  };
  return barrier;
}

/**
 * `db`, whose first transaction per racer holds after its first `userRole` read
 * until every racer has made one, so both read "no roles" before either writes.
 * A barrier that never fills opens after `fallbackMs`: SQLite runs one write
 * transaction at a time, so there the second racer cannot arrive.
 */
function gatedOnRoleRead(db: PrismaClient, barrier: Barrier, fallbackMs: number): PrismaClient {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver) as unknown;
      return (work: (tx: unknown) => Promise<unknown>, options?: unknown) => {
        let held = barrier.arrivedAtOpen === null;
        return target.$transaction(
          (tx) =>
            work(
              new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  const value = Reflect.get(txTarget, txProp, txReceiver) as unknown;
                  if (txProp !== "userRole") return value;
                  const delegate = value as Record<string, unknown>;
                  return new Proxy(delegate, {
                    get(dTarget, dProp) {
                      const fn = dTarget[dProp as string];
                      if (dProp !== "findMany" || typeof fn !== "function") return fn;
                      return async (...args: unknown[]) => {
                        const rows = await (fn as (...a: unknown[]) => Promise<unknown>).apply(
                          dTarget,
                          args,
                        );
                        if (held) {
                          held = false;
                          barrier.arrived += 1;
                          if (barrier.arrived === barrier.size) barrier.release();
                          const timer = setTimeout(barrier.release, fallbackMs);
                          await barrier.open;
                          clearTimeout(timer);
                        }
                        return rows;
                      };
                    },
                  });
                },
              }),
            ),
          options as never,
        );
      };
    },
  });
}

export function describeWriteConflictRetry(opts: {
  title: string;
  skip: boolean;
  state: WriteConflictState;
  audited: Mock;
  open: () => Promise<PrismaClient>;
  close: () => Promise<void>;
  /** Unique per run, so a shared Postgres database never collides. */
  suffix: string;
  /** The engine runs both racers' transactions at once, so both must reach the barrier. */
  forced: boolean;
  hookTimeoutMs?: number;
}): void {
  const { state, suffix, audited } = opts;
  const PREFIX = `w1959-${suffix}`;
  const TOKEN = `scim-1959-${suffix}`;

  describe.skipIf(opts.skip)(opts.title, () => {
    let db: PrismaClient;
    let seq = 0;
    const app = express();
    app.use(express.json());
    app.use("/scim/v2", scimRouter());
    app.use(errorHandler);

    /** Point the code at `db`, refusing its next `refuse` transactions with `shape`. */
    function refuseNext(refuse: number, shape: Shape): Conflicting {
      const c = conflicting(db, refuse, shape);
      state.db = c.client;
      return c;
    }

    async function user(data: Record<string, unknown> = {}) {
      seq += 1;
      const username = `${PREFIX}-${seq}`;
      return db.user.create({
        data: { username, displayName: username, email: `${username}@corp.test`, ...data },
      });
    }

    beforeAll(async () => {
      db = await opts.open();
    }, opts.hookTimeoutMs);

    beforeEach(() => {
      audited.mockClear();
      state.db = db;
      __resetScimTokens();
      addScimTokenForTest(TOKEN);
    });

    afterAll(async () => {
      if (db) {
        const users = await db.user.findMany({
          where: { username: { startsWith: PREFIX } },
          select: { id: true },
        });
        const ids = users.map((u) => u.id);
        await db.auditLog.deleteMany({ where: { targetId: { in: ids } } });
        await db.userIdentity.deleteMany({ where: { userId: { in: ids } } });
        await db.userRole.deleteMany({ where: { userId: { in: ids } } });
        await db.user.deleteMany({ where: { id: { in: ids } } });
        await db.role.deleteMany({ where: { key: { startsWith: PREFIX } } });
      }
      await opts.close();
    }, opts.hookTimeoutMs);

    describe.each(SHAPES)("a %s write conflict", (shape) => {
      it("a sign-in claiming a legacy row loses two and still binds it, with no identity-conflict audit", async () => {
        const row = await user({ authSource: "oidc" });
        const subject = `sub-${randomUUID()}`;
        const c = refuseNext(2, shape);
        const resolved = await resolveLoginUser({
          identity: { provider: "oidc", issuer: `https://${PREFIX}.test`, subject },
          profile: { username: row.username, displayName: "Claimed", email: row.email },
          primaryKind: "ldap",
        });
        expect(resolved.id).toBe(row.id);
        expect(c.opened()).toBe(3);
        const bound = await db.userIdentity.findMany({ where: { userId: row.id } });
        expect(bound.map((b) => b.subject)).toEqual([subject]);
        expect(audited).not.toHaveBeenCalled();
      });

      it("a sign-in that loses every attempt is a transient 503 that writes and audits nothing", async () => {
        const row = await user({ authSource: "oidc" });
        const c = refuseNext(Number.MAX_SAFE_INTEGER, shape);
        await expect(
          resolveLoginUser({
            identity: { provider: "oidc", issuer: `https://${PREFIX}.test`, subject: "s" },
            profile: { username: row.username, displayName: "Claimed", email: row.email },
            primaryKind: "ldap",
          }),
        ).rejects.toMatchObject({ statusCode: 503, code: "SIGN_IN_CONFLICT" });
        expect(c.opened()).toBe(3);
        expect(await db.userIdentity.count({ where: { userId: row.id } })).toBe(0);
        const after = await db.user.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.displayName).toBe(row.displayName);
        expect(audited).not.toHaveBeenCalled();
      });

      it("the sign-in's role reconciliation loses two and still grants the provider role once", async () => {
        const row = await user();
        const c = refuseNext(2, shape);
        await expect(
          reconcileTrustedLoginRole({
            userId: row.id,
            providerRole: "developer",
            authRolesInitializedAt: null,
          }),
        ).resolves.toBe("developer");
        expect(c.opened()).toBe(3);
        const roles = await db.userRole.findMany({
          where: { userId: row.id },
          include: { role: true },
        });
        expect(roles.map((r) => [r.role.key, r.source])).toEqual([["developer", "provider"]]);
        const after = await db.user.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.authRolesInitializedAt).not.toBeNull();
      });

      it("a role reconciliation's inspect and confirm each lose conflicts and record one decision", async () => {
        const row = await user({ authRoleAuthority: "unknown" });
        const actor = { kind: "host-operator", name: "1959 operator" } as const;
        const target = { targetId: row.id, username: row.username };
        let c = refuseNext(1, shape);
        const inspected = await inspectRoleState(actor, target);
        expect(c.opened()).toBe(2);

        const requestId = randomUUID();
        c = refuseNext(2, shape);
        const confirmed = await confirmRoleState(actor, {
          ...target,
          expectedFingerprint: inspected.fingerprint,
          requestId,
          decision: "revoked",
          reason: "Verified with the account owner (#1959)",
        });
        expect(confirmed).toMatchObject({ replayed: false, state: { authority: "revoked" } });
        expect(c.opened()).toBe(3);
        const after = await db.user.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.authRoleAuthority).toBe("revoked");
        const audits = await db.auditLog.findMany({
          where: { id: `auth-role-reconciliation:${requestId}` },
        });
        expect(audits).toHaveLength(1);
      });

      it("every SCIM write loses two and still lands", async () => {
        const auth = `Bearer ${TOKEN}`;
        seq += 1;
        const userName = `${PREFIX}-${seq}`;

        let c = refuseNext(2, shape);
        const created = await request(app)
          .post("/scim/v2/Users")
          .set("Authorization", auth)
          .send({ userName, emails: [{ value: `${userName}@corp.test` }] });
        expect(created.status).toBe(201);
        expect(c.opened()).toBe(3);
        const id = created.body.id as string;
        expect(await db.user.findUniqueOrThrow({ where: { id } })).toMatchObject({
          authSource: "scim",
          authRoleAuthority: "scim",
        });

        c = refuseNext(2, shape);
        const patched = await request(app)
          .patch(`/scim/v2/Users/${id}`)
          .set("Authorization", auth)
          .send({ Operations: [{ op: "replace", path: "displayName", value: "Renamed" }] });
        expect(patched.status).toBe(200);
        expect(c.opened()).toBe(3);
        expect((await db.user.findUniqueOrThrow({ where: { id } })).displayName).toBe("Renamed");

        const role = await db.role.create({ data: { key: `${PREFIX}-group`, name: "g" } });
        c = refuseNext(2, shape);
        const joined = await request(app)
          .patch(`/scim/v2/Groups/${role.id}`)
          .set("Authorization", auth)
          .send({ Operations: [{ op: "add", path: "members", value: [{ value: id }] }] });
        expect(joined.status).toBe(200);
        expect(c.opened()).toBe(3);
        expect(
          await db.userRole.findUnique({
            where: { userId_roleId: { userId: id, roleId: role.id } },
          }),
        ).toMatchObject({ source: "scim" });

        c = refuseNext(2, shape);
        const dropped = await request(app)
          .delete(`/scim/v2/Groups/${role.id}`)
          .set("Authorization", auth);
        expect(dropped.status).toBe(204);
        expect(c.opened()).toBe(3);
        expect(await db.role.findUnique({ where: { id: role.id } })).toBeNull();

        c = refuseNext(2, shape);
        const deleted = await request(app)
          .delete(`/scim/v2/Users/${id}`)
          .set("Authorization", auth);
        expect(deleted.status).toBe(204);
        expect(c.opened()).toBe(3);
        expect(await db.user.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: "disabled",
          deletedAt: expect.any(Date),
        });
      });
    });

    // The SSI false positive of the issue: two UNRELATED users share nothing but
    // the `user_roles` pages each one's read locks and the other's grant writes.
    it("first sign-ins of two different users, forced to read before either writes, both land", async () => {
      const rows = [await user(), await user()];
      const barrier = newBarrier(rows.length);
      state.db = gatedOnRoleRead(db, barrier, 1_000);
      const results = await Promise.allSettled(
        rows.map((row) =>
          reconcileTrustedLoginRole({
            userId: row.id,
            providerRole: "developer",
            authRolesInitializedAt: null,
          }),
        ),
      );
      if (opts.forced) expect(barrier.arrivedAtOpen).toBe(rows.length);
      expect(results).toEqual(rows.map(() => ({ status: "fulfilled", value: "developer" })));
      for (const row of rows) {
        const roles = await db.userRole.findMany({ where: { userId: row.id } });
        expect(roles.map((r) => r.source)).toEqual(["provider"]);
      }
    });
  });
}
