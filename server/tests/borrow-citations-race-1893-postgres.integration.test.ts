/**
 * #1893 — concurrent borrows of a similar requirement's code links on real
 * Postgres. The body is shared with the SQLite twin
 * (`borrow-citations-race-1893.sqlite.test.ts`); see
 * `helpers/borrow-citations-race-suite.ts` for what it proves and how the
 * interleaving is forced.
 *
 * On Postgres the racers run their transactions on separate pooled
 * connections at once, every one reading the target's links before any
 * writes. Under SERIALIZABLE the database aborts all but one with a write
 * conflict (the pg adapter's `TransactionWriteConflict`, which carries no
 * Prisma code; not P2034), and the retry sees the winner's rows; under READ
 * COMMITTED, or with no transaction, every racer copied every link.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import { describeBorrowCitationsRace } from "./helpers/borrow-citations-race-suite.js";

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

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");

let db: PrismaClient | undefined;

describeBorrowCitationsRace({
  title: "#1893 — concurrent borrows (Postgres)",
  skip: !enabled,
  state,
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
