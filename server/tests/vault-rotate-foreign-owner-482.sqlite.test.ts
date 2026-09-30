/**
 * #482 — an admin rotating a vault secret another user owns is refused with 409
 * VAULT_ROTATE_FOREIGN_OWNER unless the request sets `confirmForeignOwner`,
 * proven through the REAL vault router, vault service and audit service against
 * a REAL SQLite database built from the migration chain.
 *
 * The refusal names the owner and the resources the secret is bound to; it
 * writes nothing (the stored value is read back and still decrypts to the
 * owner's). With the flag the rotation lands and its audit row records the
 * confirmation. Rotating your own secret, or one no user owns, is unchanged.
 */
import express from "express";
import request from "supertest";
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

const { vaultRouter } = await import("../src/routes/vault.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

const OWNER_VALUE = "coordinator-own-token-482";
const ADMIN_VALUE = "admin-real-token-482";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#482 — vault rotate refuses a secret another user owns unless confirmed",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let adminToken = "";
    let n = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/vault", vaultRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const rotate = (id: string, body: Record<string, unknown>) =>
      request(app())
        .post(`/api/vault/${id}/rotate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body);

    const plaintextOf = async (id: string) => (await getVaultService().read(id)).plaintext;
    const rotateAudit = async (id: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.rotate", targetType: "secret", targetId: id },
      });
    };
    const newSecret = async (createdById: string | undefined) => {
      n += 1;
      return (
        await getVaultService().create(`s482-${n}`, OWNER_VALUE, "global", {
          ...(createdById ? { createdById } : {}),
        })
      ).id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("482-vault-rotate-foreign");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();
      for (const [id, displayName] of [
        ["u-admin", "Ada Admin"],
        ["u-coord", "Cora Coordinator"],
      ]) {
        await db.user.create({
          data: { id, username: id, displayName, email: `${id}@example.test` },
        });
      }
      await db.project.create({
        data: { id: "proj-1", name: "proj-1", slug: "proj-1", createdById: "u-coord" },
      });
      adminToken = issueTokens({
        userId: "u-admin",
        username: "u-admin",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("refuses another user's secret with 409, naming the owner and bindings, and writes nothing", async () => {
      const id = await newSecret("u-coord");
      await db.databaseConnection.create({
        data: {
          id: "db-coord",
          projectId: "proj-1",
          label: "Coord DB",
          driver: "postgres",
          host: "db.coord.example",
          port: 5432,
          secretId: id,
        },
      });
      await db.repoConnection.create({
        data: {
          id: "repo-coord",
          projectId: "proj-1",
          label: "Coord Repo",
          provider: "github_enterprise",
          apiBaseUrl: "https://ghe.coord.example/api/v3",
          secretId: id,
        },
      });
      await db.mCPServer.create({
        data: {
          id: "mcp-coord",
          scope: "project",
          projectId: "proj-1",
          label: "Coord MCP",
          transport: "stdio",
          command: "coord-mcp",
          envSecretId: id,
        },
      });
      await db.jiraConnection.create({
        data: {
          id: "jira-coord",
          projectId: "proj-1",
          label: "Coord Jira",
          edition: "cloud",
          baseUrl: "https://coord.atlassian.example",
          username: "cora",
          secretId: id,
          createdById: "u-coord",
        },
      });
      // A deleted connector is not a binding.
      await db.databaseConnection.create({
        data: {
          id: "db-gone",
          projectId: "proj-1",
          label: "Gone DB",
          driver: "postgres",
          host: "gone.example",
          secretId: id,
          deletedAt: new Date(),
        },
      });

      for (const body of [
        { value: ADMIN_VALUE },
        { value: ADMIN_VALUE, confirmForeignOwner: false },
      ]) {
        const res = await rotate(id, body);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("VAULT_ROTATE_FOREIGN_OWNER");
        expect(res.body.error.message).toContain("Cora Coordinator");
        expect(res.body.error.message).toContain("db.coord.example");
        expect(res.body.error.details.owner).toEqual({
          id: "u-coord",
          username: "u-coord",
          displayName: "Cora Coordinator",
        });
        const bindings = res.body.error.details.bindings as Array<Record<string, unknown>>;
        expect(bindings).toEqual(
          expect.arrayContaining([
            {
              type: "db_connector",
              id: "db-coord",
              label: "Coord DB",
              projectId: "proj-1",
              destination: "postgres://db.coord.example:5432",
            },
            {
              type: "repo_connector",
              id: "repo-coord",
              label: "Coord Repo",
              projectId: "proj-1",
              destination: "https://ghe.coord.example/api/v3",
            },
            {
              type: "mcp_server",
              id: "mcp-coord",
              label: "Coord MCP",
              projectId: "proj-1",
              destination: "coord-mcp",
            },
            {
              type: "jira_connection",
              id: "jira-coord",
              label: "Coord Jira",
              projectId: "proj-1",
              destination: "https://coord.atlassian.example",
            },
          ]),
        );
        expect(bindings).toHaveLength(4);
        expect(JSON.stringify(res.body)).not.toContain(ADMIN_VALUE);
      }

      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    it("an unbound foreign secret is refused too, and says so", async () => {
      const id = await newSecret("u-coord");
      const res = await rotate(id, { value: ADMIN_VALUE });
      expect(res.status).toBe(409);
      expect(res.body.error.details.bindings).toEqual([]);
      expect(res.body.error.message).toContain("not bound");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });

    it("with confirmForeignOwner the rotation lands and is audited as confirmed", async () => {
      const id = await newSecret("u-coord");
      const res = await rotate(id, { value: ADMIN_VALUE, confirmForeignOwner: true });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);

      const rows = await rotateAudit(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBe("u-admin");
      const meta = JSON.parse(rows[0]!.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.foreignOwnerConfirmed).toBe(true);
      expect(meta.ownerId).toBe("u-coord");
      expect(JSON.stringify(rows[0])).not.toContain(ADMIN_VALUE);
    });

    it("rotating your own secret is unchanged: no flag needed, no confirmation recorded", async () => {
      const id = await newSecret("u-admin");
      const res = await rotate(id, { value: ADMIN_VALUE });
      expect(res.status).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);
      const rows = await rotateAudit(id);
      expect(rows).toHaveLength(1);
      const meta = JSON.parse(rows[0]!.metadata ?? "{}") as Record<string, unknown>;
      expect(meta).not.toHaveProperty("foreignOwnerConfirmed");
      expect(meta).not.toHaveProperty("ownerId");
    });

    it("a secret no user owns (system-written) rotates without the flag", async () => {
      const id = await newSecret(undefined);
      const res = await rotate(id, { value: ADMIN_VALUE });
      expect(res.status).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);
    });

    it("an unknown or deleted id is still 404, with or without the flag", async () => {
      const gone = await newSecret("u-coord");
      await getVaultService().delete(gone);
      for (const id of ["does-not-exist", gone]) {
        for (const confirmForeignOwner of [undefined, true]) {
          const res = await rotate(id, { value: ADMIN_VALUE, confirmForeignOwner });
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe("SECRET_NOT_FOUND");
        }
      }
    });

    it("rejects a non-boolean confirm flag as an invalid body", async () => {
      const id = await newSecret("u-coord");
      const res = await rotate(id, { value: ADMIN_VALUE, confirmForeignOwner: "yes" });
      expect(res.status).toBe(400);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });
  },
);
