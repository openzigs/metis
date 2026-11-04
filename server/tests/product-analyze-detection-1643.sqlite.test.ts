/**
 * #1643 — `POST /api/products/:id/analyze` runs edge detection (#1619) over each
 * repo's connector clone before it generates the documents, on a real SQLite
 * database built by the migration chain, with a temp-dir clone per repo.
 *
 * The product holds three repos of project A:
 *   - writer: a clone of the shared-table `order-writer` fixture, plus a
 *     symlinked file and a symlinked directory pointing OUTSIDE the clone at
 *     SQL that writes a `secrets` table;
 *   - reader: a clone of the `report-reader` fixture, plus SQL that reads
 *     `secrets` — so a followed symlink would show up as a second shared table;
 *   - legacy: no clone at all, with an edge an earlier run stored.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";
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
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { productsRouter } = await import("../src/routes/products-multi.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "products",
  "shared-table",
);
const WS = "ws-1643";
const PA = "proj-a-1643";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1643 — /analyze detects edges from each repo's clone",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let tmp: string;
    const originalCloneDir = process.env.REPO_CLONE_DIR;
    const rc: Record<string, string> = {};
    let productId = "";
    let legacyEdgeId = "";

    const bob: AuthPayload = {
      userId: "bob",
      username: "bob",
      role: "coordinator",
      permissions: getPermissionsForRole("coordinator"),
      workspaces: [WS],
    };
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/products", productsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const analyze = (id: string = productId) =>
      request(app())
        .post(`/api/products/${id}/analyze`)
        .set("Authorization", `Bearer ${issueTokens(bob).accessToken}`);
    const snapshot = async () => ({
      edges: await db.productEdge.findMany({ where: { productId }, orderBy: { id: "asc" } }),
      resources: await db.productResource.findMany({
        where: { productId },
        orderBy: { id: "asc" },
      }),
    });

    /** A clone of `connectorId` under the clone root, as ingest leaves one. */
    const makeClone = (connectorId: string, fixture: string) => {
      const dir = path.join(tmp, "clones", connectorId);
      cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
      mkdirSync(path.join(dir, ".git"), { recursive: true });
      writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      return dir;
    };

    beforeAll(async () => {
      tmp = mkdtempSync(path.join(os.tmpdir(), "metis-1643-"));
      process.env.REPO_CLONE_DIR = path.join(tmp, "clones");
      sqlite = createMigratedSqlite("1643-analyze-detection");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      await db.role.create({ data: { id: "role-coordinator", key: "coordinator", name: "c" } });
      await db.user.create({
        data: { id: "bob", username: "bob", displayName: "bob", email: "bob@example.test" },
      });
      await db.userRole.create({ data: { userId: "bob", roleId: "role-coordinator" } });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.workspaceMember.create({ data: { workspaceId: WS, userId: "bob", role: "member" } });
      await db.project.create({
        data: { id: PA, name: PA, slug: PA, createdById: "bob", workspaceId: WS, status: "active" },
      });
      for (const key of ["writer", "reader", "legacy"]) {
        rc[key] = (
          await db.repoConnection.create({
            data: { projectId: PA, label: key, repoName: `${key}-1643`, ownerOrOrg: "org" },
          })
        ).id;
      }
      productId = (
        await db.product.create({
          data: { name: "p", slug: "p-1643", createdById: "bob", workspaceId: WS },
        })
      ).id;
      for (const key of ["writer", "reader", "legacy"]) {
        await db.productRepo.create({ data: { productId, repoConnectionId: rc[key] } });
      }

      // Outside every clone: SQL that writes a `secrets` table.
      const outside = path.join(tmp, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, "secret.sql"), "INSERT INTO secrets (k) VALUES (:k);\n");
      const writer = makeClone(rc.writer, "order-writer");
      symlinkSync(path.join(outside, "secret.sql"), path.join(writer, "db", "escape.sql"));
      symlinkSync(outside, path.join(writer, "linked"));
      const reader = makeClone(rc.reader, "report-reader");
      writeFileSync(path.join(reader, "reports", "secrets.sql"), "SELECT k FROM secrets;\n");

      // An edge an earlier run found to the repo that has no clone now.
      legacyEdgeId = (
        await db.productEdge.create({
          data: {
            productId,
            sourceRepoId: rc.writer,
            targetRepoId: rc.legacy,
            edgeType: "calls",
            confidence: 0.8,
            origin: "detected",
          },
        })
      ).id;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      if (originalCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
      else process.env.REPO_CLONE_DIR = originalCloneDir;
      await db?.$disconnect();
      sqlite?.cleanup();
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    it("stores the edge detected from the clones and reports the stored edges", async () => {
      const res = await analyze();
      expect(res.status).toBe(200);
      const { edges, resources } = await snapshot();
      const detected = edges.filter((e) => e.id !== legacyEdgeId);
      expect(detected).toHaveLength(1);
      expect(detected[0]).toMatchObject({
        sourceRepoId: rc.writer,
        targetRepoId: rc.reader,
        integrationKind: "database",
        strength: "intrusive",
        direction: "writes",
        origin: "detected",
        sourceFile: "db/orders.sql",
      });
      expect(detected[0].resourceId).toBe(resources[0]?.id);
      // The detected edge and the stored legacy one, both between readable repos.
      expect(res.body.data.edgesDetected).toBe(2);
      // #1727 — the repo with no clone is named, not skipped silently.
      expect(res.body.data.reposWithoutClone).toEqual([
        { repoConnectionId: rc.legacy, name: "org/legacy-1643" },
      ]);
      const analysis = await db.productAnalysis.findUnique({
        where: { id: res.body.data.analysisId },
      });
      expect(analysis).toMatchObject({ status: "completed", edgeCount: 2 });
      // The documents are generated from the detected edge.
      const perService = await db.productDocument.findFirst({
        where: { productId, docType: "per-service", repoId: rc.reader },
      });
      expect(JSON.parse(perService!.metadata ?? "{}").repoConnectionIds).toContain(rc.writer);
    });

    it("never reads through a symlink out of the clone root", async () => {
      const { resources } = await snapshot();
      expect(resources.map((r) => `${r.kind}:${r.name}`)).toEqual(["table:orders"]);
    });

    it("keeps the stored edge of a repo with no clone", async () => {
      expect(await db.productEdge.findUnique({ where: { id: legacyEdgeId } })).toMatchObject({
        sourceRepoId: rc.writer,
        targetRepoId: rc.legacy,
        origin: "detected",
      });
    });

    it("changes nothing on a second run", async () => {
      const before = await snapshot();
      const res = await analyze();
      expect(res.status).toBe(200);
      expect(await snapshot()).toEqual(before);
    });

    it("links an API edge to the contract version of its first run, and a second run changes nothing", async () => {
      const ids: Record<string, string> = {};
      const apiProduct = (
        await db.product.create({
          data: { name: "api", slug: "api-1643", createdById: "bob", workspaceId: WS },
        })
      ).id;
      for (const key of ["client", "server"]) {
        ids[key] = (
          await db.repoConnection.create({
            data: { projectId: PA, label: key, repoName: `${key}-api-1643`, ownerOrOrg: "org" },
          })
        ).id;
        await db.productRepo.create({
          data: { productId: apiProduct, repoConnectionId: ids[key] },
        });
        const dir = path.join(tmp, "clones", ids[key]);
        mkdirSync(path.join(dir, ".git"), { recursive: true });
        writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      }
      writeFileSync(
        path.join(tmp, "clones", ids.client, "openapi.yaml"),
        "servers:\n  - url: https://server-api-1643.example.test\n",
      );
      const edgeRows = () => db.productEdge.findMany({ where: { productId: apiProduct } });

      expect((await analyze(apiProduct)).status).toBe(200);
      const first = await edgeRows();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ integrationKind: "api", targetRepoId: ids.server });
      const contract = await db.productContractDoc.findFirst({
        where: { productId: apiProduct, repoId: ids.server },
        orderBy: { version: "desc" },
      });
      expect(contract).not.toBeNull();
      expect(first[0].contractDocId).toBe(contract!.id);

      expect((await analyze(apiProduct)).status).toBe(200);
      expect(await edgeRows()).toEqual(first);
    });
  },
);
