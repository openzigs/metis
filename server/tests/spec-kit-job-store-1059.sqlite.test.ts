/**
 * #1059 — the REAL `spec_kit_jobs` store (`src/lib/spec-kit/job-store.ts`) on a
 * REAL SQLite database built from the migration chain, held to the store
 * contract (`helpers/spec-kit-job-store-contract.ts`): every compare-and-set
 * predicate, the database-clock staleness check, and each race's single winner.
 *
 * The same contract runs on Postgres in CI's `postgres-adapter` job
 * (`spec-kit-job-store-1059-postgres.integration.test.ts`): the store's time
 * expressions are different SQL there, so SQLite passing says nothing about it.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import { defineSpecKitJobStoreContract } from "./helpers/spec-kit-job-store-contract.js";
import { prismaSpecKitJobTable } from "./helpers/spec-kit-job-table.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

const store = await import("../src/lib/spec-kit/job-store.js");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1059 — spec_kit_jobs store contract (real store, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1059-job-store");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const table = prismaSpecKitJobTable("sqlite", () => db, { ...store });
    defineSpecKitJobStoreContract(() => table, "c1059");

    it("uses the SQLite clock expressions here", () => {
      expect(store.specKitJobSqlEngine()).toBe("sqlite");
    });

    it("passes on a database error that is not the unique-key refusal", async () => {
      // A NOT NULL violation, not a duplicate key: it must not read as "key held".
      await expect(
        store.createJob({
          id: "c1059-bad",
          projectId: null as unknown as string,
          command: "speckit.plan",
          featureSlug: null,
          activeKey: "c1059-pa:bad",
          startedById: null,
        }),
      ).rejects.toThrow();
    });

    it("writes timestamps in the text shape Prisma's own writes use, so they compare", async () => {
      await store.createJob({
        id: "c1059-shape",
        projectId: "c1059-pa",
        command: "speckit.plan",
        featureSlug: null,
        activeKey: "c1059-pa:shape",
        startedById: null,
      });
      const [raw] = await db.$queryRaw<
        Array<{ heartbeatAt: string; kind: string }>
      >`SELECT CAST("heartbeatAt" AS TEXT) AS "heartbeatAt", typeof("heartbeatAt") AS "kind" FROM "spec_kit_jobs" WHERE "id" = 'c1059-shape'`;
      expect(raw?.kind).toBe("text");
      expect(raw?.heartbeatAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$/);

      // …and that IS what the typed client writes (a planted heartbeat, a test's
      // aged one): if the adapter's format ever changes, the store's text
      // comparison silently stops meaning "earlier than", and this says so.
      await db.specKitJob.update({
        where: { id: "c1059-shape" },
        data: { heartbeatAt: new Date("2026-01-02T03:04:05.678Z") },
      });
      const [typed] = await db.$queryRaw<
        Array<{ heartbeatAt: string }>
      >`SELECT CAST("heartbeatAt" AS TEXT) AS "heartbeatAt" FROM "spec_kit_jobs" WHERE "id" = 'c1059-shape'`;
      expect(typed?.heartbeatAt).toBe("2026-01-02T03:04:05.678+00:00");
      await db.specKitJob.deleteMany({ where: { id: "c1059-shape" } });
    });
  },
);

describe("specKitJobSqlEngine / specKitJobClock", () => {
  it("picks the engine by the DATABASE_URL scheme, as lib/prisma.ts does", () => {
    expect(store.specKitJobSqlEngine({ DATABASE_URL: "postgresql://u:p@h/db" })).toBe("postgresql");
    expect(store.specKitJobSqlEngine({ DATABASE_URL: " postgres://h/db" })).toBe("postgresql");
    expect(store.specKitJobSqlEngine({ DATABASE_URL: "file:./dev.db" })).toBe("sqlite");
    expect(store.specKitJobSqlEngine({})).toBe("sqlite");
  });

  it("reads the database's clock, never a bound JavaScript date", () => {
    const pg = store.specKitJobClock("postgresql");
    expect(pg.now.sql).toBe("timezone('UTC', clock_timestamp())");
    expect(pg.now.values).toEqual([]);
    expect(pg.ago(90_000).sql).toContain("clock_timestamp()");
    expect(pg.ago(90_000).values).toEqual([90_000]);

    const lite = store.specKitJobClock("sqlite");
    expect(lite.now.sql).toBe("strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')");
    expect(lite.now.values).toEqual([]);
    expect(lite.ago(90_000).values).toEqual(["-90.000 seconds"]);
    expect(lite.ago(1_500).values).toEqual(["-1.500 seconds"]);
  });
});
