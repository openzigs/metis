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
  return {
    db: null,
    between: null,
    afterVaultCreate: null,
    rewrite: null,
  } as unknown as BindingSuiteState;
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

// The catalog installs resolve an entry before creating a server; serve one
// installable entry from each, so the install reaches the write.
vi.mock("../src/lib/mcp/registry-client.js", async (original) => ({
  ...(await original<typeof import("../src/lib/mcp/registry-client.js")>()),
  fetchRegistry: vi.fn(async () => ({
    servers: [
      {
        id: "reg-577",
        name: "registry-577",
        install: { type: "http", url: "https://example.test/mcp" },
      },
    ],
  })),
}));
vi.mock("../src/lib/mcp/federation/registry-cache.js", async (original) => ({
  ...(await original<typeof import("../src/lib/mcp/federation/registry-cache.js")>()),
  getEntryById: vi.fn(async () => ({
    id: "fed-577",
    source: "official",
    externalId: "ext-577",
    name: "federated-577",
    manifest: { type: "http", url: "https://example.test/mcp" },
  })),
  recordLocalInstall: vi.fn(async () => undefined),
}));

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
    let ADMIN = "";

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
      ADMIN = token("u-admin", "admin");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      state.between = null;
      state.rewrite = null;
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

    // ── PR #585 review — an import entry that cannot be bound fails alone ──
    // An unresolved reference reaches no secret, so the ownership rule refuses
    // it (403) for a caller without `vault.reveal`; it reaches the bind only
    // for an admin. An ambiguous one whose secrets are all the caller's reaches
    // the bind for anyone.
    describe.each([
      ["/api/mcp/import", "mcpServers"],
      ["/api/mcp/import-copilot", "servers"],
    ])("%s: a mixed import", (url, key) => {
      it("admin: creates the good entries (207); the unresolved and ambiguous ones fail with their codes", async () => {
        const n = next();
        const good = `mcp-577-good-${n}`;
        const own = await ownSecret(good, "u-admin");
        const ambiguous = `mcp-577-amb-${n}`;
        await getVaultService().create(ambiguous, "a", "global", { createdById: "u-admin" });
        await getVaultService().create(ambiguous, "b", "project", { createdById: "u-admin" });
        const entries = {
          good: `mcp-577-e-good-${n}`,
          plain: `mcp-577-e-plain-${n}`,
          unresolved: `mcp-577-e-unres-${n}`,
          ambiguous: `mcp-577-e-amb-${n}`,
        };
        const secretsBefore = await db.secret.count();
        const res = await call("post", url, ADMIN, {
          mcpJson: {
            [key]: {
              [entries.good]: { command: "node", env: { API_KEY: ref(good) } },
              [entries.plain]: { command: "node", env: { GITHUB_TOKEN: "ghp_plain577value" } },
              [entries.unresolved]: {
                command: "node",
                env: { API_KEY: ref(`mcp-577-missing-${n}`), GITHUB_TOKEN: "ghp_never577value" },
              },
              [entries.ambiguous]: { command: "node", env: { API_KEY: ref(ambiguous) } },
            },
          },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(207);
        const created = (res.body.data.created as Array<{ label: string }>).map((c) => c.label);
        expect(created.sort()).toEqual([entries.good, entries.plain].sort());
        const errors = res.body.data.errors as Array<{ label: string; code?: string }>;
        expect(errors.map(({ label, code }) => ({ label, code }))).toEqual([
          { label: entries.unresolved, code: "VAULT_REF_UNRESOLVED" },
          { label: entries.ambiguous, code: "VAULT_REF_AMBIGUOUS" },
        ]);
        for (const bad of [entries.unresolved, entries.ambiguous]) {
          expect(await db.mCPServer.count({ where: { label: bad } })).toBe(0);
        }
        // The failed entry vaulted nothing: only the plain entry's secret is new.
        expect(await db.secret.count()).toBe(secretsBefore + 1);
        const goodRow = await db.mCPServer.findFirstOrThrow({ where: { label: entries.good } });
        expect(await bindingsOf(goodRow.id)).toEqual({ [good]: own });
      });

      it("coordinator: an ambiguous reference to their own secrets fails only its entry (207)", async () => {
        const n = next();
        const good = `mcp-577-good-${n}`;
        const own = await ownSecret(good, "u-coord");
        const ambiguous = `mcp-577-amb-${n}`;
        // Both the caller's, so the ownership check passes and only the bind fails.
        await getVaultService().create(ambiguous, "a", "global", { createdById: "u-coord" });
        await getVaultService().create(ambiguous, "b", "project", { createdById: "u-coord" });
        const goodEntry = `mcp-577-e-good-${n}`;
        const badEntry = `mcp-577-e-amb-${n}`;
        const res = await call("post", url, COORD, {
          mcpJson: {
            [key]: {
              [goodEntry]: { command: "node", env: { API_KEY: ref(good) } },
              [badEntry]: { command: "node", env: { API_KEY: ref(ambiguous) } },
            },
          },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(207);
        expect(res.body.data.errors).toEqual([
          expect.objectContaining({ label: badEntry, code: "VAULT_REF_AMBIGUOUS" }),
        ]);
        expect(await db.mCPServer.count({ where: { label: badEntry } })).toBe(0);
        const goodRow = await db.mCPServer.findFirstOrThrow({ where: { label: goodEntry } });
        expect(await bindingsOf(goodRow.id)).toEqual({ [good]: own });
      });

      it("a foreign reference in any entry still refuses the whole import (403)", async () => {
        const n = next();
        const good = `mcp-577-good-${n}`;
        await ownSecret(good, "u-coord");
        const foreign = `mcp-577-foreign-${n}`;
        await ownSecret(foreign, "u-other");
        const goodEntry = `mcp-577-e-good-${n}`;
        const res = await call("post", url, COORD, {
          mcpJson: {
            [key]: {
              [goodEntry]: { command: "node", env: { API_KEY: ref(good) } },
              [`mcp-577-e-unres-${n}`]: { command: "node", env: { K: ref(`missing-${n}`) } },
              [`mcp-577-e-foreign-${n}`]: { command: "node", env: { API_KEY: ref(foreign) } },
            },
          },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error.code).toBe("SECRET_BINDING_FORBIDDEN");
        expect(await db.mCPServer.count({ where: { label: goodEntry } })).toBe(0);
      });
    });

    // ── PR #585 review — a write never re-resolves what its check did not approve ──
    /** Drop `label` from whatever checked set the guard returns. */
    const dropFromCheck = (label: string) => {
      const without = (b: Record<string, string> | null | undefined) => {
        if (!b) return b;
        const copy = Object.assign(Object.create(null) as Record<string, string>, b);
        delete copy[label];
        return copy;
      };
      state.rewrite = (name, result) => {
        if (name === "assertMcpCreateSecretBinding") {
          const check = result as { bindings: Record<string, string> };
          return { ...check, bindings: without(check.bindings) };
        }
        if (name === "assertMcpImportSecretBinding") {
          const check = result as { bindings: Map<string, Record<string, string>> };
          for (const [k, v] of check.bindings) check.bindings.set(k, without(v)!);
          return check;
        }
        const check = result as { checkedAt: Date; bindings: Record<string, string> | null } | null;
        return check ? { ...check, bindings: without(check.bindings) } : check;
      };
    };
    /** Counts secret lookups after the check: the write must make none. */
    const countReReads = () => {
      const counter = { reReads: 0 };
      state.between = async () => {
        const findMany = db.secret.findMany.bind(db.secret);
        vi.spyOn(db.secret, "findMany").mockImplementation(((args: unknown) => {
          counter.reReads += 1;
          return findMany(args as never);
        }) as never);
      };
      return counter;
    };

    it("create: a reference the checked set misses is refused (500), no row, no re-read", async () => {
      const label = `mcp-577-unchecked-${next()}`;
      await ownSecret(label, "u-coord");
      dropFromCheck(label);
      const counter = countReReads();
      const serverLabel = `mcp-577-${next()}`;
      const res = await call("post", "/api/mcp", COORD, {
        scope: "global",
        label: serverLabel,
        transport: "stdio",
        command: "node",
        env: { API_KEY: ref(label) },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(500);
      expect(res.body.error.code).toBe("SECRET_BINDING_UNCHECKED");
      expect(counter.reReads).toBe(0);
      expect(await db.mCPServer.count({ where: { label: serverLabel } })).toBe(0);
    });

    it("PATCH: a new reference the checked set misses is refused (500), row unchanged", async () => {
      const kept = `mcp-577-kept-${next()}`;
      const keptId = await ownSecret(kept, "u-coord");
      const created = await call("post", "/api/mcp", COORD, {
        scope: "global",
        label: `mcp-577-${next()}`,
        transport: "stdio",
        command: "node",
        env: { KEPT: ref(kept) },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.data.id as string;
      const before = await db.mCPServer.findUniqueOrThrow({ where: { id } });
      const label = `mcp-577-unchecked-${next()}`;
      await ownSecret(label, "u-coord");
      dropFromCheck(label);
      const counter = countReReads();
      const res = await call("patch", `/api/mcp/${id}`, COORD, {
        env: { KEPT: ref(kept), API_KEY: ref(label) },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(500);
      expect(res.body.error.code).toBe("SECRET_BINDING_UNCHECKED");
      expect(counter.reReads).toBe(0);
      const after = await db.mCPServer.findUniqueOrThrow({ where: { id } });
      expect(after.envJson).toBe(before.envJson);
      expect(await bindingsOf(id)).toEqual({ [kept]: keptId });
    });

    it("re-bind: a flagged reference the checked set misses is refused (500), still unbound", async () => {
      const label = `mcp-577-rebind-unchecked-${next()}`;
      await ownSecret(label, "u-other");
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
      dropFromCheck(label);
      const counter = countReReads();
      const res = await call("post", `/api/mcp/${id}/rebind-secrets`, OTHER);
      expect(res.status, JSON.stringify(res.body)).toBe(500);
      expect(res.body.error.code).toBe("SECRET_BINDING_UNCHECKED");
      expect(counter.reReads).toBe(0);
      expect(await bindingsOf(id)).toEqual({});
    });

    it("import: an entry whose reference the checked set misses fails alone, unbound", async () => {
      const label = `mcp-577-imp-unchecked-${next()}`;
      await ownSecret(label, "u-coord");
      dropFromCheck(label);
      const counter = countReReads();
      const bad = `mcp-577-e-unchecked-${next()}`;
      const plain = `mcp-577-e-plain-${next()}`;
      const res = await call("post", "/api/mcp/import", COORD, {
        mcpJson: {
          mcpServers: {
            [bad]: { command: "node", env: { API_KEY: ref(label) } },
            [plain]: { command: "node", env: { GITHUB_TOKEN: "ghp_plain577second" } },
          },
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(207);
      expect(res.body.data.errors).toEqual([
        expect.objectContaining({ label: bad, code: "SECRET_BINDING_UNCHECKED" }),
      ]);
      expect(counter.reReads).toBe(0);
      expect(await db.mCPServer.count({ where: { label: bad } })).toBe(0);
      expect(await db.mCPServer.count({ where: { label: plain } })).toBe(1);
    });

    it.each([
      ["/api/mcp/registry/install", { registryServerId: "reg-577" }],
      ["/api/mcp/federation/install", { entryId: "fed-577" }],
    ])("%s binds nothing and still installs (201)", async (url, body) => {
      const res = await call("post", url, COORD, { ...body, label: `mcp-577-inst-${next()}` });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await bindingsOf(res.body.data.id)).toEqual({});
    });

    it("PATCH without env or headers binds nothing and keeps the stored bindings", async () => {
      const label = `mcp-577-keep-${next()}`;
      const own = await ownSecret(label, "u-coord");
      const created = await call("post", "/api/mcp", COORD, {
        scope: "global",
        label: `mcp-577-${next()}`,
        transport: "stdio",
        command: "node",
        env: { API_KEY: ref(label) },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.data.id as string;
      const res = await call("patch", `/api/mcp/${id}`, COORD, { enabled: false });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.enabled).toBe(false);
      expect(await bindingsOf(id)).toEqual({ [label]: own });
    });
  },
);
