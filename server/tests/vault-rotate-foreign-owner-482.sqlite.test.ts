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
import { createHash } from "node:crypto";
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

const {
  vaultRouter,
  CONFIRMED_BINDING_DESTINATION_MAX,
  CONFIRMED_BINDING_ID_MAX,
  MAX_CONFIRMED_BINDINGS,
  SECRET_VALUE_MAX,
} = await import("../src/routes/vault.js");
const { JSON_LIMIT_BYTES } = await import("../src/lib/config/json-limit.js");
/** A well-formed routing digest that matches no live binding. */
const HEX64 = "ab".repeat(32);
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { routingDigest, routingFields } = await import("../src/lib/vault/rotate-foreign-owner.js");

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
              routing: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
            {
              type: "repo_connector",
              id: "repo-coord",
              label: "Coord Repo",
              projectId: "proj-1",
              destination: "https://ghe.coord.example/api/v3",
              routing: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
            {
              type: "import_source",
              id: "imp-coord",
              label: "Coord Linear",
              projectId: "proj-1",
              destination: "https://linear.coord.example",
              routing: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
            {
              type: "mcp_server",
              id: "mcp-coord",
              label: "Coord MCP",
              projectId: "proj-1",
              destination: "coord-mcp",
              routing: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
            {
              type: "mcp_server",
              id: "mcp-coord-http",
              label: "Coord MCP HTTP",
              projectId: "proj-1",
              destination: "https://mcp.coord.example",
              routing: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
            {
              type: "jira_connection",
              id: "jira-coord",
              label: "Coord Jira",
              projectId: "proj-1",
              destination: "https://coord.atlassian.example",
              routing: expect.stringMatching(/^[0-9a-f]{64}$/),
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
          routing: expect.stringMatching(/^[0-9a-f]{64}$/),
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
        confirmedBindings: [],
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
      expect(meta.confirmedBindings).toEqual([]);
      expect(JSON.stringify(rows[0])).not.toContain(ADMIN_VALUE);
    });

    // ── #502 — the confirm is tied to the bindings shown ──────────────────
    const bindDb = (id: string, secretId: string, host: string) =>
      db.databaseConnection.create({
        data: { id, projectId: "proj-1", label: id, driver: "postgres", host, secretId },
      });
    type Shown = { type: string; id: string; destination: string | null; routing: string };
    /** What the admin echoes back: the type, id, destination and routing of each binding shown. */
    const shownIn = (res: request.Response): Shown[] =>
      (res.body.error.details.bindings as Shown[]).map(({ type, id, destination, routing }) => ({
        type,
        id,
        destination,
        routing,
      }));
    /** #557 — a DB binding as the 409 shows it, digest computed the way the server does. */
    const pg = (id: string, host: string, databaseName: string | null = null): Shown => ({
      type: "db_connector",
      id,
      destination: `postgres://${host}`,
      routing: routingDigest(
        "db_connector",
        id,
        routingFields.db_connector({
          driver: "postgres",
          host,
          port: null,
          databaseName,
          options: null,
        }),
      ),
    });

    it("#502: a confirm without the bindings it was shown is refused and writes nothing", async () => {
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

    it("#502: a binding re-pointed at a new host under the same id refuses the confirm", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-502-r", id, "r.coord.example");
      const first = await rotate(id, { value: ADMIN_VALUE });
      expect(first.status).toBe(409);
      const shown = shownIn(first);
      expect(shown).toEqual([pg("db-502-r", "r.coord.example")]);

      // The owner re-points the SAME connector at a new host before "Rotate anyway".
      await db.databaseConnection.update({
        where: { id: "db-502-r" },
        data: { host: "evil.coord.example" },
      });
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: shown,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      expect(res.body.error.message).toContain("evil.coord.example");
      expect(shownIn(res)).toEqual([pg("db-502-r", "evil.coord.example")]);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
      const row = await db.secret.findUniqueOrThrow({ where: { id } });
      expect(row.createdById).toBe("u-coord");
    });

    it("#557: the same DB host with a changed database refuses the confirm", async () => {
      const id = await newSecret("u-coord");
      await db.databaseConnection.create({
        data: {
          id: "db-557",
          projectId: "proj-1",
          label: "db-557",
          driver: "postgres",
          host: "h557.coord.example",
          databaseName: "app",
          secretId: id,
        },
      });
      const first = await rotate(id, { value: ADMIN_VALUE });
      expect(first.status).toBe(409);
      const shown = shownIn(first);
      expect(shown).toEqual([pg("db-557", "h557.coord.example", "app")]);

      // Same host, same displayed destination — a different database.
      await db.databaseConnection.update({
        where: { id: "db-557" },
        data: { databaseName: "exfil" },
      });
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: shown,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      const fresh = shownIn(res);
      expect(fresh.map((b) => b.destination)).toEqual(shown.map((b) => b.destination));
      expect(fresh[0]!.routing).not.toBe(shown[0]!.routing);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
      expect((await db.secret.findUniqueOrThrow({ where: { id } })).createdById).toBe("u-coord");

      // Confirming the fresh list rotates, and the audit row keeps the digest.
      const ok = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: fresh,
      });
      expect(ok.status).toBe(200);
      const meta = JSON.parse((await rotateAudit(id))[0]!.metadata ?? "{}") as Record<
        string,
        unknown
      >;
      expect(meta.confirmedBindings).toEqual(fresh);
    });

    it("#557: the same MCP command with changed args refuses the confirm", async () => {
      const id = await newSecret("u-coord");
      await db.mCPServer.create({
        data: {
          id: "mcp-557",
          scope: "project",
          projectId: "proj-1",
          label: "MCP 557",
          transport: "stdio",
          command: "npx mcp-557",
          args: JSON.stringify(["--safe"]),
          envJson: JSON.stringify({ TOKEN: `\${vault:global:${lastLabel}}` }),
        },
      });
      const first = await rotate(id, { value: ADMIN_VALUE });
      expect(first.status).toBe(409);
      const shown = shownIn(first);
      expect(shown.map((b) => [b.id, b.destination])).toEqual([["mcp-557", "npx mcp-557"]]);

      await db.mCPServer.update({
        where: { id: "mcp-557" },
        data: { args: JSON.stringify(["--forward-to", "https://evil.example"]) },
      });
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: shown,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      expect(shownIn(res).map((b) => b.destination)).toEqual(["npx mcp-557"]);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
      expect((await db.secret.findUniqueOrThrow({ where: { id } })).createdById).toBe("u-coord");
    });

    it("#609: a secret bound only by a test-management connection is listed, and a stale digest refuses the confirm", async () => {
      const id = await newSecret("u-coord");
      // As `connection-service.ts` writes them: `${vault:<id>}` in the auth config.
      await db.testManagementConnection.create({
        data: {
          id: "tm-609",
          projectId: "proj-1",
          label: "Coord Zephyr",
          kind: "zephyr",
          baseUrl: "https://zephyr.coord.example",
          authConfigJson: JSON.stringify({ bearerTokenRef: `\${vault:${id}}` }),
          createdById: "u-coord",
        },
      });
      // One pointing at another secret is not a binding of this one.
      await db.testManagementConnection.create({
        data: {
          id: "tm-609-other",
          projectId: "proj-1",
          label: "Other Zephyr",
          kind: "zephyr",
          baseUrl: "https://zephyr.other.example",
          authConfigJson: JSON.stringify({ bearerTokenRef: "${vault:someone-else}" }),
          createdById: "u-coord",
        },
      });
      const first = await rotate(id, { value: ADMIN_VALUE });
      expect(first.status).toBe(409);
      expect(first.body.error.code).toBe("VAULT_ROTATE_FOREIGN_OWNER");
      expect(first.body.error.details.bindings).toEqual([
        {
          type: "test_management_connection",
          id: "tm-609",
          label: "Coord Zephyr",
          projectId: "proj-1",
          destination: "https://zephyr.coord.example",
          routing: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
      expect(first.body.error.message).toContain(
        "bound to Coord Zephyr (https://zephyr.coord.example)",
      );
      const shown = shownIn(first);

      // The owner routes the SAME connection through a proxy of their choosing:
      // the displayed destination is unchanged, the digest is not.
      await db.testManagementConnection.update({
        where: { id: "tm-609" },
        data: { proxyConfigJson: JSON.stringify({ url: "http://proxy.evil.example:8080" }) },
      });
      const stale = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: shown,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      const fresh = shownIn(stale);
      expect(fresh.map((b) => b.destination)).toEqual(["https://zephyr.coord.example"]);
      expect(fresh[0]!.routing).not.toBe(shown[0]!.routing);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect(await rotateAudit(id)).toHaveLength(0);
      expect((await db.secret.findUniqueOrThrow({ where: { id } })).createdById).toBe("u-coord");

      // Confirming what is live now rotates, and the audit row records it.
      const ok = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: fresh,
      });
      expect(ok.status).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);
      const meta = JSON.parse((await rotateAudit(id))[0]!.metadata ?? "{}") as Record<
        string,
        unknown
      >;
      expect(meta.confirmedBindings).toEqual(fresh);
    });

    it("#502: a binding added after the 409 refuses the confirm with the live list", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-502-b", id, "b.coord.example");
      const first = await rotate(id, { value: ADMIN_VALUE });
      expect(first.status).toBe(409);
      const shown = shownIn(first);
      expect(shown).toEqual([pg("db-502-b", "b.coord.example")]);

      // The owner adds a second binding, to a new host, before "Rotate anyway".
      await bindDb("db-502-b2", id, "evil.coord.example");
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: shown,
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
        confirmedBindings: [pg("db-502-c", "c.coord.example")],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      expect(res.body.error.details.bindings).toEqual([]);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });

    it("#502: the exact bindings shown (any order) rotate, record them with destinations, and transfer ownership", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-502-d1", id, "d1.coord.example");
      await bindDb("db-502-d2", id, "d2.coord.example");
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: [
          pg("db-502-d2", "d2.coord.example"),
          pg("db-502-d1", "d1.coord.example"),
        ],
      });
      expect(res.status).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);

      const rows = await rotateAudit(id);
      expect(rows).toHaveLength(1);
      const meta = JSON.parse(rows[0]!.metadata ?? "{}") as Record<string, unknown>;
      // The audit row keeps where the admin agreed the value would go.
      expect(meta.confirmedBindings).toEqual([
        pg("db-502-d1", "d1.coord.example"),
        pg("db-502-d2", "d2.coord.example"),
      ]);
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
      ).resolves.toBeInstanceOf(Date);
      // #552 — that check stamped the secret; let its window close before rotating.
      await db.secret.update({ where: { id }, data: { bindingWriteUntil: new Date(0) } });

      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: [pg("db-502-e", "e.coord.example")],
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
      ).resolves.toBeNull();
    });

    it("#502: rejects a malformed confirmedBindings as an invalid body", async () => {
      const id = await newSecret("u-coord");
      for (const confirmedBindings of [
        "db-1",
        ["db-1"],
        [{ type: "db_connector", id: "db-1" }],
        [{ type: "nope", id: "db-1", destination: null }],
        [{ type: "db_connector", id: "", destination: null }],
        [{ type: "db_connector", id: "db-1", destination: null, routing: HEX64, extra: 1 }],
        // #557 — the routing digest is required, and never empty.
        [{ type: "db_connector", id: "db-1", destination: null }],
        [{ type: "db_connector", id: "db-1", destination: null, routing: "" }],
        // Over the cap is asserted against the real JSON limit in the #557 size test.
      ]) {
        const res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindings,
        });
        expect(res.status).toBe(400);
      }
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });

    it("#557: rejects a routing value that is not the 64-hex digest the server issues", async () => {
      const id = await newSecret("u-coord");
      for (const routing of [
        "r",
        HEX64.slice(1),
        `${HEX64}0`,
        HEX64.toUpperCase(),
        `${HEX64.slice(1)}g`,
        ` ${HEX64.slice(1)}`,
        `${HEX64}\n`,
        1234,
        null,
      ]) {
        const res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindings: [{ type: "db_connector", id: "db-1", destination: null, routing }],
        });
        expect(res.status, JSON.stringify(routing)).toBe(400);
        expect(res.body.error.code).toBe("INVALID_BODY");
      }
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });

    /** The route behind the app's real 10 MiB parser limit and real error handler. */
    const realLimitRotate = (id: string, payload: unknown) => {
      const a = express();
      a.use(express.json({ limit: JSON_LIMIT_BYTES }));
      a.use("/api/vault", vaultRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return request(a)
        .post(`/api/vault/${id}/rotate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload as object);
    };

    it("#557: a realistic 1000-binding confirm is parsed and judged on the merits, not refused by size", async () => {
      const id = await newSecret("u-coord");
      // Typical field shapes as describeForeignOwner lists them: cuid ids,
      // driver://host:port or URL destinations, and real 64-hex routing digests.
      const types = [
        "db_connector",
        "repo_connector",
        "import_source",
        "mcp_server",
        "jira_connection",
      ] as const;
      const destinationFor = (type: (typeof types)[number], host: string) => {
        switch (type) {
          case "db_connector":
            return `postgresql://${host}:5432`;
          case "mcp_server":
            return `https://${host}:8443/mcp`;
          default:
            return `https://${host}/api/v3`;
        }
      };
      const entries = (count: number) =>
        Array.from({ length: count }, (_, i) => {
          const type = types[i % types.length]!;
          const host = `svc-${String(i).padStart(4, "0")}.prod.internal.example.com`;
          return {
            type,
            id: `cm${i.toString(36).padStart(6, "0")}k2x9q0000vq8z3h7t`,
            destination: destinationFor(type, host),
            routing: createHash("sha256").update(`binding-${i}`).digest("hex"),
          };
        });
      // A long plain secret (the schema's max value length, no escaping).
      const body = (count: number) => ({
        value: "k".repeat(SECRET_VALUE_MAX),
        confirmForeignOwner: true,
        confirmedBindings: entries(count),
      });
      expect(Buffer.byteLength(JSON.stringify(body(1000)))).toBeLessThan(JSON_LIMIT_BYTES);

      // 1000 is a literal, not MAX_CONFIRMED_BINDINGS: a secret's live list may
      // legitimately reach it, and a lower cap would strand that secret (400).
      // Parsed and validated, the route answers on the merits — the bindings do
      // not match the (empty) live set.
      const atCap = await realLimitRotate(id, body(1000));
      expect(atCap.status).toBe(409);
      expect(atCap.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");

      // One more is a 400 from the schema, never a 413 from the parser.
      const overCap = await realLimitRotate(id, body(1001));
      expect(overCap.status).toBe(400);
      expect(overCap.body.error.code).toBe("INVALID_BODY");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
    });

    it("#557: a schema-valid confirm over the JSON limit gets the structured 413 envelope", async () => {
      const id = await newSecret("u-coord");
      // Every field within its schema max, but each character JSON-escapes to six
      // bytes (\u0001), so a full list of bindings exceeds the 10 MiB limit.
      const escaped = (len: number) => "\u0001".repeat(len);
      const destinationLen = 2000;
      expect(destinationLen).toBeLessThanOrEqual(CONFIRMED_BINDING_DESTINATION_MAX);
      const payload = {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: Array.from({ length: MAX_CONFIRMED_BINDINGS }, () => ({
          type: "jira_connection",
          id: escaped(CONFIRMED_BINDING_ID_MAX),
          destination: escaped(destinationLen),
          routing: HEX64,
        })),
      };
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(JSON_LIMIT_BYTES);

      const res = await realLimitRotate(id, payload);
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
      });
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
