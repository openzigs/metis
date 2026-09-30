/**
 * #552 — the Postgres twin of the raw-stamp cases in
 * `vault-rotate-binding-race-552.sqlite.test.ts` (PR #587 panel).
 *
 * `markBindingWrite` writes `secrets.bindingWriteUntil` with raw SQL
 * (`$executeRaw`), and a confirmed foreign-owner rotation reads it back through
 * Prisma and makes its UPDATE conditional on it as a typed Date
 * (`VaultService.rotate`'s `onlyIfBindingWriteUntil`). On Postgres the column is
 * `TIMESTAMP(3)`: if what the raw write stores never compares equal to what the
 * typed read hands back, every confirmed rotation of a once-bound secret is
 * refused forever. Proved here through the REAL vault router against the
 * production database, with the stamp written by the REAL raw helper:
 *
 *   - a closed window written raw lets the confirmed rotation land;
 *   - an open window written raw refuses it (the read sees the stamp);
 *   - a raw stamp landing between the rotation's read and its UPDATE misses
 *     the compare-and-set (the equality is not vacuous).
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { vaultRouter } = await import("../src/routes/vault.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { BINDING_WRITE_WINDOW_MS, markBindingWrite } =
  await import("../src/lib/vault/binding-write-mark.js");

const SUFFIX = randomUUID().slice(0, 8);
const OWNER = `u-552pg-owner-${SUFFIX}`;
const ADMIN = `u-552pg-admin-${SUFFIX}`;
const OWNER_VALUE = "owner-token-552-pg";
const ADMIN_VALUE = "admin-token-552-pg";

describe.skipIf(!enabled)(
  "#552 — a raw binding-write stamp and the rotation's typed compare-and-set agree (Postgres)",
  () => {
    let db: PrismaClient;
    let adminToken = "";
    let n = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/vault", vaultRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const rotate = (id: string) =>
      request(app())
        .post(`/api/vault/${id}/rotate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ value: ADMIN_VALUE, confirmForeignOwner: true, confirmedBindings: [] });
    const newSecret = async () =>
      (
        await getVaultService().create(`s552pg-${SUFFIX}-${(n += 1)}`, OWNER_VALUE, "global", {
          createdById: OWNER,
        })
      ).id;
    const secretRow = (id: string) => db.secret.findUniqueOrThrow({ where: { id } });
    const plaintextOf = async (id: string) => (await getVaultService().read(id)).plaintext;

    beforeAll(async () => {
      db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
      state.db = db;
      __resetVaultSingleton();
      for (const id of [OWNER, ADMIN]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      adminToken = issueTokens({
        userId: ADMIN,
        username: ADMIN,
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    });

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      if (db) {
        // The database is shared and outlives the run: remove what this run wrote.
        const users = [OWNER, ADMIN];
        await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
        await db.secret.deleteMany({ where: { createdById: { in: users } } });
        await db.user.deleteMany({ where: { id: { in: users } } });
        await db.$disconnect();
      }
    });

    it("a closed window written by the raw markBindingWrite lets the confirmed rotation land", async () => {
      const id = await newSecret();
      const until = await markBindingWrite(
        [{ id }],
        OWNER,
        new Date(Date.now() - BINDING_WRITE_WINDOW_MS - 5_000),
      );
      expect(until).not.toBeNull();
      expect((await secretRow(id)).bindingWriteUntil?.getTime()).toBe(until!.getTime());

      const res = await rotate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);
      expect((await secretRow(id)).createdById).toBe(ADMIN);
    });

    it("a closed window with sub-millisecond precision in the clock still compares equal", async () => {
      // A Date carries whole milliseconds; pick an instant whose ms field is
      // non-zero so a truncation to seconds anywhere on the path would show.
      const id = await newSecret();
      const past = new Date(Date.now() - BINDING_WRITE_WINDOW_MS - 5_000);
      past.setUTCMilliseconds(987);
      const until = await markBindingWrite([{ id }], OWNER, past);
      expect(until!.getUTCMilliseconds()).toBe(987);
      expect((await secretRow(id)).bindingWriteUntil?.toISOString()).toBe(until!.toISOString());

      const res = await rotate(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);
    });

    it("an open window written by the raw markBindingWrite refuses the rotation", async () => {
      const id = await newSecret();
      expect(await markBindingWrite([{ id }], OWNER)).not.toBeNull();

      const res = await rotate(id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDING_IN_PROGRESS");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect((await secretRow(id)).createdById).toBe(OWNER);
    });

    it("a raw stamp landing between the rotation's read and its UPDATE misses the compare-and-set", async () => {
      const id = await newSecret();
      // A closed window first, so the rotation's read sees a non-null stamp.
      await markBindingWrite(
        [{ id }],
        OWNER,
        new Date(Date.now() - BINDING_WRITE_WINDOW_MS - 5_000),
      );
      const svc = getVaultService();
      const real = svc.rotate.bind(svc);
      const spy = vi.spyOn(svc, "rotate").mockImplementationOnce(async (...args) => {
        await markBindingWrite([{ id }], OWNER);
        return real(...args);
      });
      let res: request.Response;
      try {
        res = await rotate(id);
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDING_IN_PROGRESS");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect((await secretRow(id)).createdById).toBe(OWNER);
    });
  },
);
