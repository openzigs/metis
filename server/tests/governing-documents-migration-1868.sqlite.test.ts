/**
 * Issue #1868 (epic #1866) — the governing-documents tables.
 *
 * 1. The migration and its committed reverse script, applied up -> reverse ->
 *    up to a SQLite database seeded with rows written BEFORE the migration.
 *    Prisma Migrate has no down migrations, so the reverse is a hand-run SQL
 *    file (server/prisma/rollbacks/); this proves the reverse leaves the schema
 *    exactly as it was and every pre-existing row unchanged, and that
 *    `prisma migrate deploy` applies the migration again afterwards.
 * 2. Rows written through the Prisma client read back through a FRESH client
 *    (the boundary a later request crosses), scoped by `workspaceId` with a
 *    second workspace's rows present, and what deleting a project or a
 *    workspace does to them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const MIGRATION = "20261116001868_issue1868_governing_documents";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);
const PG_ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);
const PG_MIGRATION_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "postgres", "migrations", MIGRATION, "migration.sql"),
  "utf-8",
);
const PG_INIT_SQL = readFileSync(
  path.join(
    SERVER_ROOT,
    "prisma",
    "postgres",
    "migrations",
    "00000000000000_init",
    "migration.sql",
  ),
  "utf-8",
);
const TABLES = [
  "governing_documents",
  "governing_document_revisions",
  "governing_rules",
  "governing_rule_edits",
] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1868 — governing documents migration: up -> reverse -> up",
  () => {
    let sqlite: MigratedSqlite;

    const withDb = <T>(fn: (db: Database.Database) => T): T => {
      const db = new Database(sqlite.dbFile);
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    /** Every table, index and trigger with its DDL, bar Prisma's own bookkeeping. */
    const schema = () =>
      withDb((db) =>
        db
          .prepare(
            `SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> '_prisma_migrations'
             ORDER BY type, name`,
          )
          .all(),
      );
    const tables = (): string[] =>
      withDb((db) =>
        (
          db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
            name: string;
          }>
        ).map((t) => t.name),
      );
    const existing = () =>
      withDb((db) =>
        Object.fromEntries(
          ["users", "workspaces", "projects"].map((t) => [
            t,
            db.prepare(`SELECT * FROM "${t}" ORDER BY "id"`).all(),
          ]),
        ),
      );
    const applied = (): boolean =>
      withDb(
        (db) =>
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM "_prisma_migrations" WHERE "migration_name" = ? AND "finished_at" IS NOT NULL`,
              )
              .get(MIGRATION) as { n: number }
          ).n === 1,
      );
    const insertGoverning = () => {
      sqlite.exec(
        `INSERT INTO "governing_documents" ("id","workspaceId","title","createdById") VALUES ('gd-0','ws-1','Policy','u-1')`,
      );
      sqlite.exec(
        `INSERT INTO "governing_document_revisions" ("id","documentId","revisionLabel","effectiveDate","storagePath","contentHash","mimeType","sizeBytes","extractedText","uploadedById")
         VALUES ('gr-0','gd-0','v1',?,'governing/ws-1/gr-0.md','h','text/markdown',4,'text','u-1')`,
        [new Date("2026-10-01T00:00:00Z").toISOString()],
      );
      sqlite.exec(
        `INSERT INTO "governing_rules" ("id","revisionId","controlId","summary","clauseRef","clauseStart","clauseEnd","clauseExcerpt")
         VALUES ('rule-0','gr-0','R-001','s','§1',0,4,'text')`,
      );
      sqlite.exec(
        `INSERT INTO "governing_rule_edits" ("id","ruleId","kind","editedById","before","after") VALUES ('e-0','rule-0','edit','u-1','{}','{}')`,
      );
    };

    let seeded: ReturnType<typeof existing>;
    let schemaBefore: ReturnType<typeof schema>;

    beforeAll(() => {
      sqlite = createMigratedSqlite("1868-governing-documents-migration", {
        stopBefore: MIGRATION,
      });
      const now = new Date("2026-10-01T00:00:00Z").toISOString();
      sqlite.exec(
        `INSERT INTO "users" ("id","username","displayName","email","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["u-1", "u-1", "U", "u1@example.test", now, now],
      );
      sqlite.exec(
        `INSERT INTO "workspaces" ("id","name","slug","createdAt","updatedAt") VALUES (?,?,?,?,?)`,
        ["ws-1", "W", "ws-1", now, now],
      );
      sqlite.exec(
        `INSERT INTO "projects" ("id","name","slug","createdById","workspaceId","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`,
        ["p-1", "P", "p-1", "u-1", "ws-1", now, now],
      );
      seeded = existing();
      schemaBefore = schema();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts without the tables, with the seeded rows", () => {
      for (const t of TABLES) expect(tables()).not.toContain(t);
      expect(seeded.projects).toHaveLength(1);
    });

    it(
      "up: creates the four tables and leaves every existing row unchanged",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        for (const t of TABLES) expect(tables()).toContain(t);
        expect(existing()).toEqual(seeded);
        insertGoverning();
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("holds one revision label per document", () => {
      expect(
        () =>
          sqlite.exec(
            `INSERT INTO "governing_document_revisions" ("id","documentId","revisionLabel","effectiveDate","storagePath","contentHash","mimeType","sizeBytes","extractedText","uploadedById")
           VALUES ('gr-dup','gd-0','v1',?,'p','h','text/plain',1,'t','u-1')`,
            [new Date().toISOString()],
          ),
        // The pair, not the row id: a retried attempt would otherwise pass on the
        // primary key of the row the failed attempt inserted.
      ).toThrow(
        /UNIQUE constraint failed: governing_document_revisions\.documentId, governing_document_revisions\.revisionLabel/,
      );
    });

    it("reverse: drops the four tables, forgets the migration, and leaves the schema as it was", () => {
      withDb((db) => {
        db.pragma("foreign_keys = ON");
        db.exec(ROLLBACK_SQL);
      });
      expect(applied()).toBe(false);
      for (const t of TABLES) expect(tables()).not.toContain(t);
      expect(schema()).toEqual(schemaBefore);
      expect(existing()).toEqual(seeded);
    });

    it(
      "up again: `migrate deploy` re-applies it and the rows still read back unchanged",
      () => {
        sqlite.applyRemaining();
        expect(applied()).toBe(true);
        for (const t of TABLES) expect(tables()).toContain(t);
        // Later migrations may add columns to these tables (#2436 added
        // `projects.allowSelfApproval`): every seeded value reads back unchanged.
        expect(existing()).toMatchObject(seeded);
        insertGoverning();
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin is idempotent, its baseline carries the tables, and its reverse is the same operation", () => {
      for (const t of TABLES) {
        expect(PG_MIGRATION_SQL).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
        expect(PG_INIT_SQL).toContain(`CREATE TABLE "${t}"`);
        expect(PG_ROLLBACK_SQL).toContain(`DROP TABLE IF EXISTS "${t}" CASCADE`);
      }
      for (const fk of [
        "governing_documents_workspaceId_fkey",
        "governing_documents_currentRevisionId_fkey",
        "governing_document_revisions_documentId_fkey",
        "governing_rules_revisionId_fkey",
        "governing_rule_edits_ruleId_fkey",
      ]) {
        expect(PG_MIGRATION_SQL).toContain(
          `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${fk}')`,
        );
        expect(PG_INIT_SQL).toContain(`ADD CONSTRAINT "${fk}"`);
      }
      expect(PG_MIGRATION_SQL).toMatch(/REFERENCES "workspaces"\("id"\) ON DELETE CASCADE/);
      expect(PG_MIGRATION_SQL).not.toMatch(/REFERENCES "projects"/);
      expect(PG_ROLLBACK_SQL).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1868 — governing rows through the Prisma client",
  () => {
    let sqlite: MigratedSqlite;
    const client = () =>
      new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });

    /** Writes a document with one revision (made current) and `rules` rules. */
    const seedDocument = async (
      db: PrismaClient,
      workspaceId: string,
      key: string,
      rules: Array<{ controlId: string; summary: string; start: number; end: number }>,
    ) => {
      const text = "4.3 Access rights are reviewed every quarter. 5.1 Logs are kept for a year.";
      const doc = await db.governingDocument.create({
        data: {
          id: `gd-${key}`,
          workspaceId,
          title: `Policy ${key}`,
          framework: "Internal security policy",
          createdById: "u-1",
        },
      });
      const revision = await db.governingDocumentRevision.create({
        data: {
          id: `gr-${key}`,
          documentId: doc.id,
          revisionLabel: "v3",
          effectiveDate: new Date("2026-10-01T00:00:00Z"),
          storagePath: `governing/${workspaceId}/gr-${key}.md`,
          contentHash: `hash-${key}`,
          mimeType: "text/markdown",
          sizeBytes: text.length,
          extractedText: text,
          uploadedById: "u-1",
        },
      });
      await db.governingDocument.update({
        where: { id: doc.id },
        data: { currentRevisionId: revision.id },
      });
      for (const [i, r] of rules.entries()) {
        await db.governingRule.create({
          data: {
            id: `rule-${key}-${i}`,
            revisionId: revision.id,
            controlId: r.controlId,
            summary: r.summary,
            clauseRef: r.controlId,
            clauseStart: r.start,
            clauseEnd: r.end,
            clauseExcerpt: text.slice(r.start, r.end),
            category: i === 0 ? "access-control" : null,
          },
        });
      }
      return doc.id;
    };
    const byWorkspace = (db: PrismaClient, workspaceId: string) =>
      db.governingDocument.findMany({
        where: { workspaceId, deletedAt: null },
        orderBy: { id: "asc" },
        include: {
          currentRevision: true,
          revisions: {
            orderBy: { id: "asc" },
            include: { rules: { orderBy: { id: "asc" }, include: { edits: true } } },
          },
        },
      });
    const counts = async (db: PrismaClient) => ({
      documents: await db.governingDocument.count(),
      revisions: await db.governingDocumentRevision.count(),
      rules: await db.governingRule.count(),
      edits: await db.governingRuleEdit.count(),
    });

    let written: Awaited<ReturnType<typeof byWorkspace>>;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1868-governing-documents-client");
      const db = client();
      try {
        await db.user.create({
          data: { id: "u-1", username: "u-1", displayName: "U", email: "u1@example.test" },
        });
        for (const id of ["ws-a", "ws-b"]) {
          await db.workspace.create({ data: { id, name: id, slug: id } });
          await db.project.create({
            data: { id: `p-${id}`, name: id, slug: `p-${id}`, createdById: "u-1", workspaceId: id },
          });
        }
        await seedDocument(db, "ws-a", "a", [
          { controlId: "AC-2", summary: "Review user access every quarter.", start: 4, end: 46 },
          { controlId: "R-002", summary: "Keep logs for a year.", start: 51, end: 75 },
        ]);
        await seedDocument(db, "ws-b", "b", [
          { controlId: "B-1", summary: "Workspace B's own rule.", start: 4, end: 46 },
        ]);
        await db.governingRule.update({
          where: { id: "rule-a-1" },
          data: { summary: "Retain logs for one year.", editedById: "u-1", editedAt: new Date() },
        });
        await db.governingRuleEdit.create({
          data: {
            ruleId: "rule-a-1",
            kind: "edit",
            editedById: "u-1",
            before: JSON.stringify({ summary: "Keep logs for a year." }),
            after: JSON.stringify({ summary: "Retain logs for one year." }),
          },
        });
        written = await byWorkspace(db, "ws-a");
      } finally {
        await db.$disconnect();
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("round trip: a fresh client reads back by workspace exactly what was written", async () => {
      const db = client();
      try {
        const read = await byWorkspace(db, "ws-a");
        expect(read).toEqual(written);
        expect(read).toHaveLength(1);
        const [doc] = read;
        expect(doc).toMatchObject({
          workspaceId: "ws-a",
          title: "Policy a",
          framework: "Internal security policy",
          currentRevisionId: "gr-a",
        });
        expect(doc.currentRevision).toMatchObject({
          id: "gr-a",
          revisionLabel: "v3",
          indexState: "pending",
          extractionState: "pending",
          effectiveDate: new Date("2026-10-01T00:00:00Z"),
        });
        const rules = doc.revisions[0].rules;
        expect(rules.map((r) => [r.controlId, r.summary])).toEqual([
          ["AC-2", "Review user access every quarter."],
          ["R-002", "Retain logs for one year."],
        ]);
        for (const r of rules) {
          expect(r.clauseExcerpt).toBe(
            doc.revisions[0].extractedText.slice(r.clauseStart, r.clauseEnd),
          );
        }
        expect(rules[1].editedById).toBe("u-1");
        expect(rules[1].edits).toHaveLength(1);
        expect(JSON.parse(rules[1].edits[0].before)).toEqual({ summary: "Keep logs for a year." });
      } finally {
        await db.$disconnect();
      }
    });

    it("scoping: workspace A's query returns none of workspace B's rows", async () => {
      const db = client();
      try {
        const a = await byWorkspace(db, "ws-a");
        const b = await byWorkspace(db, "ws-b");
        expect(b.map((d) => d.id)).toEqual(["gd-b"]);
        expect(a.map((d) => d.id)).toEqual(["gd-a"]);
        const ruleIds = (docs: typeof a) =>
          docs.flatMap((d) => d.revisions.flatMap((r) => r.rules.map((rule) => rule.id)));
        expect(ruleIds(a)).toEqual(["rule-a-0", "rule-a-1"]);
        expect(ruleIds(b)).toEqual(["rule-b-0"]);
        const aRules = await db.governingRule.findMany({
          where: { revision: { document: { workspaceId: "ws-a" } } },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        expect(aRules.map((r) => r.id)).toEqual(["rule-a-0", "rule-a-1"]);
      } finally {
        await db.$disconnect();
      }
    });

    it("deleting a revision clears the document's current-revision pointer", async () => {
      const db = client();
      try {
        await db.governingDocumentRevision.create({
          data: {
            id: "gr-a-v4",
            documentId: "gd-a",
            revisionLabel: "v4",
            effectiveDate: new Date("2026-11-01T00:00:00Z"),
            storagePath: "governing/ws-a/gr-a-v4.md",
            contentHash: "hash-a-v4",
            mimeType: "text/markdown",
            sizeBytes: 1,
            extractedText: "x",
            uploadedById: "u-1",
          },
        });
        await db.governingDocument.update({
          where: { id: "gd-a" },
          data: { currentRevisionId: "gr-a-v4" },
        });
        await db.governingDocumentRevision.delete({ where: { id: "gr-a-v4" } });
        const doc = await db.governingDocument.findUniqueOrThrow({ where: { id: "gd-a" } });
        expect(doc.currentRevisionId).toBeNull();
        await db.governingDocument.update({
          where: { id: "gd-a" },
          data: { currentRevisionId: "gr-a" },
        });
      } finally {
        await db.$disconnect();
      }
    });

    it("deleting a project in the workspace deletes no governing row", async () => {
      const db = client();
      try {
        const before = await counts(db);
        expect(before).toEqual({ documents: 2, revisions: 2, rules: 3, edits: 1 });
        await db.project.delete({ where: { id: "p-ws-a" } });
        expect(await db.project.count({ where: { id: "p-ws-a" } })).toBe(0);
        expect(await counts(db)).toEqual(before);
        expect(await byWorkspace(db, "ws-a")).toEqual(written);
      } finally {
        await db.$disconnect();
      }
    });

    it("soft-deleting a workspace (what the delete route does) keeps its rows", async () => {
      const db = client();
      try {
        await db.workspace.update({ where: { id: "ws-a" }, data: { deletedAt: new Date() } });
        expect(await counts(db)).toEqual({ documents: 2, revisions: 2, rules: 3, edits: 1 });
      } finally {
        await db.$disconnect();
      }
    });

    it("hard-deleting a workspace cascades its governing rows and only its own", async () => {
      const db = client();
      try {
        await db.workspace.delete({ where: { id: "ws-a" } });
        expect(await counts(db)).toEqual({ documents: 1, revisions: 1, rules: 1, edits: 0 });
        expect((await byWorkspace(db, "ws-b")).map((d) => d.id)).toEqual(["gd-b"]);
      } finally {
        await db.$disconnect();
      }
    });
  },
);
