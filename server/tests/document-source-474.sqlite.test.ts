/**
 * Issue #474 — every document records the path that wrote it (`source`) and the
 * title its source supplied, so the Workbench classifies on a stored field
 * instead of the filename.
 *
 * REAL SQLite built from the real migration chain, REAL connector writers and
 * the REAL list route: the backfill is only meaningful against the migration as
 * shipped, and the "an upload named `jira:…` is not a Jira issue" rule only
 * holds if the connector's lookup, the insert and the list read all agree.
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
  return { db: null as unknown, blobs: 0 };
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
vi.mock("../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({
    write: async ({ buffer }: { buffer: Buffer }) => {
      state.blobs += 1;
      const text = buffer.toString("utf8");
      return {
        storagePath: `blob/${state.blobs}`,
        checksum: `sha-${text.length}-${text.slice(0, 40)}`,
        sizeBytes: buffer.length,
      };
    },
  }),
}));
vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({
    ingestDocument: async () => ({ status: "ready", chunkCount: 1 }),
  }),
}));
vi.mock("../src/lib/mcp/mcp-service.js", () => ({
  getMCPRegistry: () => ({ invokeTool: vi.fn() }),
}));

const { ingestConfluenceSpace, ingestJiraQuery } =
  await import("../src/lib/connectors/atlassian.js");
const { ingestDbSchema, ingestRepoMetadata } =
  await import("../src/lib/connectors/connector-ingest.js");
const { documentsRouter } = await import("../src/routes/documents.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const MIGRATION = "20261004000474_issue474_document_source_title";
const PROJ = "proj-source-000474";
const USER = "u-474";

async function seedUserAndProject(db: PrismaClient): Promise<void> {
  await db.user.create({
    data: { id: USER, username: USER, displayName: "A", email: "a474@example.test" },
  });
  await db.project.create({
    data: { id: PROJ, name: PROJ, slug: PROJ, description: "", createdById: USER },
  });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#474 — documents record their source (real SQLite)",
  () => {
    describe("the migration backfills existing rows", () => {
      let sqlite: MigratedSqlite;
      let db: PrismaClient;

      beforeAll(() => {
        sqlite = createMigratedSqlite("474-backfill", { stopBefore: MIGRATION });
        sqlite.exec(
          `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
           VALUES (?, ?, 'A', 'a474@example.test', 0, 0)`,
          [USER, USER],
        );
        sqlite.exec(
          `INSERT INTO projects (id, name, slug, description, createdById, createdAt, updatedAt)
           VALUES (?, ?, ?, '', ?, 0, 0)`,
          [PROJ, PROJ, PROJ, USER],
        );
        const rows: Array<[string, string, string]> = [
          ["d-repo", "connector:repo:c1:README.md", "text/markdown"],
          ["d-db", "connector:db:c2:public.users.md", "text/markdown"],
          ["d-conf", "confluence:DOCS:123", "text/markdown"],
          ["d-jira", "jira:ABC-1", "text/markdown"],
          ["d-gen", "generated-doc-abc.md", "text/markdown"],
          // Named like a connector row, but no connector ever writes a PDF.
          ["d-upload-jira-pdf", "jira:ABC-2.pdf", "application/pdf"],
          // Only a prefix of the pattern, in the wrong case.
          ["d-upload-case", "JIRA:ABC-3", "text/markdown"],
          ["d-upload", "Spec v2.docx", "application/octet-stream"],
        ];
        for (const [id, filename, mimeType] of rows) {
          sqlite.exec(
            `INSERT INTO documents (id, projectId, filename, mimeType, sizeBytes, storagePath,
               checksum, uploadedById, uploadedAt)
             VALUES (?, ?, ?, ?, 1, 'p', 'c', ?, 0)`,
            [id, PROJ, filename, mimeType, USER],
          );
        }
        sqlite.apply(MIGRATION);
        db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      afterAll(async () => {
        await db?.$disconnect();
        sqlite?.cleanup();
      });

      it("classifies each connector's rows and leaves everything else an upload", async () => {
        const rows = await db.document.findMany({
          select: { id: true, source: true, title: true },
        });
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.source]));
        expect(byId).toEqual({
          "d-repo": "repo",
          "d-db": "db",
          "d-conf": "confluence",
          "d-jira": "jira",
          "d-gen": "generated",
          "d-upload-jira-pdf": "upload",
          "d-upload-case": "upload",
          "d-upload": "upload",
        });
        expect(rows.every((r) => r.title === null)).toBe(true);
      });
    });

    describe("writers stamp source and title; the list returns them", () => {
      let sqlite: MigratedSqlite;
      let db: PrismaClient;
      let token = "";

      const list = () =>
        request(
          express()
            .use(express.json())
            .use(
              "/api/projects/:projectId/documents",
              documentsRouter({
                storage: {} as never,
                knowledge: { deleteDocument: vi.fn() } as never,
                ingestQueue: null,
              }),
            )
            .use(notFoundHandler)
            .use(errorHandler),
        )
          .get(`/api/projects/${PROJ}/documents`)
          .query({ limit: 100 })
          .set("Authorization", `Bearer ${token}`);

      async function listed(): Promise<
        Array<{ id: string; filename: string; source: string; title: string | null }>
      > {
        const res = await list();
        expect(res.status).toBe(200);
        return res.body.data.items;
      }

      beforeAll(async () => {
        sqlite = createMigratedSqlite("474-writers");
        db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
        state.db = db;
        await seedUserAndProject(db);
        token = issueTokens({
          userId: USER,
          username: USER,
          role: "admin",
          permissions: [],
          workspaces: [],
        }).accessToken;
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      beforeEach(async () => {
        await db.document.deleteMany({});
        await db.repoConnection.deleteMany({});
        await db.databaseConnection.deleteMany({});
      });

      afterAll(async () => {
        await db?.$disconnect();
        sqlite?.cleanup();
      });

      const confluence = (title: string, body = "page body") =>
        vi
          .fn()
          .mockResolvedValueOnce({
            content: { results: [{ id: "123", title, url: "" }] },
            isError: false,
          })
          .mockResolvedValueOnce({ content: { title, body }, isError: false });

      it("a Confluence page is stored with source and title", async () => {
        await ingestConfluenceSpace({
          projectId: PROJ,
          spaceKey: "DOCS",
          actorId: USER,
          invokeTool: confluence("Release checklist"),
          resolveServer: async () => ({ id: "srv" }),
        });
        expect(await listed()).toMatchObject([
          { filename: "confluence:DOCS:123", source: "confluence", title: "Release checklist" },
        ]);
      });

      it("an unchanged page ingested before #474 gains its title on the next ingest", async () => {
        const args = {
          projectId: PROJ,
          spaceKey: "DOCS",
          actorId: USER,
          resolveServer: async () => ({ id: "srv" }),
        };
        await ingestConfluenceSpace({ ...args, invokeTool: confluence("Runbook") });
        // As the backfill leaves a pre-#474 row: classified, but untitled.
        await db.document.updateMany({ data: { title: null } });
        const second = await ingestConfluenceSpace({ ...args, invokeTool: confluence("Runbook") });
        expect(second.skipped).toBe(1);
        expect(await listed()).toMatchObject([{ source: "confluence", title: "Runbook" }]);
      });

      it("a renamed page's new title replaces the old one on the next ingest", async () => {
        const args = {
          projectId: PROJ,
          spaceKey: "DOCS",
          actorId: USER,
          resolveServer: async () => ({ id: "srv" }),
        };
        await ingestConfluenceSpace({ ...args, invokeTool: confluence("Draft plan") });
        const second = await ingestConfluenceSpace({
          ...args,
          invokeTool: confluence("Final plan", "revised body"),
        });
        expect(second.documentsUpdated).toBe(1);
        expect(await listed()).toMatchObject([{ source: "confluence", title: "Final plan" }]);
      });

      it("a Jira issue never overwrites an upload that shares its filename", async () => {
        await db.document.create({
          data: {
            id: "d-user-upload",
            projectId: PROJ,
            filename: "jira:ABC-1",
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: "user/blob",
            checksum: "user",
            uploadedById: USER,
          },
        });
        const summary = await ingestJiraQuery({
          projectId: PROJ,
          jql: "project=ABC",
          actorId: USER,
          invokeTool: vi
            .fn()
            .mockResolvedValueOnce({
              content: { issues: [{ key: "ABC-1", fields: { summary: "s" } }] },
              isError: false,
            })
            .mockResolvedValueOnce({
              content: { fields: { summary: "s", description: "d" } },
              isError: false,
            }),
          resolveServer: async () => ({ id: "srv" }),
        });
        expect(summary.documentsCreated).toBe(1);
        const rows = await listed();
        expect(rows.map((r) => [r.filename, r.source, r.title]).sort()).toEqual([
          ["jira:ABC-1", "jira", null],
          ["jira:ABC-1", "upload", null],
        ]);
        const upload = await db.document.findUniqueOrThrow({ where: { id: "d-user-upload" } });
        expect(upload.storagePath).toBe("user/blob");
      });

      it("the repository and database connectors stamp their own source", async () => {
        await db.repoConnection.create({ data: { id: "c-repo", projectId: PROJ, label: "r" } });
        await db.databaseConnection.create({
          data: { id: "c-db", projectId: PROJ, label: "d", driver: "postgres" },
        });
        // A user upload sharing the repository README's filename is left alone.
        await db.document.create({
          data: {
            id: "d-user-readme",
            projectId: PROJ,
            filename: "connector:repo:c-repo:README.md",
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: "user/readme",
            checksum: "user",
            uploadedById: USER,
          },
        });
        await ingestRepoMetadata(PROJ, "c-repo", USER, {
          repo: { full_name: "o/r", default_branch: "main", size: 1 },
          languages: {},
          topLevel: [],
          readme: "hi",
          manifests: {},
          headSha: null,
        });
        await ingestDbSchema(PROJ, "c-db", USER, {
          connectorId: "c-db",
          driver: "postgres",
          tables: [{ schema: "public", name: "users", columns: [], foreignKeys: [], indexes: [] }],
        } as never);
        const rows = await listed();
        const sourceOf = (prefix: string) =>
          new Set(rows.filter((r) => r.filename.startsWith(prefix)).map((r) => r.source));
        expect(sourceOf("connector:db:")).toEqual(new Set(["db"]));
        expect(
          rows
            .filter((r) => r.filename === "connector:repo:c-repo:README.md")
            .map((r) => r.source)
            .sort(),
        ).toEqual(["repo", "upload"]);
        const upload = await db.document.findUniqueOrThrow({ where: { id: "d-user-readme" } });
        expect(upload.storagePath).toBe("user/readme");
      });
    });
  },
);
