/**
 * #1893 — concurrent borrows of a similar requirement's code links on a REAL
 * SQLite database built from the migration chain. The body is shared with the
 * Postgres twin (`borrow-citations-race-1893-postgres.integration.test.ts`);
 * see `helpers/borrow-citations-race-suite.ts` for what it proves and how the
 * interleaving is forced. SQLite runs one write transaction at a time, so the
 * racers are not required to meet at the barrier here (`forced: false`).
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
import { describeBorrowCitationsRace } from "./helpers/borrow-citations-race-suite.js";

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

let sqlite: MigratedSqlite | undefined;
let db: PrismaClient | undefined;

describeBorrowCitationsRace({
  title: "#1893 — concurrent borrows (real SQLite)",
  skip: readGeneratedClientProvider() !== "sqlite",
  state,
  suffix: randomUUID().slice(0, 8),
  forced: false,
  hookTimeoutMs: MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  open: async () => {
    sqlite = createMigratedSqlite("1893-borrow-citations-race");
    db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    return db;
  },
  close: async () => {
    await db?.$disconnect();
    sqlite?.cleanup();
  },
});
