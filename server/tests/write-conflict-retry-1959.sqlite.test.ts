/**
 * #1959 — the login and SCIM paths' SERIALIZABLE transactions run again after a
 * write conflict, on a REAL SQLite database built from the migration chain. The
 * body is shared with the Postgres twin
 * (`write-conflict-retry-1959-postgres.integration.test.ts`); see
 * `helpers/write-conflict-retry-1959-suite.ts` for what it proves and how the
 * conflicts are injected. SQLite runs one write transaction at a time, so the
 * real race's racers are not required to meet at the barrier here
 * (`forced: false`).
 */
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

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

const { describeWriteConflictRetry } = await import("./helpers/write-conflict-retry-1959-suite.js");

let sqlite: MigratedSqlite | undefined;
let db: PrismaClient | undefined;

describeWriteConflictRetry({
  title: "#1959 — login and SCIM transactions retry a write conflict (real SQLite)",
  skip: readGeneratedClientProvider() !== "sqlite",
  state,
  audited,
  suffix: randomUUID().slice(0, 8),
  forced: false,
  hookTimeoutMs: MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  open: async () => {
    sqlite = createMigratedSqlite("1959-write-conflict-retry");
    db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    return db;
  },
  close: async () => {
    await db?.$disconnect();
    sqlite?.cleanup();
  },
});
