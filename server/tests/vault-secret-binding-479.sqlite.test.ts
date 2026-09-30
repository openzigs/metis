/**
 * #479 — a binding-guarded update is conditional on the row the guard checked.
 *
 * The #344/#358 guards read a row, decide, and the service then re-reads and
 * writes it without a transaction. Two concurrent PATCHes could interleave:
 *
 *   B (keep the foreign secret, move nothing)  — guard reads row, allows
 *   A (move it, replacing the secret with own) — guard allows, A writes
 *   B writes — the foreign secret again, now at A's destination
 *
 * Each guard now returns the `updatedAt` it read and the service's write is
 * `updateMany where { id, updatedAt }`; no match is a 409.
 *
 * The interleaving is FORCED, not raced: both guard modules are wrapped so a
 * test can run a second request through the REAL router after request B's
 * guard has returned and before B's service writes. Everything else — router,
 * auth, vault, audit, SQLite from the migration chain — is real, and every
 * outcome is proved by reading the row back.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    /** Runs once, after a guard returns and before the service writes. */
    between: null as null | (() => Promise<void>),
  };
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
vi.mock("../src/lib/connectors/network-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertConnectorHostAllowed: async () => undefined,
    resolveAndAssertConnectorHost: async (hostname: string) => ({
      hostname,
      address: "203.0.113.7",
      family: 4,
    }),
  };
});

/** Wrap every export so the `between` hook fires after the real guard returns. */
async function interleaved(actual: Record<string, unknown>) {
  const wrapped: Record<string, unknown> = { ...actual };
  for (const [name, fn] of Object.entries(actual)) {
    if (typeof fn !== "function" || !/^assert\w+SecretBinding$/.test(name)) continue;
    wrapped[name] = async (...args: unknown[]) => {
      const result = await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
      const hook = state.between;
      state.between = null;
      if (hook) await hook();
      return result;
    };
  }
  return wrapped;
}
vi.mock("../src/lib/connectors/connector-secret-binding.js", async (importOriginal) =>
  interleaved(await importOriginal<Record<string, unknown>>()),
);
vi.mock("../src/lib/mcp/secret-binding.js", async (importOriginal) =>
  interleaved(await importOriginal<Record<string, unknown>>()),
);

const { connectorsRouter } = await import("../src/routes/connectors.js");
const { jiraRouter } = await import("../src/routes/jira.js");
const { testManagementRouter } = await import("../src/routes/test-management.js");
const { mcpRouter } = await import("../src/routes/mcp.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { setMCPRegistry, getMCPRegistry, MCPRegistryService } =
  await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");
const { updateDbConnector } = await import("../src/lib/connectors/db/db-service.js");
const { updateRepoConnector } = await import("../src/lib/connectors/repo/repo-service.js");
const { updateJiraConnection } = await import("../src/lib/connectors/jira/jira-service.js");
const { updateTestManagementConnection } =
  await import("../src/lib/connectors/testmgmt/connection-service.js");

type Method = "post" | "patch";

const PROJ = "proj-479-binding-01";
const CONFLICT = "CONCURRENT_UPDATE";
const EVIL = "attacker.example.test";
const ref = (body: string) => `\${vault:${body}}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#479 — binding-guarded updates are conditional on the checked row's updatedAt",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ADMIN = "";
    let COORD = "";
    /** Created by the admin: the coordinator never saw its value. */
    let FOREIGN = "";
    const FOREIGN_LABEL = "admin-secret-479";
    /** Created by the coordinator. */
    let OWN = "";
    const OWN_LABEL = "coord-secret-479";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/connectors", connectorsRouter());
      a.use("/api/jira", jiraRouter());
      a.use("/api/test-management", testManagementRouter());
      a.use("/api/mcp", mcpRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (method: Method, url: string, bearer: string, body: unknown) =>
      request(app())
        [method](url)
        .set("Authorization", `Bearer ${bearer}`)
        .send(body as object);

    /**
     * PATCH `url` with `patchB`; after B's guard passes, PATCH `url` with
     * `patchA` to completion. Returns both responses.
     */
    const interleave = async (url: string, patchB: unknown, patchA: unknown) => {
      let a: request.Response | undefined;
      state.between = async () => {
        a = await call("patch", url, COORD, patchA);
      };
      const b = await call("patch", url, COORD, patchB);
      expect(state.between, "the interleaving hook never ran").toBeNull();
      return { a: a!, b };
    };

    let seq = 0;
    const next = () => (seq += 1);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("479-conditional-update");
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

      for (const id of ["u-admin", "u-coord"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1", name: "ws-1", slug: "ws-1" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1", userId: "u-coord", role: "member" },
      });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: "u-admin", workspaceId: "ws-1" },
      });
      // An existing repo, so creating one below is not a project's first and
      // does not start a background deep-ingest whose status writes would
      // race the rows under test.
      await db.repoConnection.create({ data: { projectId: PROJ, label: "seed-repo-479" } });

      const vault = getVaultService();
      FOREIGN = (
        await vault.create(FOREIGN_LABEL, "admin-value", "global", { createdById: "u-admin" })
      ).id;
      OWN = (await vault.create(OWN_LABEL, "coord-value", "global", { createdById: "u-coord" })).id;

      const token = (userId: string, role: "admin" | "coordinator", workspaces: string[]) =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
      ADMIN = token("u-admin", "admin", []);
      COORD = token("u-coord", "coordinator", ["ws-1"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      state.between = null;
    });

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      setMCPRegistry(null);
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── DB connectors ────────────────────────────────────────────────────────
    describe("PATCH /api/projects/:projectId/connectors/dbs/:id", () => {
      const create = async () => {
        const res = await call("post", `/api/projects/${PROJ}/connectors/dbs`, ADMIN, {
          label: `db-${next()}`,
          driver: "postgres",
          host: "db.internal.example.test",
          port: 5432,
          secretRef: ref(FOREIGN),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.databaseConnection.findUniqueOrThrow({ where: { id } });

      it("a PATCH keeping the foreign secret cannot land it at a host a concurrent PATCH chose", async () => {
        const id = await create();
        const { a, b } = await interleave(
          `/api/projects/${PROJ}/connectors/dbs/${id}`,
          { secretRef: ref(FOREIGN) },
          { host: EVIL, secretRef: ref(OWN) },
        );
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        const after = await row(id);
        expect(after.host).toBe(EVIL);
        expect(after.secretId).toBe(OWN);
      });

      it("without a concurrent change the same PATCH succeeds", async () => {
        const id = await create();
        const res = await call("patch", `/api/projects/${PROJ}/connectors/dbs/${id}`, COORD, {
          label: `renamed-${next()}`,
          secretRef: ref(FOREIGN),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((await row(id)).label).toBe(res.body.data.label);
      });

      it("the service refuses a write whose guard saw no row", async () => {
        const id = await create();
        const before = await row(id);
        await expect(
          updateDbConnector(PROJ, id, { label: "never" }, "u-admin", null),
        ).rejects.toMatchObject({ status: 409, code: CONFLICT });
        expect(await row(id)).toEqual(before);
      });
    });

    // ── Repo connectors ──────────────────────────────────────────────────────
    describe("PATCH /api/projects/:projectId/connectors/repos/:id", () => {
      const create = async () => {
        const res = await call("post", `/api/projects/${PROJ}/connectors/repos`, ADMIN, {
          label: `repo-${next()}`,
          provider: "github_enterprise",
          ownerOrOrg: "octo",
          repoName: "app",
          apiBaseUrl: "https://ghe.example.test/api/v3",
          secretRef: ref(FOREIGN_LABEL),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.repoConnection.findUniqueOrThrow({ where: { id } });

      it("a PATCH keeping the foreign secret cannot land it at a host a concurrent PATCH chose", async () => {
        const id = await create();
        const { a, b } = await interleave(
          `/api/projects/${PROJ}/connectors/repos/${id}`,
          { secretRef: ref(FOREIGN_LABEL) },
          { apiBaseUrl: `https://${EVIL}/api/v3`, secretRef: ref(OWN_LABEL) },
        );
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        const after = await row(id);
        expect(after.apiBaseUrl).toBe(`https://${EVIL}/api/v3`);
        expect(after.secretId).toBe(OWN);
      });

      it("the service refuses a write whose guard saw no row", async () => {
        const id = await create();
        const before = await row(id);
        await expect(
          updateRepoConnector(PROJ, id, { label: "never" }, "u-admin", null),
        ).rejects.toMatchObject({ status: 409, code: CONFLICT });
        expect(await row(id)).toEqual(before);
      });
    });

    // ── Jira connections ─────────────────────────────────────────────────────
    describe("PATCH /api/jira/connections/:id", () => {
      const create = async () => {
        const res = await call("post", `/api/jira/connections?projectId=${PROJ}`, ADMIN, {
          label: `jira-${next()}`,
          edition: "datacenter",
          baseUrl: "https://jira.internal.example.test",
          username: "svc",
          apiToken: "jira-token-479",
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.jiraConnection.findUniqueOrThrow({ where: { id } });

      it("a change between the guard and the write is a 409, not a silent overwrite", async () => {
        const id = await create();
        const { a, b } = await interleave(
          `/api/jira/connections/${id}`,
          { label: `b-${next()}` },
          { baseUrl: `https://${EVIL}`, apiToken: "coord-token-479" },
        );
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        const after = await row(id);
        expect(after.baseUrl).toBe(`https://${EVIL}`);
        expect(after.label).toBe(a.body.data.label);
      });

      it("the service refuses a write whose guard saw no row", async () => {
        const id = await create();
        const before = await row(id);
        await expect(
          updateJiraConnection(id, { label: "never" }, "u-admin", undefined, null),
        ).rejects.toMatchObject({ status: 409, code: CONFLICT });
        expect(await row(id)).toEqual(before);
      });
    });

    // ── Test-management connections ──────────────────────────────────────────
    describe("PATCH /api/test-management/connections/:id", () => {
      const create = async () => {
        const res = await call(
          "post",
          `/api/test-management/connections?projectId=${PROJ}`,
          ADMIN,
          {
            label: `tm-${next()}`,
            kind: "zephyr",
            baseUrl: "https://zephyr.internal.example.test",
            auth: { kind: "zephyr", bearerToken: "zephyr-token-479" },
          },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.testManagementConnection.findUniqueOrThrow({ where: { id } });

      it("a change between the guard and the write is a 409, not a silent overwrite", async () => {
        const id = await create();
        const { a, b } = await interleave(
          `/api/test-management/connections/${id}`,
          { label: `b-${next()}` },
          {
            baseUrl: `https://${EVIL}`,
            auth: { kind: "zephyr", bearerToken: "coord-zephyr-479" },
          },
        );
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        const after = await row(id);
        expect(after.baseUrl).toBe(`https://${EVIL}`);
        expect(after.label).toBe(a.body.data.label);
      });

      it("the service refuses a write whose guard saw no row", async () => {
        const id = await create();
        const before = await row(id);
        await expect(
          updateTestManagementConnection(
            id,
            { label: "never" },
            "u-admin",
            undefined,
            undefined,
            null,
          ),
        ).rejects.toMatchObject({ status: 409, code: CONFLICT });
        expect(await row(id)).toEqual(before);
      });
    });

    // ── MCP servers ──────────────────────────────────────────────────────────
    describe("PATCH /api/mcp/:id", () => {
      const create = async () => {
        const res = await call("post", "/api/mcp", ADMIN, {
          scope: "global",
          label: `mcp-${next()}`,
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: ref(FOREIGN) },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.mCPServer.findUniqueOrThrow({ where: { id } });

      it("a PATCH keeping the foreign secret cannot land it in a command a concurrent PATCH chose", async () => {
        const id = await create();
        const { a, b } = await interleave(
          `/api/mcp/${id}`,
          { env: { API_KEY: ref(FOREIGN) } },
          { command: "sh", args: ["evil.sh"], env: { API_KEY: ref(OWN) } },
        );
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        const after = await row(id);
        expect(after.command).toBe("sh");
        expect(JSON.parse(after.envJson ?? "{}")).toEqual({ API_KEY: ref(OWN) });
      });

      it("the service refuses a write whose guard saw no row", async () => {
        const id = await create();
        const before = await row(id);
        await expect(
          getMCPRegistry().update(id, { label: "never" }, { id: "u-admin", role: "admin" }, null),
        ).rejects.toMatchObject({ status: 409, code: CONFLICT });
        expect(await row(id)).toEqual(before);
      });
    });
  },
);
