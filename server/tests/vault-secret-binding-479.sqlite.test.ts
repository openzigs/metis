/**
 * #479 / #495 — binding-guarded updates are conditional on the checked row, and
 * a PATCH that loses that race leaves no vault secret behind. SQLite run; the
 * body is shared with the Postgres twin
 * (`vault-secret-binding-479-postgres.integration.test.ts`) — see
 * `helpers/conditional-binding-update-suite.ts` for what is proved and how the
 * interleavings are forced.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    between: null as null | (() => Promise<void>),
    afterVaultCreate: null as null | (() => Promise<void>),
  };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
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

const { describeConditionalBindingUpdates } =
  await import("./helpers/conditional-binding-update-suite.js");

describeConditionalBindingUpdates({
  title: "#479/#495 — binding-guarded updates are conditional on the checked row (SQLite)",
  enabled: readGeneratedClientProvider() === "sqlite",
  state,
  suffix: "sqlite",
  hookTimeoutMs: MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
  connect: async () => {
    const sqlite = createMigratedSqlite("479-conditional-update");
    const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    return { db, cleanup: () => sqlite.cleanup() };
  },
});
