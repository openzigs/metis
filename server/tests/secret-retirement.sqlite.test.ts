/**
 * #481 — when another user's Jira or test-management credentials are replaced,
 * the previous secret is soft-deleted unless something else still references
 * it. Runs against a REAL SQLite database built by the migration chain and the
 * REAL `VaultService`; every assertion reads the secret row back from the
 * database rather than trusting the object the service returned.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { VaultService, __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const {
  isSecretReferenced,
  retireReplacedSecret,
  withdrawCreatedSecrets,
  sweepReplacedSecrets,
  startReplacedSecretSweep,
} = await import("../src/lib/vault/secret-retirement.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
const jira = await import("../src/lib/connectors/jira/jira-service.js");
const testmgmt = await import("../src/lib/connectors/testmgmt/connection-service.js");
const { TASK_RETRY_WINDOW_MS } = await import("../src/lib/scheduler/task-retry-window.js");

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const OWNER = "owner";
const COORD = "coord";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#481 — a replaced foreign secret is retired unless still referenced (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let vault: InstanceType<typeof VaultService>;
    const prevKey = process.env.VAULT_MASTER_KEY;
    let seq = 0;
    const uniq = (p: string) => `${p}-${++seq}`;
    /** Every SQL statement the client sent, for the #574 query-plan check. */
    const captured: string[] = [];

    const isLive = async (id: string) =>
      (await db.secret.findUniqueOrThrow({ where: { id } })).deletedAt === null;
    const refIdOf = (ref: string) => /^\$\{vault:([^}]+)\}$/.exec(ref)![1];
    const nameOf = async (id: string) =>
      (await db.secret.findUniqueOrThrow({ where: { id } })).name;
    const labelOf = (name: string) => name.slice(name.indexOf(":") + 1);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("481-secret-retirement");
      db = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: sqlite.url }),
        log: [{ emit: "event", level: "query" }],
      });
      db.$on("query", (e) => captured.push(e.query));
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      for (const id of [OWNER, COORD]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
      }
      await db.project.create({ data: { id: "p1", name: "P", slug: "p1", createdById: OWNER } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
      else process.env.VAULT_MASTER_KEY = prevKey;
      __resetVaultSingleton();
    });

    // ---- Jira ---------------------------------------------------------------

    async function ownerJira(withCa = false) {
      const created = await jira.createJiraConnection(
        "p1",
        {
          label: uniq("j"),
          edition: "datacenter",
          baseUrl: "https://jira.example.test",
          username: "svc",
          apiToken: "owner-token",
          ...(withCa ? { tlsCaCert: "owner-ca" } : {}),
        },
        OWNER,
      );
      return db.jiraConnection.findUniqueOrThrow({ where: { id: created.id } });
    }

    it("Jira: a coordinator replacing the owner's token soft-deletes the owner's secret", async () => {
      const before = await ownerJira();

      await jira.updateJiraConnection(before.id, { apiToken: "coord-token" }, COORD);

      const after = await db.jiraConnection.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.secretId).not.toBe(before.secretId);
      expect((await vault.read(after.secretId)).plaintext).toBe("coord-token");
      expect(await isLive(before.secretId)).toBe(false);
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "vault.secret_retired",
          target: { type: "jira_connection", id: before.id },
          metadata: expect.objectContaining({ secretId: before.secretId }),
        }),
      );
    });

    it("Jira: a replaced TLS CA secret is retired too", async () => {
      const before = await ownerJira(true);

      await jira.updateJiraConnection(before.id, { tlsCaCert: "coord-ca" }, COORD);

      const after = await db.jiraConnection.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.tlsCaSecretId).not.toBe(before.tlsCaSecretId);
      expect(await isLive(before.tlsCaSecretId!)).toBe(false);
      // The token was not touched, so its secret stays.
      expect(await isLive(before.secretId)).toBe(true);
    });

    it("Jira: the owner's own rotation keeps the same live secret", async () => {
      const before = await ownerJira();

      await jira.updateJiraConnection(before.id, { apiToken: "owner-token-2" }, OWNER);

      const after = await db.jiraConnection.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.secretId).toBe(before.secretId);
      expect(await isLive(before.secretId)).toBe(true);
      expect((await vault.read(after.secretId)).plaintext).toBe("owner-token-2");
    });

    it("Jira: an old secret still referenced by a DB connector is left alone", async () => {
      const before = await ownerJira();
      await db.databaseConnection.create({
        data: { projectId: "p1", label: uniq("db"), driver: "postgres", secretId: before.secretId },
      });

      await jira.updateJiraConnection(before.id, { apiToken: "coord-token" }, COORD);

      const after = await db.jiraConnection.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.secretId).not.toBe(before.secretId);
      expect(await isLive(before.secretId)).toBe(true);
    });

    it("Jira: an old secret the owner's BYOK chat session uses is left alone", async () => {
      const before = await ownerJira();
      await db.aISession.create({
        data: {
          userId: OWNER,
          provider: "anthropic",
          model: "m",
          providerSecretRef: before.secretId,
        },
      });

      await jira.updateJiraConnection(before.id, { apiToken: "coord-token" }, COORD);

      const after = await db.jiraConnection.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.secretId).not.toBe(before.secretId);
      expect(await isLive(before.secretId)).toBe(true);
      expect((await vault.read(before.secretId)).plaintext).toBe("owner-token");
    });

    // ---- Test management ----------------------------------------------------

    const tmDeps = () => ({ prisma: db, vault, assertHost: async () => undefined });

    async function ownerZephyr(withCa = false) {
      const created = await testmgmt.createTestManagementConnection(
        "p1",
        {
          label: uniq("z"),
          kind: "zephyr",
          baseUrl: "https://zephyr.example.test",
          auth: { kind: "zephyr", bearerToken: "owner-bearer" },
          ...(withCa ? { tlsConfig: { rejectUnauthorized: true, caCert: "owner-ca" } } : {}),
        },
        OWNER,
        tmDeps(),
      );
      const row = await db.testManagementConnection.findUniqueOrThrow({
        where: { id: created.id },
      });
      const auth = JSON.parse(row.authConfigJson) as { bearerTokenRef: string };
      const tls = row.tlsConfigJson
        ? (JSON.parse(row.tlsConfigJson) as { caCertRef: string })
        : null;
      return {
        id: row.id,
        bearerId: refIdOf(auth.bearerTokenRef),
        caId: tls ? refIdOf(tls.caCertRef) : null,
      };
    }

    async function storedBearerId(id: string): Promise<string> {
      const row = await db.testManagementConnection.findUniqueOrThrow({ where: { id } });
      return refIdOf((JSON.parse(row.authConfigJson) as { bearerTokenRef: string }).bearerTokenRef);
    }

    it("test management: a coordinator replacing the owner's credential soft-deletes the old secret", async () => {
      const before = await ownerZephyr();

      await testmgmt.updateTestManagementConnection(
        before.id,
        { auth: { kind: "zephyr", bearerToken: "coord-bearer" } },
        COORD,
        undefined,
        tmDeps(),
      );

      const newId = await storedBearerId(before.id);
      expect(newId).not.toBe(before.bearerId);
      expect((await vault.read(newId)).plaintext).toBe("coord-bearer");
      expect(await isLive(before.bearerId)).toBe(false);
    });

    it("test management: a replaced TLS CA secret is retired", async () => {
      const before = await ownerZephyr(true);

      await testmgmt.updateTestManagementConnection(
        before.id,
        { tlsConfig: { rejectUnauthorized: true, caCert: "coord-ca" } },
        COORD,
        undefined,
        tmDeps(),
      );

      expect(await isLive(before.caId!)).toBe(false);
      expect(await isLive(before.bearerId)).toBe(true);
    });

    it.each([
      ["dropping the CA from the TLS config", { rejectUnauthorized: false }],
      ["clearing the TLS config", null],
    ] as const)("test management: %s replaces nothing, so nothing is retired", async (_w, tls) => {
      const before = await ownerZephyr(true);

      await testmgmt.updateTestManagementConnection(
        before.id,
        { tlsConfig: tls },
        COORD,
        undefined,
        tmDeps(),
      );

      expect(await isLive(before.caId!)).toBe(true);
    });

    it("test management: an old secret an MCP server references by label is left alone", async () => {
      const before = await ownerZephyr();
      const label = labelOf(await nameOf(before.bearerId));
      await db.mCPServer.create({
        data: {
          label: uniq("mcp"),
          transport: "stdio",
          envJson: JSON.stringify({ TOKEN: `\${vault:project:${label}}` }),
        },
      });

      await testmgmt.updateTestManagementConnection(
        before.id,
        { auth: { kind: "zephyr", bearerToken: "coord-bearer" } },
        COORD,
        undefined,
        tmDeps(),
      );

      expect(await storedBearerId(before.id)).not.toBe(before.bearerId);
      expect(await isLive(before.bearerId)).toBe(true);
    });

    // ---- isSecretReferenced, one column at a time ---------------------------

    async function freshSecret() {
      const s = await vault.create(uniq("probe"), "v", "project", { createdById: OWNER });
      return { id: s.id, name: await nameOf(s.id) };
    }

    const referrers: Array<[string, (id: string, label: string) => Promise<unknown>]> = [
      [
        "repo connector secretId",
        (id) =>
          db.repoConnection.create({ data: { projectId: "p1", label: uniq("r"), secretId: id } }),
      ],
      [
        "Jira tlsCaSecretId",
        async (id) => {
          const other = await vault.create(uniq("tok"), "t", "project");
          return db.jiraConnection.create({
            data: {
              projectId: "p1",
              label: uniq("jj"),
              edition: "cloud",
              baseUrl: "https://j.example.test",
              username: "u",
              secretId: other.id,
              tlsCaSecretId: id,
              createdById: OWNER,
            },
          });
        },
      ],
      [
        "test-management tlsConfigJson",
        (id) =>
          db.testManagementConnection.create({
            data: {
              projectId: "p1",
              label: uniq("tt"),
              kind: "zephyr",
              baseUrl: "https://z.example.test",
              tlsConfigJson: JSON.stringify({ caCertRef: `\${vault:${id}}` }),
              createdById: OWNER,
            },
          }),
      ],
      [
        "MCP envSecretId",
        (id) =>
          db.mCPServer.create({ data: { label: uniq("m"), transport: "stdio", envSecretId: id } }),
      ],
      [
        "MCP headers",
        (_id, label) =>
          db.mCPServer.create({
            data: {
              label: uniq("m"),
              transport: "http",
              headers: JSON.stringify({ Authorization: `Bearer \${vault:${label}}` }),
            },
          }),
      ],
      [
        "MCP envSecretRefs",
        (_id, label) =>
          db.mCPServer.create({
            data: {
              label: uniq("m"),
              transport: "stdio",
              envSecretRefs: JSON.stringify({ TOKEN: label }),
            },
          }),
      ],
      [
        "publish batch secretRef",
        (id) =>
          db.publishBatch.create({
            data: {
              projectId: "p1",
              targetOwner: "o",
              targetRepo: "r",
              startedById: OWNER,
              metadata: JSON.stringify({ secretRef: `\${vault:${id}}` }),
            },
          }),
      ],
      [
        "AI session providerSecretRef (BYOK)",
        (id) =>
          db.aISession.create({
            data: { userId: OWNER, provider: "anthropic", model: "m", providerSecretRef: id },
          }),
      ],
      [
        "scheduled http-webhook authHeader",
        (id) =>
          db.scheduledJob.create({
            data: {
              key: uniq("job"),
              name: "hook",
              cron: "0 * * * *",
              taskType: "http-webhook",
              payload: JSON.stringify({
                url: "https://hook.example.test",
                authHeader: `\${vault:${id}}`,
              }),
            },
          }),
      ],
    ];

    /** #495 — a Task's materialised copy of an http-webhook payload. */
    const webhookTask = (
      id: string,
      status: string,
      opts: { updatedAt?: Date; completedAt?: Date; type?: string } = {},
    ) =>
      db.task.create({
        data: {
          type: opts.type ?? "http-webhook",
          status,
          payload: JSON.stringify({
            url: "https://hook.example.test",
            authHeader: `\${vault:${id}}`,
          }),
          ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
          ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
        },
      });
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    /** Just past the retry window: a terminal Task this old can no longer be retried. */
    const expired = () => new Date(Date.now() - TASK_RETRY_WINDOW_MS - DAY);
    /** Just inside it. */
    const recent = () => new Date(Date.now() - TASK_RETRY_WINDOW_MS + DAY);

    it.each(["pending", "running", "failed", "cancelled"])(
      "#495 — a %s http-webhook Task's payload counts (a retry re-runs it)",
      async (status) => {
        const s = await freshSecret();
        await webhookTask(s.id, status);
        expect(await isSecretReferenced(s.id, s.name)).toBe(true);
      },
    );

    it.each(["failed", "cancelled"])(
      "#574 — a %s Task past the retry window no longer pins the secret",
      async (status) => {
        const s = await freshSecret();
        const t = await webhookTask(s.id, status, { updatedAt: expired() });
        // The row really is that old: the check is not passing on a fresh row.
        expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).updatedAt.getTime()).toBe(
          t.updatedAt.getTime(),
        );
        expect(await isSecretReferenced(s.id, s.name)).toBe(false);
      },
    );

    it.each(["failed", "cancelled"])(
      "#574 — a %s Task that ended past the window stays unpinned after an unrelated later write",
      async (status) => {
        const s = await freshSecret();
        const t = await webhookTask(s.id, status, { completedAt: expired(), updatedAt: expired() });
        // Any write to the row resets `updatedAt` (@updatedAt); it must not reopen the window.
        await db.task.update({ where: { id: t.id }, data: { progress: 50 } });
        const after = await db.task.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.updatedAt.getTime()).toBeGreaterThan(recent().getTime());
        expect(await isSecretReferenced(s.id, s.name)).toBe(false);
      },
    );

    it.each(["failed", "cancelled"])(
      "#574 — a %s Task that ended inside the window pins the secret",
      async (status) => {
        const s = await freshSecret();
        await webhookTask(s.id, status, { completedAt: recent(), updatedAt: recent() });
        expect(await isSecretReferenced(s.id, s.name)).toBe(true);
      },
    );

    it.each(["failed", "cancelled"])(
      "#574 — a %s Task still inside the retry window pins the secret",
      async (status) => {
        const s = await freshSecret();
        await webhookTask(s.id, status, { updatedAt: recent() });
        expect(await isSecretReferenced(s.id, s.name)).toBe(true);
      },
    );

    it.each(["pending", "running"])(
      "#574 — a %s Task pins the secret however old it is (it can still run)",
      async (status) => {
        const s = await freshSecret();
        await webhookTask(s.id, status, { updatedAt: expired() });
        expect(await isSecretReferenced(s.id, s.name)).toBe(true);
      },
    );

    it("#574 — only an http-webhook Task's payload counts (no other handler reads the vault)", async () => {
      const s = await freshSecret();
      await webhookTask(s.id, "pending", { type: "rerun-analysis" });
      expect(await isSecretReferenced(s.id, s.name)).toBe(false);
    });

    it("#574 — the Task reference check is answered from an index, not a table scan", async () => {
      const s = await freshSecret();
      captured.length = 0;
      await isSecretReferenced(s.id, s.name);
      const sql = captured.find((q) => /FROM [`"]?main[`"]?\.[`"]?tasks[`"]?/i.test(q));
      expect(sql, captured.join("\n")).toBeDefined();
      const raw = new Database(sqlite.dbFile, { readonly: true });
      try {
        const params = Array.from(sql!.matchAll(/\?/g), () => null);
        const plan = raw
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .map((r) => (r as { detail: string }).detail)
          .join("\n");
        expect(plan).toMatch(/SEARCH .*tasks USING INDEX tasks_type_status_idx/);
        expect(plan).not.toMatch(/SCAN .*tasks/);
      } finally {
        raw.close();
      }
    });

    it("#495 — a completed Task's payload does not count (it can never run again)", async () => {
      const s = await freshSecret();
      await webhookTask(s.id, "completed");
      expect(await isSecretReferenced(s.id, s.name)).toBe(false);
    });

    it("an unreferenced secret reads as unreferenced", async () => {
      const s = await freshSecret();
      expect(await isSecretReferenced(s.id, s.name)).toBe(false);
    });

    it.each(referrers)("a reference from %s counts", async (_what, attach) => {
      const s = await freshSecret();
      await attach(s.id, labelOf(s.name));
      expect(await isSecretReferenced(s.id, s.name)).toBe(true);
    });

    // ---- retireReplacedSecret edges -----------------------------------------

    const ctx = { actorId: COORD, target: { type: "t", id: "x" }, projectId: "p1" };

    it("an already-deleted secret is not retired again", async () => {
      const s = await freshSecret();
      await vault.delete(s.id);
      const del = vi.fn();
      expect(await retireReplacedSecret({ delete: del }, s.id, ctx)).toBe(false);
      expect(del).not.toHaveBeenCalled();
    });

    it("a vault failure leaves the secret live and does not throw", async () => {
      const s = await freshSecret();
      const del = vi.fn().mockRejectedValue(new Error("vault down"));
      expect(await retireReplacedSecret({ delete: del }, s.id, ctx)).toBe(false);
      expect(await isLive(s.id)).toBe(true);
    });

    // ---- withdrawCreatedSecrets (#495) --------------------------------------

    it("withdrawal audits each deleted secret, and one the vault refuses is skipped, not thrown", async () => {
      vi.mocked(audit).mockClear();
      const del = vi.fn(async (id: string) => {
        if (id === "refused") throw new Error("vault down");
      });
      await withdrawCreatedSecrets({ delete: del }, ["refused", "gone"], {
        actorId: COORD,
        resource: { type: "t", id: "x" },
        cause: new Error("unique violation"),
      });
      expect(del).toHaveBeenCalledTimes(2);
      expect(vi.mocked(audit).mock.calls.map(([e]) => e)).toEqual([
        {
          actor: { id: COORD },
          action: "vault.delete",
          target: { type: "secret", id: "gone" },
          metadata: {
            source: "update_not_applied",
            reason: "update_failed",
            resourceType: "t",
            resourceId: "x",
          },
        },
      ]);
    });

    it("#574 — a withdrawal after a failed create (no resource id) is audited as a create", async () => {
      vi.mocked(audit).mockClear();
      await withdrawCreatedSecrets({ delete: vi.fn(async () => {}) }, ["orphan"], {
        actorId: COORD,
        resource: { type: "jira_connection" },
        projectId: "p1",
        cause: new Error("CA write failed"),
      });
      expect(vi.mocked(audit).mock.calls.map(([e]) => e)).toEqual([
        {
          actor: { id: COORD },
          action: "vault.delete",
          target: { type: "secret", id: "orphan" },
          metadata: {
            source: "create_not_applied",
            reason: "create_failed",
            resourceType: "jira_connection",
            projectId: "p1",
          },
        },
      ]);
    });

    // ---- #591 — the replaced-secret sweep -----------------------------------

    const markOf = async (id: string) =>
      (await db.secret.findUniqueOrThrow({ where: { id } })).replacedKeptAt;
    const sweepAudits = () =>
      vi
        .mocked(audit)
        .mock.calls.map(([e]) => e)
        .filter((e) => e.action === "vault.delete");
    /** A sweep with the per-secret throttle off, so a just-marked secret is due. */
    const sweepDue = (now?: Date) => sweepReplacedSecrets(now, { recheckAfterMs: 0 });

    it("#591 — a replaced secret that is kept is marked, and its Updated time is untouched", async () => {
      const s = await freshSecret();
      await db.databaseConnection.create({
        data: { projectId: "p1", label: uniq("db"), driver: "postgres", secretId: s.id },
      });
      const before = await db.secret.findUniqueOrThrow({ where: { id: s.id } });

      expect(await retireReplacedSecret(vault, s.id, ctx)).toBe(false);

      const after = await db.secret.findUniqueOrThrow({ where: { id: s.id } });
      expect(after.replacedKeptAt).toBeInstanceOf(Date);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.deletedAt).toBeNull();
    });

    it("#591 — a retired replacement is not marked", async () => {
      const s = await freshSecret();
      expect(await retireReplacedSecret(vault, s.id, ctx)).toBe(true);
      expect(await markOf(s.id)).toBeNull();
    });

    it("#591 — a secret kept for an in-window Task is retired by the sweep once the Task ages out", async () => {
      const before = await ownerJira();
      const task = await webhookTask(before.secretId, "failed", {
        completedAt: recent(),
        updatedAt: recent(),
      });
      await jira.updateJiraConnection(before.id, { apiToken: "coord-token" }, COORD);
      // Kept at replacement time: the Task can still be retried.
      expect(await isLive(before.secretId)).toBe(true);
      expect(await markOf(before.secretId)).toBeInstanceOf(Date);

      vi.mocked(audit).mockClear();
      await sweepDue();
      // Still inside the window: the sweep leaves it alone.
      expect(await isLive(before.secretId)).toBe(true);
      expect(sweepAudits()).toEqual([]);

      await db.task.update({
        where: { id: task.id },
        data: { completedAt: expired(), updatedAt: expired() },
      });
      const result = await sweepDue();

      expect(await isLive(before.secretId)).toBe(false);
      expect(result.retired).toContain(before.secretId);
      expect(sweepAudits()).toEqual([
        {
          actor: { id: "system" },
          action: "vault.delete",
          target: { type: "secret", id: before.secretId },
          metadata: {
            source: "replaced_secret_sweep",
            reason: "replaced_no_longer_referenced",
          },
        },
      ]);
      // The connection's current secret is untouched.
      const after = await db.jiraConnection.findUniqueOrThrow({ where: { id: before.id } });
      expect(await isLive(after.secretId)).toBe(true);
    });

    it("#591 — the sweep keeps a replaced secret a live binding still references", async () => {
      const before = await ownerJira();
      await db.databaseConnection.create({
        data: { projectId: "p1", label: uniq("db"), driver: "postgres", secretId: before.secretId },
      });
      await jira.updateJiraConnection(before.id, { apiToken: "coord-token" }, COORD);
      expect(await markOf(before.secretId)).toBeInstanceOf(Date);

      vi.mocked(audit).mockClear();
      const result = await sweepDue();

      expect(await isLive(before.secretId)).toBe(true);
      expect(result.retired).not.toContain(before.secretId);
      expect(sweepAudits().map((e) => e.target.id)).not.toContain(before.secretId);
    });

    it("#591 — the sweep judges the retry window at the time it is given", async () => {
      const s = await freshSecret();
      await webhookTask(s.id, "failed", { completedAt: recent(), updatedAt: recent() });
      await db.secret.update({ where: { id: s.id }, data: { replacedKeptAt: new Date() } });
      expect((await sweepDue()).retired).not.toContain(s.id);
      const later = new Date(Date.now() + 2 * DAY);
      expect((await sweepDue(later)).retired).toContain(s.id);
      expect(await isLive(s.id)).toBe(false);
    });

    it("#591 — the sweep never touches an unreferenced secret that was not a kept replacement", async () => {
      const s = await freshSecret();
      await sweepDue();
      expect(await isLive(s.id)).toBe(true);
    });

    it("#591 — the sweep leaves a marked secret alone while a binding write is in flight", async () => {
      const s = await freshSecret();
      const now = new Date();
      await db.secret.update({
        where: { id: s.id },
        data: { replacedKeptAt: now, bindingWriteUntil: new Date(now.getTime() + 60_000) },
      });
      const result = await sweepDue(now);
      expect(await isLive(s.id)).toBe(true);
      expect(result.retired).not.toContain(s.id);

      // Once the window has closed it goes.
      await db.secret.update({ where: { id: s.id }, data: { bindingWriteUntil: now } });
      expect((await sweepDue(now)).retired).toContain(s.id);
      expect(await isLive(s.id)).toBe(false);
    });

    it("#591 — a failed check on one secret does not stop the sweep", async () => {
      const bad = await freshSecret();
      const good = await freshSecret();
      const now = new Date();
      // Older than anything an earlier test marked, so `bad` is the first row
      // the sweep reaches and so the one the injected failure hits.
      await db.secret.update({
        where: { id: bad.id },
        data: { replacedKeptAt: new Date(now.getTime() - 30 * DAY) },
      });
      await db.secret.update({
        where: { id: good.id },
        data: { replacedKeptAt: new Date(now.getTime() - 30 * DAY + 1_000) },
      });
      const spy = vi.spyOn(db.secret, "updateMany").mockImplementationOnce(() => {
        // A non-Error throw is reported too.
        throw "db locked";
      });
      try {
        const result = await sweepDue(now);
        expect(result.retired).toContain(good.id);
        expect(result.retired).not.toContain(bad.id);
      } finally {
        spy.mockRestore();
      }
      expect(await isLive(bad.id)).toBe(true);
      expect(await isLive(good.id)).toBe(false);
      // The failed one was not re-stamped, so the next run picks it up.
      expect((await sweepDue(now)).retired).toContain(bad.id);
      expect(await isLive(bad.id)).toBe(false);
    });

    it("#591 — one run re-checks at most batchSize secrets, oldest mark first", async () => {
      const now = new Date();
      // Created newest-first, so insertion order (what SQLite scans without an
      // ORDER BY) is the opposite of mark age: dropping `orderBy` picks the wrong two.
      const byAge = new Map<number, string>();
      for (const ageDays of [58, 59, 60]) {
        const s = await freshSecret();
        await db.secret.update({
          where: { id: s.id },
          data: { replacedKeptAt: new Date(now.getTime() - ageDays * DAY) },
        });
        byAge.set(ageDays, s.id);
      }
      const [oldest, middle, newest] = [byAge.get(60)!, byAge.get(59)!, byAge.get(58)!];

      const result = await sweepReplacedSecrets(now, { batchSize: 2 });

      expect(result.checked).toBe(2);
      expect(result.retired).toEqual(expect.arrayContaining([oldest, middle]));
      expect(result.retired).not.toContain(newest);
      expect(await isLive(newest)).toBe(true);
      // The next run reaches it.
      expect((await sweepReplacedSecrets(now, { batchSize: 2 })).retired).toContain(newest);
    });

    it("#591 — a still-referenced secret is re-checked at most once per interval", async () => {
      const s = await freshSecret();
      const conn = await db.databaseConnection.create({
        data: { projectId: "p1", label: uniq("db"), driver: "postgres", secretId: s.id },
      });
      const now = new Date();
      await db.secret.update({
        where: { id: s.id },
        data: { replacedKeptAt: new Date(now.getTime() - 2 * HOUR) },
      });

      // Due, checked, still referenced: kept and re-stamped.
      expect((await sweepReplacedSecrets(now)).retired).not.toContain(s.id);
      expect((await markOf(s.id))?.getTime()).toBe(now.getTime());

      // The binding goes. Within the interval the secret is not re-checked...
      await db.databaseConnection.delete({ where: { id: conn.id } });
      const soon = new Date(now.getTime() + 30 * 60_000);
      expect((await sweepReplacedSecrets(soon)).retired).not.toContain(s.id);
      expect(await isLive(s.id)).toBe(true);

      // ...and once the interval has passed it is, and goes.
      const later = new Date(now.getTime() + HOUR + 1_000);
      expect((await sweepReplacedSecrets(later)).retired).toContain(s.id);
      expect(await isLive(s.id)).toBe(false);
    });

    it("#591 — the sweep runs once shortly after start, not an interval later", async () => {
      vi.useFakeTimers();
      try {
        const sweep = vi.fn().mockResolvedValue({ checked: 0, retired: [] });
        const handle = startReplacedSecretSweep(HOUR, sweep, 5_000);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(sweep).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(sweep).toHaveBeenCalledTimes(1);
        handle.stop();

        // Stopped before the first run: it never happens.
        const other = vi.fn().mockResolvedValue({ checked: 0, retired: [] });
        startReplacedSecretSweep(HOUR, other, 5_000).stop();
        await vi.advanceTimersByTimeAsync(2 * HOUR);
        expect(other).not.toHaveBeenCalled();
        expect(sweep).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("#591 — the sweep runs on its interval until stopped, and a failed run does not kill it", async () => {
      vi.useFakeTimers();
      try {
        const sweep = vi
          .fn()
          .mockRejectedValueOnce(new Error("db down"))
          .mockRejectedValueOnce("db down")
          .mockResolvedValue({ checked: 0, retired: [] });
        const handle = startReplacedSecretSweep(1_000, sweep);
        expect(sweep).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(sweep).toHaveBeenCalledTimes(3);
        handle.stop();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(sweep).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });
  },
);
