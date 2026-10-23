/**
 * #1447 — a stored notification is shown only while its reader can still open
 * its project.
 *
 * A row written while the recipient could read the project used to keep its
 * title, message and link for good. It now carries the project it is about,
 * and every read path re-checks the reader's CURRENT access with ONE batched
 * project query per response, redacting each row they can no longer open:
 *
 *   - removed from the project's workspace (the token still claims it — #561)
 *   - the project moved to a workspace they are not in
 *   - the project soft-deleted (#1430: closed to non-admins)
 *
 * Each with a live control in the same response, and an admin control (an
 * admin still sees all three). Plus the migration backfill that gives every
 * pre-#1447 row its project.
 *
 * Real router, real JWT auth, a real SQLite database from the migration chain.
 * No access helper is mocked.
 */
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
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

const { notificationsRouter } = await import("../src/routes/notifications.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { REDACTED_TITLE, REDACTED_TYPE } = await import("../src/lib/notifications/visibility.js");

const MIGRATION = "20261028001447_issue1447_notification_project_id";

const WS = "ws-1447";
const WS_REMOVED = "ws-1447-removed";
const WS_OTHER = "ws-1447-other";
const P_LIVE = "p-1447-live";
const P_REMOVED = "p-1447-removed"; // in WS_REMOVED, which the reader has left
const P_MOVED = "p-1447-moved"; // moved from WS to WS_OTHER
const P_DELETED = "p-1447-deleted"; // soft-deleted, still in WS

const isSqlite = readGeneratedClientProvider() === "sqlite";

type Row = {
  id: string;
  type: string;
  title: string;
  message: string;
  href: string | null;
  payload: string | null;
  read: boolean;
  redacted: boolean;
  projectId?: unknown;
};

describe.skipIf(!isSqlite)("#1447 — the notification list re-checks project access", () => {
  let sqlite: MigratedSqlite;
  let db: PrismaClient;
  let READER = "";
  let ADMIN = "";

  const app = () => {
    const a = express();
    a.use(express.json());
    a.use("/api/notifications", notificationsRouter());
    a.use(notFoundHandler);
    a.use(errorHandler);
    return a;
  };

  const seedFor = async (userId: string) => {
    const rows: Array<[string, string | null]> = [
      ["live", P_LIVE],
      ["removed", P_REMOVED],
      ["moved", P_MOVED],
      ["deleted", P_DELETED],
      ["orphan", null],
    ];
    for (const [i, [tag, projectId]] of rows.entries()) {
      await db.notification.create({
        data: {
          id: `n-${userId}-${tag}`,
          userId,
          type: "review_rejected",
          title: `Secret title ${tag}`,
          message: `Secret excerpt ${tag}`,
          href: `/reviews/r-${tag}`,
          payload: JSON.stringify({ reviewId: `r-${tag}`, projectId }),
          projectId,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
        },
      });
    }
  };

  const byId = (rows: Row[], id: string): Row => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  };

  const expectRedacted = (row: Row) => {
    expect(row).toMatchObject({
      type: REDACTED_TYPE,
      title: REDACTED_TITLE,
      message: "",
      href: null,
      payload: null,
      redacted: true,
    });
    expect(JSON.stringify(row)).not.toContain("Secret");
  };

  beforeAll(async () => {
    sqlite = createMigratedSqlite("1447-notification-access");
    db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    state.db = db;
    for (const id of ["u-reader", "u-admin", "u-owner"]) {
      await db.user.create({
        data: { id, username: id, displayName: id, email: `${id}@example.test` },
      });
    }
    const adminRole = await db.role.create({ data: { key: "admin", name: "Admin" } });
    await db.userRole.create({ data: { userId: "u-admin", roleId: adminRole.id } });
    for (const id of [WS, WS_REMOVED, WS_OTHER]) {
      await db.workspace.create({ data: { id, name: id, slug: id } });
    }
    // The reader is (still) a member of WS only. Their WS_REMOVED membership
    // row is gone, though their token below still claims it.
    await db.workspaceMember.create({
      data: { workspaceId: WS, userId: "u-reader", role: "member" },
    });
    for (const [id, workspaceId, deletedAt] of [
      [P_LIVE, WS, null],
      [P_REMOVED, WS_REMOVED, null],
      [P_MOVED, WS_OTHER, null],
      [P_DELETED, WS, new Date()],
    ] as const) {
      await db.project.create({
        data: { id, name: id, slug: id, createdById: "u-owner", workspaceId, deletedAt },
      });
    }
    await seedFor("u-reader");
    await seedFor("u-admin");

    READER = issueTokens({
      userId: "u-reader",
      username: "u-reader",
      role: "developer",
      permissions: [],
      // A stale claim: still names the workspace they were removed from and the
      // one the project left.
      workspaces: [WS, WS_REMOVED],
    }).accessToken;
    ADMIN = issueTokens({
      userId: "u-admin",
      username: "u-admin",
      role: "admin",
      permissions: [],
      workspaces: [],
    }).accessToken;
  }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    sqlite?.cleanup();
  });

  it("redacts rows the reader can no longer open, keeps the live control intact", async () => {
    const res = await request(app())
      .get("/api/notifications")
      .set("Authorization", `Bearer ${READER}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.notifications as Row[];
    expect(rows).toHaveLength(5);

    // Control: the project they can still open.
    expect(byId(rows, "n-u-reader-live")).toMatchObject({
      type: "review_rejected",
      title: "Secret title live",
      message: "Secret excerpt live",
      href: "/reviews/r-live",
      redacted: false,
    });
    expectRedacted(byId(rows, "n-u-reader-removed"));
    expectRedacted(byId(rows, "n-u-reader-moved"));
    expectRedacted(byId(rows, "n-u-reader-deleted"));
    // Fail closed: a row with no project.
    expectRedacted(byId(rows, "n-u-reader-orphan"));
    // The project id is the check's input, never part of the response.
    for (const row of rows) expect(row).not.toHaveProperty("projectId");
  });

  it("an admin still sees removed-from, moved and soft-deleted projects in full", async () => {
    const res = await request(app())
      .get("/api/notifications")
      .set("Authorization", `Bearer ${ADMIN}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.notifications as Row[];
    for (const tag of ["live", "removed", "moved", "deleted"]) {
      expect(byId(rows, `n-u-admin-${tag}`)).toMatchObject({
        title: `Secret title ${tag}`,
        message: `Secret excerpt ${tag}`,
        redacted: false,
      });
    }
    // A row with no project is redacted for an admin too.
    expectRedacted(byId(rows, "n-u-admin-orphan"));
  });

  it("the unread count counts exactly the rows the list returns", async () => {
    const res = await request(app())
      .get("/api/notifications")
      .set("Authorization", `Bearer ${READER}`);
    const rows = res.body.data.notifications as Row[];
    expect(res.body.data.unreadCount).toBe(rows.filter((r) => !r.read).length);
  });

  it("checks access with ONE project query per page, not one per row", async () => {
    const spy = vi.spyOn(db.project, "findMany");
    const findUnique = vi.spyOn(db.project, "findUnique");
    const findFirst = vi.spyOn(db.project, "findFirst");
    try {
      const res = await request(app())
        .get("/api/notifications")
        .set("Authorization", `Bearer ${READER}`);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(findUnique).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      findUnique.mockRestore();
      findFirst.mockRestore();
    }
  });

  it("marking a redacted row read works and returns it redacted", async () => {
    const res = await request(app())
      .patch("/api/notifications/n-u-reader-deleted/read")
      .set("Authorization", `Bearer ${READER}`);
    expect(res.status).toBe(200);
    expectRedacted(res.body.data.notification as Row);
    expect(res.body.data.notification.read).toBe(true);
    expect(res.body.data.unreadCount).toBe(4);

    const live = await request(app())
      .patch("/api/notifications/n-u-reader-live/read")
      .set("Authorization", `Bearer ${READER}`);
    expect(live.body.data.notification).toMatchObject({
      title: "Secret title live",
      redacted: false,
    });
  });
});

// ── the backfill ─────────────────────────────────────────────────────────────

describe.skipIf(!isSqlite)("#1447 — migration backfills each notification's project", () => {
  let sqlite: MigratedSqlite;

  const insertLegacy = (
    id: string,
    type: string,
    payload: string | null,
    commentId: string | null = null,
  ) =>
    sqlite.exec(
      `INSERT INTO "notifications" ("id","userId","type","title","message","payload","commentId","read","createdAt")
       VALUES (?, 'u-1', ?, 't', 'm', ?, ?, 0, CURRENT_TIMESTAMP)`,
      [id, type, payload, commentId],
    );

  beforeAll(async () => {
    sqlite = createMigratedSqlite("1447-backfill", { stopBefore: MIGRATION });
    const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    try {
      await db.user.create({
        data: { id: "u-1", username: "u-1", displayName: "u-1", email: "u-1@example.test" },
      });
      for (const id of ["p-req", "p-spec", "p-disc", "p-review", "p-sla"]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: "u-1" } });
      }
      await db.analysis.create({
        data: { id: "a-1", projectId: "p-req", startedById: "u-1", status: "completed" },
      });
      await db.analysis.create({
        data: { id: "a-2", projectId: "p-sla", startedById: "u-1", status: "completed" },
      });
      await db.requirement.create({
        data: { id: "req-1", projectId: "p-req", analysisId: "a-1", title: "r", body: "b" },
      });
      await db.requirement.create({
        data: { id: "req-sla", projectId: "p-sla", analysisId: "a-2", title: "r", body: "b" },
      });
      await db.commentThread.create({
        data: {
          id: "ct-req",
          requirementId: "req-1",
          comments: { create: { id: "c-req", authorId: "u-1", body: "x" } },
        },
      });
      await db.commentThread.create({
        data: {
          id: "ct-spec",
          specKitProjectId: "p-spec",
          specKitArtifactName: "spec.md",
          comments: { create: { id: "c-spec", authorId: "u-1", body: "x" } },
        },
      });
      await db.discussionThread.create({
        data: { id: "dt-1", projectId: "p-disc", createdById: "u-1" },
      });
      await db.reviewRequest.create({
        data: { id: "rr-1", projectId: "p-review", title: "r", requestedById: "u-1" },
      });
    } finally {
      await db.$disconnect();
    }

    // #1318-era mention: commentId column set.
    // The column alone names the comment (the payload does not), so the
    // backfill must read the column.
    insertLegacy("n-mention-col", "mention", JSON.stringify({ kind: "mention" }), "c-req");
    // Pre-#1318 mention: commentId only in the payload, Spec Kit thread.
    insertLegacy("n-mention-payload", "mention", JSON.stringify({ commentId: "c-spec" }));
    insertLegacy("n-disc", "discussion_mention", JSON.stringify({ threadId: "dt-1" }));
    for (const type of [
      "review_requested",
      "review_decided",
      "review_approved",
      "review_rejected",
    ]) {
      insertLegacy(
        `n-${type}`,
        type,
        // The echoed projectId is deliberately wrong: the backfill must follow
        // the review, not trust the payload.
        JSON.stringify({ reviewId: "rr-1", projectId: "p-wrong" }),
      );
    }
    insertLegacy("n-sla", "sla_deadline", JSON.stringify({ requirementId: "req-sla" }));
    // Unresolvable: malformed payload, target gone, unknown type.
    insertLegacy("n-bad-json", "discussion_mention", "{not json");
    insertLegacy("n-gone", "discussion_mention", JSON.stringify({ threadId: "dt-gone" }));
    insertLegacy("n-null-payload", "sla_deadline", null);
    insertLegacy("n-other", "something_else", JSON.stringify({ projectId: "p-req" }));
    // A key planted inside a user-controlled string is never read: the real
    // top-level key wins even when the planted one comes first...
    insertLegacy(
      "n-sla-planted-first",
      "sla_deadline",
      JSON.stringify({ requirementTitle: 'x "requirementId":"req-1" y', requirementId: "req-sla" }),
    );
    // ...and a payload whose ONLY occurrence is planted resolves to nothing.
    insertLegacy(
      "n-sla-planted-only",
      "sla_deadline",
      JSON.stringify({ requirementTitle: '{"requirementId":"req-1"}', assignmentId: "a-1" }),
    );

    // Every row the migration writes is logged, so the test can tell "left
    // alone" from "rewritten to NULL".
    sqlite.exec(`CREATE TABLE "t1447_updated" ("id" TEXT)`);
    sqlite.exec(
      `CREATE TRIGGER "t1447_log" AFTER UPDATE ON "notifications"
       BEGIN INSERT INTO "t1447_updated" VALUES (NEW."id"); END`,
    );

    sqlite.apply(MIGRATION);
  }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

  afterAll(() => sqlite?.cleanup());

  const RESOLVED = {
    "n-mention-col": "p-req",
    "n-mention-payload": "p-spec",
    "n-disc": "p-disc",
    "n-review_requested": "p-review",
    "n-review_decided": "p-review",
    "n-review_approved": "p-review",
    "n-review_rejected": "p-review",
    "n-sla": "p-sla",
    "n-sla-planted-first": "p-sla",
  };

  it("writes ONLY the rows that resolve to a project — never rewrites the rest", () => {
    const conn = new Database(sqlite.dbFile, { readonly: true });
    try {
      const updated = conn.prepare(`SELECT "id" FROM "t1447_updated"`).all() as Array<{
        id: string;
      }>;
      expect(updated.map((r) => r.id).sort()).toEqual(Object.keys(RESOLVED).sort());
    } finally {
      conn.close();
    }
  });

  it("gives every resolvable row its project and leaves the rest NULL", () => {
    const conn = new Database(sqlite.dbFile, { readonly: true });
    try {
      const rows = conn.prepare(`SELECT "id", "projectId" FROM "notifications"`).all() as Array<{
        id: string;
        projectId: string | null;
      }>;
      const got = Object.fromEntries(rows.map((r) => [r.id, r.projectId]));
      expect(got).toEqual({
        ...RESOLVED,
        "n-sla-planted-only": null,
        "n-bad-json": null,
        "n-gone": null,
        "n-null-payload": null,
        "n-other": null,
      });
    } finally {
      conn.close();
    }
  });
});
