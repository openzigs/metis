/**
 * #2192 — a discussion @mention notification quotes its message, and keeps
 * quoting what the message says now.
 *
 *   - A mention ADDED by an edit quotes the whole edited message, not just the
 *     added handle (`@carol`), and only the added handle is notified.
 *   - Editing the message re-quotes the notifications already sent; a recipient
 *     who can no longer open the project gets "The message was edited." instead.
 *   - Deleting the message replaces every quote with "The message was deleted."
 *
 * Real routes (`discussionsRouter`, `notificationsRouter`), real JWT auth, real
 * mention fan-out and access rule, and a real SQLite database built from the
 * migration chain: the quote is read back the way the notification drawer reads
 * it, so the payload match (`notificationsQuoting`) is proven on SQLite's LIKE.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { discussionsRouter } = await import("../src/routes/discussions.js");
const { notificationsRouter } = await import("../src/routes/notifications.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { DELETED_MESSAGE_TEXT, EDITED_MESSAGE_TEXT } =
  await import("../src/lib/discussions/notify.js");

const WS = "ws-2192";
const P = "p-2192";
const T = "t-2192";
const MEMBERS = ["u-alice", "u-bob", "u-carol", "u-dave"];

const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/discussions", discussionsRouter());
  a.use("/api/notifications", notificationsRouter());
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
};

const bearer = (userId: string) =>
  `Bearer ${
    issueTokens({
      userId,
      username: userId.replace("u-", ""),
      role: "developer",
      permissions: [],
      workspaces: [WS],
    }).accessToken
  }`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2192 — discussion mention quotes follow the message (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2192-discussion-mention-quote");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      for (const id of MEMBERS) {
        const username = id.replace("u-", "");
        await db.user.create({
          data: { id, username, displayName: username, email: `${username}@example.test` },
        });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: id } });
      }
      await db.project.create({
        data: { id: P, name: "P", slug: P, createdById: "u-alice", workspaceId: WS },
      });
      await db.discussionThread.create({
        data: { id: T, projectId: P, createdById: "u-alice", title: "Feed refresh" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /** The user's discussion-mention messages, read as the drawer reads them. */
    const drawer = async (userId: string): Promise<string[]> => {
      const res = await request(app())
        .get("/api/notifications")
        .set("Authorization", bearer(userId));
      expect(res.status).toBe(200);
      return (res.body.data.notifications as Array<{ type: string; message: string }>)
        .filter((n) => n.type === "discussion_mention")
        .map((n) => n.message);
    };
    const mentionCount = (userId: string) =>
      db.notification.count({ where: { userId, type: "discussion_mention" } });

    it("quotes an edit's added mention whole, re-quotes on edit and retracts on delete", async () => {
      // Alice mentions Bob and Dave.
      const posted = await request(app())
        .post(`/api/discussions/threads/${T}/messages`)
        .set("Authorization", bearer("u-alice"))
        .send({ body: "@bob @dave can you check the default?" });
      expect(posted.status).toBe(201);
      const messageId = posted.body.data.id as string;
      await vi.waitFor(async () => {
        expect(await mentionCount("u-bob")).toBe(1);
        expect(await mentionCount("u-dave")).toBe(1);
      });
      expect(await drawer("u-bob")).toEqual(["“@bob @dave can you check the default?”"]);

      // Dave leaves the workspace; then Alice edits, adding Carol.
      await db.workspaceMember.deleteMany({ where: { workspaceId: WS, userId: "u-dave" } });
      const edited = await request(app())
        .patch(`/api/discussions/threads/${T}/messages/${messageId}`)
        .set("Authorization", bearer("u-alice"))
        .send({ body: "@bob @dave @carol the default is hourly" });
      expect(edited.status).toBe(200);

      // Carol, added by the edit, is quoted the whole message — not "@carol".
      await vi.waitFor(async () => expect(await mentionCount("u-carol")).toBe(1));
      expect(await drawer("u-carol")).toEqual(["“@bob @dave @carol the default is hourly”"]);
      // Bob's notification now quotes the edited text, and he is not re-notified.
      // The re-quote runs after the edit answers, so wait for it.
      await vi.waitFor(async () =>
        expect(await drawer("u-bob")).toEqual(["“@bob @dave @carol the default is hourly”"]),
      );
      expect(await mentionCount("u-bob")).toBe(1);
      // Dave can no longer open the project: his row never gets the new text.
      await vi.waitFor(async () => {
        const daves = await db.notification.findMany({
          where: { userId: "u-dave", type: "discussion_mention" },
          select: { message: true },
        });
        expect(daves).toEqual([{ message: EDITED_MESSAGE_TEXT }]);
      });

      // A second message's notification is never touched by this one's changes.
      const other = await request(app())
        .post(`/api/discussions/threads/${T}/messages`)
        .set("Authorization", bearer("u-alice"))
        .send({ body: "@bob separate question" });
      expect(other.status).toBe(201);
      await vi.waitFor(async () => expect(await mentionCount("u-bob")).toBe(2));

      // Alice deletes the first message: every quote of it is retracted.
      const deleted = await request(app())
        .delete(`/api/discussions/threads/${T}/messages/${messageId}`)
        .set("Authorization", bearer("u-alice"));
      expect(deleted.status).toBe(200);
      await vi.waitFor(async () => expect(await drawer("u-carol")).toEqual([DELETED_MESSAGE_TEXT]));
      expect((await drawer("u-bob")).sort()).toEqual(
        [DELETED_MESSAGE_TEXT, "“@bob separate question”"].sort(),
      );
    });
  },
);
