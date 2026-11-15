/**
 * #2547 — the document access list gets a UI, so the routes that UI reads and
 * writes say, per caller, whether each document is restricted and whether the
 * caller can read it; only a reader (or an admin) is told who it is restricted
 * to (#2546: a non-reader's row never carries the subjects). A member a
 * document is restricted away from cannot manage it: not its list, not its
 * approval, rejection or toggles. Through the real application over a real
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

const { createApp } = await import("../src/app.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
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
        post: (path: string, body: object) => set(request(app).post(path)).send(body),
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

    // Every test starts from the same state, whatever ran before it.
    beforeEach(async () => {
      await db.document.update({
        where: { id: PAYROLL },
        data: {
          aclSubjects: JSON.stringify(TO_COORDINATORS),
          isSpec: false,
          autoApproveTrusted: false,
          indexState: "quarantined",
        },
      });
      await db.document.update({ where: { id: HANDBOOK }, data: { aclSubjects: "[]" } });
      await db.project.update({ where: { id: PROJECT }, data: { status: "active" } });
      vi.mocked(audit).mockClear();
    });

    const deniedAudit = (action: string, documentId: string) =>
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          actor: { id: BOB },
          target: { type: "document", id: documentId },
        }),
      );

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the Documents list tells Bob, a non-reader, only that it is restricted; readers are told to whom", async () => {
      const bob = await as(BOB).get(`/api/projects/${PROJECT}/documents`);
      expect(bob.status).toBe(200);
      const bobRow = bob.body.data.items.find((d: { id: string }) => d.id === PAYROLL);
      // One shape: the #2546 restricted row, its access saying no more.
      expect(bobRow.access).toEqual({ restricted: true, canRead: false });
      expect(bobRow.restricted).toBe(true);
      expect(bobRow).not.toHaveProperty("aclSubjects");
      expect(JSON.stringify(bobRow)).not.toContain("coordinator");
      expect(accessOf(bob.body.data.items, HANDBOOK)).toEqual({
        restricted: false,
        canRead: true,
        subjects: [],
        users: [],
      });

      const alice = await as(ALICE).get(`/api/projects/${PROJECT}/documents`);
      expect(accessOf(alice.body.data.items, PAYROLL)).toEqual({
        restricted: true,
        canRead: true,
        subjects: TO_COORDINATORS,
        users: [],
      });
      // The admin reads it through the bypass, as retrieval does, and is told to whom.
      const admin = await as(ADMIN).get(`/api/projects/${PROJECT}/documents`);
      expect(accessOf(admin.body.data.items, PAYROLL)).toEqual({
        restricted: true,
        canRead: true,
        subjects: TO_COORDINATORS,
        users: [],
      });
    });

    it("a cursor page carries the same access", async () => {
      const first = await as(BOB).get(`/api/projects/${PROJECT}/documents?limit=1`);
      const cursor = first.body.data.nextCursor as string;
      expect(cursor).toBeTruthy();
      const next = await as(BOB).get(
        `/api/projects/${PROJECT}/documents?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      const both = [...first.body.data.items, ...next.body.data.items];
      expect(accessOf(both, PAYROLL)).toEqual({ restricted: true, canRead: false });
      expect(accessOf(both, HANDBOOK)).toEqual({
        restricted: false,
        canRead: true,
        subjects: [],
        users: [],
      });
    });

    it("the document's own read carries the access", async () => {
      const bob = await as(BOB).get(`/api/projects/${PROJECT}/documents/${PAYROLL}`);
      expect(bob.status).toBe(200);
      expect(bob.body.data.access).toEqual({ restricted: true, canRead: false });
      const alice = await as(ALICE).get(`/api/projects/${PROJECT}/documents/${PAYROLL}`);
      expect(alice.body.data.access).toEqual({
        restricted: true,
        canRead: true,
        subjects: TO_COORDINATORS,
        users: [],
      });
    });

    it("the quarantine reviewer's list carries the access, the subjects to readers only", async () => {
      const bob = await as(BOB).get(`/api/projects/${PROJECT}/quarantine`);
      expect(bob.status).toBe(200);
      const rows = bob.body.data.items as Array<Record<string, unknown>>;
      const bobRow = rows.find((r) => r.documentId === PAYROLL)!;
      expect(bobRow.access).toEqual({ restricted: true, canRead: false });
      expect(bobRow.restricted).toBe(true);
      expect(JSON.stringify(bobRow)).not.toContain("coordinator");
      const alice = await as(ALICE).get(`/api/projects/${PROJECT}/quarantine`);
      const aliceRows = alice.body.data.items as Array<{ documentId: string; access: unknown }>;
      expect(aliceRows.find((r) => r.documentId === PAYROLL)?.access).toEqual({
        restricted: true,
        canRead: true,
        subjects: TO_COORDINATORS,
        users: [],
      });
    });

    it("Bob cannot rewrite the list of a document restricted away from him", async () => {
      const res = await as(BOB).patch(`/api/projects/${PROJECT}/documents/${PAYROLL}/acl`, {
        aclSubjects: [{ kind: "user", value: BOB }],
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACL_EDIT_FORBIDDEN");
      const row = await db.document.findUnique({ where: { id: PAYROLL } });
      expect(JSON.parse(row!.aclSubjects)).toEqual(TO_COORDINATORS);
      // The refused attempt leaves an audit row (A09).
      deniedAudit("document.acl.update.denied", PAYROLL);
    });

    describe("owner policy — a member who cannot read a document cannot manage it", () => {
      it("Bob cannot approve it", async () => {
        const res = await as(BOB).post(`/api/projects/${PROJECT}/documents/${PAYROLL}/approve`, {});
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("DOCUMENT_RESTRICTED");
        const row = await db.document.findUnique({ where: { id: PAYROLL } });
        expect(row!.indexState).toBe("quarantined");
        deniedAudit("document.approve.denied", PAYROLL);
      });

      it("Bob cannot reject it", async () => {
        const res = await as(BOB).post(`/api/projects/${PROJECT}/documents/${PAYROLL}/reject`, {
          reason: "no",
        });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("DOCUMENT_RESTRICTED");
        const row = await db.document.findUnique({ where: { id: PAYROLL } });
        expect(row!.indexState).toBe("quarantined");
        deniedAudit("document.reject.denied", PAYROLL);
      });

      it("Bob cannot toggle its auto-approve", async () => {
        const res = await as(BOB).patch(
          `/api/projects/${PROJECT}/documents/${PAYROLL}/auto-approve`,
          { autoApproveTrusted: true },
        );
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("DOCUMENT_RESTRICTED");
        const row = await db.document.findUnique({ where: { id: PAYROLL } });
        expect(row!.autoApproveTrusted).toBe(false);
        deniedAudit("document.autoApprove.update.denied", PAYROLL);
      });

      it("Bob cannot toggle its spec tag", async () => {
        const res = await as(BOB).patch(`/api/projects/${PROJECT}/documents/${PAYROLL}/spec`, {
          isSpec: true,
        });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("DOCUMENT_RESTRICTED");
        const row = await db.document.findUnique({ where: { id: PAYROLL } });
        expect(row!.isSpec).toBe(false);
        deniedAudit("document.spec.update.denied", PAYROLL);
      });

      it("Alice, a reader, can toggle both, and is answered with her row and its access", async () => {
        const spec = await as(ALICE).patch(`/api/projects/${PROJECT}/documents/${PAYROLL}/spec`, {
          isSpec: true,
        });
        expect(spec.status).toBe(200);
        expect(spec.body.data.access).toEqual({
          restricted: true,
          canRead: true,
          subjects: TO_COORDINATORS,
          users: [],
        });
        const trust = await as(ALICE).patch(
          `/api/projects/${PROJECT}/documents/${PAYROLL}/auto-approve`,
          { autoApproveTrusted: true },
        );
        expect(trust.status).toBe(200);
        const row = await db.document.findUnique({ where: { id: PAYROLL } });
        expect(row!.isSpec).toBe(true);
        expect(row!.autoApproveTrusted).toBe(true);
      });

      it("Bob may still manage an unrestricted document", async () => {
        const res = await as(BOB).patch(`/api/projects/${PROJECT}/documents/${HANDBOOK}/spec`, {
          isSpec: false,
        });
        expect(res.status).toBe(200);
      });
    });

    it("an archived project's access lists cannot be changed", async () => {
      await db.project.update({ where: { id: PROJECT }, data: { status: "archived" } });
      const res = await as(ALICE).patch(`/api/projects/${PROJECT}/documents/${HANDBOOK}/acl`, {
        aclSubjects: [{ kind: "user", value: ALICE }],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PROJECT_ARCHIVED");
      const row = await db.document.findUnique({ where: { id: HANDBOOK } });
      expect(row!.aclSubjects).toBe("[]");
    });

    it("Alice, a reader, can change it, and Bob then reads it", async () => {
      const res = await as(ALICE).patch(`/api/projects/${PROJECT}/documents/${PAYROLL}/acl`, {
        aclSubjects: [...TO_COORDINATORS, { kind: "user", value: BOB }],
      });
      expect(res.status).toBe(200);
      const bob = await as(BOB).get(`/api/projects/${PROJECT}/documents/${PAYROLL}`);
      expect(bob.body.data.access).toEqual({
        restricted: true,
        canRead: true,
        subjects: [...TO_COORDINATORS, { kind: "user", value: BOB }],
        users: [{ id: BOB, username: BOB, displayName: BOB }],
      });
    });

    it("Bob can restrict an unrestricted document", async () => {
      const res = await as(BOB).patch(`/api/projects/${PROJECT}/documents/${HANDBOOK}/acl`, {
        aclSubjects: [{ kind: "user", value: BOB }],
      });
      expect(res.status).toBe(200);
      const alice = await as(ALICE).get(`/api/projects/${PROJECT}/documents/${HANDBOOK}`);
      expect(alice.body.data.access).toEqual({ restricted: true, canRead: false });
    });
  },
);
