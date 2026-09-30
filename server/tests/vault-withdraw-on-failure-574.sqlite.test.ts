/**
 * #574 — every secret a request creates is withdrawn when the request fails
 * before its write commits: a failing LATER vault write (the Jira TLS CA cert
 * after the token, the second xray credential, the test-management CA cert
 * after the auth config) and a refused MCP create after auto-vaulting.
 *
 * Real SQLite built by the migration chain, the real `VaultService`, the real
 * MCP router; the only thing faked is the one failure each test forces. Every
 * assertion reads the secret rows back from the database.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
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

const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const jira = await import("../src/lib/connectors/jira/jira-service.js");
const testmgmt = await import("../src/lib/connectors/testmgmt/connection-service.js");
const { mcpRouter } = await import("../src/routes/mcp.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setMCPRegistry, getMCPRegistry, MCPRegistryService } =
  await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");

const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
const OWNER = "owner-574";
const COORD = "coord-574";
const ADMIN = "admin-574";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#574 — a request that fails before its write commits leaves no secret behind (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let adminToken = "";
    const prevKey = process.env.VAULT_MASTER_KEY;
    let seq = 0;
    const uniq = (p: string) => `${p}-${++seq}`;
    const refIdOf = (ref: string) => /^\$\{vault:([^}]+)\}$/.exec(ref)![1];

    /** Every secret row `actor` ever created, withdrawn ones included. */
    const secretsBy = async (actor: string) =>
      db.secret.findMany({
        where: { createdById: actor },
        select: { id: true, deletedAt: true },
      });
    /**
     * Run `fn` and return the secrets `actor` created during it, split into
     * the ones still live and the ones withdrawn.
     */
    async function madeDuring(actor: string, fn: () => Promise<unknown>) {
      const before = new Set((await secretsBy(actor)).map((s) => s.id));
      const outcome = await fn().then(
        () => ({ threw: null as unknown }),
        (err: unknown) => ({ threw: err }),
      );
      const made = (await secretsBy(actor)).filter((s) => !before.has(s.id));
      return {
        ...outcome,
        live: made.filter((s) => s.deletedAt === null).map((s) => s.id),
        withdrawn: made.filter((s) => s.deletedAt !== null).map((s) => s.id),
      };
    }

    /** Make the `n`th vault create from now on fail (1-based); the others are real. */
    function failVaultCreateOn(n: number) {
      const vault = getVaultService();
      const real = vault.create.bind(vault);
      let calls = 0;
      return vi.spyOn(vault, "create").mockImplementation(async (...args) => {
        calls += 1;
        if (calls === n) throw new Error("vault unavailable");
        return real(...args);
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("574-withdraw");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      setMCPRegistry(
        new MCPRegistryService(
          new MCPLifecycleManager({
            resolveEnv: async (e) => e,
            transportFactory: () => {
              throw new Error("no MCP transport in this test");
            },
          }),
        ),
      );
      for (const id of [OWNER, COORD, ADMIN]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
      }
      await db.project.create({ data: { id: "p1", name: "P", slug: "p1", createdById: OWNER } });
      adminToken = issueTokens({
        userId: ADMIN,
        username: ADMIN,
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setMCPRegistry(null);
      await db?.$disconnect();
      sqlite?.cleanup();
      if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
      else process.env.VAULT_MASTER_KEY = prevKey;
      __resetVaultSingleton();
    });

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    // ---- Jira ---------------------------------------------------------------

    const jiraInput = (withCa: boolean) => ({
      label: uniq("j"),
      edition: "datacenter" as const,
      baseUrl: "https://jira.example.test",
      username: "svc",
      apiToken: "owner-token",
      ...(withCa ? { tlsCaCert: "owner-ca" } : {}),
    });

    it("Jira create: the CA cert write failing withdraws the token secret already written", async () => {
      failVaultCreateOn(2);
      const input = jiraInput(true);

      const r = await madeDuring(OWNER, () => jira.createJiraConnection("p1", input, OWNER));

      expect((r.threw as Error).message).toBe("vault unavailable");
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(1);
      expect(await db.jiraConnection.count({ where: { label: input.label } })).toBe(0);
    });

    it("Jira create: a row write failing for a reason other than the label withdraws both secrets", async () => {
      vi.spyOn(db.jiraConnection, "create").mockRejectedValueOnce(new Error("disk full"));

      const r = await madeDuring(OWNER, () =>
        jira.createJiraConnection("p1", jiraInput(true), OWNER),
      );

      expect((r.threw as Error).message).toBe("disk full");
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(2);
    });

    it("Jira create: a successful create keeps both secrets", async () => {
      const r = await madeDuring(OWNER, () =>
        jira.createJiraConnection("p1", jiraInput(true), OWNER),
      );
      expect(r.threw).toBeNull();
      expect(r.live).toHaveLength(2);
      expect(r.withdrawn).toEqual([]);
    });

    it("Jira update: the CA cert write failing withdraws the fresh token secret, and the row keeps its own", async () => {
      const made = await jira.createJiraConnection("p1", jiraInput(true), OWNER);
      const before = await db.jiraConnection.findUniqueOrThrow({ where: { id: made.id } });
      // A coordinator cannot rotate the owner's secrets in place (#358), so
      // both writes create fresh ones; the second fails.
      failVaultCreateOn(2);

      const r = await madeDuring(COORD, () =>
        jira.updateJiraConnection(
          made.id,
          { apiToken: "coord-token", tlsCaCert: "coord-ca" },
          COORD,
        ),
      );

      expect((r.threw as Error).message).toBe("vault unavailable");
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(1);
      const after = await db.jiraConnection.findUniqueOrThrow({ where: { id: made.id } });
      expect(after.secretId).toBe(before.secretId);
      expect(after.tlsCaSecretId).toBe(before.tlsCaSecretId);
      // The owner's secrets were never superseded, so neither was retired.
      for (const id of [before.secretId, before.tlsCaSecretId!]) {
        expect((await db.secret.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
      }
    });

    // ---- Test management ---------------------------------------------------

    const tmDeps = () => ({
      prisma: db,
      vault: getVaultService(),
      assertHost: async () => undefined,
    });
    const xrayInput = (withCa: boolean) => ({
      label: uniq("x"),
      kind: "xray" as const,
      baseUrl: "https://xray.example.test",
      auth: { kind: "xray" as const, clientId: "owner-id", clientSecret: "owner-secret" },
      ...(withCa ? { tlsConfig: { rejectUnauthorized: true, caCert: "owner-ca" } } : {}),
    });

    it("xray create: the client_secret write failing withdraws the client_id secret", async () => {
      failVaultCreateOn(2);
      const input = xrayInput(false);

      const r = await madeDuring(OWNER, () =>
        testmgmt.createTestManagementConnection("p1", input, OWNER, tmDeps()),
      );

      expect((r.threw as Error).message).toBe("vault unavailable");
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(1);
      expect(await db.testManagementConnection.count({ where: { label: input.label } })).toBe(0);
    });

    it("xray create: the TLS CA write failing withdraws both xray secrets", async () => {
      failVaultCreateOn(3);

      const r = await madeDuring(OWNER, () =>
        testmgmt.createTestManagementConnection("p1", xrayInput(true), OWNER, tmDeps()),
      );

      expect((r.threw as Error).message).toBe("vault unavailable");
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(2);
    });

    it("xray create: a successful create keeps all three secrets", async () => {
      const r = await madeDuring(OWNER, () =>
        testmgmt.createTestManagementConnection("p1", xrayInput(true), OWNER, tmDeps()),
      );
      expect(r.threw).toBeNull();
      expect(r.live).toHaveLength(3);
    });

    async function ownerXray() {
      const made = await testmgmt.createTestManagementConnection(
        "p1",
        xrayInput(true),
        OWNER,
        tmDeps(),
      );
      return db.testManagementConnection.findUniqueOrThrow({ where: { id: made.id } });
    }

    it("xray update: the client_secret write failing withdraws the fresh client_id secret", async () => {
      const before = await ownerXray();
      failVaultCreateOn(2);

      const r = await madeDuring(COORD, () =>
        testmgmt.updateTestManagementConnection(
          before.id,
          { auth: { kind: "xray", clientId: "coord-id", clientSecret: "coord-secret" } },
          COORD,
          undefined,
          tmDeps(),
        ),
      );

      expect((r.threw as Error).message).toBe("vault unavailable");
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(1);
      const after = await db.testManagementConnection.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.authConfigJson).toBe(before.authConfigJson);
    });

    it("test management update: the TLS CA write failing withdraws the fresh auth secrets", async () => {
      const before = await ownerXray();
      failVaultCreateOn(3);

      const r = await madeDuring(COORD, () =>
        testmgmt.updateTestManagementConnection(
          before.id,
          {
            auth: { kind: "xray", clientId: "coord-id", clientSecret: "coord-secret" },
            tlsConfig: { rejectUnauthorized: true, caCert: "coord-ca" },
          },
          COORD,
          undefined,
          tmDeps(),
        ),
      );

      expect((r.threw as Error).message).toBe("vault unavailable");
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(2);
      const after = await db.testManagementConnection.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.authConfigJson).toBe(before.authConfigJson);
      expect(after.tlsConfigJson).toBe(before.tlsConfigJson);
      // The owner's secrets stay: nothing replaced them.
      const auth = JSON.parse(before.authConfigJson) as Record<string, string>;
      for (const ref of [auth.clientIdRef, auth.clientSecretRef]) {
        const row = await db.secret.findUniqueOrThrow({ where: { id: refIdOf(ref) } });
        expect(row.deletedAt).toBeNull();
      }
    });

    // ---- MCP create (POST /api/mcp) ------------------------------------------

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/mcp", mcpRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (body: object) =>
      request(app()).post("/api/mcp").set("Authorization", `Bearer ${adminToken}`).send(body);
    const mcpBody = (label: string) => ({
      scope: "global",
      label,
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "plaintext-key-574" },
    });

    it("MCP create: a label already taken is refused after auto-vaulting, and the vaulted value is withdrawn", async () => {
      const label = uniq("mcp-574");
      expect((await post(mcpBody(label))).status).toBe(201);

      let res: request.Response | undefined;
      const r = await madeDuring(ADMIN, async () => {
        res = await post(mcpBody(label));
      });

      expect(res!.status).toBe(409);
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(1);
    });

    it("MCP create: a header failing to vault withdraws the env secret vaulted before it", async () => {
      failVaultCreateOn(2);

      let res: request.Response | undefined;
      const r = await madeDuring(ADMIN, async () => {
        res = await post({
          ...mcpBody(uniq("mcp-574")),
          transport: "http",
          url: "https://mcp.example.test/sse",
          headers: { Authorization: "Bearer plaintext-header-574" },
        });
      });

      expect(res!.status, JSON.stringify(res!.body)).toBe(400);
      expect(res!.body.error.code).toBe("SECRET_PLAINTEXT_REJECTED");
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(1);
    });

    it("MCP create: a failure after the row landed keeps the secret the row now names", async () => {
      const registry = getMCPRegistry() as unknown as { toView: (row: unknown) => unknown };
      vi.spyOn(registry, "toView").mockImplementationOnce(() => {
        throw new Error("view failed");
      });
      const label = uniq("mcp-574");

      let res: request.Response | undefined;
      const r = await madeDuring(ADMIN, async () => {
        res = await post(mcpBody(label));
      });

      expect(res!.status).toBe(500);
      expect(await db.mCPServer.count({ where: { label } })).toBe(1);
      expect(r.live).toHaveLength(1);
      expect(r.withdrawn).toEqual([]);
    });

    it("MCP create: a successful create keeps its vaulted value", async () => {
      let res: request.Response | undefined;
      const r = await madeDuring(ADMIN, async () => {
        res = await post(mcpBody(uniq("mcp-574")));
      });
      expect(res!.status).toBe(201);
      expect(r.live).toHaveLength(1);
      expect(r.withdrawn).toEqual([]);
    });
  },
);
