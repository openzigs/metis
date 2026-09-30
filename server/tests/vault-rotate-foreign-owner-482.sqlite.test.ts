/**
 * #482 — an admin rotating a vault secret another user owns is refused with 409
 * VAULT_ROTATE_FOREIGN_OWNER unless the request sets `confirmForeignOwner`,
 * proven through the REAL vault router, vault service and audit service against
 * a REAL SQLite database built from the migration chain.
 *
 * The refusal names the owner and the resources the secret is bound to —
 * including MCP servers whose env / headers hold a `${vault:x}` ref to it; it
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
    let lastLabel = "";
    const newSecret = async (createdById: string | undefined) => {
      n += 1;
      lastLabel = `s482-${n}`;
      return (
        await getVaultService().create(lastLabel, OWNER_VALUE, "global", {
          ...(createdById ? { createdById } : {}),
        })
      ).id;
    };
    const mcpServer = (
      id: string,
      label: string,
      fields: { envJson?: string; headers?: string; url?: string; command?: string },
    ) =>
      db.mCPServer.create({
        data: {
          id,
          scope: "project",
          projectId: "proj-1",
          label,
          transport: fields.url ? "http" : "stdio",
          ...fields,
        },
      });

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
      await db.importSource.create({
        data: {
          id: "imp-coord",
          projectId: "proj-1",
          analysisId: "an-1",
          source: "linear",
          label: "Coord Linear",
          baseUrl: "https://linear.coord.example",
          secretId: id,
          createdById: "u-coord",
        },
      });
      // MCP bindings are `${vault:<label>}` refs in env / headers, as the
      // importer and `routes/mcp.ts` write them — by label and by id.
      await mcpServer("mcp-coord", "Coord MCP", {
        command: "coord-mcp",
        envJson: JSON.stringify({ TOKEN: `\${vault:${lastLabel}}`, MODE: "prod" }),
      });
      await mcpServer("mcp-coord-http", "Coord MCP HTTP", {
        url: "https://mcp.coord.example",
        headers: JSON.stringify({ Authorization: `Bearer \${vault:${id}}` }),
      });
      // A server referencing some other secret is not a binding of this one.
      await mcpServer("mcp-other", "Other MCP", {
        command: "other-mcp",
        envJson: JSON.stringify({ TOKEN: "${vault:someone-else}" }),
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
              type: "import_source",
              id: "imp-coord",
              label: "Coord Linear",
              projectId: "proj-1",
              destination: "https://linear.coord.example",
            },
            {
              type: "mcp_server",
              id: "mcp-coord",
              label: "Coord MCP",
              projectId: "proj-1",
              destination: "coord-mcp",
            },
            {
              type: "mcp_server",
              id: "mcp-coord-http",
              label: "Coord MCP HTTP",
              projectId: "proj-1",
              destination: "https://mcp.coord.example",
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
        expect(bindings).toHaveLength(6);
        expect(JSON.stringify(res.body)).not.toContain(ADMIN_VALUE);
      }

      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    it("an unbound foreign secret is refused too, and says only what was checked", async () => {
      const id = await newSecret("u-coord");
      const res = await rotate(id, { value: ADMIN_VALUE });
      expect(res.status).toBe(409);
      expect(res.body.error.details.bindings).toEqual([]);
      expect(res.body.error.message).toContain("were not checked");
      expect(res.body.error.message).not.toContain("not bound");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });

    it("names an MCP server as the only binding when its env holds a ${vault:label} ref", async () => {
      const id = await newSecret("u-coord");
      await mcpServer("mcp-only", "Only MCP", {
        command: "only-mcp",
        envJson: JSON.stringify({ API_KEY: `\${vault:global:${lastLabel}}` }),
      });
      const res = await rotate(id, { value: ADMIN_VALUE });
      expect(res.status).toBe(409);
      expect(res.body.error.details.bindings).toEqual([
        {
          type: "mcp_server",
          id: "mcp-only",
          label: "Only MCP",
          projectId: "proj-1",
          destination: "only-mcp",
        },
      ]);
      expect(res.body.error.message).toContain("bound to Only MCP (only-mcp)");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });

    it("rotates only against the owner it checked (compare-and-swap on createdById)", async () => {
      const id = await newSecret("u-admin");
      const svc = getVaultService();
      const real = svc.rotate.bind(svc);
      // The owner changes between the route's owner check and its write.
      const spy = vi.spyOn(svc, "rotate").mockImplementationOnce(async (...args) => {
        await db.secret.update({ where: { id }, data: { createdById: "u-coord" } });
        return real(...args);
      });
      try {
        const res = await rotate(id, { value: ADMIN_VALUE });
        expect(res.status).toBe(404);
      } finally {
        spy.mockRestore();
      }
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });

    it("with confirmForeignOwner and the bindings shown, the rotation lands and is audited as confirmed", async () => {
      const id = await newSecret("u-coord");
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingIds: [],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);

      const rows = await rotateAudit(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBe("u-admin");
      const meta = JSON.parse(rows[0]!.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.foreignOwnerConfirmed).toBe(true);
      expect(meta.ownerId).toBe("u-coord");
      expect(meta.confirmedBindingIds).toEqual([]);
      expect(JSON.stringify(rows[0])).not.toContain(ADMIN_VALUE);
    });

    // ── #502 — the confirm is tied to the bindings shown ──────────────────
    const bindDb = (id: string, secretId: string, host: string) =>
      db.databaseConnection.create({
        data: { id, projectId: "proj-1", label: id, driver: "postgres", host, secretId },
      });

    it("#502: a confirm without the binding ids it was shown is refused and writes nothing", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-502-a", id, "a.coord.example");
      const res = await rotate(id, { value: ADMIN_VALUE, confirmForeignOwner: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_FOREIGN_OWNER");
      expect(res.body.error.details.bindings.map((b: { id: string }) => b.id)).toEqual([
        "db-502-a",
      ]);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    it("#502: a binding added after the 409 refuses the confirm with the live list", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-502-b", id, "b.coord.example");
      const first = await rotate(id, { value: ADMIN_VALUE });
      expect(first.status).toBe(409);
      const shown = (first.body.error.details.bindings as Array<{ id: string }>).map((b) => b.id);
      expect(shown).toEqual(["db-502-b"]);

      // The owner re-points the secret at a new host before "Rotate anyway".
      await bindDb("db-502-b2", id, "evil.coord.example");
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingIds: shown,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      expect(res.body.error.message).toContain("evil.coord.example");
      expect(
        (res.body.error.details.bindings as Array<{ id: string }>).map((b) => b.id).sort(),
      ).toEqual(["db-502-b", "db-502-b2"]);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    it("#502: a binding removed after the 409 refuses the confirm too", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-502-c", id, "c.coord.example");
      await db.databaseConnection.update({
        where: { id: "db-502-c" },
        data: { deletedAt: new Date() },
      });
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingIds: ["db-502-c"],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      expect(res.body.error.details.bindings).toEqual([]);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });

    it("#502: the exact bindings shown (any order) rotate, record the ids, and transfer ownership", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-502-d1", id, "d1.coord.example");
      await bindDb("db-502-d2", id, "d2.coord.example");
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingIds: ["db-502-d2", "db-502-d1"],
      });
      expect(res.status).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);

      const rows = await rotateAudit(id);
      expect(rows).toHaveLength(1);
      const meta = JSON.parse(rows[0]!.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.confirmedBindingIds).toEqual(["db-502-d1", "db-502-d2"]);
      expect(meta.ownerId).toBe("u-coord");
      expect(meta.ownershipTransferredTo).toBe("u-admin");

      // Read back through the path the binding check uses: the admin now owns it.
      const row = await db.secret.findUniqueOrThrow({ where: { id } });
      expect(row.createdById).toBe("u-admin");
      // A later rotation by the admin is their own secret: no confirm needed.
      const again = await rotate(id, { value: `${ADMIN_VALUE}-2` });
      expect(again.status).toBe(200);
    });

    it("#502: after a confirmed foreign rotation the old owner cannot bind it anywhere new", async () => {
      const { assertSecretBindingAllowed } = await import("../src/lib/vault/secret-binding.js");
      const coord = { userId: "u-coord", role: "coordinator" as const };
      const ctx = { target: { type: "db_connector", id: "db-502-new" } };
      const id = await newSecret("u-coord");
      await bindDb("db-502-e", id, "e.coord.example");

      // Before: the owner may attach their own secret anywhere (rule 1).
      await expect(
        assertSecretBindingAllowed(
          coord,
          { before: [], after: [id], destinationChanged: true },
          ctx,
        ),
      ).resolves.toBeUndefined();

      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindingIds: ["db-502-e"],
      });
      expect(res.status).toBe(200);

      // After: a new destination is refused, by id and by label.
      for (const ref of [id, lastLabel]) {
        await expect(
          assertSecretBindingAllowed(
            coord,
            { before: [], after: [ref], destinationChanged: true },
            ctx,
          ),
        ).rejects.toMatchObject({ statusCode: 403, code: "SECRET_BINDING_FORBIDDEN" });
      }
      // Re-pointing the existing binding at a new host is refused too.
      await expect(
        assertSecretBindingAllowed(
          coord,
          { before: [id], after: [id], destinationChanged: true },
          ctx,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      // Rule 2: the existing binding keeps working where it is.
      await expect(
        assertSecretBindingAllowed(
          coord,
          { before: [id], after: [id], destinationChanged: false },
          ctx,
        ),
      ).resolves.toBeUndefined();
    });

    it("#502: rejects a malformed confirmedBindingIds as an invalid body", async () => {
      const id = await newSecret("u-coord");
      for (const confirmedBindingIds of ["db-1", [1], Array.from({ length: 1001 }, () => "x")]) {
        const res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindingIds,
        });
        expect(res.status).toBe(400);
      }
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
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
