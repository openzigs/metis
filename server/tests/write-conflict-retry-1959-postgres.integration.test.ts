/**
 * #1959 — the login and SCIM paths' SERIALIZABLE transactions run again after a
 * write conflict, on real Postgres. The body is shared with the SQLite twin
 * (`write-conflict-retry-1959.sqlite.test.ts`); see
 * `helpers/write-conflict-retry-1959-suite.ts` for what it proves and how the
 * conflicts are injected.
 *
 * Here the last case is a real race: the first sign-ins of two DIFFERENT users
 * run their role reconciliation on separate pooled connections, both reading
 * "no roles" before either writes. They share only `user_roles` index pages,
 * yet Postgres's SSI can abort one (40001, which the pg adapter surfaces as
 * `TransactionWriteConflict`); before #1959 that was a 500 at sign-in, and now
 * its retry lands, so both users end with their provider grant. Two first
 * sign-ins of the SAME user collide on the unique key instead (a P2002 on
 * `user_roles_pkey`, measured), and since #1971 that loser runs again too.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";

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
const audited = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: audited }));
vi.mock("../src/lib/auth/jwt.js", () => ({ revokeAllUserSessions: vi.fn(async () => undefined) }));
vi.mock("../src/lib/socket/user-disconnect.js", () => ({
  disconnectUserSockets: vi.fn(),
  reconnectUserSockets: vi.fn(),
}));

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { describeWriteConflictRetry } = await import("./helpers/write-conflict-retry-1959-suite.js");

let db: PrismaClient | undefined;

describeWriteConflictRetry({
  title: "#1959 — login and SCIM transactions retry a write conflict (Postgres)",
  skip: !enabled,
  state,
  audited,
  suffix: randomUUID().slice(0, 8),
  forced: true,
  open: async () => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    return db;
  },
  close: async () => {
    await db?.$disconnect();
  },
});
