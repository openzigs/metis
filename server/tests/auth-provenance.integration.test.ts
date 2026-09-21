/** Real DB/route proof, never the app singleton or DATABASE_URL.
 * SQLite uses a fresh temporary file. PostgreSQL requires the dedicated
 * AUTH_PROVENANCE_TEST_POSTGRES_URL and uses an isolated random schema.
 * Generate the matching Prisma client before choosing the backend.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";

const state = vi.hoisted(() => ({ db: null as PrismaClient | null, revoke: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/auth/jwt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth/jwt.js")>()),
  revokeAllUserSessions: state.revoke,
}));

import { addScimToken, __resetScimTokens, scimRouter } from "../src/routes/scim.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { reconcileTrustedLoginRole, resolveDurableRole } from "../src/lib/auth/durable-roles.js";
import {
  confirmRolesForAdmin,
  inspectRolesForAdmin,
  type ReconciliationInput,
} from "../src/lib/auth/role-reconciliation.js";
import {
  confirmRolesForHost,
  inspectRolesForHost,
} from "../src/lib/auth/role-reconciliation-host.js";
import {
  authReconciliationRouter,
  reconciliationJson,
} from "../src/routes/admin/auth-reconciliation.js";
import { issueTokens } from "../src/lib/auth/jwt.js";

const provider = readGeneratedClientProvider();
const postgresUrl = process.env.AUTH_PROVENANCE_TEST_POSTGRES_URL;
const enabled = provider === "sqlite" || (provider === "postgresql" && Boolean(postgresUrl));
const execFileAsync = promisify(execFile);

describe.runIf(enabled)(`auth provenance with real ${provider} persistence`, () => {
  let db: PrismaClient;
  let directory: string | undefined;
  let pool: pg.Pool | undefined;
  const schema = `auth_provenance_${randomUUID().replaceAll("-", "")}`;
  const app = express();
  app.use("/api/admin/auth/role-reconciliation", reconciliationJson);
  app.use(express.json());
  app.use("/scim/v2", scimRouter());
  app.use("/api/admin/auth/role-reconciliation", authReconciliationRouter());
  app.use(errorHandler);

  beforeAll(async () => {
    if (provider === "postgresql") {
      // Never fall back to DATABASE_URL: only an explicitly supplied test DB.
      pool = new pg.Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` });
      await pool.query(`CREATE SCHEMA "${schema}"`);
      db = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString: postgresUrl, options: `-c search_path=${schema}` },
          { schema },
        ),
      });
      // Model queries and unqualified migration SQL must BOTH use our schema.
      expect(await db.$queryRawUnsafe("SELECT current_schema() AS schema")).toEqual([{ schema }]);
    } else {
      directory = await mkdtemp(join(tmpdir(), "metis-auth-provenance-"));
      db = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: `file:${join(directory, "auth.db")}` }),
      });
    }
    state.db = db;
    // Minimal pre-migration auth schema; apply the REAL additive migration to
    // prove legacy rows survive with unknown provenance (not provider grants).
    const timestamp = provider === "postgresql" ? "TIMESTAMP(3)" : "DATETIME";
    await db.$executeRawUnsafe(`CREATE TABLE "users" (
      "id" TEXT PRIMARY KEY, "username" TEXT NOT NULL UNIQUE,
      "displayName" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE,
      "status" TEXT NOT NULL DEFAULT 'active', "lastLoginAt" ${timestamp},
      "passwordHash" TEXT, "createdAt" ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" ${timestamp} NOT NULL, "deletedAt" ${timestamp})`);
    await db.$executeRawUnsafe(`CREATE TABLE "roles" (
      "id" TEXT PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '', "isSystem" BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt" ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" ${timestamp} NOT NULL)`);
    await db.$executeRawUnsafe(`CREATE TABLE "user_roles" (
      "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "roleId" TEXT NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
      "assignedAt" ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("userId", "roleId"))`);
    await db.$executeRawUnsafe(`CREATE TABLE "audit_logs" (
      "id" TEXT PRIMARY KEY, "actorId" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
      "action" TEXT NOT NULL, "targetType" TEXT NOT NULL, "targetId" TEXT NOT NULL,
      "argsHash" TEXT, "resultHash" TEXT, "metadata" TEXT,
      "ts" ${timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await db.$executeRawUnsafe(
      `INSERT INTO "users" ("id", "username", "displayName", "email", "updatedAt") VALUES ('legacy', 'legacy', 'Legacy', 'legacy@example.test', CURRENT_TIMESTAMP)`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "roles" ("id", "key", "name", "updatedAt") VALUES ('legacy-role', 'coordinator', 'Coordinator', CURRENT_TIMESTAMP)`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "user_roles" ("userId", "roleId") VALUES ('legacy', 'legacy-role')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "users" ("id", "username", "displayName", "email", "updatedAt") VALUES ('legacy-revoked', 'legacy-revoked', 'Revoked', 'revoked@example.test', CURRENT_TIMESTAMP)`,
    );
    const migration = await readFile(
      new URL(
        `../prisma/${provider === "postgresql" ? "postgres/" : ""}migrations/20260918000000_issue1350_durable_auth_roles/migration.sql`,
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of migration.split(";").filter((sql) => sql.trim())) {
      await db.$executeRawUnsafe(statement);
    }
    // Audit-only SCIM accounts retain authority even after their final role vanished.
    for (const id of [
      "scim-created",
      "scim-updated",
      "scim-deleted",
      "scim-role",
      "unrelated-audit",
    ]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "users" ("id", "username", "displayName", "email", "updatedAt") VALUES ('${id}', '${id}', '${id}', '${id}@example.test', CURRENT_TIMESTAMP)`,
      );
    }
    for (const action of ["created", "updated", "deleted"]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "audit_logs" ("id", "action", "targetType", "targetId") VALUES ('audit-${action}', 'scim.user.${action}', 'user', 'scim-${action}')`,
      );
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "audit_logs" ("id", "action", "targetType", "targetId") VALUES ('not-user', 'scim.user.created', 'role', 'unrelated-audit')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "user_roles" ("userId", "roleId", "source") VALUES ('scim-role', 'legacy-role', 'scim')`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "roles" ("id", "key", "name", "updatedAt") VALUES ('provider-admin', 'admin', 'Admin', CURRENT_TIMESTAMP)`,
    );
    for (const id of ["scim-created", "scim-deleted", "scim-updated", "scim-role"]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "user_roles" ("userId", "roleId", "source") VALUES ('${id}', 'provider-admin', 'provider')`,
      );
    }
    await db.$executeRawUnsafe(
      `UPDATE "audit_logs" SET "metadata" = '{"ops":1}' WHERE "id" = 'audit-updated'`,
    );
    const rolesBeforeMigration = await db.userRole.findMany({
      orderBy: [{ userId: "asc" }, { roleId: "asc" }],
    });
    const authorityMigration = await readFile(
      new URL(
        `../prisma/${provider === "postgresql" ? "postgres/" : ""}migrations/20260918010000_issue1350_auth_role_authority/migration.sql`,
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of authorityMigration.split(";").filter((sql) => sql.trim()))
      await db.$executeRawUnsafe(statement);
    expect(await db.userRole.findMany({ orderBy: [{ userId: "asc" }, { roleId: "asc" }] })).toEqual(
      rolesBeforeMigration,
    );
    for (const id of ["scim-created", "scim-deleted", "scim-role"]) {
      expect(await db.user.findUnique({ where: { id } })).toMatchObject({
        authRoleAuthority: "scim",
      });
    }
    for (const id of ["legacy", "legacy-revoked", "unrelated-audit", "scim-updated"]) {
      expect(await db.user.findUnique({ where: { id } })).toMatchObject({
        authRoleAuthority: "unknown",
      });
    }
    for (const id of ["scim-created", "scim-deleted", "scim-role"]) {
      const expected = id === "scim-role" ? "coordinator" : "reader";
      expect(await resolveDurableRole(id)).toBe(expected);
      expect(
        await reconcileTrustedLoginRole({
          userId: id,
          providerRole: "admin",
          authRolesInitializedAt: null,
        }),
      ).toBe(expected);
      expect(await resolveDurableRole(id)).toBe(expected);
    }
    // A historical ops-only update could have been displayName: it must not
    // convert an otherwise valid provider account into SCIM authority.
    expect(await resolveDurableRole("scim-updated")).toBe("admin");
    expect(
      await reconcileTrustedLoginRole({
        userId: "scim-updated",
        providerRole: "admin",
        authRolesInitializedAt: null,
      }),
    ).toBe("admin");
    expect(
      await db.userRole.findUnique({
        where: { userId_roleId: { userId: "legacy", roleId: "legacy-role" } },
      }),
    ).toMatchObject({ source: "unknown" });
    expect(await db.user.findUnique({ where: { id: "legacy" } })).toMatchObject({
      authRolesInitializedAt: expect.any(Date),
    });
    expect(
      await reconcileTrustedLoginRole({
        userId: "legacy",
        providerRole: "admin",
        authRolesInitializedAt: null,
      }),
    ).toBe("coordinator");
    expect(
      await reconcileTrustedLoginRole({
        userId: "legacy-revoked",
        providerRole: "admin",
        authRolesInitializedAt: null,
      }),
    ).toBe("reader");
    expect(await db.userRole.count({ where: { userId: "legacy-revoked" } })).toBe(0);
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (pool) {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    state.db = null;
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany();
    await db.userRole.deleteMany();
    await db.user.deleteMany();
    await db.role.deleteMany();
    for (const key of ["reader", "developer", "coordinator", "admin"]) {
      await db.role.create({ data: { id: `role-${key}`, key, name: key } });
    }
    __resetScimTokens();
    addScimToken("auth-provenance-test-token");
    state.revoke.mockClear();
  });

  async function createUser() {
    return db.user.create({
      data: { id: "u1", username: "alice", displayName: "Alice", email: "alice@example.test" },
    });
  }

  it.each(["unknown", "provider", "scim", "explicit", "revoked"])(
    "preserves the complete role/authority snapshot across repeated profile patches (%s)",
    async (authRoleAuthority) => {
      await createUser();
      await db.user.update({
        where: { id: "u1" },
        data: {
          authRoleAuthority,
          authRolesInitializedAt: new Date("2026-09-17T00:00:00Z"),
        },
      });
      await db.userRole.create({
        data: { userId: "u1", roleId: "role-admin", source: "provider" },
      });
      if (authRoleAuthority === "explicit" || authRoleAuthority === "scim") {
        await db.userRole.create({
          data: { userId: "u1", roleId: "role-coordinator", source: "local" },
        });
        await db.userRole.create({ data: { userId: "u1", roleId: "role-reader", source: "scim" } });
        await db.userRole.create({
          data: { userId: "u1", roleId: "role-developer", source: "unknown" },
        });
      }
      const snapshot = () =>
        db.user.findUnique({
          where: { id: "u1" },
          select: {
            authRoleAuthority: true,
            authRolesInitializedAt: true,
            roles: { orderBy: { roleId: "asc" } },
          },
        });
      const before = await snapshot();
      for (const operation of [
        { path: "displayName", value: "Alice Updated" },
        { value: { displayName: "Alice Updated Again" } },
      ]) {
        const response = await request(app)
          .patch("/scim/v2/Users/u1")
          .set("Authorization", "Bearer auth-provenance-test-token")
          .send({ Operations: [{ op: "replace", ...operation }] });
        expect(response.status).toBe(200);
        expect(await snapshot()).toEqual(before);
      }
      const expected = ["unknown", "provider"].includes(authRoleAuthority)
        ? "admin"
        : authRoleAuthority === "revoked"
          ? "reader"
          : "coordinator";
      expect(await resolveDurableRole("u1")).toBe(expected);
      expect(await login("admin")).toBe(expected);
      expect(await resolveDurableRole("u1")).toBe(expected);
    },
  );

  it.each([
    { path: "active", value: true },
    { path: "urn:ietf:params:scim:schemas:core:2.0:User:active", value: "true" },
    { value: { active: true, displayName: "Alice Still Active" } },
  ])("redundant activation preserves provider admin and live access: %j", async (operation) => {
    await createUser();
    await db.user.create({
      data: {
        id: "target",
        username: "target",
        displayName: "Target",
        email: "target@example.test",
      },
    });
    await db.user.update({ where: { id: "u1" }, data: { authRoleAuthority: "provider" } });
    expect(await login("admin")).toBe("admin");
    const snapshot = () =>
      db.user.findUniqueOrThrow({
        where: { id: "u1" },
        select: {
          status: true,
          authRoleAuthority: true,
          authRolesInitializedAt: true,
          roles: { orderBy: { roleId: "asc" } },
        },
      });
    const before = await snapshot();
    expect(before.roles).toMatchObject([{ roleId: "role-admin", source: "provider" }]);
    const token = issueTokens({
      userId: "u1",
      username: "alice",
      role: "admin",
      permissions: [],
      workspaces: [],
    }).accessToken;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app)
        .patch("/scim/v2/Users/u1")
        .set("Authorization", "Bearer auth-provenance-test-token")
        .send({ Operations: [{ op: "replace", ...operation }] });
      expect(response.status).toBe(200);
      expect(response.body.active).toBe(true);
      expect(await snapshot()).toEqual(before);
    }
    expect(state.revoke).not.toHaveBeenCalled();
    for (const freshLogin of [false, true]) {
      if (freshLogin) expect(await login("admin")).toBe("admin");
      expect(await resolveDurableRole("u1")).toBe("admin");
      const inspected = await request(app)
        .post("/api/admin/auth/role-reconciliation/inspect")
        .set("Authorization", `Bearer ${token}`)
        .send({ targetId: "target", username: "target" });
      expect(inspected.status).toBe(200);
    }
    expect(await snapshot()).toMatchObject({
      authRoleAuthority: "provider",
      roles: [{ roleId: "role-admin", source: "provider" }],
    });
  });

  it("activation takes SCIM authority, removes provider access, and survives later profile patches", async () => {
    await createUser();
    expect(await login("admin")).toBe("admin");
    await db.user.update({ where: { id: "u1" }, data: { status: "disabled" } });
    const activated = await request(app)
      .patch("/scim/v2/Users/u1")
      .set("Authorization", "Bearer auth-provenance-test-token")
      .send({ Operations: [{ op: "replace", path: "active", value: true }] });
    expect(activated.status).toBe(200);
    const before = await db.user.findUniqueOrThrow({ where: { id: "u1" } });
    expect(before).toMatchObject({
      status: "active",
      authRoleAuthority: "scim",
      authRolesInitializedAt: expect.any(Date),
    });
    expect(await db.userRole.count({ where: { userId: "u1" } })).toBe(0);
    const profile = await request(app)
      .patch("/scim/v2/Users/u1")
      .set("Authorization", "Bearer auth-provenance-test-token")
      .send({ Operations: [{ op: "replace", path: "displayName", value: "Alice Active" }] });
    expect(profile.status).toBe(200);
    expect(await db.user.findUniqueOrThrow({ where: { id: "u1" } })).toMatchObject({
      authRoleAuthority: "scim",
      authRolesInitializedAt: before.authRolesInitializedAt,
    });
    expect(await login("admin")).toBe("reader");
    expect(await resolveDurableRole("u1")).toBe("reader");
  });
  async function login(providerRole: "admin" | "reader", marker: Date | null = null) {
    return reconcileTrustedLoginRole({
      userId: "u1",
      providerRole,
      authRolesInitializedAt: marker,
    });
  }
  async function membership(role: string, op: "add" | "remove", filtered = false) {
    const response = await request(app)
      .patch(`/scim/v2/Groups/role-${role}`)
      .set("Authorization", "Bearer auth-provenance-test-token")
      .send({
        Operations: [
          {
            op,
            path: filtered ? 'members[value eq "u1"]' : "members",
            ...(filtered ? {} : { value: [{ value: "u1" }] }),
          },
        ],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response;
  }

  async function reconciliationFixture() {
    await createUser();
    await db.user.update({ where: { id: "u1" }, data: { authRolesInitializedAt: new Date() } });
    await db.user.create({
      data: {
        id: "admin",
        username: "operator",
        displayName: "Operator",
        email: "operator@example.test",
      },
    });
    await db.userRole.create({ data: { userId: "admin", roleId: "role-admin", source: "local" } });
    return { targetId: "u1", username: "alice" };
  }

  async function approval(decision: ReconciliationInput["decision"] = "provider-managed") {
    const target = { targetId: "u1", username: "alice" };
    const inspected = await inspectRolesForAdmin("admin", target);
    return {
      ...target,
      expectedFingerprint: inspected.fingerprint,
      decision,
      requestId: randomUUID(),
      reason: "Administrator verified ownership and intended authority",
    };
  }

  function runCli(args: string[], acknowledge = true) {
    let databaseUrl: string;
    const imports = ["--import", import.meta.resolve("tsx")];
    if (provider === "postgresql") {
      if (!postgresUrl) throw new Error("CLI requires the dedicated PostgreSQL fixture URL");
      const url = new URL(postgresUrl);
      url.searchParams.set("schema", schema);
      url.searchParams.set("options", `-c search_path=${schema}`);
      databaseUrl = url.href;
      // PrismaPg needs an explicit schema for qualified model queries, not just
      // search_path in the URL. Preload ONLY the fixture client into the existing
      // singleton seam; the CLI entrypoint and reconciliation remain real.
      const preload = `
        import { PrismaClient } from ${JSON.stringify(import.meta.resolve("@prisma/client"))};
        import { PrismaPg } from ${JSON.stringify(import.meta.resolve("@prisma/adapter-pg"))};
        globalThis.__metisPrisma = new PrismaClient({
          adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }, { schema: ${JSON.stringify(schema)} }),
        });
      `;
      imports.push("--import", `data:text/javascript,${encodeURIComponent(preload)}`);
    } else {
      if (!directory) throw new Error("CLI requires the temporary SQLite fixture directory");
      databaseUrl = `file:${join(directory, "auth.db")}`;
    }
    return execFileAsync(
      process.execPath,
      [
        ...imports,
        fileURLToPath(new URL("../src/lib/auth/role-reconciliation-cli.ts", import.meta.url)),
        ...args,
        "--operator",
        "integration host administrator",
        "--target-id",
        "u1",
        "--username",
        "alice",
        ...(acknowledge ? ["--acknowledge-host-authority"] : []),
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        // Do not inherit DATABASE_URL, NODE_OPTIONS, NODE_V8_COVERAGE or Vitest's
        // environment. Production mode and an explicit opt-out prevent a test
        // Prisma factory from substituting an unrelated in-memory database.
        env: { DATABASE_URL: databaseUrl, NODE_ENV: "production", METIS_TEST_IN_MEMORY_DB: "0" },
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        shell: false,
      },
    );
  }

  async function inspectCli() {
    const { stdout, stderr } = await runCli(["inspect"]);
    expect(stderr).toBe("");
    const inspected = JSON.parse(stdout) as Awaited<ReturnType<typeof inspectRolesForHost>>;
    expect(inspected).toMatchObject({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      state: { id: "u1", username: "alice" },
    });
    // Parsing the entire stdout (not a substring) also pins machine-readable output.
    expect(inspected).toEqual(
      await inspectRolesForHost("integration host administrator", {
        targetId: "u1",
        username: "alice",
      }),
    );
    return inspected;
  }

  function cliConfirmation(
    fingerprint: string,
    decision: ReconciliationInput["decision"] = "provider-managed",
    confirmation = `u1:alice:${decision}`,
  ) {
    return [
      "confirm",
      "--expected-fingerprint",
      fingerprint,
      "--request-id",
      randomUUID(),
      "--decision",
      decision,
      "--reason",
      "Host administrator verified legacy provider ownership",
      "--confirm",
      confirmation,
    ];
  }

  it("CLI inspects JSON, approves only reader, replays one audit, and requires trusted login before elevation", async () => {
    await reconciliationFixture();
    expect(await login("admin")).toBe("reader");
    const before = await inspectCli();
    expect(before.state).toMatchObject({ authority: "unknown", roles: [] });
    expect(await db.auditLog.count()).toBe(0);
    const args = cliConfirmation(before.fingerprint);
    const confirmed = await runCli(args);
    expect(confirmed.stderr).toBe("");
    const result = JSON.parse(confirmed.stdout) as Awaited<ReturnType<typeof confirmRolesForHost>>;
    expect(result).toMatchObject({
      replayed: false,
      state: { authority: "provider", roles: [{ key: "reader", source: "provider" }] },
    });
    expect(result.state.roles).toHaveLength(1);
    expect(await resolveDurableRole("u1")).toBe("reader");
    const auditBefore = await db.auditLog.findMany();
    expect(auditBefore).toHaveLength(1);
    expect(auditBefore[0]).toMatchObject({
      actorId: null,
      action: "admin.auth.role-reconciled",
      targetId: "u1",
    });
    expect(JSON.parse(auditBefore[0].metadata!)).toMatchObject({
      actor: { kind: "host-operator", name: "integration host administrator" },
    });
    const replay = await runCli(args);
    expect(replay.stderr).toBe("");
    expect(JSON.parse(replay.stdout)).toEqual({ ...result, replayed: true });
    expect(await db.auditLog.findMany()).toEqual(auditBefore);
    expect(await resolveDurableRole("u1")).toBe("reader");
    expect(await login("admin")).toBe("admin");

    const elevated = await inspectCli();
    const revoked = await runCli(cliConfirmation(elevated.fingerprint, "revoked"));
    expect(revoked.stderr).toBe("");
    expect(JSON.parse(revoked.stdout)).toMatchObject({
      replayed: false,
      state: { authority: "revoked", roles: [] },
    });
    expect(await resolveDurableRole("u1")).toBe("reader");
    expect(await login("admin")).toBe("reader");
    expect(await db.userRole.count({ where: { userId: "u1" } })).toBe(0);
    expect(await db.auditLog.count()).toBe(2);
  });

  it("CLI rejects a bad confirmation with nonzero exit and no mutation", async () => {
    await reconciliationFixture();
    const before = await inspectCli();
    await expect(
      runCli(cliConfirmation(before.fingerprint, "provider-managed", "yes")),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Confirmation must exactly match"),
    });
    expect(await inspectCli()).toEqual(before);
    expect(await db.auditLog.count()).toBe(0);
    expect(await login("admin")).toBe("reader");
  });

  it.each(["inspect", "confirm"])(
    "CLI refuses %s without host acknowledgment and makes no mutation",
    async (command) => {
      await reconciliationFixture();
      const before = await inspectCli();
      const args = command === "inspect" ? ["inspect"] : cliConfirmation(before.fingerprint);
      await expect(runCli(args, false)).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining("Usage: inspect|confirm"),
      });
      expect(await inspectCli()).toEqual(before);
      expect(await db.auditLog.count()).toBe(0);
      expect(await login("admin")).toBe("reader");
    },
  );

  it("CLI host acknowledgment cannot bypass SCIM authority after its final grant is revoked", async () => {
    await reconciliationFixture();
    await membership("coordinator", "add");
    await membership("coordinator", "remove");
    const before = await inspectCli();
    expect(before.state).toMatchObject({ authority: "scim", roles: [] });
    const auditBefore = await db.auditLog.findMany();
    await expect(runCli(cliConfirmation(before.fingerprint))).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Explicit or SCIM authority cannot be converted"),
    });
    expect(await inspectCli()).toEqual(before);
    expect(await db.auditLog.findMany()).toEqual(auditBefore);
    expect(await login("admin")).toBe("reader");
  });

  it("requires explicit legacy approval, installs only reader and elevates only on the next trusted login", async () => {
    await reconciliationFixture();
    expect(await login("admin")).toBe("reader");
    const actorBefore = await db.user.findUniqueOrThrow({
      where: { id: "admin" },
      include: { roles: true },
    });
    const input = await approval();
    const result = await confirmRolesForAdmin("admin", input);
    expect(result.state).toMatchObject({
      authority: "provider",
      roles: [{ key: "reader", source: "provider" }],
    });
    expect(await resolveDurableRole("u1")).toBe("reader");
    const replay = await confirmRolesForAdmin("admin", input);
    expect(replay).toEqual({ ...result, replayed: true });
    expect(await db.auditLog.count()).toBe(1);
    expect(
      await db.user.findUniqueOrThrow({ where: { id: "admin" }, include: { roles: true } }),
    ).toEqual(actorBefore);
    await expect(
      confirmRolesForAdmin("admin", {
        ...input,
        reason: "A different reason with the same request ID",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await login("admin")).toBe("admin");
    await expect(confirmRolesForAdmin("admin", input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects cross-target idempotency replay and username mismatch", async () => {
    await reconciliationFixture();
    const input = await approval();
    await confirmRolesForAdmin("admin", input);
    await db.user.create({
      data: { id: "other", username: "other", displayName: "Other", email: "other@example.test" },
    });
    const other = await inspectRolesForAdmin("admin", { targetId: "other", username: "other" });
    await expect(
      confirmRolesForAdmin("admin", {
        ...input,
        targetId: "other",
        username: "other",
        expectedFingerprint: other.fingerprint,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      inspectRolesForAdmin("admin", { targetId: "u1", username: "other" }),
    ).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(await db.userRole.count({ where: { userId: "other" } })).toBe(0);
    expect(await db.auditLog.count()).toBe(1);
  });

  it.each(["local", "unknown", "scim"])(
    "preserves %s explicit grants on keep/revoke and refuses provider conversion",
    async (source) => {
      await reconciliationFixture();
      await db.userRole.create({ data: { userId: "u1", roleId: "role-coordinator", source } });
      await expect(confirmRolesForAdmin("admin", await approval())).rejects.toMatchObject({
        code: "EXPLICIT_AUTHORITY",
      });
      for (const decision of ["keep-explicit", "revoked"] as const) {
        await confirmRolesForAdmin("admin", await approval(decision));
        expect(await login("admin")).toBe("coordinator");
        expect(await db.userRole.findMany({ where: { userId: "u1" } })).toMatchObject([
          { roleId: "role-coordinator", source },
        ]);
      }
    },
  );

  it("revoked provider access stays reader despite later provider admin claims", async () => {
    await reconciliationFixture();
    await confirmRolesForAdmin("admin", await approval());
    await login("admin");
    await confirmRolesForAdmin("admin", await approval("revoked"));
    expect(await login("admin")).toBe("reader");
    expect(await db.user.findUnique({ where: { id: "u1" } })).toMatchObject({
      authRoleAuthority: "revoked",
    });
  });

  it("SCIM assignment then last revoke invalidates approval and retains authority without rows", async () => {
    await reconciliationFixture();
    const pending = await approval();
    await membership("coordinator", "add");
    await expect(confirmRolesForAdmin("admin", pending)).rejects.toMatchObject({
      code: "RECONCILIATION_CONFLICT",
    });
    await membership("coordinator", "remove");
    expect(await db.userRole.count({ where: { userId: "u1" } })).toBe(0);
    await expect(confirmRolesForAdmin("admin", await approval())).rejects.toMatchObject({
      code: "EXPLICIT_AUTHORITY",
    });
    const inspected = await inspectRolesForHost("named host operator", {
      targetId: "u1",
      username: "alice",
    });
    await expect(
      confirmRolesForHost(
        "named host operator",
        { ...pending, expectedFingerprint: inspected.fingerprint },
        "u1:alice:provider-managed",
      ),
    ).rejects.toMatchObject({ code: "EXPLICIT_AUTHORITY" });
    expect(await login("admin")).toBe("reader");
  });

  it("supports audited offline recovery when there is no remaining durable admin", async () => {
    await createUser();
    await db.user.update({ where: { id: "u1" }, data: { authRolesInitializedAt: new Date() } });
    const target = { targetId: "u1", username: "alice" };
    const before = await inspectRolesForHost("on-call administrator", target);
    const input = {
      ...target,
      expectedFingerprint: before.fingerprint,
      decision: "provider-managed" as const,
      requestId: randomUUID(),
      reason: "Verified legacy provider-only administrator during recovery",
    };
    expect(() => confirmRolesForHost("on-call administrator", input, "yes")).toThrow(
      "Confirmation",
    );
    await confirmRolesForHost("on-call administrator", input, "u1:alice:provider-managed");
    const audit = await db.auditLog.findFirstOrThrow();
    expect(audit.actorId).toBeNull();
    expect(JSON.parse(audit.metadata!)).toMatchObject({
      actor: { kind: "host-operator", name: "on-call administrator" },
      reason: input.reason,
    });
    expect(await resolveDurableRole("u1")).toBe("reader");
    expect(await login("admin")).toBe("admin");
  });

  it("rolls back all user/role mutations if transactional audit insertion fails", async () => {
    await reconciliationFixture();
    const input = await approval();
    const target = { targetId: input.targetId, username: input.username };
    const before = await inspectRolesForAdmin("admin", target);
    if (provider === "postgresql") {
      await db.$executeRawUnsafe(
        `CREATE FUNCTION reject_auth_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER reject_auth_audit BEFORE INSERT ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION reject_auth_audit()`,
      );
    } else {
      await db.$executeRawUnsafe(
        `CREATE TRIGGER reject_auth_audit BEFORE INSERT ON "audit_logs" BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
      );
    }
    try {
      await expect(confirmRolesForAdmin("admin", input)).rejects.toThrow();
      expect(await inspectRolesForAdmin("admin", target)).toEqual(before);
      expect(await db.auditLog.count()).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        provider === "postgresql"
          ? `DROP TRIGGER reject_auth_audit ON "audit_logs"`
          : `DROP TRIGGER reject_auth_audit`,
      );
      if (provider === "postgresql")
        await db.$executeRawUnsafe(`DROP FUNCTION reject_auth_audit()`);
    }
  });

  it("serializes competing approve/revoke decisions so only one stale snapshot can commit", async () => {
    await reconciliationFixture();
    const input = await approval();
    const results = await Promise.allSettled([
      confirmRolesForAdmin("admin", input),
      confirmRolesForAdmin("admin", { ...input, decision: "revoked", requestId: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.auditLog.count()).toBe(1);
    const current = await inspectRolesForAdmin("admin", {
      targetId: input.targetId,
      username: input.username,
    });
    expect(current.state.roles.every((row) => row.key === "reader")).toBe(true);
  });

  it("orders SCIM against approval: a winning SCIM revoke cannot be undone by a pending approval", async () => {
    await reconciliationFixture();
    await confirmRolesForAdmin("admin", await approval());
    const pending = await approval();
    await membership("coordinator", "add");
    const results = await Promise.allSettled([
      confirmRolesForAdmin("admin", pending),
      membership("coordinator", "remove"),
    ]);
    expect(results[0].status).toBe("rejected");
    if (results[1].status === "rejected") await membership("coordinator", "remove");
    expect(await login("admin")).toBe("reader");
    expect(await db.user.findUnique({ where: { id: "u1" } })).toMatchObject({
      authRoleAuthority: "scim",
    });
  });

  it("keeps SCIM authoritative when a valid approval overlaps actual provider-membership revocation", async () => {
    await reconciliationFixture();
    await confirmRolesForAdmin("admin", await approval());
    const pending = await approval();
    // Both requests start with a valid reader membership and a valid snapshot.
    // Whichever commits first, a completed SCIM removal must dominate. Retry
    // only an aborted SCIM transaction, never the stale administrator decision.
    const results = await Promise.allSettled([
      confirmRolesForAdmin("admin", pending),
      membership("reader", "remove"),
    ]);
    if (results[1].status === "rejected") await membership("reader", "remove");
    expect(await db.userRole.count({ where: { userId: "u1" } })).toBe(0);
    expect(await db.user.findUnique({ where: { id: "u1" } })).toMatchObject({
      authRoleAuthority: "scim",
    });
    await expect(confirmRolesForAdmin("admin", pending)).rejects.toMatchObject({ statusCode: 409 });
    await expect(confirmRolesForAdmin("admin", await approval())).rejects.toMatchObject({
      code: "EXPLICIT_AUTHORITY",
    });
    expect(await login("admin")).toBe("reader");
  });

  it.each([false, true])(
    "absent/local SCIM removal preserves the entire authority snapshot (local=%s)",
    async (local) => {
      await reconciliationFixture();
      if (local)
        await db.userRole.create({
          data: { userId: "u1", roleId: "role-reader", source: "local" },
        });
      const target = { targetId: "u1", username: "alice" };
      const before = await inspectRolesForAdmin("admin", target);
      await membership("reader", "remove");
      expect(await inspectRolesForAdmin("admin", target)).toEqual(before);
    },
  );

  it("checks live actor state through real signed JWT middleware on both inspection and confirmation", async () => {
    const target = await reconciliationFixture();
    const token = issueTokens({
      userId: "admin",
      username: "operator",
      role: "admin",
      permissions: [],
      workspaces: [],
    }).accessToken;
    const base = "/api/admin/auth/role-reconciliation";
    const inspected = await request(app)
      .post(`${base}/inspect`)
      .set("Authorization", `Bearer ${token}`)
      .send(target);
    expect(inspected.status).toBe(200);
    const input = { ...(await approval()), expectedFingerprint: inspected.body.data.fingerprint };
    await db.userRole.deleteMany({ where: { userId: "admin" } });
    for (const endpoint of ["inspect", "confirm"]) {
      const response = await request(app)
        .post(`${base}/${endpoint}`)
        .set("Authorization", `Bearer ${token}`)
        .send(endpoint === "inspect" ? target : input);
      expect(response.status).toBe(403);
    }
    expect(await db.auditLog.count()).toBe(0);
  });

  it("persists provider downgrade and upgrade across actual transactions", async () => {
    await createUser();
    expect(await login("admin")).toBe("admin");
    expect(await login("reader")).toBe("reader");
    expect(await db.userRole.findMany()).toMatchObject([
      { roleId: "role-reader", source: "provider" },
    ]);
    expect(await login("admin")).toBe("admin");
    expect(await db.userRole.findMany()).toMatchObject([
      { roleId: "role-admin", source: "provider" },
    ]);
  });

  it("provisions a SCIM user with an initialized no-role state, then assigns and revokes a group", async () => {
    const response = await request(app)
      .post("/scim/v2/Users")
      .set("Authorization", "Bearer auth-provenance-test-token")
      .send({ userName: "alice", displayName: "Alice", emails: [{ value: "alice@example.test" }] });
    expect(response.status).toBe(201);
    const userId = response.body.id as string;
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: userId } })).authRolesInitializedAt,
    ).toBeInstanceOf(Date);
    expect(
      await reconcileTrustedLoginRole({
        userId,
        providerRole: "admin",
        authRolesInitializedAt: null,
      }),
    ).toBe("reader");
    for (const op of ["add", "remove"]) {
      const group = await request(app)
        .patch("/scim/v2/Groups/role-coordinator")
        .set("Authorization", "Bearer auth-provenance-test-token")
        .send({ Operations: [{ op, path: "members", value: [{ value: userId }] }] });
      expect(group.status, JSON.stringify(group.body)).toBe(200);
      expect(await resolveDurableRole(userId)).toBe(op === "add" ? "coordinator" : "reader");
    }
    expect(
      await reconcileTrustedLoginRole({
        userId,
        providerRole: "admin",
        authRolesInitializedAt: null,
      }),
    ).toBe("reader");
    expect(await db.userRole.count()).toBe(0);
  });

  it.each([false, true])(
    "SCIM revoke clears a leftover provider admin (filtered=%s)",
    async (filtered) => {
      await createUser();
      await login("admin");
      await membership("reader", "add");
      expect(await db.userRole.findMany()).toMatchObject([
        { roleId: "role-reader", source: "scim" },
      ]);
      // Reproduce mixed legacy provenance, not just the cleaned-up add path.
      await db.userRole.create({
        data: { userId: "u1", roleId: "role-admin", source: "provider" },
      });
      await membership("reader", "remove", filtered);
      expect(await resolveDurableRole("u1")).toBe("reader");
      expect(await login("admin")).toBe("reader");
      expect(await db.userRole.count()).toBe(0);
    },
  );

  it.each([false, true])(
    "removing an absent membership preserves unrelated provider permissions (filtered=%s)",
    async (filtered) => {
      await createUser();
      await login("admin");
      await membership("reader", "remove", filtered);
      expect(await db.userRole.findMany()).toMatchObject([
        { roleId: "role-admin", source: "provider" },
      ]);
      expect(await login("admin")).toBe("admin");
    },
  );

  it("preserves local provenance when SCIM adds/removes the same role", async () => {
    await createUser();
    await db.userRole.create({
      data: { userId: "u1", roleId: "role-coordinator", source: "local" },
    });
    await membership("coordinator", "add");
    await membership("coordinator", "remove");
    expect(await db.userRole.findMany()).toMatchObject([
      { roleId: "role-coordinator", source: "local" },
    ]);
    expect(await login("admin")).toBe("coordinator");
  });

  it.each([false, true])(
    "revokes a targeted legacy unknown membership (filtered=%s)",
    async (filtered) => {
      await createUser();
      await db.userRole.create({ data: { userId: "u1", roleId: "role-admin", source: "unknown" } });
      await membership("admin", "remove", filtered);
      expect(await db.userRole.count()).toBe(0);
      expect(await login("admin")).toBe("reader");
    },
  );

  it("keeps a same-role SCIM grant explicit through provider reconciliation", async () => {
    await createUser();
    await login("admin");
    await membership("admin", "add");
    expect(await login("reader")).toBe("admin");
    expect(await db.userRole.findMany()).toMatchObject([{ roleId: "role-admin", source: "scim" }]);
  });

  it("keeps an explicit assignment when a login and SCIM assignment overlap", async () => {
    await createUser();
    await login("reader");
    const results = await Promise.allSettled([login("admin"), membership("coordinator", "add")]);
    // A serialization conflict may reject either transaction; retry SCIM only.
    if (results[1].status === "rejected") await membership("coordinator", "add");
    expect(await login("admin")).toBe("coordinator");
    expect(await db.userRole.findMany()).toMatchObject([
      { roleId: "role-coordinator", source: "scim" },
    ]);
  });

  it("deactivation revokes sessions and prevents trusted login", async () => {
    await createUser();
    await login("admin");
    const response = await request(app)
      .patch("/scim/v2/Users/u1")
      .set("Authorization", "Bearer auth-provenance-test-token")
      .send({ Operations: [{ op: "replace", path: "active", value: false }] });
    expect(response.status).toBe(200);
    expect(response.body.active).toBe(false);
    expect(state.revoke).toHaveBeenCalledWith("u1");
    await expect(login("admin")).rejects.toThrow("Login user is unavailable");
  });

  it("unauthorized provisioning does not write any users", async () => {
    const response = await request(app).post("/scim/v2/Users").send({ userName: "intruder" });
    expect(response.status).toBe(401);
    expect(await db.user.count()).toBe(0);
  });
  it("deleting a custom SCIM group cannot uncover a provider grant", async () => {
    await createUser();
    const response = await request(app)
      .post("/scim/v2/Groups")
      .set("Authorization", "Bearer auth-provenance-test-token")
      .send({ displayName: "custom-group" });
    expect(response.status).toBe(201);
    await db.userRole.create({
      data: { userId: "u1", roleId: response.body.id as string, source: "scim" },
    });
    await db.userRole.create({ data: { userId: "u1", roleId: "role-admin", source: "provider" } });
    const deleted = await request(app)
      .delete(`/scim/v2/Groups/${response.body.id}`)
      .set("Authorization", "Bearer auth-provenance-test-token");
    expect(deleted.status).toBe(204);
    expect(await login("admin")).toBe("reader");
    expect(await db.userRole.count()).toBe(0);
  });
});
