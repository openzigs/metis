/**
 * #537 — a UI-reachable repair for the MCP servers the #504 backfill flagged.
 *
 * The backfill judges a legacy server's vault references against its CREATOR
 * (`createdById`), so two populations of legitimate servers are flagged
 * `not_owned` and stop connecting:
 *
 *   1. pre-#359 mcp.json imports, whose auto-vaulted secrets have no owner;
 *   2. servers a second user edited under #344, attaching their own secret.
 *
 * `POST /api/mcp/:id/rebind-secrets` binds the flagged references under the
 * #344 rule for the ACTING user (they created the secret, or hold
 * `vault.reveal`), and the server view carries `unboundSecretRefs` so the UI
 * can show the flag. A plain re-save (`PATCH`) is held to the same rule: a
 * flagged reference is attached by the write, never "kept".
 *
 * Real routers, real vault, real audit, real SQLite from the migration chain.
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

const { mcpRouter } = await import("../src/routes/mcp.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");
const { unboundMcpRefs, assertMcpRebindSecretBinding } =
  await import("../src/lib/mcp/secret-binding.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { backfillSecretBindings } = await import("../src/lib/vault/secret-binding-backfill.js");
const { parseSecretBindings } = await import("../src/lib/vault/bound-secret.js");
const { expandVaultRefs } = await import("../src/lib/vault/env-manager.js");

type Role = "admin" | "coordinator";
const ref = (body: string) => `\${vault:${body}}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#537 — re-binding the MCP servers the #504 backfill flagged",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let registry: InstanceType<typeof MCPRegistryService>;
    let seq = 0;
    const next = () => (seq += 1);

    const token = (userId: string, role: Role) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces: [] }).accessToken;
    let ADMIN = "";
    let COORD = ""; // the servers' creator
    let OTHER = ""; // a second coordinator

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/mcp", mcpRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const rebind = (id: string, bearer: string) =>
      request(app()).post(`/api/mcp/${id}/rebind-secrets`).set("Authorization", `Bearer ${bearer}`);
    const view = (id: string, bearer: string) =>
      request(app()).get(`/api/mcp/${id}`).set("Authorization", `Bearer ${bearer}`);

    /** A secret with the given owner; `null` is a pre-#359 import (no owner). */
    const secret = async (
      label: string,
      value: string,
      createdById: string | null,
      scope: "global" | "project" = "global",
    ) =>
      (
        await getVaultService().create(
          label,
          value,
          scope,
          createdById ? { createdById } : undefined,
        )
      ).id;

    /** A global MCP server as saved before #480, created by `u-coord`. */
    const legacyMcp = async (env: Record<string, string>) =>
      (
        await db.mCPServer.create({
          data: {
            label: `mcp-537-${next()}`,
            transport: "stdio",
            command: "node",
            envJson: JSON.stringify(env),
            createdById: "u-coord",
          },
        })
      ).id;
    const rowOf = (id: string) => db.mCPServer.findUniqueOrThrow({ where: { id } });
    const bindingsOf = async (id: string) => parseSecretBindings((await rowOf(id)).secretBindings);
    const auditsFor = async (id: string, action: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({ where: { action, targetId: id } });
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("537-mcp-rebind-secrets");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();
      registry = new MCPRegistryService(
        new MCPLifecycleManager({
          resolveEnv: async (e) => e,
          transportFactory: () => {
            throw new Error("no MCP transport in this test");
          },
        }),
      );
      setMCPRegistry(registry);
      for (const id of ["u-admin", "u-coord", "u-other"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      ADMIN = token("u-admin", "admin");
      COORD = token("u-coord", "coordinator");
      OTHER = token("u-other", "coordinator");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setMCPRegistry(null);
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("a flagged pre-#359 import (owner-less secret)", () => {
      it("shows the flag, refuses its creator, and is repaired by an admin's re-bind", async () => {
        const label = `imported-537-${next()}`;
        const secretId = await secret(label, "imported-value", null);
        const id = await legacyMcp({ TOKEN: ref(label) });
        await backfillSecretBindings();
        expect(await bindingsOf(id)).toEqual({});

        // The flag is on the server itself, not only in the audit log.
        const before = await view(id, ADMIN);
        expect(before.status).toBe(200);
        expect(before.body.data.unboundSecretRefs).toEqual([label]);

        // The creator did not create the imported secret: #344 refuses them,
        // audits it, and writes nothing.
        const refused = await rebind(id, COORD);
        expect(refused.status).toBe(403);
        expect(refused.body.error.code).toBe("SECRET_BINDING_FORBIDDEN");
        expect(await bindingsOf(id)).toEqual({});
        expect(
          (await auditsFor(id, "vault.binding_refused")).map(
            (r) => JSON.parse(r.metadata ?? "{}").reason,
          ),
        ).toEqual(["secret_not_owned"]);

        // An admin (vault.reveal) may bind it.
        const repaired = await rebind(id, ADMIN);
        expect(repaired.status).toBe(200);
        expect(repaired.body.data.unboundSecretRefs).toEqual([]);
        expect(await bindingsOf(id)).toEqual({ [label]: secretId });
        await expect(
          expandVaultRefs({ TOKEN: ref(label) }, getVaultService(), await bindingsOf(id)),
        ).resolves.toEqual({ TOKEN: "imported-value" });
        const [audited] = await auditsFor(id, "vault.binding_rebound");
        expect(audited.actorId).toBe("u-admin");
        expect(JSON.parse(audited.metadata ?? "{}").rebound).toEqual([
          { ref: label, boundId: secretId },
        ]);
        expect((await view(id, ADMIN)).body.data.unboundSecretRefs).toEqual([]);
      });

      it("a plain re-save by a coordinator cannot bind it either", async () => {
        const label = `imported-resave-537-${next()}`;
        await secret(label, "imported-value", null);
        const env = { TOKEN: ref(label) };
        const id = await legacyMcp(env);
        await backfillSecretBindings();

        const res = await request(app())
          .patch(`/api/mcp/${id}`)
          .set("Authorization", `Bearer ${COORD}`)
          .send({ env });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("SECRET_BINDING_FORBIDDEN");
        expect(await bindingsOf(id)).toEqual({});
      });
    });

    describe("a server a second user edited under #344", () => {
      it("its secret's creator can re-bind it; the server's creator cannot", async () => {
        const label = `second-editor-537-${next()}`;
        const secretId = await secret(label, "other-value", "u-other");
        const id = await legacyMcp({ TOKEN: ref(label) });
        await backfillSecretBindings();

        expect((await rebind(id, COORD)).status).toBe(403);
        expect(await bindingsOf(id)).toEqual({});

        const res = await rebind(id, OTHER);
        expect(res.status).toBe(200);
        expect(await bindingsOf(id)).toEqual({ [label]: secretId });
      });

      it("its secret's creator can also repair it by re-saving", async () => {
        const label = `second-editor-resave-537-${next()}`;
        const secretId = await secret(label, "other-value", "u-other");
        const env = { TOKEN: ref(label) };
        const id = await legacyMcp(env);
        await backfillSecretBindings();

        const res = await request(app())
          .patch(`/api/mcp/${id}`)
          .set("Authorization", `Bearer ${OTHER}`)
          .send({ env });
        expect(res.status).toBe(200);
        expect(await bindingsOf(id)).toEqual({ [label]: secretId });
      });
    });

    it("keeps every existing binding, even one whose secret has since been deleted", async () => {
      const own = `own-537-${next()}`;
      const imported = `imported-kept-537-${next()}`;
      const ownId = await secret(own, "own-value", "u-coord");
      const importedId = await secret(imported, "imported-value", null);
      const id = await legacyMcp({ OWN: ref(own), IMPORTED: ref(imported) });
      await backfillSecretBindings();
      expect(await bindingsOf(id)).toEqual({ [own]: ownId });

      // Re-creating `own` elsewhere must not re-bind it (#480).
      await getVaultService().delete(ownId);
      await secret(own, "squatter", "u-admin", "project");

      const res = await rebind(id, ADMIN);
      expect(res.status).toBe(200);
      expect(await bindingsOf(id)).toEqual({ [own]: ownId, [imported]: importedId });
    });

    it("refuses an unresolved reference and writes nothing", async () => {
      const gone = `never-existed-537-${next()}`;
      const id = await legacyMcp({ TOKEN: ref(gone) });
      await backfillSecretBindings();
      const before = await rowOf(id);

      const res = await rebind(id, ADMIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VAULT_REF_UNRESOLVED");
      expect((await rowOf(id)).updatedAt).toEqual(before.updatedAt);
      expect(await bindingsOf(id)).toEqual({});
    });

    it("is a no-op on a server with nothing flagged", async () => {
      const label = `bound-537-${next()}`;
      const secretId = await secret(label, "v", "u-coord");
      const id = await legacyMcp({ TOKEN: ref(label) });
      await backfillSecretBindings();
      const before = await rowOf(id);

      const res = await rebind(id, COORD);
      expect(res.status).toBe(200);
      expect(res.body.data.unboundSecretRefs).toEqual([]);
      expect(await bindingsOf(id)).toEqual({ [label]: secretId });
      expect((await rowOf(id)).updatedAt).toEqual(before.updatedAt);
      expect(await auditsFor(id, "vault.binding_rebound")).toEqual([]);
    });

    it("answers an unknown server with 404", async () => {
      expect((await rebind("mcp-537-nope", ADMIN)).status).toBe(404);
      // Below the route's access check: the guard leaves the 404 to the
      // service, which reports it itself.
      const admin = { userId: "u-admin", role: "admin" as const };
      expect(await assertMcpRebindSecretBinding(admin, "mcp-537-nope")).toBeNull();
      await expect(
        registry.rebindSecrets("mcp-537-nope", { id: "u-admin" }, null),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("refuses a stale or missing check (409) and writes nothing", async () => {
      const label = `stale-537-${next()}`;
      await secret(label, "v", null);
      const id = await legacyMcp({ TOKEN: ref(label) });
      await backfillSecretBindings();
      const actor = { id: "u-admin", role: "admin" as const };

      await expect(registry.rebindSecrets(id, actor, new Date(0))).rejects.toMatchObject({
        status: 409,
      });
      await expect(registry.rebindSecrets(id, actor, null)).rejects.toMatchObject({
        status: 409,
      });
      expect(await bindingsOf(id)).toEqual({});
    });

    it("does not judge a row the backfill has not reached yet", () => {
      expect(unboundMcpRefs({ envJson: JSON.stringify({ T: ref("x") }), headers: null })).toEqual(
        [],
      );
      expect(
        unboundMcpRefs({
          envJson: JSON.stringify({ T: ref("x") }),
          headers: JSON.stringify({ Authorization: `Bearer ${ref("y")}` }),
          secretBindings: JSON.stringify({ x: "sec-x" }),
        }),
      ).toEqual(["y"]);
    });
  },
);
