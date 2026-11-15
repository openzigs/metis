/**
 * #2548 — a member a document is restricted away from cannot delete it, as
 * #2547 refuses them its approval, rejection, toggles and access list: the
 * refusal is the same 403 `DOCUMENT_RESTRICTED` with a `.denied` audit row, and
 * the document, its vectors and its rows are untouched. An admin keeps the
 * bypass, as retrieval does.
 *
 * The built-in roles grant `document.delete` to admins only, so this file
 * grants it to every role, as a deployment widening that permission would: the
 * access-list check must hold on its own rather than lean on the role table.
 *
 * Through the real application over a real (migrated SQLite) database. Alice is
 * a `coordinator`, Bob a `developer`; `d-payroll` is restricted to coordinators.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import type { Application } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_RATE_LIMIT_MAX = "100000";
  return { db: null as unknown, deleted: [] as string[] };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
// Every role may delete documents here (see the header).
vi.mock("@metis/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metis/shared")>();
  return {
    ...actual,
    hasPermission: (role: Parameters<typeof actual.hasPermission>[0], permission: string) =>
      permission === "document.delete" ||
      actual.hasPermission(role, permission as Parameters<typeof actual.hasPermission>[1]),
  };
});
// The vector store is not under test: deleting marks the row, as the real service does.
vi.mock("../src/lib/rag/knowledge-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: () => ({
    deleteDocument: async (id: string) => {
      state.deleted.push(id);
      await (state.db as PrismaClient).document.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    },
  }),
}));

const { createApp } = await import("../src/app.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getPermissionsForRole } = await import("@metis/shared");

type Role = "admin" | "coordinator" | "developer";
const WS = "ws-2548-del";
const PROJECT = "p-2548-del";
const PAYROLL = "d-payroll-2548-del";
const HANDBOOK = "d-handbook-2548-del";
const ALICE = "u-alice-2548-del";
const BOB = "u-bob-2548-del";
const ADMIN = "u-admin-2548-del";
const ROLE_OF: Record<string, Role> = {
  [ALICE]: "coordinator",
  [BOB]: "developer",
  [ADMIN]: "admin",
};
const TO_COORDINATORS = JSON.stringify([{ kind: "role", value: "coordinator" }]);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2548 — only a reader of a document may delete it (real app, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let app: Application;

    let ip = 0;
    const del = (userId: string, documentId: string) => {
      ip += 1;
      const token = issueTokens({
        userId,
        username: userId,
        role: ROLE_OF[userId],
        permissions: getPermissionsForRole(ROLE_OF[userId]),
        workspaces: userId === ADMIN ? [] : [WS],
      }).accessToken;
      return request(app)
        .delete(`/api/projects/${PROJECT}/documents/${documentId}`)
        .set("X-Forwarded-For", `198.51.100.${ip % 250}`)
        .set("Authorization", `Bearer ${token}`);
    };
    const live = async (id: string) =>
      (await db.document.findUniqueOrThrow({ where: { id } })).deletedAt === null;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2548-document-delete");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      for (const [id, key] of Object.entries(ROLE_OF)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        const role = await db.role.upsert({
          where: { key },
          create: { key, name: key },
          update: {},
        });
        await db.userRole.create({ data: { userId: id, roleId: role.id } });
        if (id !== ADMIN) {
          await db.workspaceMember.create({
            data: { workspaceId: WS, userId: id, role: "member" },
          });
        }
      }
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: ALICE, workspaceId: WS },
      });
      for (const [id, aclSubjects] of [
        [PAYROLL, TO_COORDINATORS],
        [HANDBOOK, "[]"],
      ] as const) {
        await db.document.create({
          data: {
            id,
            projectId: PROJECT,
            filename: `${id}.md`,
            mimeType: "text/markdown",
            sizeBytes: 10,
            storagePath: `/tmp/${id}`,
            checksum: id,
            status: "ready",
            uploadedById: ALICE,
            aclSubjects,
          },
        });
      }
      app = createApp();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      await db.document.updateMany({ data: { deletedAt: null } });
      state.deleted.length = 0;
      vi.mocked(audit).mockClear();
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("Bob cannot delete a document restricted away from him, and the refusal is audited", async () => {
      const res = await del(BOB, PAYROLL);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("DOCUMENT_RESTRICTED");
      expect(await live(PAYROLL)).toBe(true);
      expect(state.deleted).toEqual([]);
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "document.delete.denied",
          actor: { id: BOB },
          target: { type: "document", id: PAYROLL },
          metadata: { projectId: PROJECT, reason: "document_restricted" },
        }),
      );
      expect(vi.mocked(audit)).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "document.delete" }),
      );
    });

    it("Bob may still delete an unrestricted document", async () => {
      expect((await del(BOB, HANDBOOK)).status).toBe(204);
      expect(await live(HANDBOOK)).toBe(false);
    });

    it("Alice, a reader, deletes it", async () => {
      expect((await del(ALICE, PAYROLL)).status).toBe(204);
      expect(state.deleted).toEqual([PAYROLL]);
      expect(await live(PAYROLL)).toBe(false);
    });

    it("an admin, on no list, keeps the bypass", async () => {
      expect((await del(ADMIN, PAYROLL)).status).toBe(204);
      expect(await live(PAYROLL)).toBe(false);
    });
  },
);
