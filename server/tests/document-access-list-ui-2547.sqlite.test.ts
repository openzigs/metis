/**
 * #2547 — the document access list gets a UI, so the routes that UI reads and
 * writes say, per caller, whether each document is restricted, to whom, and
 * whether the caller can read it; and a member a document is restricted away
 * from cannot rewrite its list. Through the real application over a real
 * (migrated SQLite) database.
 *
 * Alice is a `coordinator`, Bob a `developer`: both are members of the
 * project's workspace and both hold `document.upload`, the permission
 * `PATCH /acl` checks. `d-payroll` is restricted to the `coordinator` role.
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

const { createApp } = await import("../src/app.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getPermissionsForRole } = await import("@metis/shared");

type Role = "admin" | "coordinator" | "developer";
const WS = "ws-2547";
const PROJECT = "p-2547";
const PAYROLL = "d-payroll-2547";
const HANDBOOK = "d-handbook-2547";
const ALICE = "u-alice-2547";
const BOB = "u-bob-2547";
const ADMIN = "u-admin-2547";
const ROLE_OF: Record<string, Role> = {
  [ALICE]: "coordinator",
  [BOB]: "developer",
  [ADMIN]: "admin",
};
const TO_COORDINATORS = [{ kind: "role", value: "coordinator" }];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2547 — document access as each caller sees it (real app, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let app: Application;

    let ip = 0;
    const as = (userId: string) => {
      ip += 1;
      const token = issueTokens({
        userId,
        username: userId,
        role: ROLE_OF[userId],
        permissions: getPermissionsForRole(ROLE_OF[userId]),
        workspaces: userId === ADMIN ? [] : [WS],
      }).accessToken;
      const set = (r: request.Test) =>
        r.set("X-Forwarded-For", `198.51.100.${ip % 250}`).set("Authorization", `Bearer ${token}`);
      return {
        get: (path: string) => set(request(app).get(path)),
        patch: (path: string, body: object) => set(request(app).patch(path)).send(body),
      };
    };
    const accessOf = (items: Array<{ id: string; access: unknown }>, id: string) =>
      items.find((d) => d.id === id)?.access;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2547-document-access-ui");
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
      for (const id of [PAYROLL, HANDBOOK]) {
        await db.document.create({
          data: {
            id,
            projectId: PROJECT,
            filename: `${id}.md`,
            mimeType: "text/markdown",
            sizeBytes: 10,
            storagePath: `/tmp/${id}`,
            checksum: id,
            status: "processing",
            indexState: "quarantined",
            uploadedById: ALICE,
          },
        });
      }
      app = createApp();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      await db.document.update({
        where: { id: PAYROLL },
        data: { aclSubjects: JSON.stringify(TO_COORDINATORS) },
      });
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the Documents list says the document is restricted, to whom, and that Bob cannot read it", async () => {
      const bob = await as(BOB).get(`/api/projects/${PROJECT}/documents`);
      expect(bob.status).toBe(200);
      expect(accessOf(bob.body.data.items, PAYROLL)).toEqual({
        restricted: true,
        canRead: false,
        subjects: TO_COORDINATORS,
      });
      expect(accessOf(bob.body.data.items, HANDBOOK)).toEqual({
        restricted: false,
        canRead: true,
        subjects: [],
      });

      const alice = await as(ALICE).get(`/api/projects/${PROJECT}/documents`);
      expect(accessOf(alice.body.data.items, PAYROLL)).toMatchObject({
        restricted: true,
        canRead: true,
      });
      // The admin reads it through the bypass, as retrieval does.
      const admin = await as(ADMIN).get(`/api/projects/${PROJECT}/documents`);
      expect(accessOf(admin.body.data.items, PAYROLL)).toMatchObject({ canRead: true });
    });

    it("a cursor page carries the same access", async () => {
      const first = await as(BOB).get(`/api/projects/${PROJECT}/documents?limit=1`);
      const cursor = first.body.data.nextCursor as string;
      expect(cursor).toBeTruthy();
      const next = await as(BOB).get(
        `/api/projects/${PROJECT}/documents?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      const both = [...first.body.data.items, ...next.body.data.items];
      expect(accessOf(both, PAYROLL)).toMatchObject({ restricted: true, canRead: false });
    });

    it("the document's own read carries the access", async () => {
      const res = await as(BOB).get(`/api/projects/${PROJECT}/documents/${PAYROLL}`);
      expect(res.status).toBe(200);
      expect(res.body.data.access).toEqual({
        restricted: true,
        canRead: false,
        subjects: TO_COORDINATORS,
      });
    });

    it("the quarantine reviewer's list carries the access", async () => {
      const bob = await as(BOB).get(`/api/projects/${PROJECT}/quarantine`);
      expect(bob.status).toBe(200);
      const rows = bob.body.data.items as Array<{ documentId: string; access: unknown }>;
      expect(rows.find((r) => r.documentId === PAYROLL)?.access).toEqual({
        restricted: true,
        canRead: false,
        subjects: TO_COORDINATORS,
      });
      const alice = await as(ALICE).get(`/api/projects/${PROJECT}/quarantine`);
      const aliceRows = alice.body.data.items as Array<{
        documentId: string;
        access: { canRead: boolean };
      }>;
      expect(aliceRows.find((r) => r.documentId === PAYROLL)?.access.canRead).toBe(true);
    });

    it("Bob cannot rewrite the list of a document restricted away from him", async () => {
      const res = await as(BOB).patch(`/api/projects/${PROJECT}/documents/${PAYROLL}/acl`, {
        aclSubjects: [{ kind: "user", value: BOB }],
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACL_EDIT_FORBIDDEN");
      const row = await db.document.findUnique({ where: { id: PAYROLL } });
      expect(JSON.parse(row!.aclSubjects)).toEqual(TO_COORDINATORS);
    });

    it("Alice, a reader, can change it, and Bob then reads it", async () => {
      const res = await as(ALICE).patch(`/api/projects/${PROJECT}/documents/${PAYROLL}/acl`, {
        aclSubjects: [...TO_COORDINATORS, { kind: "user", value: BOB }],
      });
      expect(res.status).toBe(200);
      const bob = await as(BOB).get(`/api/projects/${PROJECT}/documents/${PAYROLL}`);
      expect(bob.body.data.access).toMatchObject({ restricted: true, canRead: true });
    });

    it("Bob can restrict an unrestricted document", async () => {
      const res = await as(BOB).patch(`/api/projects/${PROJECT}/documents/${HANDBOOK}/acl`, {
        aclSubjects: [{ kind: "user", value: BOB }],
      });
      expect(res.status).toBe(200);
      const alice = await as(ALICE).get(`/api/projects/${PROJECT}/documents/${HANDBOOK}`);
      expect(alice.body.data.access).toMatchObject({ restricted: true, canRead: false });
    });
  },
);
