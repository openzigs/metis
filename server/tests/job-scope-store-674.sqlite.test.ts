/**
 * #674 — the durable job-scope record against a REAL SQLite database built by
 * the real migration chain, read back through the production query. It must
 * survive what the in-process scope store does not: a restart (the memory is
 * gone) and eviction (500 newer ids).
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", () => ({
  get prisma() {
    return state.db;
  },
}));

const { JOB_SCOPE_TTL_MS, readJobScope, recordJobScope } =
  await import("../src/lib/socket/job-scope-store.js");
const { _resetJobLifecycleMemory, getJobScope, rememberJobScope } =
  await import("../src/lib/socket/job-events.js");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#674 job_scopes on a migrated SQLite database",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(() => {
      sqlite = createMigratedSqlite("674-job-scopes");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      _resetJobLifecycleMemory();
      await db.jobScopeRecord.deleteMany({});
    });

    it("reads a recorded scope back after the process memory is gone", async () => {
      await recordJobScope("job-restart", "overview-regenerate", "p1");
      _resetJobLifecycleMemory();
      expect(getJobScope("job-restart")).toBeUndefined();
      expect(await readJobScope("job-restart")).toEqual({
        kind: "overview-regenerate",
        projectId: "p1",
      });
    });

    it("reads a recorded scope back after 500 newer ids evicted it from memory", async () => {
      await recordJobScope("job-evicted", "pr-review", null);
      for (let i = 0; i < 500; i += 1) rememberJobScope(`other-${i}`, "pr-review", "p1");
      expect(getJobScope("job-evicted")).toBeUndefined();
      expect(await readJobScope("job-evicted")).toEqual({ kind: "pr-review", projectId: null });
    });

    it("ignores a lapsed record and prunes it on the next write", async () => {
      const then = new Date("2026-01-01T00:00:00.000Z");
      await recordJobScope("job-old", "spec-kit", "p1", then);
      const later = new Date(then.getTime() + JOB_SCOPE_TTL_MS + 1);
      expect(await readJobScope("job-old", later)).toBeNull();

      await recordJobScope("job-new", "spec-kit", "p1", later);
      await vi.waitFor(async () =>
        expect(await db.jobScopeRecord.findUnique({ where: { jobId: "job-old" } })).toBeNull(),
      );
      expect(await readJobScope("job-new", later)).toEqual({ kind: "spec-kit", projectId: "p1" });
    });

    it("re-recording an id replaces its scope and extends its expiry", async () => {
      const then = new Date("2026-01-01T00:00:00.000Z");
      await recordJobScope("job-reuse", "spec-kit", "p1", then);
      const later = new Date(then.getTime() + JOB_SCOPE_TTL_MS - 1);
      await recordJobScope("job-reuse", "repo-ingest", "p2", later);
      expect(
        await readJobScope("job-reuse", new Date(then.getTime() + JOB_SCOPE_TTL_MS + 1)),
      ).toEqual({ kind: "repo-ingest", projectId: "p2" });
    });
  },
);
