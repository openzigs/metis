/**
 * Issue #402 — the #369 dedup migration and the #402 repoint migration, run by
 * the real `prisma migrate deploy` over duplicate rows in a REAL SQLite, then
 * read back through Prisma the way the publisher and createBatch read them.
 *
 * The Postgres twin is `issue-draft-dedup-postgres.integration.test.ts`; both
 * seed `helpers/draft-dedup-fixture.ts` and assert the same outcome.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  BATCHES,
  DRAFT_IDS_AFTER_402,
  DRAFTS,
  LIVE_AFTER_369,
  MIGRATION_369,
  MIGRATION_402,
  PARENTS_AFTER_402,
  PROJECT_IDS,
  SEED_TIME,
  USER_ID,
} from "./helpers/draft-dedup-fixture.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#402 — references to #369's retired drafts are repointed (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(() => {
      sqlite = createMigratedSqlite("402-repoint", { stopBefore: MIGRATION_369 });
      const x = sqlite.exec;
      x(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES (?, ?, 'U1', 'u1@example.test', ?, ?)`,
        [USER_ID, USER_ID, SEED_TIME, SEED_TIME],
      );
      for (const p of PROJECT_IDS) {
        x(
          `INSERT INTO projects (id, name, slug, createdById, createdAt, updatedAt)
           VALUES (?, 'Apollo', ?, ?, ?, ?)`,
          [p, `slug-${p}`, USER_ID, SEED_TIME, SEED_TIME],
        );
      }
      for (const r of DRAFTS) {
        x(
          `INSERT INTO issue_drafts
             (id, projectId, parentDraftId, title, body, status, dedupHash, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, 'T', 'B', ?, ?, ?, ?, ?)`,
          [
            r.id,
            r.projectId,
            r.parentDraftId,
            r.status,
            r.dedupHash,
            r.createdAt,
            r.createdAt,
            r.deletedAt,
          ],
        );
      }
      for (const b of BATCHES) {
        x(
          `INSERT INTO publish_batches
             (id, projectId, status, targetOwner, targetRepo, archived, startedById, metadata, createdAt, updatedAt)
           VALUES (?, ?, ?, 'acme', 'metis', ?, ?, ?, ?, ?)`,
          [
            b.id,
            b.projectId,
            b.status,
            b.archived ? 1 : 0,
            USER_ID,
            b.metadata,
            SEED_TIME,
            SEED_TIME,
          ],
        );
      }
      sqlite.apply(MIGRATION_369);
      sqlite.apply(MIGRATION_402);
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("keeps one live draft per key, the published one or else the oldest", async () => {
      const live = await db.issueDraft.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      expect(live.map((r) => r.id).sort()).toEqual(LIVE_AFTER_369);
    });

    it("repoints a retired epic's live children at the survivor", async () => {
      const rows = await db.issueDraft.findMany({
        where: { parentDraftId: { not: null } },
        select: { id: true, parentDraftId: true },
      });
      expect(Object.fromEntries(rows.map((r) => [r.id, r.parentDraftId]))).toEqual(
        PARENTS_AFTER_402,
      );
      // The repointed parent is a draft a reader can actually load.
      const parent = await db.issueDraft.findFirst({
        where: { id: PARENTS_AFTER_402.c_live, deletedAt: null },
      });
      expect(parent).not.toBeNull();
    });

    it("repoints an unfinished batch's draftIds, leaving settled and foreign batches alone", async () => {
      const rows = await db.publishBatch.findMany({ select: { id: true, metadata: true } });
      for (const seeded of BATCHES) {
        const after = rows.find((r) => r.id === seeded.id)?.metadata ?? null;
        const expected = DRAFT_IDS_AFTER_402[seeded.id];
        if (!expected) {
          expect(after, seeded.id).toBe(seeded.metadata);
          continue;
        }
        const parsed = JSON.parse(after ?? "{}");
        expect(parsed.draftIds, seeded.id).toEqual(expected);
        // The other batch options survive the rewrite.
        expect(parsed.secretRef).toBe("${vault:gh}");
        expect(parsed.additionalLabels).toEqual(["x"]);
      }
    });

    it("leaves every repointed draftId loadable by createBatch's own query", async () => {
      const ids = DRAFT_IDS_AFTER_402.b_running;
      // Mirrors publishing-service.ts createBatch: a short count is DRAFT_MISMATCH.
      const found = await db.issueDraft.findMany({
        where: { id: { in: ids }, projectId: "p1", deletedAt: null },
      });
      expect(found).toHaveLength(ids.length);
    });
  },
);
