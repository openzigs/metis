/**
 * #480 — a vault reference is bound to the secret id it resolved to when saved.
 *
 * #358 made the resolvers refuse a label that reaches more than one live
 * secret. One case remained: a resource bound to the caller's `global:x`; that
 * secret is soft-deleted and someone else creates `project:x`; the label now
 * resolves UNIQUELY to the new secret, which the resource then sends to the
 * destination the caller chose.
 *
 * For every resource type — DB connector, repo connector, MCP server, publish
 * batch — this file saves the resource against a coordinator's own secret by
 * LABEL, deletes that secret, has the admin create the same label in the other
 * scope, and then uses the resource. The admin's value must never be handed to
 * the network edge, and the stored binding must be the original secret id.
 *
 * Real routers, real auth, real vault, real SQLite built from the migration
 * chain. Only the network edge is stubbed, and each stub records the secret it
 * was handed: the DB driver, the repo Octokit factory, the MCP env resolver and
 * the publishing Octokit factory.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
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
  return { db: null as unknown, sent: [] as string[] };
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
vi.mock("../src/lib/publishing/octokit-factory.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    acquirePublishOctokit: async (opts: { token: string }) => {
      state.sent.push(opts.token);
      throw new Error("network stubbed in #480 test");
    },
  };
});

const { connectorsRouter } = await import("../src/routes/connectors.js");
const { mcpRouter } = await import("../src/routes/mcp.js");
const { publishingRouter } = await import("../src/routes/publishing.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");
const { expandVaultRefs } = await import("../src/lib/vault/env-manager.js");
const { registerDriver } = await import("../src/lib/connectors/db/driver.js");
const { __setOctokitFactory } = await import("../src/lib/connectors/repo/repo-service.js");

type Method = "get" | "post" | "patch";

const PROJ = "proj-480-binding-01";
const EVIL = "attacker.example.test";
const ADMIN_VALUE = "admin-value-480";
const ref = (body: string) => `\${vault:${body}}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#480 — a binding follows the secret it was made against, not its label",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ADMIN = "";
    let COORD = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/connectors", connectorsRouter());
      a.use("/api/projects/:projectId/publishing", publishingRouter());
      a.use("/api/mcp", mcpRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (method: Method, url: string, bearer: string, body?: unknown) => {
      const r = request(app())[method](url).set("Authorization", `Bearer ${bearer}`);
      return body === undefined ? r : r.send(body as object);
    };

    let seq = 0;
    const next = () => (seq += 1);

    /**
     * The coordinator's own `global:<label>` secret, and the move that
     * re-points the label: delete it, then the admin creates `project:<label>`.
     */
    const ownSecret = async (label: string, value: string) =>
      (await getVaultService().create(label, value, "global", { createdById: "u-coord" })).id;
    const reCreateInOtherScope = async (ownId: string, label: string) => {
      await getVaultService().delete(ownId);
      return (
        await getVaultService().create(label, ADMIN_VALUE, "project", { createdById: "u-admin" })
      ).id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("480-secret-binding");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();

      // Network edges that record the secret they were handed.
      registerDriver(
        "postgres",
        () =>
          ({
            init: async (config: { password?: string }) => {
              if (config.password) state.sent.push(config.password);
            },
            ping: async () => 1,
            close: async () => undefined,
            query: async () => ({ columns: [], rows: [], rowCount: 0, truncated: false }),
            introspect: async () => [],
            listRoutines: async () => [],
          }) as never,
      );
      __setOctokitFactory(((args: { token?: string }) => {
        if (args.token) state.sent.push(args.token);
        throw new Error("network stubbed in #480 test");
      }) as never);
      setMCPRegistry(
        new MCPRegistryService(
          new MCPLifecycleManager({
            resolveEnv: async (env, bindings) => {
              const out = await expandVaultRefs(env, getVaultService(), bindings);
              state.sent.push(...Object.values(out));
              return out;
            },
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
      // A project's first repo connector is deep-ingested (a real `git clone`)
      // on create; one already present keeps these tests off the network.
      await db.repoConnection.create({
        data: { projectId: PROJ, label: "pre-existing", provider: "github", isPrimary: true },
      });

      const token = (userId: string, role: "admin" | "coordinator", workspaces: string[]) =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
      ADMIN = token("u-admin", "admin", []);
      COORD = token("u-coord", "coordinator", ["ws-1"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      state.sent.length = 0;
    });

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      setMCPRegistry(null);
      __setOctokitFactory(null);
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── DB connectors ────────────────────────────────────────────────────────
    describe("DB connectors", () => {
      const dbs = `/api/projects/${PROJ}/connectors/dbs`;
      const createDb = async (secretRef: string) => {
        const res = await call("post", dbs, COORD, {
          label: `db-${next()}`,
          driver: "postgres",
          host: EVIL,
          port: 5432,
          secretRef,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.databaseConnection.findUnique({ where: { id } });

      it("stores the id a label resolved to, and refuses once that secret is gone", async () => {
        const label = `db-pw-480-${next()}`;
        const own = await ownSecret(label, "coord-db-480");
        const id = await createDb(ref(label));
        expect((await row(id))?.secretId).toBe(own);

        const ok = await call("post", `${dbs}/${id}/test`, COORD);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(state.sent).toEqual(["coord-db-480"]);

        state.sent.length = 0;
        await reCreateInOtherScope(own, label);
        const res = await call("post", `${dbs}/${id}/test`, COORD);
        expect(res.body.data, JSON.stringify(res.body)).toMatchObject({
          ok: false,
          code: "VAULT_BINDING_STALE",
        });
        expect(state.sent).toEqual([]);
        expect((await row(id))?.secretId).toBe(own);
      });

      it("never resolves a stale bound id as a label someone created later", async () => {
        const own = await ownSecret(`db-pw-480-${next()}`, "coord-db-480b");
        const id = await createDb(ref(own));
        await getVaultService().delete(own);
        // A secret whose LABEL is the deleted secret's id: a label fallback would pick it.
        await getVaultService().create(own, ADMIN_VALUE, "project", { createdById: "u-admin" });
        const res = await call("post", `${dbs}/${id}/test`, COORD);
        expect(res.body.data?.code, JSON.stringify(res.body)).toBe("VAULT_BINDING_STALE");
        expect(state.sent).toEqual([]);
      });

      it("a full-form save re-sending the bound ref keeps the binding; a new ref rebinds", async () => {
        const label = `db-pw-480-${next()}`;
        const own = await ownSecret(label, "coord-db-480c");
        const id = await createDb(ref(label));
        await reCreateInOtherScope(own, label);
        // The form echoes `secretRef` as `${vault:<bound id>}`: still bound to the deleted one.
        const saved = await call("patch", `${dbs}/${id}`, COORD, {
          label: `renamed-${next()}`,
          secretRef: ref(own),
        });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        expect((await row(id))?.secretId).toBe(own);
        // A different reference is resolved now, to the caller's new secret.
        const fresh = await ownSecret(`db-pw-480-${next()}`, "coord-db-480d");
        const rebound = await call("patch", `${dbs}/${id}`, COORD, { secretRef: ref(fresh) });
        expect(rebound.status, JSON.stringify(rebound.body)).toBe(200);
        expect((await row(id))?.secretId).toBe(fresh);
      });

      it("refuses a reference that names no secret, or a label in both scopes, before writing", async () => {
        const label = `db-pw-480-${next()}`;
        await getVaultService().create(label, "a", "global", { createdById: "u-admin" });
        await getVaultService().create(label, "b", "project", { createdById: "u-admin" });
        const ambiguous = await call("post", dbs, ADMIN, {
          label: `db-${next()}`,
          driver: "postgres",
          host: EVIL,
          secretRef: ref(label),
        });
        expect(ambiguous.status, JSON.stringify(ambiguous.body)).toBe(409);
        expect(ambiguous.body.error.code).toBe("VAULT_REF_AMBIGUOUS");
        const missing = await call("post", dbs, ADMIN, {
          label: `db-${next()}`,
          driver: "postgres",
          host: EVIL,
          secretRef: ref("no-such-480"),
        });
        expect(missing.status, JSON.stringify(missing.body)).toBe(400);
        expect(missing.body.error.code).toBe("VAULT_REF_UNRESOLVED");
        expect(
          await db.databaseConnection.count({ where: { host: EVIL, createdById: "u-admin" } }),
        ).toBe(0);
      });
    });

    // ── Repo connectors ──────────────────────────────────────────────────────
    describe("repo connectors", () => {
      const repos = `/api/projects/${PROJ}/connectors/repos`;
      const row = (id: string) => db.repoConnection.findUnique({ where: { id } });

      it("stores the id a label resolved to, and refuses once that secret is gone", async () => {
        const label = `repo-pat-480-${next()}`;
        const own = await ownSecret(label, "coord-repo-480");
        const created = await call("post", repos, COORD, {
          label: `repo-${next()}`,
          provider: "github_enterprise",
          ownerOrOrg: "octo",
          repoName: "app",
          apiBaseUrl: `https://${EVIL}/api/v3`,
          secretRef: ref(label),
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.data.id as string;
        expect((await row(id))?.secretId).toBe(own);

        await call("post", `${repos}/${id}/test`, COORD);
        expect(state.sent).toEqual(["coord-repo-480"]);

        state.sent.length = 0;
        await reCreateInOtherScope(own, label);
        const res = await call("post", `${repos}/${id}/test`, COORD);
        expect(res.body.data, JSON.stringify(res.body)).toMatchObject({
          ok: false,
          code: "VAULT_BINDING_STALE",
        });
        expect(state.sent).toEqual([]);
      });

      it("binds by secret id too, and keeps 404 for an unknown reference", async () => {
        const own = await ownSecret(`repo-pat-480-${next()}`, "coord-repo-480b");
        const byId = await call("post", repos, COORD, {
          label: `repo-${next()}`,
          provider: "github",
          ownerOrOrg: "octo",
          repoName: "app",
          secretRef: ref(own),
        });
        expect(byId.status, JSON.stringify(byId.body)).toBe(201);
        expect((await row(byId.body.data.id))?.secretId).toBe(own);
        const unknown = await call("post", repos, ADMIN, {
          label: `repo-${next()}`,
          provider: "github",
          ownerOrOrg: "octo",
          repoName: "app",
          secretRef: ref("no-such-480"),
        });
        expect(unknown.status, JSON.stringify(unknown.body)).toBe(404);
        expect(unknown.body.error.code).toBe("VAULT_SECRET_NOT_FOUND");
      });
    });

    // ── MCP servers ──────────────────────────────────────────────────────────
    describe("MCP servers", () => {
      const row = (id: string) => db.mCPServer.findUnique({ where: { id } });
      const bindings = async (id: string) =>
        JSON.parse((await row(id))?.secretBindings ?? "null") as Record<string, string> | null;

      it("stores the ids env and header refs resolved to, and refuses once a secret is gone", async () => {
        const label = `mcp-key-480-${next()}`;
        const hdr = `mcp-hdr-480-${next()}`;
        const own = await ownSecret(label, "coord-mcp-480");
        const ownHdr = await ownSecret(hdr, "coord-hdr-480");
        const created = await call("post", "/api/mcp", COORD, {
          scope: "global",
          label: `mcp-${next()}`,
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: ref(label) },
          headers: { "X-Token": ref(hdr) },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.data.id as string;
        expect(await bindings(id)).toEqual({ [label]: own, [hdr]: ownHdr });

        await call("post", `/api/mcp/${id}/start`, COORD);
        // #504 — header references are expanded through the bindings too.
        expect(state.sent).toEqual(["coord-mcp-480", "coord-hdr-480"]);

        state.sent.length = 0;
        await reCreateInOtherScope(own, label);
        const res = await call("post", `/api/mcp/${id}/start`, COORD);
        expect(state.sent).toEqual([]);
        expect(res.body.data?.status ?? "error").toBe("error");
        expect((await row(id))?.lastError ?? "").toMatch(/bound to has been deleted/);
      });

      it("an env edit keeps a kept reference's binding and binds only the new one", async () => {
        const label = `mcp-key-480-${next()}`;
        const own = await ownSecret(label, "coord-mcp-480b");
        const created = await call("post", "/api/mcp", COORD, {
          scope: "global",
          label: `mcp-${next()}`,
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: ref(label) },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id = created.body.data.id as string;
        await reCreateInOtherScope(own, label);
        const extra = `mcp-extra-480-${next()}`;
        const extraId = await ownSecret(extra, "coord-extra-480");
        // The coordinator may not change this env any more: `API_KEY`'s label now
        // reaches the admin's secret (#344). An admin may, and the kept reference
        // must stay bound to the deleted secret rather than follow its label.
        const refused = await call("patch", `/api/mcp/${id}`, COORD, {
          env: { API_KEY: ref(label), OTHER: ref(extra) },
        });
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        const res = await call("patch", `/api/mcp/${id}`, ADMIN, {
          env: { API_KEY: ref(label), OTHER: ref(extra) },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(await bindings(id)).toEqual({ [label]: own, [extra]: extraId });
      });
    });

    // ── Publish batches ──────────────────────────────────────────────────────
    describe("publish batches", () => {
      const batches = `/api/projects/${PROJ}/publishing/batches`;

      it("stores the id the token ref resolved to, and a later rollback refuses once it is gone", async () => {
        const label = `pub-pat-480-${next()}`;
        const own = await ownSecret(label, "coord-pub-480");
        const draft = await db.issueDraft.create({
          data: { projectId: PROJ, title: `Draft ${next()}`, body: "b", status: "approved" },
        });
        const created = await call("post", batches, COORD, {
          targetOwner: "octo",
          targetRepo: `repo-${next()}`,
          provider: "github_enterprise",
          targetBaseUrl: `https://${EVIL}/api/v3`,
          draftIds: [draft.id],
          dryRun: false,
          secretRef: ref(label),
        });
        expect(state.sent).toEqual(["coord-pub-480"]);
        const batch = await db.publishBatch.findFirstOrThrow({
          where: { projectId: PROJ, targetRepo: created.body.data?.batch?.targetRepo ?? undefined },
          orderBy: { createdAt: "desc" },
        });
        expect(JSON.parse(batch.metadata ?? "{}").secretId).toBe(own);

        state.sent.length = 0;
        await reCreateInOtherScope(own, label);
        const res = await call("post", `${batches}/${batch.id}/archive`, COORD, {
          reason: "roll back",
          closeIssues: true,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.error.code).toBe("VAULT_BINDING_STALE");
        expect(state.sent).toEqual([]);
      });

      it("caller metadata cannot supply the bound secret id", async () => {
        const own = await ownSecret(`pub-pat-480-${next()}`, "coord-pub-480b");
        const foreign = (
          await getVaultService().create(`pub-admin-480-${next()}`, ADMIN_VALUE, "global", {
            createdById: "u-admin",
          })
        ).id;
        const draft = await db.issueDraft.create({
          data: { projectId: PROJ, title: `Draft ${next()}`, body: "b", status: "approved" },
        });
        const targetRepo = `repo-${next()}`;
        await call("post", batches, COORD, {
          targetOwner: "octo",
          targetRepo,
          provider: "github_enterprise",
          targetBaseUrl: `https://${EVIL}/api/v3`,
          draftIds: [draft.id],
          dryRun: false,
          secretRef: ref(own),
          metadata: { secretId: foreign },
        });
        expect(state.sent).toEqual(["coord-pub-480b"]);
        const batch = await db.publishBatch.findFirstOrThrow({ where: { targetRepo } });
        expect(JSON.parse(batch.metadata ?? "{}").secretId).toBe(own);
      });

      it("a live batch whose ref names no secret is refused before any row is written", async () => {
        const draft = await db.issueDraft.create({
          data: { projectId: PROJ, title: `Draft ${next()}`, body: "b", status: "approved" },
        });
        const targetRepo = `repo-${next()}`;
        const res = await call("post", batches, ADMIN, {
          targetOwner: "octo",
          targetRepo,
          provider: "github",
          draftIds: [draft.id],
          dryRun: false,
          secretRef: ref("no-such-480"),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.error.code).toBe("VAULT_REF_UNRESOLVED");
        expect(await db.publishBatch.count({ where: { targetRepo } })).toBe(0);
      });
    });
  },
);
