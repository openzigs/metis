/**
 * Epic #475 (Phase 1, #476) — Discussion data-model migration sanity.
 *
 * Asserts the documented tables, columns, indexes, and cascade/SET NULL FK
 * behavior are present in both the SQLite and Postgres migrations and that both
 * Prisma schemas declare the two models. Catches silent drift (a dropped index
 * regresses history-listing to a full scan; a changed FK rule breaks the
 * thread→messages cascade contract the REST layer relies on).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");

const sqliteMigration = readFileSync(
  join(repoRoot, "server/prisma/migrations/20260627090000_epic475_discussion_models/migration.sql"),
  "utf-8",
);
const postgresMigration = readFileSync(
  join(
    repoRoot,
    "server/prisma/postgres/migrations/20260627090000_epic475_discussion_models/migration.sql",
  ),
  "utf-8",
);
const sqliteSchema = readFileSync(join(repoRoot, "server/prisma/schema.prisma"), "utf-8");
const postgresSchema = readFileSync(
  join(repoRoot, "server/prisma/postgres/schema.prisma"),
  "utf-8",
);

describe("discussion migration (#476)", () => {
  describe("tables", () => {
    it.each(["discussion_threads", "discussion_messages"])(
      "SQLite migration creates the %s table",
      (table) => {
        expect(sqliteMigration).toContain(`CREATE TABLE "${table}"`);
      },
    );

    // Postgres incremental migrations are idempotent so the full history
    // applies from scratch over the cumulative init baseline (issue #556):
    // `CREATE TABLE IF NOT EXISTS`.
    it.each(["discussion_threads", "discussion_messages"])(
      "Postgres migration creates the %s table (idempotent)",
      (table) => {
        expect(postgresMigration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
      },
    );
  });

  describe("thread anchors are nullable + default aiResponseMode", () => {
    it("declares nullable requirementId/analysisId/specKitFeatureId", () => {
      // No NOT NULL on the anchor columns.
      expect(sqliteMigration).toMatch(/"requirementId" TEXT,/);
      expect(sqliteMigration).toMatch(/"analysisId" TEXT,/);
      expect(sqliteMigration).toMatch(/"specKitFeatureId" TEXT,/);
    });

    it("defaults aiResponseMode to on_mention", () => {
      expect(sqliteMigration).toMatch(/"aiResponseMode" TEXT NOT NULL DEFAULT 'on_mention'/);
      expect(postgresMigration).toMatch(/"aiResponseMode" TEXT NOT NULL DEFAULT 'on_mention'/);
    });
  });

  describe("message author columns", () => {
    it("declares authorKind NOT NULL and nullable author/ai columns", () => {
      expect(sqliteMigration).toMatch(/"authorKind" TEXT NOT NULL/);
      expect(sqliteMigration).toMatch(/"authorUserId" TEXT,/);
      expect(sqliteMigration).toMatch(/"aiProvider" TEXT,/);
      expect(sqliteMigration).toMatch(/"aiModel" TEXT,/);
      expect(sqliteMigration).toMatch(/"aiSessionId" TEXT,/);
    });
  });

  describe("indexes", () => {
    const required = [
      "discussion_threads_projectId_idx",
      "discussion_threads_requirementId_idx",
      "discussion_threads_analysisId_idx",
      "discussion_threads_specKitFeatureId_idx",
      "discussion_messages_threadId_createdAt_idx",
    ];
    it.each(required)("SQLite declares index %s", (idx) => {
      expect(sqliteMigration).toContain(`CREATE INDEX "${idx}"`);
    });
    // Idempotent form (issue #556): `CREATE INDEX IF NOT EXISTS`.
    it.each(required)("Postgres declares index %s (idempotent)", (idx) => {
      expect(postgresMigration).toContain(`CREATE INDEX IF NOT EXISTS "${idx}"`);
    });
  });

  describe("FK cascade / set-null behavior", () => {
    it("messages cascade-delete with their thread (SQLite)", () => {
      expect(sqliteMigration).toMatch(
        /discussion_messages_threadId_fkey.*REFERENCES "discussion_threads".*ON DELETE CASCADE/s,
      );
    });
    it("messages cascade-delete with their thread (Postgres)", () => {
      expect(postgresMigration).toMatch(
        /discussion_messages_threadId_fkey.*REFERENCES "discussion_threads".*ON DELETE CASCADE/s,
      );
    });
    it("threads cascade-delete with their project (SQLite)", () => {
      expect(sqliteMigration).toMatch(
        /discussion_threads_projectId_fkey.*REFERENCES "projects".*ON DELETE CASCADE/s,
      );
    });
    it("anchors SET NULL on delete, not cascade (SQLite)", () => {
      expect(sqliteMigration).toMatch(/discussion_threads_requirementId_fkey.*ON DELETE SET NULL/s);
      expect(sqliteMigration).toMatch(/discussion_threads_analysisId_fkey.*ON DELETE SET NULL/s);
      expect(sqliteMigration).toMatch(
        /discussion_threads_specKitFeatureId_fkey.*ON DELETE SET NULL/s,
      );
    });
    it("an AI message's session link SET NULL on delete (SQLite)", () => {
      expect(sqliteMigration).toMatch(
        /discussion_messages_aiSessionId_fkey.*REFERENCES "ai_sessions".*ON DELETE SET NULL/s,
      );
    });
  });

  describe("both Prisma schemas declare the models", () => {
    it.each([sqliteSchema, postgresSchema])(
      "declares DiscussionThread + DiscussionMessage",
      (s) => {
        expect(s).toMatch(/model DiscussionThread \{/);
        expect(s).toMatch(/model DiscussionMessage \{/);
        expect(s).toMatch(/@@map\("discussion_threads"\)/);
        expect(s).toMatch(/@@map\("discussion_messages"\)/);
      },
    );
  });
});
