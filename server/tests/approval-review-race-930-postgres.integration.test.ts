/**
 * #930 — concurrent approval reviews on real Postgres. The body is shared with
 * the SQLite twin (`approval-review-race-930.sqlite.test.ts`); see
 * `helpers/approval-review-race-suite.ts` for what it proves and how the
 * interleaving is forced.
 *
 * On Postgres the held reviews run their `UPDATE … WHERE status = 'pending'`
 * on separate pooled connections at once: the first takes the row lock, the
 * rest wait, then re-check the predicate against the committed row and match
 * nothing — so exactly one review lands under READ COMMITTED.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import { describeApprovalReviewRace } from "./helpers/approval-review-race-suite.js";

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

describeApprovalReviewRace({
  title: "#930 — concurrent approval reviews (Postgres)",
  skip: !enabled,
  state,
  suffix: randomUUID().slice(0, 8),
  open: async () => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    return db;
  },
  close: async () => {
    await db?.$disconnect();
  },
});
