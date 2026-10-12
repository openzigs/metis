/**
 * #1059 — the Spec Kit job runner's rules (`helpers/spec-kit-job-rules.ts`)
 * against the REAL store on a REAL SQLite database built from the migration
 * chain. Every race in those rules — a cancel against a save, the time limit
 * against a save, a sweep against the owner, a row failed by another replica —
 * is decided here by `job-store.ts`'s own UPDATE statements and the table's
 * unique index, not by the in-memory fake's re-implementation of them
 * (`spec-kit-jobs-1059.test.ts` runs the same rules on the fake).
 *
 * Postgres: the statements are held to the store contract on a real Postgres
 * in CI (`spec-kit-job-store-1059-postgres.integration.test.ts`); the rules
 * above the store are engine-independent.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

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
vi.mock("../src/lib/socket/job-events.js", async () => {
  return (await import("./helpers/spec-kit-job-rules-mocks.js")).jobEventsModule;
});
vi.mock("../src/lib/socket/job-scope-store.js", async () => {
  return (await import("./helpers/spec-kit-job-rules-mocks.js")).jobScopeStoreModule;
});
vi.mock("../src/lib/audit/audit-service.js", async () => {
  return (await import("./helpers/spec-kit-job-rules-mocks.js")).auditModule;
});
vi.mock("../src/lib/config/config-service.js", async () => {
  return (await import("./helpers/spec-kit-job-rules-mocks.js")).configModule;
});
// The real store, copied onto a plain object so a test can make one write fail.
vi.mock("../src/lib/spec-kit/job-store.js", async (importOriginal) => {
  const { realSpecKitJobStore } = await import("./helpers/spec-kit-job-rules-mocks.js");
  return Object.assign(realSpecKitJobStore, await importOriginal<Record<string, unknown>>());
});

const { defineSpecKitJobRules } = await import("./helpers/spec-kit-job-rules.js");
const { prismaSpecKitJobTable } = await import("./helpers/spec-kit-job-table.js");
const { realSpecKitJobStore } = await import("./helpers/spec-kit-job-rules-mocks.js");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1059 — Spec Kit job rules (real store, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1059-job-rules");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const table = prismaSpecKitJobTable("sqlite", () => db, realSpecKitJobStore);
    defineSpecKitJobRules(() => table);
  },
);
