/**
 * Issue #2290 — `discussion_messages.meta`: an AI discussion reply records its
 * checked citations, as a chat reply does (#2242).
 *
 * Against a REAL SQLite database built by the migration chain:
 *
 * - the migration and its committed reverse script, applied up -> reverse ->
 *   up over a message written BEFORE the migration (NULL after it: nothing is
 *   backfilled, so an old reply shows no citation list);
 * - the round trip a reader depends on: `streamAIReply` writes a reply whose
 *   citations were checked against what it retrieved, and the thread's history
 *   read (`GET /api/discussions/threads/:id/messages`) returns those citations,
 *   never the raw column.
 *
 * The provider is a scripted double: nothing calls a model. SQLite-only (a
 * Postgres-generated client rejects the better-sqlite3 adapter); the `api` CI
 * job builds the SQLite client, so this runs on every PR.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { AIProvider, ChatChunk } from "../src/lib/ai/types.js";

const MIGRATION = "20261130002290_issue2290_discussion_message_meta";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// The budget gate and the project ledger are not what this pins.
vi.mock("../src/lib/finops/budget-enforcer.js", async (original) => ({
  ...(await original<typeof import("../src/lib/finops/budget-enforcer.js")>()),
  assertWithinBudget: async () => undefined,
}));
vi.mock("../src/lib/finops/token-tracker.js", () => ({ recordUsage: vi.fn() }));

const { streamAIReply } = await import("../src/lib/discussions/ai-responder.js");
const { discussionsRouter } = await import("../src/routes/discussions.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const ALICE = "u-alice";

/** A provider that streams `answer` and nothing else. */
function answering(answer: string): AIProvider {
  return {
    key: "offline-stub",
    model: "offline-stub",
    offline: true,
    async chat() {
      throw new Error("not used");
    },
    async *stream(): AsyncGenerator<ChatChunk> {
      yield { type: "delta", content: answer };
      yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      yield { type: "done" };
    },
  } as unknown as AIProvider;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2290 — discussion message meta (real SQLite)",
  () => {
    describe("the migration: up -> reverse -> up", () => {
      let sqlite: MigratedSqlite;
      const rollback = readFileSync(
        path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
        "utf-8",
      );
      const pgUp = readFileSync(
        path.join(SERVER_ROOT, "prisma", "postgres", "migrations", MIGRATION, "migration.sql"),
        "utf-8",
      );
      const pgDown = readFileSync(
        path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
        "utf-8",
      );
      const withDb = <T>(fn: (db: Database.Database) => T): T => {
        const db = new Database(sqlite.dbFile);
        try {
          return fn(db);
        } finally {
          db.close();
        }
      };
      const columns = () =>
        withDb((db) =>
          (
            db.prepare(`PRAGMA table_info("discussion_messages")`).all() as Array<{ name: string }>
          ).map((c) => c.name),
        );
      const row = () =>
        withDb(
          (db) =>
            db.prepare(`SELECT * FROM "discussion_messages" WHERE "id" = 'dm-1'`).get() as Record<
              string,
              unknown
            >,
        );
      let seeded: Record<string, unknown>;
      let before: string[];

      beforeAll(() => {
        sqlite = createMigratedSqlite("2290-discussion-meta-migration", { stopBefore: MIGRATION });
        withDb((db) => {
          // Only the column is under test: the rows it hangs off are not all seeded.
          db.pragma("foreign_keys = OFF");
          db.prepare(
            `INSERT INTO "discussion_messages" ("id","threadId","authorKind","aiProvider","aiModel","body")
             VALUES ('dm-1','t-1','ai','offline-stub','m','See src/a.ts:1.')`,
          ).run();
        });
        seeded = row();
        before = columns();
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      afterAll(() => sqlite?.cleanup());

      it(
        "up adds the column, NULL on the existing row; reverse drops it; up again re-applies",
        () => {
          expect(before).not.toContain("meta");

          sqlite.apply(MIGRATION);
          expect(columns()).toEqual([...before, "meta"]);
          expect(row()).toEqual({ ...seeded, meta: null });

          // What the rollback's header says is lost: the recorded citations.
          withDb((db) =>
            db.prepare(`UPDATE "discussion_messages" SET "meta" = '{"citations":[]}'`).run(),
          );
          withDb((db) => db.exec(rollback));
          expect(columns()).toEqual(before);
          expect(row()).toEqual(seeded);

          sqlite.applyRemaining();
          expect(row()).toEqual({ ...seeded, meta: null });
        },
        MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
      );

      it("the Postgres twin makes the same change and its reverse, idempotently", () => {
        expect(pgUp).toContain(
          `ALTER TABLE "discussion_messages" ADD COLUMN IF NOT EXISTS "meta" TEXT;`,
        );
        expect(pgDown).toContain(`ALTER TABLE "discussion_messages" DROP COLUMN IF EXISTS "meta";`);
        expect(pgDown).toContain(
          `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
        );
        expect(pgUp).not.toMatch(/\bUPDATE\b/);
      });
    });

    describe("a reply's citations: written by the responder, read by the history route", () => {
      let sqlite: MigratedSqlite;
      let db: PrismaClient;

      beforeAll(async () => {
        sqlite = createMigratedSqlite("2290-discussion-citations");
        db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
        state.db = db;
        await db.user.create({
          data: { id: ALICE, username: ALICE, displayName: "Alice", email: "a@example.test" },
        });
        await db.workspace.create({ data: { id: "ws-1", name: "ws-1", slug: "ws-1" } });
        await db.workspaceMember.create({ data: { workspaceId: "ws-1", userId: ALICE } });
        await db.project.create({
          data: { id: "p-1", name: "P1", slug: "p-1", createdById: ALICE, workspaceId: "ws-1" },
        });
        await db.discussionThread.create({
          data: { id: "t-1", projectId: "p-1", createdById: ALICE },
        });
        await db.discussionMessage.create({
          data: {
            id: "trigger",
            threadId: "t-1",
            authorKind: "human",
            authorUserId: ALICE,
            body: "@AI refunds?",
          },
        });
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      afterAll(async () => {
        await db?.$disconnect();
        sqlite?.cleanup();
      });

      it("the history read returns what the responder checked and stored", async () => {
        const result = await streamAIReply({
          thread: { id: "t-1", projectId: "p-1", aiResponseMode: "on_mention" },
          triggerMessage: { id: "trigger", body: "@AI refunds?" },
          actor: { id: ALICE },
          provider: answering("Refunds take 30 days [1]; see also src/made/up.ts:3."),
          retrieve: async () => ({
            block: "## Retrieved Knowledge\n[1] FRD-12.md#0\nRefunds within 30 days.",
            sources: 1,
            evidence: { contexts: ["Refunds within 30 days."], excerpts: [{ name: "FRD-12.md" }] },
          }),
        });
        expect(result.message.citations?.map((c) => c.status)).toEqual(["verified", "not-read"]);

        const app = express();
        app.use(express.json());
        app.use("/api/discussions", discussionsRouter());
        app.use(notFoundHandler);
        app.use(errorHandler);
        const token = issueTokens({
          userId: ALICE,
          username: ALICE,
          role: "developer",
          permissions: [],
          workspaces: ["ws-1"],
        }).accessToken;
        const res = await request(app)
          .get("/api/discussions/threads/t-1/messages")
          .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        const rows = res.body.data as Array<Record<string, unknown>>;
        const reply = rows.find((m) => m.id === result.message.id)!;
        expect(reply.citations).toEqual(result.message.citations);
        expect(reply).not.toHaveProperty("meta");
        // The human trigger carries none.
        expect(rows.find((m) => m.id === "trigger")).not.toHaveProperty("citations");
      });
    });
  },
);
