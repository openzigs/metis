/**
 * Issue #525 — since #474 an upload named like a connector document persists
 * next to the real connector row, so nothing may classify it by its filename.
 *
 * REAL SQLite built from the real migration chain: the readers' queries only
 * mean something against the `documents.source` column as shipped, and the
 * generated-row correction only against the #474 backfill it corrects.
 *
 * - The upload routes refuse a connector-reserved filename (400).
 * - Every reader that holds a document row classifies on `source`: the
 *   analysis capability probe, the analysis default document set and the
 *   docs-generation evidence gate.
 * - The migration reclassifies generated rows by their `gendoc-` id.
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
  return { db: null as unknown, writes: 0 };
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
// The real evidence gate, wrapped so a test can read the rows the generation
// inventory's own query returned: the gate drops a connector-named upload too,
// so the snapshot alone would not show whether the query excluded it.
vi.mock("../src/lib/docs-gen/evidence-filter.js", async (original) => {
  const real = await original<typeof import("../src/lib/docs-gen/evidence-filter.js")>();
  return { ...real, filterPrimaryEvidence: vi.fn(real.filterPrimaryEvidence) };
});

const { documentsRouter } = await import("../src/routes/documents.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { detectStaticCapability } = await import("../src/lib/analysis/analysis-capability.js");
const { defaultAnalysisDocumentIds } = await import("../src/lib/analysis/orchestrator.js");
const { filterPrimaryEvidence } = await import("../src/lib/docs-gen/evidence-filter.js");
const { captureGenerationInputs } = await import("../src/lib/docs-gen/generation-inputs.js");

const MIGRATION = "20261006000525_issue525_generated_source_by_id";
const PROJ = "proj-source-000525";
const USER = "u-525";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#525 — classify on documents.source, never a connector-shaped filename (real SQLite)",
  () => {
    describe("the migration classifies generated rows by their synthetic id", () => {
      let sqlite: MigratedSqlite;
      let db: PrismaClient;

      beforeAll(() => {
        sqlite = createMigratedSqlite("525-backfill", { stopBefore: MIGRATION });
        sqlite.exec(
          `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
           VALUES (?, ?, 'A', 'a525@example.test', 0, 0)`,
          [USER, USER],
        );
        sqlite.exec(
          `INSERT INTO projects (id, name, slug, description, createdById, createdAt, updatedAt)
           VALUES (?, ?, ?, '', ?, 0, 0)`,
          [PROJ, PROJ, PROJ, USER],
        );
        // [id, filename, source as #474's filename backfill left it]
        const rows: Array<[string, string, string]> = [
          ["gendoc-g1", "generated-doc-g1.md", "generated"],
          ["gendoc-g2:rev-2", "generated-doc-g2.md", "generated"],
          // A markdown upload #474 misfiled by its `generated-doc-` filename.
          ["cupload1", "generated-doc-notes.md", "generated"],
          // A generated row #474 missed (its filename is not the usual shape).
          ["gendoc-g3", "renamed.md", "upload"],
          // `gendoc` without the dash, and the prefix in the wrong case.
          ["gendocx", "x.md", "upload"],
          ["GENDOC-y", "y.md", "upload"],
          ["crepo", "connector:repo:c1:README.md", "repo"],
          ["cjira", "jira:ABC-1", "jira"],
        ];
        for (const [id, filename, source] of rows) {
          sqlite.exec(
            `INSERT INTO documents (id, projectId, filename, source, mimeType, sizeBytes,
               storagePath, checksum, uploadedById, uploadedAt)
             VALUES (?, ?, ?, ?, 'text/markdown', 1, 'p', 'c', ?, 0)`,
            [id, PROJ, filename, source, USER],
          );
        }
        sqlite.apply(MIGRATION);
        db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      afterAll(async () => {
        await db?.$disconnect();
        sqlite?.cleanup();
      });

      it("a row is generated exactly when its id starts with gendoc-", async () => {
        const rows = await db.document.findMany({ select: { id: true, source: true } });
        expect(Object.fromEntries(rows.map((r) => [r.id, r.source]))).toEqual({
          "gendoc-g1": "generated",
          "gendoc-g2:rev-2": "generated",
          cupload1: "upload",
          "gendoc-g3": "generated",
          gendocx: "upload",
          "GENDOC-y": "upload",
          crepo: "repo",
          cjira: "jira",
        });
      });
    });

    describe("readers and the upload routes", () => {
      let sqlite: MigratedSqlite;
      let db: PrismaClient;
      let token = "";

      const app = () =>
        express()
          .use(express.json())
          .use(
            "/api/projects/:projectId/documents",
            documentsRouter({
              storage: {
                write: async ({ buffer }: { buffer: Buffer }) => {
                  state.writes += 1;
                  return {
                    storagePath: `blob/${state.writes}`,
                    checksum: `sha-${state.writes}`,
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

      const doc = (
        id: string,
        filename: string,
        source: string,
        extra: { deletedAt?: Date } = {},
      ) =>
        db.document.create({
          data: {
            id,
            projectId: PROJ,
            filename,
            source,
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: `blob/${id}`,
            checksum: id,
            uploadedById: USER,
            status: "ready",
            indexState: "indexed",
            ...extra,
          },
        });

      beforeAll(async () => {
        sqlite = createMigratedSqlite("525-readers");
        db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
        state.db = db;
        await db.user.create({
          data: { id: USER, username: USER, displayName: "A", email: "a525@example.test" },
        });
        await db.project.create({
          data: { id: PROJ, name: PROJ, slug: PROJ, description: "", createdById: USER },
        });
        token = issueTokens({
          userId: USER,
          username: USER,
          role: "admin",
          permissions: [],
          workspaces: [],
        }).accessToken;
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      beforeEach(async () => {
        await db.knowledgeChunk.deleteMany({});
        await db.document.deleteMany({});
      });

      afterAll(async () => {
        await db?.$disconnect();
        sqlite?.cleanup();
      });

      // Slash-free: the upload keeps only a path's basename, so
      // `connector:repo:c1:src/auth.ts` is stored as `auth.ts` already.
      it.each([
        "connector:repo:c1:README.md",
        "connector:db:c2:public.users.md",
        "jira:ABC-1",
        "confluence:DOCS:123",
        "repo:c1:README.md",
        "generated-doc-abc.md",
        "live-schema:proj-1",
        "live-schema:x",
        "connector:repo:x",
        // `doc-label.ts` matches `generated-doc-` with `/i`, so every case is reserved.
        "Generated-Doc-x.md",
        "GENERATED-DOC-abc.md",
        "  jira:ABC-1",
      ])("the text upload refuses the reserved filename %j with a 400", async (filename) => {
        const res = await request(app())
          .post(`/api/projects/${PROJ}/documents/text`)
          .set("Authorization", `Bearer ${token}`)
          .send({ filename, content: "hello", mimeType: "text/markdown" });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("RESERVED_FILENAME");
        expect(await db.document.count()).toBe(0);
      });

      it("the file upload refuses a reserved filename with a 400", async () => {
        const res = await request(app())
          .post(`/api/projects/${PROJ}/documents`)
          .set("Authorization", `Bearer ${token}`)
          .attach("file", Buffer.from("hello"), {
            filename: "connector:repo:c1:README.md",
            contentType: "text/plain",
          });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("RESERVED_FILENAME");
        expect(await db.document.count()).toBe(0);
      });

      // Every reader of these prefixes matches case-sensitively, so a pasted
      // title that only looks like one is an ordinary upload.
      it.each([
        "Jira: sprint 12 retro.md",
        "Confluence: onboarding.md",
        "Repo: notes.md",
        "Live-Schema:proj-1.md",
        "JIRA:ABC-1",
        "Connector:repo:c1:README.md",
      ])("the text upload accepts the non-reserved-case filename %j", async (filename) => {
        const res = await request(app())
          .post(`/api/projects/${PROJ}/documents/text`)
          .set("Authorization", `Bearer ${token}`)
          .send({ filename, content: "hello", mimeType: "text/markdown" });
        expect(res.status).toBe(201);
        const rows = await db.document.findMany({ select: { filename: true, source: true } });
        expect(rows).toEqual([{ filename, source: "upload" }]);
      });

      it("an ordinary filename that merely mentions a prefix is still accepted", async () => {
        const res = await request(app())
          .post(`/api/projects/${PROJ}/documents/text`)
          .set("Authorization", `Bearer ${token}`)
          .send({ filename: "notes on jira:ABC-1.md", content: "hello" });
        expect(res.status).toBe(201);
        const rows = await db.document.findMany({ select: { filename: true, source: true } });
        expect(rows).toEqual([{ filename: "notes on jira:ABC-1.md", source: "upload" }]);
      });

      it("the capability probe reports repository source only for a repository row", async () => {
        await doc("d-upload", "connector:repo:c1:src/auth.ts", "upload");
        expect((await detectStaticCapability(PROJ)).repoSourceIngested).toBe(false);
        await doc("d-repo", "connector:repo:c1:src/auth.ts", "repo");
        expect((await detectStaticCapability(PROJ)).repoSourceIngested).toBe(true);
      });

      it("the analysis default set keeps connector-named uploads and drops connector rows", async () => {
        await doc("d-upload-repo", "connector:repo:c1:src/auth.ts", "upload");
        await doc("d-upload-db", "connector:db:c2:public.users.md", "upload");
        await doc("d-repo", "connector:repo:c1:src/auth.ts", "repo");
        await doc("d-db", "connector:db:c2:public.users.md", "db");
        await doc("d-jira", "jira:ABC-1", "jira");
        await doc("d-gone", "spec.md", "upload", { deletedAt: new Date() });
        expect((await defaultAnalysisDocumentIds(PROJ)).sort()).toEqual([
          "d-jira",
          "d-upload-db",
          "d-upload-repo",
        ]);
      });

      it("the evidence gate scopes an upload named like repository source as an upload", async () => {
        await doc("d-upload", "connector:repo:c1:src/auth.ts", "upload");
        await doc("d-repo", "connector:repo:c1:src/auth.ts", "repo");
        for (const documentId of ["d-upload", "d-repo"]) {
          await db.knowledgeChunk.create({
            data: {
              id: `k-${documentId}`,
              projectId: PROJ,
              documentId,
              position: 0,
              text: `text of ${documentId}`,
              md5: documentId,
            },
          });
        }
        const candidates = ["d-upload", "d-repo"].map((documentId) => ({
          chunkId: `k-${documentId}`,
          documentId,
          filename: "connector:repo:c1:src/auth.ts",
          text: "dense",
        }));
        const policy = {
          projectId: PROJ,
          generatedDocumentId: "g",
          actor: { userId: USER, role: "admin" as const },
          repoConnectorId: "c1",
          codeGraphId: "graph",
          sharedDocumentIds: [] as string[],
          allowWebResearch: false,
        };
        const ids = async (shared: string[]) =>
          (await filterPrimaryEvidence(candidates, { ...policy, sharedDocumentIds: shared })).map(
            (c) => c.documentId,
          );
        expect(await ids([])).toEqual(["d-repo"]);
        expect(await ids(["d-upload"])).toEqual(["d-upload", "d-repo"]);
      });

      it("the generation inventory query reads a repository row, never an upload named like one", async () => {
        const filename = "connector:repo:c1:src/auth.ts";
        await doc("d-upload", filename, "upload");
        await doc("d-repo", filename, "repo");
        for (const documentId of ["d-upload", "d-repo"]) {
          await db.knowledgeChunk.create({
            data: {
              id: `k-${documentId}`,
              projectId: PROJ,
              documentId,
              position: 0,
              text: `text of ${documentId}`,
              md5: documentId,
            },
          });
        }
        const gate = vi.mocked(filterPrimaryEvidence);
        gate.mockClear();
        await captureGenerationInputs(
          {
            projectId: PROJ,
            title: "Doc",
            scope: "project",
            scopeFilter: "{}",
            evidencePolicy: null,
          },
          {
            projectId: PROJ,
            generatedDocumentId: "g",
            actor: { userId: USER, role: "admin" },
            repoConnectorId: "c1",
            codeGraphId: "graph",
            sharedDocumentIds: [],
            allowWebResearch: false,
          },
        );
        expect(gate).toHaveBeenCalledTimes(1);
        expect(gate.mock.calls[0][0].map((c) => c.documentId)).toEqual(["d-repo"]);
      });
    });
  },
);
