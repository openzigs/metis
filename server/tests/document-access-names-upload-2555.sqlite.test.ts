/**
 * #2555 — the access list an analyst can use: a reader of a restricted
 * document is told who reads it by name (the Restricted badge read "Readable by
 * user cmurr3lo11r2nns9kfurops14"), and a file can be restricted as it is
 * uploaded, so it is never open to the whole project while it is indexed.
 * Through the real documents router over a real (migrated SQLite) database.
 *
 * Alice (`coordinator`) and Bob (`developer`) are members of the project's
 * workspace; Olive is not; Dora is a member whose account is disabled.
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
  return { db: null as unknown, writes: 0, ingestedAcl: [] as string[] };
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

const { documentsRouter } = await import("../src/routes/documents.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { listQuarantine } = await import("../src/lib/rag/quarantine.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
const { getPermissionsForRole } = await import("@metis/shared");

type Role = "admin" | "coordinator" | "developer";
const WS = "ws-2555";
const PROJECT = "p-2555";
const PAYROLL = "d-payroll-2555";
const ALICE = "u-alice-2555";
const BOB = "u-bob-2555";
const OLIVE = "u-olive-2555";
const DORA = "u-dora-2555";
const USERS: Record<string, { role: Role; name: string; member: boolean; disabled?: true }> = {
  [ALICE]: { role: "coordinator", name: "Alice Smith", member: true },
  [BOB]: { role: "developer", name: "Bob Jones", member: true },
  [OLIVE]: { role: "developer", name: "Olive Outsider", member: false },
  [DORA]: { role: "developer", name: "Dora Gone", member: true, disabled: true },
};
const PERSON = (id: string) => ({ id, username: `${id}-login`, displayName: USERS[id]!.name });
const LIST = [
  { kind: "user", value: ALICE },
  { kind: "user", value: OLIVE },
  { kind: "user", value: DORA },
  { kind: "role", value: "coordinator" },
];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2555 — names on an access list, and a list given at upload (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

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
              // The list the document holds when ingest starts: what its chunks get.
              ingestDocument: async (documentId: string) => {
                const row = await db.document.findUnique({ where: { id: documentId } });
                state.ingestedAcl.push(row!.aclSubjects);
                return { status: "ready", chunkCount: 0 };
              },
              deleteDocument: vi.fn(),
            } as never,
            ingestQueue: null,
          }),
        )
        .use(notFoundHandler)
        .use(errorHandler);

    const tokenOf = (userId: string) =>
      issueTokens({
        userId,
        username: `${userId}-login`,
        role: USERS[userId]!.role,
        permissions: getPermissionsForRole(USERS[userId]!.role),
        workspaces: USERS[userId]!.member ? [WS] : [],
      }).accessToken;
    const get = (userId: string, path: string) =>
      request(app())
        .get(path)
        .set("Authorization", `Bearer ${tokenOf(userId)}`);
    const upload = (userId: string, fields: Record<string, string> = {}) => {
      let req = request(app())
        .post(`/api/projects/${PROJECT}/documents`)
        .set("Authorization", `Bearer ${tokenOf(userId)}`);
      for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
      return req.attach("file", Buffer.from("# Salaries\n\nBands."), {
        filename: "salaries.md",
        contentType: "text/markdown",
      });
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2555-access-names-upload");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      for (const [id, u] of Object.entries(USERS)) {
        await db.user.create({
          data: {
            id,
            username: `${id}-login`,
            displayName: u.name,
            email: `${id}@example.test`,
            ...(u.disabled ? { status: "disabled" } : {}),
          },
        });
        const role = await db.role.upsert({
          where: { key: u.role },
          create: { key: u.role, name: u.role },
          update: {},
        });
        await db.userRole.create({ data: { userId: id, roleId: role.id } });
        if (u.member) {
          await db.workspaceMember.create({
            data: { workspaceId: WS, userId: id, role: "member" },
          });
        }
      }
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: ALICE, workspaceId: WS },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      await db.document.deleteMany({});
      await db.document.create({
        data: {
          id: PAYROLL,
          projectId: PROJECT,
          filename: "payroll.md",
          mimeType: "text/markdown",
          sizeBytes: 10,
          storagePath: `/tmp/${PAYROLL}`,
          checksum: PAYROLL,
          status: "ready",
          indexState: "quarantined",
          uploadedById: ALICE,
          aclSubjects: JSON.stringify(LIST),
        },
      });
      state.ingestedAcl = [];
      vi.mocked(audit).mockClear();
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("a reader is told who reads a document by name", () => {
      it("the Documents list names the project's active people on it, and no one else", async () => {
        const res = await get(ALICE, `/api/projects/${PROJECT}/documents`);
        expect(res.status).toBe(200);
        const row = res.body.data.items.find((d: { id: string }) => d.id === PAYROLL);
        expect(row.access).toEqual({
          restricted: true,
          canRead: true,
          subjects: LIST,
          // Not Olive (outside the project), not Dora (disabled): the list is
          // no lookup of a person by id.
          users: [PERSON(ALICE)],
        });
      });

      it("the document's own read names them too", async () => {
        const res = await get(ALICE, `/api/projects/${PROJECT}/documents/${PAYROLL}`);
        expect(res.body.data.access.users).toEqual([PERSON(ALICE)]);
      });

      it("a member the list leaves out is told no names", async () => {
        const res = await get(BOB, `/api/projects/${PROJECT}/documents`);
        const row = res.body.data.items.find((d: { id: string }) => d.id === PAYROLL);
        expect(row.access).toEqual({ restricted: true, canRead: false });
        expect(JSON.stringify(row)).not.toContain("Alice Smith");
      });

      it("the quarantine reviewer's list names them, to a reader only", async () => {
        const asAlice = await listQuarantine(PROJECT, ALICE);
        const access = (asAlice[0] as { access?: { users?: unknown } }).access;
        expect(access?.users).toEqual([PERSON(ALICE)]);
        const asBob = await listQuarantine(PROJECT, BOB);
        expect(JSON.stringify(asBob)).not.toContain("Alice Smith");
      });
    });

    describe("a file restricted as it is uploaded", () => {
      const TO_ALICE = [{ kind: "user", value: ALICE }];

      it("is created with its list, and ingest starts with it in place", async () => {
        const res = await upload(ALICE, { aclSubjects: JSON.stringify(TO_ALICE) });
        expect(res.status).toBe(201);
        const id = res.body.data.document.id as string;
        const row = await db.document.findUnique({ where: { id } });
        expect(JSON.parse(row!.aclSubjects)).toEqual(TO_ALICE);
        // Never unrestricted while it is indexed.
        expect(state.ingestedAcl.map((a) => JSON.parse(a))).toEqual([TO_ALICE]);
        // The upload's audit row says what it was restricted to.
        expect(vi.mocked(audit)).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "document.upload",
            metadata: expect.objectContaining({ aclSubjects: TO_ALICE }),
          }),
        );
        // Bob is told only that it is restricted; Alice who reads it, by name.
        const bob = await get(BOB, `/api/projects/${PROJECT}/documents/${id}`);
        expect(bob.body.data.access).toEqual({ restricted: true, canRead: false });
        expect(bob.body.data.filename).not.toBe("salaries.md");
        const alice = await get(ALICE, `/api/projects/${PROJECT}/documents/${id}`);
        expect(alice.body.data.access).toEqual({
          restricted: true,
          canRead: true,
          subjects: TO_ALICE,
          users: [PERSON(ALICE)],
        });
      });

      it("is unrestricted without a list, as before", async () => {
        const forms: Array<Record<string, string>> = [
          {},
          { aclSubjects: "" },
          { aclSubjects: "[]" },
        ];
        for (const fields of forms) {
          const res = await upload(ALICE, fields);
          expect(res.status).toBe(201);
          const row = await db.document.findUnique({ where: { id: res.body.data.document.id } });
          expect(row!.aclSubjects).toBe("[]");
        }
        expect(vi.mocked(audit).mock.calls[0]![0].metadata).not.toHaveProperty("aclSubjects");
      });

      it("refuses a group subject, storing nothing", async () => {
        const writes = state.writes;
        const res = await upload(ALICE, {
          aclSubjects: JSON.stringify([{ kind: "group", value: "hr" }]),
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("ACL_GROUP_UNSUPPORTED");
        expect(state.writes).toBe(writes);
        expect(await db.document.count()).toBe(1);
      });

      it.each([
        ["not JSON", "{oops"],
        ["not a list", JSON.stringify({ kind: "user", value: ALICE })],
        ["an unknown kind", JSON.stringify([{ kind: "team", value: "hr" }])],
        ["an empty value", JSON.stringify([{ kind: "user", value: "" }])],
      ])("refuses a list that is %s, storing nothing", async (_label, aclSubjects) => {
        const writes = state.writes;
        const res = await upload(ALICE, { aclSubjects });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
        expect(state.writes).toBe(writes);
        expect(await db.document.count()).toBe(1);
      });
    });
  },
);
