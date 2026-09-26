/**
 * #190 — the generated-document detail payload carries the content ONCE plus
 * summary metadata; version bodies, provenance manifests and changed symbols
 * each have their own endpoint.
 *
 * Real SQLite, real JWTs and the real `requireProjectAccess` membership check,
 * so the access assertions exercise the same path production does. Every
 * assertion reads back through the HTTP route a consumer uses.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import { isolateSupertestLoopback } from "./helpers/supertest-loopback.js";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";
import { issueTokens } from "../src/lib/auth/jwt.js";

const state = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../src/lib/prisma.js", async () => ({
  Prisma: (await import("@prisma/client")).Prisma,
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// #196 — count manifest parses without changing what they return.
const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/lib/docs-gen/generated-doc-provenance.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/docs-gen/generated-doc-provenance.js")>();
  return {
    ...actual,
    parseGeneratedDocVersionManifest: (raw: unknown) => {
      parses.count += 1;
      return actual.parseGeneratedDocVersionManifest(raw);
    },
  };
});

import { generatedDocsRouter } from "../src/routes/generated-docs.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import {
  generatedDocRevisionId,
  legacyGeneratedDocVersionManifest,
} from "../src/lib/docs-gen/generated-doc-provenance.js";
import { createApp } from "../src/app.js";
import { clearGeneratedDocVersionReadCaches } from "../src/lib/docs-gen/generated-doc-version-reads.js";
import { generatedDocSyntheticDocumentId } from "../src/lib/docs-gen/generated-doc-publication.js";
import { generatedDocOutboxId } from "../src/lib/docs-gen/generated-doc-outbox.js";

/**
 * #196 — the `select` of every `generatedDocumentVersion.findFirst` the routes
 * issue, so a test can see which heavy columns a request actually read.
 */
function recordingVersionReads(client: PrismaClient, reads: Array<Record<string, unknown>>) {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop !== "generatedDocumentVersion") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      const delegate = value as PrismaClient["generatedDocumentVersion"];
      return new Proxy(delegate, {
        get(model, method) {
          const fn = Reflect.get(model, method, model) as unknown;
          if (method !== "findFirst" || typeof fn !== "function") return fn;
          return (args: { select?: Record<string, unknown> }) => {
            reads.push(args?.select ?? {});
            return (fn as (a: unknown) => unknown).call(model, args);
          };
        },
      });
    },
  });
}

/** A ~600k-character body shaped like a full-coverage document (#184). */
function largeMarkdown(targetChars: number): string {
  const parts: string[] = ["# Business Requirements\n"];
  let n = 0;
  while (parts.join("\n").length < targetChars) {
    n += 1;
    if (n % 25 === 1) parts.push(`## Area ${n}\n`);
    parts.push(
      `### Rule ${n}\n\nThe system applies rule ${n} when a record changes. `.repeat(8) +
        "\n\n| Field | Meaning |\n|---|---|\n| a | b |\n",
    );
  }
  return parts.join("\n");
}

describe.runIf(readGeneratedClientProvider() === "sqlite")(
  "#190 generated-doc detail payload and per-version endpoints",
  () => {
    let db: PrismaClient;
    let directory: string;
    const router = express();
    router.use("/projects/:projectId/docs", generatedDocsRouter());
    router.use(errorHandler);

    const CONTENT = largeMarkdown(600_000);
    // Heavy per-version fields at the measured proportions (manifest ≈ 28×,
    // changed symbols ≈ 13.6× the content) scaled down to keep the suite fast.
    const SECTIONS = Array.from({ length: 6_000 }, (_, i) => ({
      sectionSlug: `section-${i}`,
      sectionLabel: `Section ${i}`,
      sectionIndex: i,
      providerKind: "local" as const,
      model: "test-model",
      factsSourceIds: Array.from({ length: 8 }, (_, j) => `facts:module-${i}-${j}`),
      groundingSourceIds: Array.from({ length: 8 }, (_, j) => `chunk:module-${i}-${j}`),
    }));
    const versionReads: Array<Record<string, unknown>> = [];
    const heavyReads = (column: "provenanceManifest" | "changedSymbols") =>
      versionReads.filter((select) => select[column]).length;
    const SYMBOLS = Array.from({ length: 40_000 }, (_, i) => `pkg.module.Symbol${i}.method`);

    function authorization(userId = "member", role: RoleKey = "reader", workspaces = ["ws"]) {
      return `Bearer ${
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: getPermissionsForRole(role),
          workspaces,
        }).accessToken
      }`;
    }
    const get = (path: string, user?: string) =>
      request(router)
        .get(path)
        .set(
          "Authorization",
          user === "outsider"
            ? authorization("outsider", "coordinator", ["other"])
            : authorization(),
        );

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "metis-doc-detail-"));
      db = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: `file:${join(directory, "test.db")}` }),
      });
      state.db = recordingVersionReads(db, versionReads);
      for (const sql of [
        `CREATE TABLE projects (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL)`,
        `CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, status TEXT DEFAULT 'active', deletedAt DATETIME, authRolesInitializedAt DATETIME DEFAULT CURRENT_TIMESTAMP, authRoleAuthority TEXT DEFAULT 'explicit')`,
        `CREATE TABLE roles (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', isSystem BOOLEAN DEFAULT true, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE user_roles (userId TEXT REFERENCES users(id), roleId TEXT REFERENCES roles(id), source TEXT DEFAULT 'local', assignedAt DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(userId,roleId))`,
        `CREATE TABLE workspace_members (id TEXT PRIMARY KEY, userId TEXT REFERENCES users(id), workspaceId TEXT NOT NULL, role TEXT DEFAULT 'member', joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(workspaceId,userId))`,
        `CREATE TABLE generated_documents (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL, scope TEXT DEFAULT 'full', scopeFilter TEXT DEFAULT '{}', evidencePolicy TEXT, content TEXT DEFAULT '', codeGraphHash TEXT, schemaGraph TEXT, status TEXT DEFAULT 'pending', errorMessage TEXT, warnings JSONB, autoUpdate BOOLEAN DEFAULT true, generatedAt DATETIME, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL, deletedAt DATETIME)`,
        `CREATE TABLE generated_document_versions (id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES generated_documents(id), version INTEGER NOT NULL, revisionId TEXT, provenanceManifest TEXT, content TEXT NOT NULL, diffSummary TEXT, changedSymbols TEXT DEFAULT '[]', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(documentId,version))`,
        `CREATE TABLE tasks (id TEXT PRIMARY KEY, scheduledJobId TEXT, projectId TEXT, type TEXT NOT NULL, trigger TEXT DEFAULT 'manual', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 5, payload TEXT DEFAULT '{}', result TEXT, errorMessage TEXT, progress INTEGER, attempts INTEGER DEFAULT 0, maxAttempts INTEGER DEFAULT 3, scheduledFor DATETIME, startedAt DATETIME, completedAt DATETIME, createdById TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`,
        `CREATE TABLE documents (id TEXT PRIMARY KEY, projectId TEXT, filename TEXT, mimeType TEXT, sizeBytes INTEGER, storagePath TEXT, checksum TEXT, status TEXT DEFAULT 'pending', indexState TEXT DEFAULT 'pending', autoApproveTrusted BOOLEAN DEFAULT false, aclSubjects TEXT DEFAULT '[]', isSpec BOOLEAN DEFAULT false, errorMessage TEXT, chunkCount INTEGER DEFAULT 0, uploadedById TEXT, uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP, processedAt DATETIME, deletedAt DATETIME)`,
      ])
        await db.$executeRawUnsafe(sql);
      await db.$executeRaw`INSERT INTO projects (id, workspaceId) VALUES ('project', 'ws'), ('foreign', 'other')`;
      await db.$executeRaw`INSERT INTO roles (id, key, name) VALUES ('reader', 'reader', 'Reader'), ('coordinator', 'coordinator', 'Coordinator')`;
      for (const [userId, role, workspaceId] of [
        ["member", "reader", "ws"],
        ["outsider", "coordinator", "other"],
      ]) {
        await db.$executeRaw`INSERT INTO users (id, username) VALUES (${userId}, ${userId})`;
        await db.$executeRaw`INSERT INTO user_roles (userId, roleId) VALUES (${userId}, ${role})`;
        await db.$executeRaw`INSERT INTO workspace_members (id, userId, workspaceId) VALUES (${userId}, ${userId}, ${workspaceId})`;
      }
    });

    beforeEach(async () => {
      vi.restoreAllMocks();
      isolateSupertestLoopback();
      clearGeneratedDocVersionReadCaches();
      for (const table of ["generated_document_versions", "generated_documents"])
        await db.$executeRawUnsafe(`DELETE FROM ${table}`);
      await db.generatedDocument.create({
        data: {
          id: "doc",
          projectId: "project",
          title: "Large",
          scope: "full",
          evidencePolicy: JSON.stringify({ actor: { userId: "member" } }),
          schemaGraph: JSON.stringify({ tables: ["t".repeat(50_000)] }),
          content: CONTENT,
          status: "ready",
        },
      });
      for (const version of [1, 2, 3]) {
        const manifest = legacyGeneratedDocVersionManifest({
          projectId: "project",
          generatedDocumentId: "doc",
          version,
        });
        await db.generatedDocumentVersion.create({
          data: {
            id: `v${version}`,
            documentId: "doc",
            version,
            revisionId:
              version === 1
                ? null
                : generatedDocRevisionId({
                    projectId: "project",
                    generatedDocumentId: "doc",
                    version,
                  }),
            // A valid manifest, made realistically heavy by its section list.
            provenanceManifest: JSON.stringify({ ...manifest, sections: SECTIONS }),
            content: version === 3 ? CONTENT : `# Version ${version}\n\nOlder body ${version}.`,
            diffSummary: version === 1 ? null : `Change ${version}`,
            changedSymbols: JSON.stringify(SYMBOLS),
          },
        });
      }
      // A second document in the same project, and one in a foreign project.
      await db.generatedDocument.create({
        data: { id: "sibling", projectId: "project", title: "Sibling", content: "# S" },
      });
      await db.generatedDocumentVersion.create({
        data: { id: "sibling-v1", documentId: "sibling", version: 1, content: "# Sibling v1" },
      });
      await db.generatedDocument.create({
        data: { id: "alien", projectId: "foreign", title: "Alien", content: "# A" },
      });
      await db.generatedDocumentVersion.create({
        data: { id: "alien-v1", documentId: "alien", version: 1, content: "# Alien v1" },
      });
    });

    afterAll(async () => {
      await db?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("detail carries the content once and stays within 1.5x of it", async () => {
      const res = await get("/projects/project/docs/doc");
      expect(res.status).toBe(200);
      const bytes = Buffer.byteLength(res.text);
      expect(bytes).toBeLessThanOrEqual(1.5 * CONTENT.length);
      expect(res.body.data.content).toBe(CONTENT);
      expect(res.body.data.contentLength).toBe(CONTENT.length);
      // The content appears exactly once in the serialized body.
      const needle = JSON.stringify(CONTENT.slice(0, 2_000)).slice(1, -1);
      expect(res.text.split(needle).length - 1).toBe(1);
      for (const heavy of ["evidencePolicy", "schemaGraph", "codeGraphHash", "deletedAt"])
        expect(res.body.data).not.toHaveProperty(heavy);
      expect(res.body.data.versions).toHaveLength(3);
      for (const version of res.body.data.versions as Array<Record<string, unknown>>) {
        expect(Object.keys(version).sort()).toEqual(
          ["createdAt", "diffSummary", "id", "revisionId", "version"].sort(),
        );
      }
    });

    it("detail keeps summary metadata: title, status, scope, versions and revision ids", async () => {
      const res = await get("/projects/project/docs/doc");
      expect(res.body.data).toMatchObject({
        id: "doc",
        title: "Large",
        status: "ready",
        scope: "full",
        interrupted: false,
        warnings: null,
      });
      expect(
        (res.body.data.versions as Array<{ version: number; revisionId: string }>).map((v) => [
          v.version,
          v.revisionId,
        ]),
      ).toEqual([
        [3, "gendoc:project:doc:v3"],
        [2, "gendoc:project:doc:v2"],
        // A null stored revisionId still reports the manifest's revision id.
        [1, "gendoc:project:doc:v1"],
      ]);
    });

    it("serves one version's body on demand", async () => {
      const res = await get("/projects/project/docs/doc/versions/v1");
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: "v1",
        version: 1,
        revisionId: "gendoc:project:doc:v1",
        diffSummary: null,
        content: "# Version 1\n\nOlder body 1.",
      });
      expect(res.body.data).not.toHaveProperty("provenanceManifest");
      expect(res.body.data).not.toHaveProperty("changedSymbols");
    });

    it("serves the provenance manifest on demand", async () => {
      const res = await get("/projects/project/docs/doc/versions/v3/provenance");
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        revision: { revisionId: "gendoc:project:doc:v3", version: 3 },
        legacy: { historicalCitations: "legacy-unknown" },
      });
      expect(res.body.data.sections).toHaveLength(SECTIONS.length);
    });

    it("says a manifest it cannot read is unreadable, without echoing it", async () => {
      await db.generatedDocumentVersion.update({
        where: { id: "v2" },
        data: { provenanceManifest: JSON.stringify({ secret: "unexpected-key-value" }) },
      });
      const res = await get("/projects/project/docs/doc/versions/v2/provenance");
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("PROVENANCE_CORRUPT");
      expect(res.text).not.toContain("unexpected-key-value");
    });

    it("serves a legacy manifest for a version that never stored one", async () => {
      const res = await get("/projects/project/docs/sibling/versions/sibling-v1/provenance");
      expect(res.status).toBe(200);
      expect(res.body.data.revision).toMatchObject({
        revisionId: "gendoc:project:sibling:v1",
        generatedDocumentId: "sibling",
      });
    });

    it("pages changed symbols and reports the total", async () => {
      const first = await get("/projects/project/docs/doc/versions/v2/changed-symbols");
      expect(first.status).toBe(200);
      expect(first.body.data.total).toBe(SYMBOLS.length);
      expect(first.body.data.offset).toBe(0);
      expect(first.body.data.items).toEqual(SYMBOLS.slice(0, 500));

      const later = await get(
        "/projects/project/docs/doc/versions/v2/changed-symbols?offset=39990&limit=50",
      );
      expect(later.body.data.items).toEqual(SYMBOLS.slice(39_990));

      const bad = await get("/projects/project/docs/doc/versions/v2/changed-symbols?limit=0");
      expect(bad.status).toBe(400);
    });

    it("reports unreadable changed symbols instead of guessing", async () => {
      await db.generatedDocumentVersion.update({
        where: { id: "v2" },
        data: { changedSymbols: "{not json" },
      });
      const res = await get("/projects/project/docs/doc/versions/v2/changed-symbols");
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("CHANGED_SYMBOLS_CORRUPT");
    });

    it.each([
      ["detail", "/projects/project/docs/doc"],
      ["version body", "/projects/project/docs/doc/versions/v3"],
      ["provenance", "/projects/project/docs/doc/versions/v3/provenance"],
      ["changed symbols", "/projects/project/docs/doc/versions/v3/changed-symbols"],
    ])("a non-member gets 404 for the %s, exactly as for the detail route", async (_, path) => {
      const res = await get(path, "outsider");
      expect(res.status).toBe(404);
      expect(res.text).not.toContain("Version");
      expect(res.text).not.toContain("pkg.module");
    });

    it.each([
      [
        "a version of another document in the project",
        "/projects/project/docs/doc/versions/sibling-v1",
      ],
      [
        "a version of a document in another project",
        "/projects/project/docs/alien/versions/alien-v1",
      ],
      [
        "another project's version under this document",
        "/projects/project/docs/doc/versions/alien-v1",
      ],
      ["an unknown version", "/projects/project/docs/doc/versions/nope/provenance"],
    ])("404s for %s", async (_, path) => {
      const res = await get(path);
      expect(res.status).toBe(404);
    });

    it("404s every per-version endpoint once the document is deleted", async () => {
      await db.generatedDocument.update({ where: { id: "doc" }, data: { deletedAt: new Date() } });
      for (const suffix of ["", "/provenance", "/changed-symbols"])
        expect((await get(`/projects/project/docs/doc/versions/v3${suffix}`)).status).toBe(404);
    });

    it("the real app gzip-compresses the detail and provenance responses", async () => {
      const app = createApp({ disableRateLimit: true });
      for (const path of [
        "/api/projects/project/docs/doc",
        "/api/projects/project/docs/doc/versions/v3/provenance",
      ]) {
        const res = await request(app)
          .get(path)
          .set("Authorization", authorization())
          .set("Accept-Encoding", "gzip");
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBe("gzip");
      }
    });

    describe("#196 follow-ups", () => {
      beforeEach(() => {
        versionReads.length = 0;
        parses.count = 0;
      });
      afterEach(async () => {
        for (const table of ["documents", "tasks"])
          await db.$executeRawUnsafe(`DELETE FROM ${table}`);
      });

      it("serves a provenance summary without the manifest body", async () => {
        const res = await get("/projects/project/docs/doc/versions/v3/provenance/summary");
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
          revisionId: "gendoc:project:doc:v3",
          version: 3,
          generatedAt: new Date(0).toISOString(),
          pipeline: "holistic",
          models: { phase1: "unknown", phase2: "unknown" },
          sectionCount: SECTIONS.length,
          selectedEvidenceCount: 0,
          sourceCount: 0,
          historicalCitations: { status: "unknown", mode: "legacy-unknown" },
          legacy: { historicalCitations: "legacy-unknown" },
        });
        // The full manifest for this version is ~2 MB; the summary is tiny.
        expect(Buffer.byteLength(res.text)).toBeLessThan(1_000);
        expect(res.text).not.toContain("facts:module-");
      });

      it("parses a version's manifest once, however often its summary is read", async () => {
        for (let i = 0; i < 3; i += 1) {
          const res = await get("/projects/project/docs/doc/versions/v2/provenance/summary");
          expect(res.body.data.sectionCount).toBe(SECTIONS.length);
        }
        expect(parses.count).toBe(1);
        expect(heavyReads("provenanceManifest")).toBe(1);
      });

      it("summarises the legacy manifest for a version that never stored one", async () => {
        const res = await get(
          "/projects/project/docs/sibling/versions/sibling-v1/provenance/summary",
        );
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
          revisionId: "gendoc:project:sibling:v1",
          sectionCount: 0,
          legacy: { historicalCitations: "legacy-unknown" },
        });
      });

      it("says a summary it cannot read is unreadable, without echoing it", async () => {
        await db.generatedDocumentVersion.update({
          where: { id: "v2" },
          data: { provenanceManifest: JSON.stringify({ secret: "unexpected-key-value" }) },
        });
        const res = await get("/projects/project/docs/doc/versions/v2/provenance/summary");
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe("PROVENANCE_CORRUPT");
        expect(res.text).not.toContain("unexpected-key-value");
      });

      it.each([
        ["a non-member", "/projects/project/docs/doc/versions/v3/provenance/summary", "outsider"],
        [
          "another project's version",
          "/projects/project/docs/doc/versions/alien-v1/provenance/summary",
          undefined,
        ],
        [
          "a sibling document's version",
          "/projects/project/docs/doc/versions/sibling-v1/provenance/summary",
          undefined,
        ],
      ])("the provenance summary 404s for %s", async (_, path, user) => {
        const res = await get(path, user);
        expect(res.status).toBe(404);
        expect(res.text).not.toContain("gendoc:");
      });

      it("404s the provenance summary once the document is deleted", async () => {
        await db.generatedDocument.update({
          where: { id: "doc" },
          data: { deletedAt: new Date() },
        });
        const res = await get("/projects/project/docs/doc/versions/v3/provenance/summary");
        expect(res.status).toBe(404);
      });

      it("the detail's legacy-index path reads each manifest once, not on every request", async () => {
        // No publication outbox and no synthetic index document: the detail
        // must consult v3's manifest for the legacy-index fallback, and v1's
        // for its null revision id.
        for (let i = 0; i < 3; i += 1) {
          const res = await get("/projects/project/docs/doc");
          expect(res.status).toBe(200);
          expect(res.body.data.versions.map((v: { revisionId: string }) => v.revisionId)).toEqual([
            "gendoc:project:doc:v3",
            "gendoc:project:doc:v2",
            "gendoc:project:doc:v1",
          ]);
        }
        expect(heavyReads("provenanceManifest")).toBe(2);
        expect(parses.count).toBe(2);
      });

      it("the list's legacy-index check does not load every document's manifest", async () => {
        for (let i = 0; i < 3; i += 1) {
          const res = await get("/projects/project/docs");
          expect(res.status).toBe(200);
          expect(res.body.data).toHaveLength(2);
        }
        // doc's latest version (v3) is read once; sibling-v1 stores none.
        expect(parses.count).toBe(1);
      });

      /** A healthy index row under the pre-revision (legacy) shared id. */
      async function legacyIndexRow() {
        await db.$executeRaw`INSERT INTO documents (id, projectId, indexState, status, chunkCount) VALUES (${generatedDocSyntheticDocumentId("doc")}, 'project', 'indexed', 'ready', 9)`;
      }

      it("uses the legacy index only for a version whose manifest says legacy", async () => {
        await legacyIndexRow();
        const detail = await get("/projects/project/docs/doc");
        expect(detail.body.data.indexing).toMatchObject({ state: "indexed", chunkCount: 9 });
        const list = await get("/projects/project/docs");
        const doc = list.body.data.find((d: { id: string }) => d.id === "doc");
        expect(doc.indexing).toMatchObject({ state: "indexed", chunkCount: 9 });
      });

      it("never treats an unreadable manifest as evidence of a legacy publication", async () => {
        await legacyIndexRow();
        await db.generatedDocumentVersion.update({
          where: { id: "v3" },
          data: { provenanceManifest: JSON.stringify({ secret: "unexpected-key-value" }) },
        });
        const detail = await get("/projects/project/docs/doc");
        expect(detail.status).toBe(200);
        expect(detail.body.data.indexing).toMatchObject({ state: "pending", chunkCount: 0 });
        const list = await get("/projects/project/docs");
        const doc = list.body.data.find((d: { id: string }) => d.id === "doc");
        expect(doc.indexing).toMatchObject({ state: "pending", chunkCount: 0 });
      });

      it("does not read the manifest at all once a publication outbox exists", async () => {
        await legacyIndexRow();
        const outboxId = generatedDocOutboxId({
          projectId: "project",
          generatedDocumentId: "doc",
          version: 3,
          revisionId: "gendoc:project:doc:v3",
        });
        await db.$executeRaw`INSERT INTO tasks (id, projectId, type, status, updatedAt) VALUES (${outboxId}, 'project', 'generated-doc-publication', 'running', CURRENT_TIMESTAMP)`;
        const detail = await get("/projects/project/docs/doc");
        expect(detail.body.data.indexing).toMatchObject({ state: "pending", status: "processing" });
        // Only v1's manifest (for its null revision id); never v3's.
        expect(parses.count).toBe(1);
      });

      it("parses stored changed symbols once per version while paging", async () => {
        const pages = [];
        for (const offset of [0, 500, 1_000, 39_990]) {
          const res = await get(
            `/projects/project/docs/doc/versions/v2/changed-symbols?offset=${offset}&limit=500`,
          );
          expect(res.status).toBe(200);
          expect(res.body.data.total).toBe(SYMBOLS.length);
          pages.push(...res.body.data.items);
        }
        expect(pages).toEqual([...SYMBOLS.slice(0, 1_500), ...SYMBOLS.slice(39_990)]);
        expect(heavyReads("changedSymbols")).toBe(1);
      });

      it("the real app serves Brotli to a client that accepts it", async () => {
        const app = createApp({ disableRateLimit: true });
        const res = await request(app)
          .get("/api/projects/project/docs/doc")
          .set("Authorization", authorization())
          .set("Accept-Encoding", "br, gzip");
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBe("br");
        expect(res.body.data.content).toBe(CONTENT);
      });
    });
  },
);
