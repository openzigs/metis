/**
 * #1059 — the REAL `spec_kit_jobs` store on a REAL Postgres, held to the store
 * contract (`helpers/spec-kit-job-store-contract.ts`).
 *
 * This is what covers Postgres. The store's clock expressions are different
 * SQL on each engine (`clock_timestamp()` against `TIMESTAMP(3)` columns here,
 * `strftime` text on SQLite), and here two statements on one row really do run
 * concurrently: the loser of each race blocks on the winner's row lock, then
 * re-evaluates its WHERE against the committed row and matches nothing. On
 * SQLite the driver serialises them, so that suite cannot show it.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (CI's
 * `postgres-adapter` job).
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineSpecKitJobStoreContract } from "./helpers/spec-kit-job-store-contract.js";
import { prismaSpecKitJobTable } from "./helpers/spec-kit-job-table.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const NS = `c1059pg-${randomUUID().slice(0, 8)}`;

describe.skipIf(!enabled)(
  "#1059 — spec_kit_jobs store contract (real store, real Postgres)",
  () => {
    let db: PrismaClient;
    let store: typeof import("../src/lib/spec-kit/job-store.js");

    beforeAll(async () => {
      ({ prisma: db } = await import("../src/lib/prisma.js"));
      store = await import("../src/lib/spec-kit/job-store.js");
    });

    afterAll(async () => {
      await db?.specKitJob.deleteMany({ where: { projectId: { startsWith: NS } } });
      await db?.$disconnect();
    });

    const table = prismaSpecKitJobTable(
      "postgres",
      () => db,
      // Resolved per call: the module is imported in `beforeAll`.
      new Proxy({} as typeof import("../src/lib/spec-kit/job-store.js"), {
        get: (_target, prop: string) => (store as unknown as Record<string, unknown>)[prop],
      }),
    );
    defineSpecKitJobStoreContract(() => table, NS);

    it("uses the Postgres clock expressions here", () => {
      expect(store.specKitJobSqlEngine()).toBe("postgresql");
    });

    it("agrees with the database about what time it is, in UTC", async () => {
      const created = await store.createJob({
        id: `${NS}-utc`,
        projectId: `${NS}-pa`,
        command: "speckit.plan",
        featureSlug: null,
        activeKey: `${NS}-pa:utc`,
        startedById: null,
      });
      // `TIMESTAMP(3)` holds no zone: a store that wrote local time would be off
      // by the server's UTC offset. Compared inside the database, so this
      // machine's clock is not part of the answer.
      const [gap] = await db.$queryRaw<Array<{ seconds: number }>>`
      SELECT ABS(EXTRACT(EPOCH FROM (timezone('UTC', clock_timestamp()) - "heartbeatAt")))::float8 AS "seconds"
      FROM "spec_kit_jobs" WHERE "id" = ${`${NS}-utc`}`;
      expect(created).not.toBeNull();
      expect(gap?.seconds).toBeLessThan(30);
      await db.specKitJob.deleteMany({ where: { id: `${NS}-utc` } });
    });
  },
);
