/**
 * #495 — the Postgres twin of `vault-secret-binding-479.sqlite.test.ts`.
 *
 * #479's conditional write (`updateMany where { id, updatedAt }`) and #495's
 * no-orphaned-secret guarantee, proved on the production database: `updatedAt`
 * is `TIMESTAMP(3)` there, so the equality the write depends on is Postgres's,
 * not SQLite's. The body is shared — see
 * `helpers/conditional-binding-update-suite.ts`.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (CI's
 * `postgres-adapter` job).
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    between: null as null | (() => Promise<void>),
    afterVaultCreate: null as null | (() => Promise<void>),
  };
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
vi.mock("../src/lib/connectors/network-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertConnectorHostAllowed: async () => undefined,
    resolveAndAssertConnectorHost: async (hostname: string) => ({
      hostname,
      address: "203.0.113.7",
      family: 4,
    }),
  };
});
vi.mock("../src/lib/connectors/connector-secret-binding.js", async (importOriginal) => {
  const { interleaved } = await import("./helpers/interleaved-guards.js");
  return interleaved(await importOriginal<Record<string, unknown>>(), state);
});
vi.mock("../src/lib/mcp/secret-binding.js", async (importOriginal) => {
  const { interleaved } = await import("./helpers/interleaved-guards.js");
  return interleaved(await importOriginal<Record<string, unknown>>(), state);
});

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { describeConditionalBindingUpdates } =
  await import("./helpers/conditional-binding-update-suite.js");

describeConditionalBindingUpdates({
  title: "#479/#495 — binding-guarded updates are conditional on the checked row (Postgres)",
  enabled,
  state,
  suffix: randomUUID().slice(0, 8),
  // The database is shared and outlives the run: the suite deletes every row
  // this run wrote, then disconnects the client before `cleanup` runs.
  purgeRunRows: true,
  connect: async () => {
    const db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    // Idempotent after the suite's own `$disconnect()`: the client owns a pg
    // pool, and a pool left open keeps the worker alive past the run.
    return { db, cleanup: () => db.$disconnect() };
  },
});
