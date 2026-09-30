/**
 * #479 / #495 — the binding-guarded-update suite, shared by the SQLite test
 * (`vault-secret-binding-479.sqlite.test.ts`) and its Postgres twin
 * (`vault-secret-binding-479-postgres.integration.test.ts`), so the conditional
 * write is proved on both databases by one body.
 *
 * The #344/#358 guards read a row, decide, and the service then re-reads and
 * writes it without a transaction. Two concurrent PATCHes could interleave:
 *
 *   B (keep the foreign secret, move nothing)  — guard reads row, allows
 *   A (move it, replacing the secret with own) — guard allows, A writes
 *   B writes — the foreign secret again, now at A's destination
 *
 * Each guard returns the `updatedAt` it read and the service's write is
 * `updateMany where { id, updatedAt }`; no match is a 409.
 *
 * #495 — a PATCH that loses that race must not leave a vault secret behind: it
 * is refused before any vault work when the row already moved, and it withdraws
 * the secrets it created when the row moves while that work is under way.
 *
 * The interleavings are FORCED, not raced. The calling test file wraps both
 * guard modules so `state.between` runs after a guard returns and before the
 * service writes; this suite wraps the vault so `state.afterVaultCreate` runs
 * after a secret is created and before the row is written. Everything else —
 * router, auth, vault, audit, the database — is real, and every outcome is
 * proved by reading the rows back.
 *
 * The calling file must `vi.mock` `lib/prisma.js` (returning `state.db`), the
 * connector network allowlist, and the two guard modules (through
 * `interleaved-guards.ts`), before importing this.
 */
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorsRouter } from "../../src/routes/connectors.js";
import { jiraRouter } from "../../src/routes/jira.js";
import { testManagementRouter } from "../../src/routes/test-management.js";
import { mcpRouter } from "../../src/routes/mcp.js";
import { errorHandler, notFoundHandler } from "../../src/middleware/error-handler.js";
import { issueTokens } from "../../src/lib/auth/jwt.js";
import { getVaultService, __resetVaultSingleton } from "../../src/lib/vault/vault-service.js";
import { getAuditService } from "../../src/lib/audit/audit-service.js";
import {
  setMCPRegistry,
  getMCPRegistry,
  MCPRegistryService,
} from "../../src/lib/mcp/mcp-service.js";
import { MCPLifecycleManager } from "../../src/lib/mcp/lifecycle-manager.js";
import { updateDbConnector } from "../../src/lib/connectors/db/db-service.js";
import { updateRepoConnector } from "../../src/lib/connectors/repo/repo-service.js";
import { updateJiraConnection } from "../../src/lib/connectors/jira/jira-service.js";
import { updateTestManagementConnection } from "../../src/lib/connectors/testmgmt/connection-service.js";

import type { BindingSuiteState } from "./interleaved-guards.js";

export type { BindingSuiteState };

type Method = "post" | "patch";

export function describeConditionalBindingUpdates(opts: {
  title: string;
  enabled: boolean;
  state: BindingSuiteState;
  /** Unique per run: every row and secret name carries it (a Postgres db is shared). */
  suffix: string;
  connect: () => Promise<{ db: PrismaClient; cleanup: () => Promise<void> | void }>;
  /**
   * Delete every row this run wrote before disconnecting. Needed where the
   * database outlives the run (Postgres); a throwaway SQLite file does not.
   */
  purgeRunRows?: boolean;
  hookTimeoutMs?: number;
}): void {
  const { state, suffix } = opts;
  describe.runIf(opts.enabled)(opts.title, () => {
    let db: PrismaClient;
    let cleanup: () => Promise<void> | void = () => undefined;
    let ADMIN = "";
    let COORD = "";
    const ADMIN_ID = `u-admin-479-${suffix}`;
    const COORD_ID = `u-coord-479-${suffix}`;
    const WS = `ws-479-${suffix}`;
    const PROJ = `proj-479-${suffix}`;
    const CONFLICT = "CONCURRENT_UPDATE";
    const EVIL = "attacker.example.test";
    const ref = (body: string) => `\${vault:${body}}`;
    /** Created by the admin: the coordinator never saw its value. */
    let FOREIGN = "";
    const FOREIGN_LABEL = `admin-secret-479-${suffix}`;
    /** Created by the coordinator. */
    let OWN = "";
    const OWN_LABEL = `coord-secret-479-${suffix}`;

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

    /**
     * #495 — PATCH `url` with `patchB`; after B has created a vault secret and
     * before B writes the row, PATCH `url` with `patchA` to completion.
     */
    const interleaveAfterVault = async (url: string, patchB: unknown, patchA: unknown) => {
      let a: request.Response | undefined;
      state.afterVaultCreate = async () => {
        a = await call("patch", url, COORD, patchA);
      };
      const b = await call("patch", url, COORD, patchB);
      expect(state.afterVaultCreate, "B created no vault secret").toBeNull();
      return { a: a!, b };
    };

    /** The coordinator's live secrets — what a losing PATCH must not add to. */
    const liveCoordSecrets = async () =>
      (
        await db.secret.findMany({
          where: { createdById: COORD_ID, deletedAt: null },
          select: { id: true },
        })
      )
        .map((s) => s.id)
        .sort();
    /**
     * Every secret row the coordinator ever created, withdrawn ones included:
     * unchanged only when a PATCH did no vault work at all.
     */
    const everyCoordSecret = async () =>
      (await db.secret.findMany({ where: { createdById: COORD_ID }, select: { id: true } }))
        .map((s) => s.id)
        .sort();

    let seq = 0;
    const next = () => (seq += 1);
    /** Every MCP server this run created, for `purgeRunRows`. */
    const mcpServerIds: string[] = [];

    type Model = "jiraConnection" | "testManagementConnection" | "mCPServer";
    /**
     * #495 — run `fn` with `model.findUniqueOrThrow` failing: the read the
     * service makes right AFTER its conditional write has committed. Anything
     * the request does after that point sees a written row.
     */
    const failingReadAfterWrite = async <T>(model: Model, fn: () => Promise<T>): Promise<T> => {
      const real = db;
      const delegate = (real as unknown as Record<Model, object>)[model];
      const failing = new Proxy(delegate, {
        get(target, prop) {
          if (prop === "findUniqueOrThrow") {
            return async () => {
              throw new Error("injected: read after the committed write failed");
            };
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as () => unknown).bind(target) : v;
        },
      });
      state.db = new Proxy(real, {
        get(target, prop) {
          if (prop === model) return failing;
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as () => unknown).bind(target) : v;
        },
      });
      try {
        return await fn();
      } finally {
        state.db = real;
      }
    };

    /** #495 — the `vault.delete` audit rows recorded against `secretIds`. */
    const withdrawalAudits = async (secretIds: string[]) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.delete", targetType: "secret", targetId: { in: secretIds } },
      });
    };
    /** #495 — every audit row names `reason: concurrent_update` and the actor. */
    const expectConcurrentWithdrawals = async (secretIds: string[]) => {
      expect(secretIds.length, "the losing PATCH created no secret").toBeGreaterThan(0);
      const rows = await withdrawalAudits(secretIds);
      expect(rows.map((r) => r.targetId).sort()).toEqual([...secretIds].sort());
      for (const r of rows) {
        expect(r.actorId).toBe(COORD_ID);
        expect(JSON.parse(r.metadata ?? "{}")).toMatchObject({ reason: "concurrent_update" });
      }
    };
    /** Secrets `after` holds that `before` did not. */
    const added = (before: string[], after: string[]) => after.filter((s) => !before.includes(s));

    beforeAll(async () => {
      ({ db, cleanup } = await opts.connect());
      state.db = db;
      __resetVaultSingleton();
      const vault = getVaultService();
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

      for (const id of [ADMIN_ID, COORD_ID]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: COORD_ID, role: "member" },
      });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: ADMIN_ID, workspaceId: WS },
      });
      // An existing repo, so creating one below is not a project's first and
      // does not start a background deep-ingest whose status writes would
      // race the rows under test.
      await db.repoConnection.create({ data: { projectId: PROJ, label: "seed-repo-479" } });

      FOREIGN = (
        await vault.create(FOREIGN_LABEL, "admin-value", "global", { createdById: ADMIN_ID })
      ).id;
      OWN = (await vault.create(OWN_LABEL, "coord-value", "global", { createdById: COORD_ID })).id;

      const token = (userId: string, role: "admin" | "coordinator", workspaces: string[]) =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
      ADMIN = token(ADMIN_ID, "admin", []);
      COORD = token(COORD_ID, "coordinator", [WS]);
    }, opts.hookTimeoutMs);

    // `tests/setup.ts` restores every spy after each test, so it is reinstalled per test.
    beforeEach(() => {
      const vault = getVaultService();
      const realCreate = vault.create.bind(vault);
      vi.spyOn(vault, "create").mockImplementation(async (...args) => {
        const created = await realCreate(...args);
        const hook = state.afterVaultCreate;
        state.afterVaultCreate = null;
        if (hook) await hook();
        return created;
      });
    });

    afterEach(() => {
      state.between = null;
      state.afterVaultCreate = null;
    });

    /**
     * Every row this run wrote, children first. Most hang off the project and
     * go with it (`onDelete: Cascade`); MCP servers, secrets and audit rows do
     * not: secrets and audit rows are found by the run's users, MCP servers
     * (which carry no creator, and are renamed by the tests) by the ids created.
     */
    const purgeRunRows = async () => {
      const users = [ADMIN_ID, COORD_ID];
      await db.auditLog.deleteMany({ where: { actorId: { in: users } } });
      await db.mCPServer.deleteMany({ where: { id: { in: mcpServerIds } } });
      await db.project.deleteMany({ where: { id: PROJ } });
      await db.workspaceMember.deleteMany({ where: { workspaceId: WS } });
      await db.workspace.deleteMany({ where: { id: WS } });
      await db.secret.deleteMany({ where: { createdById: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    };

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      setMCPRegistry(null);
      __resetVaultSingleton();
      try {
        if (db && opts.purgeRunRows) await purgeRunRows();
      } finally {
        await db?.$disconnect();
        await cleanup();
      }
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
          updateDbConnector(PROJ, id, { label: "never" }, ADMIN_ID, null),
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
          updateRepoConnector(PROJ, id, { label: "never" }, ADMIN_ID, null),
        ).rejects.toMatchObject({ status: 409, code: CONFLICT });
        expect(await row(id)).toEqual(before);
      });
    });

    // ── Jira connections ─────────────────────────────────────────────────────
    describe("PATCH /api/jira/connections/:id", () => {
      const url = (id: string) => `/api/jira/connections/${id}`;
      const create = async () => {
        const res = await call("post", `/api/jira/connections?projectId=${PROJ}`, ADMIN, {
          label: `jira-${next()}`,
          edition: "datacenter",
          baseUrl: "https://jira.internal.example.test",
          username: "svc",
          apiToken: "jira-token-479",
          tlsCaCert: "-----BEGIN CERTIFICATE-----\nadmin\n-----END CERTIFICATE-----",
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.jiraConnection.findUniqueOrThrow({ where: { id } });
      /** Replaces the admin's API token and CA cert: two new coordinator secrets. */
      const newCredentials = {
        apiToken: "coord-token-495",
        tlsCaCert: "-----BEGIN CERTIFICATE-----\ncoord\n-----END CERTIFICATE-----",
      };

      it("a change between the guard and the write is a 409, not a silent overwrite", async () => {
        const id = await create();
        const { a, b } = await interleave(
          url(id),
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

      it("#495 — a PATCH whose row moved before its vault work leaves no new secret", async () => {
        const id = await create();
        const before = await row(id);
        const secretsBefore = await everyCoordSecret();
        const { a, b } = await interleave(url(id), newCredentials, { label: `a-${next()}` });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        expect(await everyCoordSecret()).toEqual(secretsBefore);
        const after = await row(id);
        expect(after.secretId).toBe(before.secretId);
        expect(after.tlsCaSecretId).toBe(before.tlsCaSecretId);
      });

      it("#495 — a PATCH whose row moved during its vault work withdraws the secrets it made", async () => {
        const id = await create();
        const before = await row(id);
        const secretsBefore = await liveCoordSecrets();
        const secretsEvery = await everyCoordSecret();
        const { a, b } = await interleaveAfterVault(url(id), newCredentials, {
          label: `a-${next()}`,
        });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        expect(await liveCoordSecrets()).toEqual(secretsBefore);
        const after = await row(id);
        expect(after.secretId).toBe(before.secretId);
        expect(after.tlsCaSecretId).toBe(before.tlsCaSecretId);
        // The row's own secrets are untouched: only B's new ones were withdrawn.
        const held = await db.secret.findMany({
          where: { id: { in: [before.secretId, before.tlsCaSecretId!] }, deletedAt: null },
        });
        expect(held).toHaveLength(2);
        // A09 — each withdrawal is on the record, as each creation was.
        await expectConcurrentWithdrawals(added(secretsEvery, await everyCoordSecret()));
      });

      it("#495 — a failure after the write has landed keeps the secrets the row now names", async () => {
        const id = await create();
        const before = await row(id);
        const res = await failingReadAfterWrite("jiraConnection", () =>
          call("patch", url(id), COORD, newCredentials),
        );
        expect(res.status, JSON.stringify(res.body)).toBe(500);
        const after = await row(id);
        expect(after.secretId).not.toBe(before.secretId);
        expect(after.tlsCaSecretId).not.toBe(before.tlsCaSecretId);
        const vault = getVaultService();
        expect((await vault.read(after.secretId)).plaintext).toBe(newCredentials.apiToken);
        expect((await vault.read(after.tlsCaSecretId!)).plaintext).toBe(newCredentials.tlsCaCert);
        expect(await withdrawalAudits([after.secretId, after.tlsCaSecretId!])).toEqual([]);
      });

      it("#495 — the same PATCH without a concurrent change keeps its new secrets", async () => {
        const id = await create();
        const secretsBefore = await liveCoordSecrets();
        const res = await call("patch", url(id), COORD, newCredentials);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const added = (await liveCoordSecrets()).filter((s) => !secretsBefore.includes(s));
        const after = await row(id);
        expect(added.sort()).toEqual([after.secretId, after.tlsCaSecretId].sort());
      });

      it("the service refuses a write whose guard saw no row", async () => {
        const id = await create();
        const before = await row(id);
        await expect(
          updateJiraConnection(id, { label: "never" }, ADMIN_ID, undefined, null),
        ).rejects.toMatchObject({ status: 409, code: CONFLICT });
        expect(await row(id)).toEqual(before);
      });
    });

    // ── Test-management connections ──────────────────────────────────────────
    describe("PATCH /api/test-management/connections/:id", () => {
      const url = (id: string) => `/api/test-management/connections/${id}`;
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
      const newAuth = { auth: { kind: "zephyr", bearerToken: "coord-zephyr-495" } };

      it("a change between the guard and the write is a 409, not a silent overwrite", async () => {
        const id = await create();
        const { a, b } = await interleave(
          url(id),
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

      it("#495 — a PATCH whose row moved before its vault work leaves no new secret", async () => {
        const id = await create();
        const before = await row(id);
        const secretsBefore = await everyCoordSecret();
        const { a, b } = await interleave(url(id), newAuth, { label: `a-${next()}` });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        expect(await everyCoordSecret()).toEqual(secretsBefore);
        expect((await row(id)).authConfigJson).toBe(before.authConfigJson);
      });

      it("#495 — a PATCH whose row moved during its vault work withdraws the secret it made", async () => {
        const id = await create();
        const before = await row(id);
        const secretsBefore = await liveCoordSecrets();
        const secretsEvery = await everyCoordSecret();
        const { a, b } = await interleaveAfterVault(url(id), newAuth, { label: `a-${next()}` });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        expect(await liveCoordSecrets()).toEqual(secretsBefore);
        expect((await row(id)).authConfigJson).toBe(before.authConfigJson);
        // A09 — the withdrawal is on the record, as the creation was.
        await expectConcurrentWithdrawals(added(secretsEvery, await everyCoordSecret()));
      });

      it("#495 — a PATCH that rotated the row's own secret in place and then lost the race does not withdraw it", async () => {
        // Seeded and PATCHed by the same owner, so `rotateOrCreate` rotates the
        // row's existing secret instead of creating one: the id is the one the
        // row already names, and withdrawing it would leave the row unreadable.
        const id = await create();
        const before = await row(id);
        const ownId = (JSON.parse(before.authConfigJson ?? "{}") as { bearerTokenRef?: string })
          .bearerTokenRef;
        expect(ownId, "the seeded row names no bearer-token secret").toBeTruthy();
        const secretId = ownId!.replace(/^\$\{vault:(.+)\}$/, "$1");
        const vault = getVaultService();
        const realRotate = vault.rotate.bind(vault);
        let a: request.Response | undefined;
        let rotated = 0;
        vi.spyOn(vault, "rotate").mockImplementation(async (...args) => {
          const result = await realRotate(...args);
          rotated += 1;
          if (!a) a = await call("patch", url(id), ADMIN, { label: `a-${next()}` });
          return result;
        });
        const createSpy = vi.mocked(vault.create);
        createSpy.mockClear();
        const b = await call("patch", url(id), ADMIN, {
          auth: { kind: "zephyr", bearerToken: "admin-rotated-495" },
        });
        expect(rotated, "B did not rotate the row's secret in place").toBeGreaterThan(0);
        expect(createSpy, "B created a secret instead of rotating").not.toHaveBeenCalled();
        expect(a?.status, JSON.stringify(a?.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        // The row still names its own secret, which is live and readable.
        const after = await row(id);
        expect(after.authConfigJson).toBe(before.authConfigJson);
        const secret = await db.secret.findUniqueOrThrow({ where: { id: secretId } });
        expect(secret.deletedAt).toBeNull();
        await expect(vault.read(secretId)).resolves.toBeTruthy();
        expect(await withdrawalAudits([secretId])).toEqual([]);
      });

      it("#495 — a failure after the write has landed keeps the secret the row now names", async () => {
        const id = await create();
        const before = await row(id);
        const secretsBefore = await liveCoordSecrets();
        const res = await failingReadAfterWrite("testManagementConnection", () =>
          call("patch", url(id), COORD, newAuth),
        );
        expect(res.status, JSON.stringify(res.body)).toBe(500);
        const after = await row(id);
        expect(after.authConfigJson).not.toBe(before.authConfigJson);
        const made = added(secretsBefore, await liveCoordSecrets());
        expect(made).toHaveLength(1);
        expect(after.authConfigJson).toContain(made[0]);
        expect((await getVaultService().read(made[0])).plaintext).toBe(newAuth.auth.bearerToken);
        expect(await withdrawalAudits(made)).toEqual([]);
      });

      it("the service refuses a write whose guard saw no row", async () => {
        const id = await create();
        const before = await row(id);
        await expect(
          updateTestManagementConnection(
            id,
            { label: "never" },
            ADMIN_ID,
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
      const url = (id: string) => `/api/mcp/${id}`;
      const create = async () => {
        const res = await call("post", "/api/mcp", ADMIN, {
          scope: "global",
          label: `mcp-${suffix}-${next()}`, // MCP labels are global: unique per run
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: ref(FOREIGN) },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        mcpServerIds.push(res.body.data.id as string);
        return res.body.data.id as string;
      };
      const row = (id: string) => db.mCPServer.findUniqueOrThrow({ where: { id } });
      /** A plaintext env value the route moves into the vault before the write. */
      const plaintextEnv = { env: { API_KEY: "coord-plaintext-key-495" } };

      it("a PATCH keeping the foreign secret cannot land it in a command a concurrent PATCH chose", async () => {
        const id = await create();
        const { a, b } = await interleave(
          url(id),
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

      it("#495 — a PATCH whose row moved before its vault work leaves no new secret", async () => {
        const id = await create();
        const secretsBefore = await everyCoordSecret();
        const { a, b } = await interleave(url(id), plaintextEnv, { label: `a-${next()}` });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        expect(await everyCoordSecret()).toEqual(secretsBefore);
        expect(JSON.parse((await row(id)).envJson ?? "{}")).toEqual({ API_KEY: ref(FOREIGN) });
      });

      it("#495 — a PATCH whose row moved during its vault work withdraws the secret it made", async () => {
        const id = await create();
        const secretsBefore = await liveCoordSecrets();
        const secretsEvery = await everyCoordSecret();
        const { a, b } = await interleaveAfterVault(url(id), plaintextEnv, {
          label: `a-${next()}`,
        });
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        expect(b.status, JSON.stringify(b.body)).toBe(409);
        expect(b.body.error.code).toBe(CONFLICT);
        expect(await liveCoordSecrets()).toEqual(secretsBefore);
        expect(JSON.parse((await row(id)).envJson ?? "{}")).toEqual({ API_KEY: ref(FOREIGN) });
        // A09 — the withdrawal is on the record, as the creation was.
        await expectConcurrentWithdrawals(added(secretsEvery, await everyCoordSecret()));
      });

      it("#495 — a failure after the write has landed keeps the secret the row now names", async () => {
        const id = await create();
        const secretsBefore = await liveCoordSecrets();
        const res = await failingReadAfterWrite("mCPServer", () =>
          call("patch", url(id), COORD, plaintextEnv),
        );
        expect(res.status, JSON.stringify(res.body)).toBe(500);
        const made = added(secretsBefore, await liveCoordSecrets());
        expect(made).toHaveLength(1);
        const [secret] = await db.secret.findMany({ where: { id: made[0] } });
        expect(JSON.parse((await row(id)).envJson ?? "{}").API_KEY).toBe(
          ref(secret.name.replace(/^global:/, "")),
        );
        expect((await getVaultService().read(made[0])).plaintext).toBe(plaintextEnv.env.API_KEY);
        expect(await withdrawalAudits(made)).toEqual([]);
      });

      it("#495 — the same PATCH without a concurrent change keeps its new secret", async () => {
        const id = await create();
        const secretsBefore = await liveCoordSecrets();
        const res = await call("patch", url(id), COORD, plaintextEnv);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const added = (await liveCoordSecrets()).filter((s) => !secretsBefore.includes(s));
        expect(added).toHaveLength(1);
        const [secret] = await db.secret.findMany({ where: { id: added[0] } });
        expect(JSON.parse((await row(id)).envJson ?? "{}").API_KEY).toContain(
          secret.name.replace(/^global:/, ""),
        );
      });

      it("the service refuses a write whose guard saw no row", async () => {
        const id = await create();
        const before = await row(id);
        await expect(
          getMCPRegistry().update(id, { label: "never" }, { id: ADMIN_ID, role: "admin" }, null),
        ).rejects.toMatchObject({ status: 409, code: CONFLICT });
        expect(await row(id)).toEqual(before);
      });
    });
  });
}
