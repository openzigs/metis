/**
 * #2548 — an upload of a file the project already holds under the same name and
 * with the same content is accepted, and the response says so (`duplicateOf`),
 * so the page can warn. Only an earlier copy the uploader may read is named: an
 * upload never confirms that a document restricted from them holds that content.
 *
 * REAL SQLite from the migration chain, through the real upload route.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";
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
  return { db: null as unknown, writes: 0 };
});
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
    resolveDatabaseProvider: () => "sqlite" as const,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// The URL route's fetch, with no network: the page's body is the URL's fragment.
vi.mock("../src/lib/documents/url-fetcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/documents/url-fetcher.js")>()),
  fetchUrlForIngest: async (url: string) => ({
    buffer: Buffer.from(decodeURIComponent(new URL(url).hash.slice(1))),
    contentType: "text/markdown",
    finalUrl: url,
    filename: "from-url.md",
  }),
}));

const { documentsRouter } = await import("../src/routes/documents.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-2548";
const P = "proj-2548-dup";
const OPEN = "doc-2548-open";
const SECRET = "doc-2548-secret";
type Who = "alice" | "bob";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2548 — a duplicate upload is accepted and said, naming only a copy the uploader can read (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const payload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: "coordinator",
      permissions: getPermissionsForRole("coordinator"),
      workspaces: [WS],
    });
    const app = () =>
      express()
        .use(express.json())
        .use(
          "/api/projects/:projectId/documents",
          documentsRouter({
            // The checksum is the content, as the real storage's hash is.
            storage: {
              write: async ({ buffer }: { buffer: Buffer }) => {
                state.writes += 1;
                return {
                  storagePath: `blob/${state.writes}`,
                  checksum: `sha-${buffer.toString("utf8")}`,
                  sizeBytes: buffer.length,
                  deduplicated: false,
                };
              },
            } as never,
            knowledge: {
              ingestDocument: async () => ({ status: "ready", chunkCount: 0 }),
              deleteDocument: vi.fn(),
            } as never,
            ingestQueue: null,
          }),
        )
        .use(notFoundHandler)
        .use(errorHandler);
    const upload = (who: Who, filename: string, content: string) =>
      request(app())
        .post(`/api/projects/${P}/documents`)
        .set("Authorization", `Bearer ${issueTokens(payload(who)).accessToken}`)
        .attach("file", Buffer.from(content), { filename, contentType: "text/markdown" });

    const token = (who: Who) => `Bearer ${issueTokens(payload(who)).accessToken}`;
    const paste = (who: Who, filename: string, content: string) =>
      request(app())
        .post(`/api/projects/${P}/documents/text`)
        .set("Authorization", token(who))
        .send({ filename, content, mimeType: "text/markdown" });
    const fromUrl = (who: Who, filename: string, content: string) =>
      request(app())
        .post(`/api/projects/${P}/documents/url`)
        .set("Authorization", token(who))
        .send({ url: `https://example.test/page#${encodeURIComponent(content)}`, filename });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2548-duplicate-upload");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: "w", slug: WS } });
      await db.role.create({ data: { id: "role-coordinator", key: "coordinator", name: "c" } });
      for (const who of ["alice", "bob"] as const) {
        await db.user.create({
          data: { id: who, username: who, displayName: who, email: `${who}@example.test` },
        });
        await db.userRole.create({ data: { userId: who, roleId: "role-coordinator" } });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: who, role: "member" } });
      }
      await db.project.create({
        data: { id: P, name: P, slug: P, createdById: "alice", workspaceId: WS, status: "active" },
      });
      for (const [id, filename, content, aclSubjects] of [
        [OPEN, "brief.md", "open brief", "[]"],
        [SECRET, "payroll.md", "salary table", JSON.stringify([{ kind: "user", value: "alice" }])],
      ] as const) {
        await db.document.create({
          data: {
            id,
            projectId: P,
            filename,
            mimeType: "text/markdown",
            sizeBytes: content.length,
            storagePath: `blob/${id}`,
            checksum: `sha-${content}`,
            uploadedById: "alice",
            status: "ready",
            aclSubjects,
            uploadedAt: new Date("2026-11-01T09:00:00Z"),
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("names the earlier copy of the same file under the same name, and keeps the upload", async () => {
      const res = await upload("bob", "brief.md", "open brief");
      expect(res.status).toBe(201);
      expect(res.body.data.duplicateOf).toEqual({
        id: OPEN,
        uploadedAt: "2026-11-01T09:00:00.000Z",
      });
      expect(res.body.data.document.id).not.toBe(OPEN);
      expect(await db.document.count({ where: { projectId: P, filename: "brief.md" } })).toBe(2);
    });

    it("says nothing when the name or the content differs", async () => {
      expect(
        (await upload("bob", "brief.md", "a new brief")).body.data.duplicateOf,
      ).toBeUndefined();
      expect((await upload("bob", "other.md", "open brief")).body.data.duplicateOf).toBeUndefined();
    });

    it("never confirms a restricted document's content to one it is restricted from", async () => {
      const bob = await upload("bob", "payroll.md", "salary table");
      expect(bob.status).toBe(201);
      expect(bob.body.data.duplicateOf).toBeUndefined();
      expect(JSON.stringify(bob.body)).not.toContain(SECRET);
      // Alice is on its list: she is told.
      const alice = await upload("alice", "payroll.md", "salary table");
      expect(alice.body.data.duplicateOf).toEqual({
        id: SECRET,
        uploadedAt: "2026-11-01T09:00:00.000Z",
      });
    });

    it("does not count a deleted document", async () => {
      const first = await upload("alice", "notes.md", "first notes");
      await db.document.update({
        where: { id: first.body.data.document.id },
        data: { deletedAt: new Date() },
      });
      expect(
        (await upload("alice", "notes.md", "first notes")).body.data.duplicateOf,
      ).toBeUndefined();
    });

    it("keeps the stored upload's answer when the duplicate lookup fails, naming nothing", async () => {
      const real = db.document.findMany.bind(db.document);
      const spy = vi
        .spyOn(db.document, "findMany")
        .mockImplementation(((args: { where?: { checksum?: unknown } }) =>
          args?.where?.checksum !== undefined
            ? Promise.reject(new Error("database unavailable"))
            : real(args as never)) as never);
      try {
        const res = await upload("alice", "brief.md", "open brief");
        expect(res.status, res.text).toBe(201);
        expect(res.body.data.document.id).toBeTruthy();
        expect(res.body.data.duplicateOf).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    // The pasted-text and URL routes create a checksummed document too: same rule.
    describe.each([
      ["POST /text", paste],
      ["POST /url", fromUrl],
    ] as const)("%s", (_route, create) => {
      // Only the two seeded documents are live: no copy an earlier test made counts.
      beforeEach(async () => {
        await db.document.updateMany({
          where: { id: { notIn: [OPEN, SECRET] } },
          data: { deletedAt: new Date() },
        });
      });

      it("names the earlier copy of the same content under the same name", async () => {
        const res = await create("bob", "brief.md", "open brief");
        expect(res.status).toBe(201);
        expect(res.body.data.duplicateOf).toEqual({
          id: OPEN,
          uploadedAt: "2026-11-01T09:00:00.000Z",
        });
      });

      it("says nothing when the content differs", async () => {
        const res = await create("bob", "brief.md", "another brief entirely");
        expect(res.status).toBe(201);
        expect(res.body.data.duplicateOf).toBeUndefined();
      });

      it("never confirms a restricted document's content to one it is restricted from", async () => {
        const bob = await create("bob", "payroll.md", "salary table");
        expect(bob.status).toBe(201);
        expect(bob.body.data.duplicateOf).toBeUndefined();
        expect(JSON.stringify(bob.body)).not.toContain(SECRET);
        const alice = await create("alice", "payroll.md", "salary table");
        expect(alice.body.data.duplicateOf).toEqual({
          id: SECRET,
          uploadedAt: "2026-11-01T09:00:00.000Z",
        });
      });
    });
  },
);
