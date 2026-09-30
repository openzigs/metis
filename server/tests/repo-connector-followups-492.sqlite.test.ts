/**
 * #492 — repo connector follow-ups to #475, proven through the REAL connectors
 * router against a REAL SQLite database built from the migration chain.
 *
 *   1. A soft-deleted connector frees its label: `repo_connections_projectId_label_key`
 *      is partial (`WHERE deletedAt IS NULL`), so delete-then-re-add succeeds.
 *   2. A rename onto a label a live connector holds is a 409, not a raw P2002.
 *   3. DELETE removes the archive at the stored `uploadPath` — not at the
 *      current `UPLOAD_ARCHIVE_DIR` — and the connector's extraction directory.
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

const PROJECT = "proj-0492";
const USER = "u-admin-0492";

async function zipBuf(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("src/main.ts", "export const main = 1;\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#492 — label freed on delete; 409 on rename clash; archive removed by stored path (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let tmp: string;
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
    const post = (body: Record<string, unknown>) =>
      request(app()).post(`${base}/repos`).set("Authorization", `Bearer ${ADMIN}`).send(body);
    const del = (id: string) =>
      request(app()).delete(`${base}/repos/${id}`).set("Authorization", `Bearer ${ADMIN}`);
    const patch = (id: string, body: Record<string, unknown>) =>
      request(app())
        .patch(`${base}/repos/${id}`)
        .set("Authorization", `Bearer ${ADMIN}`)
        .send(body);

    beforeAll(async () => {
      tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-492-")));
      process.env.UPLOAD_EXTRACT_DIR = path.join(tmp, "extracts");
      process.env.UPLOAD_ARCHIVE_DIR = path.join(tmp, "archives");
      sqlite = createMigratedSqlite("492-repo-followups");
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

    it("deleting a connector, then creating one with the same label, succeeds", async () => {
      const first = await post({ label: "reused", ownerOrOrg: "octocat", repoName: "demo" });
      expect(first.status).toBe(201);
      expect((await del(String(first.body.data.id))).status).toBe(204);

      const again = await post({ label: "reused", ownerOrOrg: "octocat", repoName: "demo" });
      expect(again.status).toBe(201);
      expect(again.body.data.id).not.toBe(first.body.data.id);
      const rows = await db.repoConnection.findMany({
        where: { projectId: PROJECT, label: "reused" },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.map((r) => r.deletedAt === null)).toEqual([false, true]);
    });

    it("an upload may reuse a deleted connector's label", async () => {
      await db.repoConnection.create({
        data: { projectId: PROJECT, label: "old-drop", deletedAt: new Date(), createdById: USER },
      });
      const res = await request(app())
        .post(`${base}/repos/upload`)
        .set("Authorization", `Bearer ${ADMIN}`)
        .field("label", "old-drop")
        .attach("file", await zipBuf(), { filename: "code.zip", contentType: "application/zip" });
      expect(res.status).toBe(201);
    });

    it("a second live connector under one label is still rejected by the index", async () => {
      await expect(
        db.repoConnection.create({
          data: { projectId: PROJECT, label: "live", createdById: USER },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("renaming a connector to a live connector's label is a 409", async () => {
      const created = await post({ label: "to-rename", ownerOrOrg: "octocat", repoName: "demo" });
      const id = String(created.body.data.id);
      const res = await patch(id, { label: "live" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: "REPO_LABEL_TAKEN" });
      const row = await db.repoConnection.findUniqueOrThrow({ where: { id } });
      expect(row.label).toBe("to-rename");
    });

    it("renaming a connector to a deleted connector's label succeeds", async () => {
      await db.repoConnection.create({
        data: { projectId: PROJECT, label: "retired", deletedAt: new Date(), createdById: USER },
      });
      const created = await post({ label: "renamed-src", ownerOrOrg: "octocat", repoName: "d" });
      const id = String(created.body.data.id);
      const res = await patch(id, { label: "retired" });
      expect(res.status).toBe(200);
      expect((await db.repoConnection.findUniqueOrThrow({ where: { id } })).label).toBe("retired");
    });

    it("renaming a connector to its own label is not a clash", async () => {
      const created = await post({ label: "same", ownerOrOrg: "octocat", repoName: "demo" });
      const res = await patch(String(created.body.data.id), { label: "same" });
      expect(res.status).toBe(200);
    });

    it("DELETE removes the archive at the stored uploadPath and the extraction directory", async () => {
      const created = await request(app())
        .post(`${base}/repos/upload`)
        .set("Authorization", `Bearer ${ADMIN}`)
        .field("label", "moved-root")
        .attach("file", await zipBuf(), { filename: "code.zip", contentType: "application/zip" });
      expect(created.status).toBe(201);
      const id = String(created.body.data.id);
      const row = await db.repoConnection.findUniqueOrThrow({ where: { id } });
      const stored = row.uploadPath ?? "";
      await expect(fs.access(stored)).resolves.toBeUndefined();
      const extraction = path.join(process.env.UPLOAD_EXTRACT_DIR!, id);
      await fs.mkdir(extraction, { recursive: true });
      await fs.writeFile(path.join(extraction, "left.ts"), "x");

      // The archive root moves after the connector was created (a config
      // change, or another replica with its own directory).
      const movedRoot = path.join(tmp, "archives-moved");
      process.env.UPLOAD_ARCHIVE_DIR = movedRoot;
      try {
        expect((await del(id)).status).toBe(204);
      } finally {
        process.env.UPLOAD_ARCHIVE_DIR = path.join(tmp, "archives");
      }

      await expect(fs.access(stored)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(extraction)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
