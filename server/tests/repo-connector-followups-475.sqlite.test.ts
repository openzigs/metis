/**
 * #475 — repo connector follow-ups to #463, proven through the REAL connectors
 * router against a REAL SQLite database built from the migration chain.
 *
 *   1. A live label clash is `409 REPO_LABEL_TAKEN`. (#492 made the label index
 *      partial, so a soft-deleted connector's label is free again: see
 *      repo-connector-followups-492.sqlite.test.ts.)
 *   2. Deleting an upload connector removes its stored `.zip` from the upload
 *      archive root.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import JSZip from "jszip";
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

const { connectorsRouter } = await import("../src/routes/connectors.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const PROJECT = "proj-0475";
const USER = "u-admin-0475";

async function zipBuf(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("src/main.ts", "export const main = 1;\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#475 — repo connector live label clash; archive removed on delete (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let tmp: string;
    let archiveDir: string;
    let ADMIN = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/connectors", connectorsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const base = `/api/projects/${PROJECT}/connectors`;

    beforeAll(async () => {
      tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-475-")));
      archiveDir = path.join(tmp, "archives");
      process.env.UPLOAD_EXTRACT_DIR = path.join(tmp, "extracts");
      process.env.UPLOAD_ARCHIVE_DIR = archiveDir;
      sqlite = createMigratedSqlite("475-repo-followups");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
      // A live repository already exists, so no create below is the project's
      // first and none of them starts a background auto-ingest.
      await db.repoConnection.create({
        data: { projectId: PROJECT, label: "live", isPrimary: true, createdById: USER },
      });
      ADMIN = issueTokens({
        userId: USER,
        username: USER,
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      await fs.rm(tmp, { recursive: true, force: true });
      delete process.env.UPLOAD_EXTRACT_DIR;
      delete process.env.UPLOAD_ARCHIVE_DIR;
    });

    it("still answers 409 for a live label clash", async () => {
      const res = await request(app())
        .post(`${base}/repos`)
        .set("Authorization", `Bearer ${ADMIN}`)
        .send({ label: "live", ownerOrOrg: "octocat", repoName: "demo" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: "REPO_LABEL_TAKEN" });
    });

    it("DELETE on an upload connector removes its stored archive", async () => {
      const created = await request(app())
        .post(`${base}/repos/upload`)
        .set("Authorization", `Bearer ${ADMIN}`)
        .field("label", "dropzone")
        .attach("file", await zipBuf(), { filename: "code.zip", contentType: "application/zip" });
      expect(created.status).toBe(201);
      expect(created.body.data.autoIngestTriggered).toBe(false);
      const id = String(created.body.data.id);
      const row = await db.repoConnection.findUniqueOrThrow({ where: { id } });
      await expect(fs.access(row.uploadPath ?? "")).resolves.toBeUndefined();

      const del = await request(app())
        .delete(`${base}/repos/${id}`)
        .set("Authorization", `Bearer ${ADMIN}`);
      expect(del.status).toBe(204);

      await expect(fs.access(row.uploadPath ?? "")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(archiveDir)).toEqual([]);
      const after = await db.repoConnection.findUniqueOrThrow({ where: { id } });
      expect(after.deletedAt).toBeInstanceOf(Date);
    });
  },
);
