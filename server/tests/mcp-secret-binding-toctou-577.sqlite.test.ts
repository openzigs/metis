/**
 * #577 — the #344 ownership check and the #480 binding resolve a vault
 * reference ONCE, and the server is bound to exactly the ids the check approved.
 *
 * They used to read the secret table separately: the route's guard checked
 * that every secret a reference reached was the caller's, and the service then
 * resolved the label again to pick the id to bind. Between the two reads the
 * caller's own `global:<label>` could be deleted and another user's
 * `project:<label>` created, so the second read bound the foreign secret — to a
 * destination the caller chose.
 *
 * Each case interposes that delete-and-recreate after the guard returns and
 * before the service writes (`interleaved` fires `state.between` there), and
 * asserts the row is bound to the caller's (now deleted) secret, never the
 * foreign one. Real routers, real vault, real SQLite from the migration chain.
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
import type { BindingSuiteState } from "./helpers/interleaved-guards.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null, between: null, afterVaultCreate: null } as unknown as BindingSuiteState;
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
vi.mock("../src/lib/mcp/secret-binding.js", async (importOriginal) => {
  const { interleaved } = await import("./helpers/interleaved-guards.js");
  return interleaved(await importOriginal<Record<string, unknown>>(), state);
});

const { mcpRouter } = await import("../src/routes/mcp.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { backfillSecretBindings } = await import("../src/lib/vault/secret-binding-backfill.js");
const { parseSecretBindings } = await import("../src/lib/vault/bound-secret.js");

type Role = "admin" | "coordinator";
const ref = (body: string) => `\${vault:${body}}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#577 — MCP binds exactly the secret ids its ownership check approved",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;
    const next = () => (seq += 1);

    const token = (userId: string, role: Role) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces: [] }).accessToken;
    let COORD = "";
    let OTHER = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/mcp", mcpRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (method: "post" | "patch", url: string, bearer: string, body?: object) => {
      const r = request(app())[method](url).set("Authorization", `Bearer ${bearer}`);
      return body === undefined ? r : r.send(body);
    };

    const ownSecret = async (label: string, owner: string) =>
      (await getVaultService().create(label, `value-${owner}`, "global", { createdById: owner }))
        .id;
    /**
     * The race: after the guard approved `ownId` for `label`, delete it and
     * have another user create `project:<label>` — which the label now reaches,
     * uniquely. Returns the foreign secret's id once the hook has run, and
     * how many times the write went on to look a secret up by reference — it
     * must bind from the check's read, so that stays 0.
     */
    const racePointsLabelAway = (ownId: string, label: string) => {
      const race = { foreignId: "", reReads: 0 };
      state.between = async () => {
        await getVaultService().delete(ownId);
        race.foreignId = (
          await getVaultService().create(label, "foreign-value", "project", {
            createdById: "u-admin",
          })
        ).id;
        const findMany = db.secret.findMany.bind(db.secret);
        vi.spyOn(db.secret, "findMany").mockImplementation(((args: unknown) => {
          race.reReads += 1;
          return findMany(args as never);
        }) as never);
      };
      return race;
    };
    const bindingsOf = async (id: string) =>
      parseSecretBindings((await db.mCPServer.findUniqueOrThrow({ where: { id } })).secretBindings);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("577-mcp-binding-toctou");
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
      for (const id of ["u-admin", "u-coord", "u-other"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      COORD = token("u-coord", "coordinator");
      OTHER = token("u-other", "coordinator");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      state.between = null;
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      setMCPRegistry(null);
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("create: binds the checked secret, not one re-created under its label", async () => {
      const label = `mcp-577-create-${next()}`;
      const own = await ownSecret(label, "u-coord");
      const race = racePointsLabelAway(own, label);
      const res = await call("post", "/api/mcp", COORD, {
        scope: "global",
        label: `mcp-577-${next()}`,
        transport: "stdio",
        command: "node",
        env: { API_KEY: ref(label) },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(race.foreignId).not.toBe("");
      expect(race.reReads).toBe(0);
      expect(await bindingsOf(res.body.data.id)).toEqual({ [label]: own });
    });

    it("create: an auto-vaulted value is bound to the secret the request created", async () => {
      const label = `mcp-577-mixed-${next()}`;
      const own = await ownSecret(label, "u-coord");
      const race = racePointsLabelAway(own, label);
      const res = await call("post", "/api/mcp", COORD, {
        scope: "global",
        label: `mcp-577-${next()}`,
        transport: "stdio",
        command: "node",
        env: { API_KEY: ref(label), GITHUB_TOKEN: "ghp_plaintext577value" },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const vaulted = await db.secret.findFirstOrThrow({
        where: { createdById: "u-coord", deletedAt: null, name: { contains: "github-token" } },
      });
      expect(race.reReads).toBe(0);
      expect(await bindingsOf(res.body.data.id)).toEqual({
        [label]: own,
        [res.body.data.envSecretRefs.GITHUB_TOKEN]: vaulted.id,
      });
    });

    it("PATCH: binds the checked secret for a newly added reference", async () => {
      const created = await call("post", "/api/mcp", COORD, {
        scope: "global",
        label: `mcp-577-${next()}`,
        transport: "stdio",
        command: "node",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.data.id as string;
      const label = `mcp-577-patch-${next()}`;
      const own = await ownSecret(label, "u-coord");
      const race = racePointsLabelAway(own, label);
      const res = await call("patch", `/api/mcp/${id}`, COORD, { env: { API_KEY: ref(label) } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(race.foreignId).not.toBe("");
      expect(race.reReads).toBe(0);
      expect(await bindingsOf(id)).toEqual({ [label]: own });
    });

    it("re-bind: binds the checked secret for a flagged reference", async () => {
      const label = `mcp-577-rebind-${next()}`;
      // Created by u-coord, referencing u-other's secret: the backfill flags it.
      const own = await ownSecret(label, "u-other");
      const id = (
        await db.mCPServer.create({
          data: {
            label: `mcp-577-${next()}`,
            transport: "stdio",
            command: "node",
            envJson: JSON.stringify({ API_KEY: ref(label) }),
            createdById: "u-coord",
          },
        })
      ).id;
      await backfillSecretBindings();
      expect(await bindingsOf(id)).toEqual({});
      const race = racePointsLabelAway(own, label);
      const res = await call("post", `/api/mcp/${id}/rebind-secrets`, OTHER);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(race.foreignId).not.toBe("");
      expect(race.reReads).toBe(0);
      expect(await bindingsOf(id)).toEqual({ [label]: own });
    });

    it("import: binds the checked secret for an entry's reference", async () => {
      const label = `mcp-577-import-${next()}`;
      const own = await ownSecret(label, "u-coord");
      const race = racePointsLabelAway(own, label);
      const serverLabel = `mcp-577-imp-${next()}`;
      const res = await call("post", "/api/mcp/import", COORD, {
        mcpJson: {
          mcpServers: { [serverLabel]: { command: "node", env: { API_KEY: ref(label) } } },
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(race.foreignId).not.toBe("");
      expect(race.reReads).toBe(0);
      const row = await db.mCPServer.findFirstOrThrow({ where: { label: serverLabel } });
      expect(await bindingsOf(row.id)).toEqual({ [label]: own });
    });
  },
);
