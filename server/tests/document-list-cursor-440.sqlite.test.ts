/**
 * #440 — `GET /api/projects/:id/documents` pages by cursor, so a document
 * inserted or deleted while a client is reading the list cannot make it skip
 * a row.
 *
 * Offset paging over a list that loses a row between two requests shifts every
 * later row up by one, and the row that moves across the page boundary is never
 * returned. The cursor names the last row seen by `(uploadedAt, id)`, so the
 * next page starts strictly after it wherever it now sits.
 *
 * REAL router, REAL auth, REAL SQLite built from the migration chain: the
 * ordering and the keyset `where` are only meaningful against a real query
 * planner, never a mock that ignores `orderBy`.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const { documentsRouter } = await import("../src/routes/documents.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const PROJ = "proj-cursor-000440";
const OTHER = "proj-cursor-000441";
/** Several rows share one timestamp, so only the id tiebreaker orders them. */
const SAME_TIME = new Date("2026-09-01T12:00:00.000Z");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#440 — the document list pages by cursor (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let admin = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use(
        "/api/projects/:projectId/documents",
        documentsRouter({
          storage: {} as never,
          knowledge: { deleteDocument: vi.fn() } as never,
          ingestQueue: null,
        }),
      );
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const list = (query: Record<string, string | number>, projectId = PROJ) =>
      request(app())
        .get(`/api/projects/${projectId}/documents`)
        .query(query)
        .set("Authorization", `Bearer ${admin}`);

    let seq = 0;
    async function addDoc(projectId: string, uploadedAt: Date, id?: string): Promise<string> {
      seq += 1;
      const row = await db.document.create({
        data: {
          ...(id ? { id } : {}),
          projectId,
          filename: `doc-${seq}.md`,
          mimeType: "text/markdown",
          sizeBytes: 1,
          storagePath: `p/${seq}`,
          checksum: `c${seq}`,
          uploadedById: "u-admin",
          uploadedAt,
          status: "ready",
        },
      });
      return row.id;
    }

    /** Ten rows: four share a timestamp, six are a minute apart. */
    async function seed(): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        ids.push(await addDoc(PROJ, new Date(SAME_TIME.getTime() - (i + 1) * 60_000)));
      }
      for (const suffix of ["a", "b", "c", "d"]) {
        ids.push(await addDoc(PROJ, SAME_TIME, `doc-same-time-${suffix}`));
      }
      return ids;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("440-document-cursor");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-admin", username: "u-admin", displayName: "A", email: "a@example.test" },
      });
      for (const id of [PROJ, OTHER]) {
        await db.project.create({
          data: { id, name: id, slug: id, description: "", createdById: "u-admin" },
        });
      }
      admin = issueTokens({
        userId: "u-admin",
        username: "u-admin",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      await db.document.deleteMany({});
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    async function readAll(limit: number): Promise<string[]> {
      const first = await list({ limit });
      expect(first.status).toBe(200);
      const ids: string[] = first.body.data.items.map((d: { id: string }) => d.id);
      let cursor: string | null = first.body.data.nextCursor;
      while (cursor) {
        const page = await list({ limit, cursor });
        expect(page.status).toBe(200);
        ids.push(...page.body.data.items.map((d: { id: string }) => d.id));
        cursor = page.body.data.nextCursor;
      }
      return ids;
    }

    it("walks every row exactly once, newest first, ties broken by id", async () => {
      const ids = await seed();
      const seen = await readAll(3);
      expect(seen).toEqual([
        "doc-same-time-d",
        "doc-same-time-c",
        "doc-same-time-b",
        "doc-same-time-a",
        ...ids.slice(0, 6),
      ]);
    });

    it("the last page carries no cursor, and a cursor page skips count(*)", async () => {
      await seed();
      const first = await list({ limit: 5 });
      expect(first.body.data.total).toBe(10);
      const second = await list({ limit: 5, cursor: first.body.data.nextCursor });
      expect(second.body.data.items).toHaveLength(5);
      expect(second.body.data.nextCursor).toBeNull();
      expect(second.body.data).not.toHaveProperty("total");
    });

    it("a row deleted from an earlier page does not make the next page skip one", async () => {
      await seed();
      const first = await list({ limit: 4 });
      const firstIds: string[] = first.body.data.items.map((d: { id: string }) => d.id);
      // Delete a row the client has already seen; offset=4 would now skip one.
      await db.document.update({
        where: { id: firstIds[0] },
        data: { deletedAt: new Date() },
      });
      const rest: string[] = [];
      let cursor: string | null = first.body.data.nextCursor;
      while (cursor) {
        const page = await list({ limit: 4, cursor });
        rest.push(...page.body.data.items.map((d: { id: string }) => d.id));
        cursor = page.body.data.nextCursor;
      }
      const live = await db.document.findMany({ where: { projectId: PROJ, deletedAt: null } });
      const expected = live.map((d) => d.id).filter((id) => !firstIds.includes(id));
      expect(rest.sort()).toEqual(expected.sort());
      expect(rest).toHaveLength(6);
    });

    it("a cursor page never returns a row soft-deleted after the cursor (PR #469 review)", async () => {
      const ids = await seed();
      const first = await list({ limit: 4 });
      // Delete a row the client has NOT seen yet: the cursor query must still
      // apply the soft-delete filter, not just the project and position.
      const unseen = ids[5]!;
      await db.document.update({ where: { id: unseen }, data: { deletedAt: new Date() } });
      const second = await list({ limit: 10, cursor: first.body.data.nextCursor });
      const secondIds: string[] = second.body.data.items.map((d: { id: string }) => d.id);
      expect(secondIds).not.toContain(unseen);
      expect(secondIds).toHaveLength(5);
    });

    it("a row inserted mid-read neither repeats nor displaces a row", async () => {
      const ids = await seed();
      const first = await list({ limit: 4 });
      await addDoc(PROJ, new Date(SAME_TIME.getTime() + 60_000));
      const second = await list({ limit: 6, cursor: first.body.data.nextCursor });
      expect(second.body.data.items.map((d: { id: string }) => d.id)).toEqual(ids.slice(0, 6));
    });

    it("never returns another project's rows through a cursor", async () => {
      await seed();
      await addDoc(OTHER, new Date(SAME_TIME.getTime() - 30 * 60_000));
      const seen = await readAll(4);
      expect(seen).toHaveLength(10);
    });

    it.each([
      ["not base64 json", "%%%"],
      ["an empty cursor", ""],
      [
        "a cursor with no id",
        Buffer.from(JSON.stringify({ t: SAME_TIME.toISOString() })).toString("base64url"),
      ],
      [
        "a cursor with a bad date",
        Buffer.from(JSON.stringify({ t: "yesterday", id: "x" })).toString("base64url"),
      ],
      ["an over-long cursor", "a".repeat(1100)],
    ])("rejects %s with 400 INVALID_CURSOR", async (_label, cursor) => {
      const res = await list({ cursor });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_CURSOR");
    });

    it("pages past a generated document's long synthetic id (PR #469 panel)", async () => {
      // generated-doc-publication writes live rows with ids like this (~94 chars);
      // the server must accept the cursor it issues when one ends a page.
      const longId = `gendoc-${"g".repeat(25)}:gendoc:${PROJ}:${"g".repeat(25)}:v12`;
      await addDoc(PROJ, new Date(SAME_TIME.getTime() + 60_000), longId);
      await seed();
      const first = await list({ limit: 1 });
      expect(first.body.data.items.map((d: { id: string }) => d.id)).toEqual([longId]);
      const second = await list({ limit: 5, cursor: first.body.data.nextCursor });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.data.items).toHaveLength(5);
      expect(second.body.data.items.map((d: { id: string }) => d.id)).not.toContain(longId);
    });

    it("offset paging keeps working and now orders ties by id too", async () => {
      await seed();
      const res = await list({ limit: 2, offset: 1 });
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual([
        "doc-same-time-c",
        "doc-same-time-b",
      ]);
      expect(res.body.data).toMatchObject({ total: 10, limit: 2, offset: 1 });
      expect(typeof res.body.data.nextCursor).toBe("string");
    });
  },
);
