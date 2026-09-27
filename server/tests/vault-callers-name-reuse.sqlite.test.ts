/**
 * #258 — every vault caller, against a REAL SQLite database built by the real
 * migration chain and the REAL `VaultService`. The defect was an index the
 * test doubles did not have: `Secret.name` is `@unique` and soft-deleted rows
 * keep their name, and `JiraConnection` / `TestManagementConnection` carry an
 * `@@unique([projectId, label])` that also covers soft-deleted rows. Each case
 * re-uses a name or label after a delete and then reads the credential back
 * through the production read path, never through the object the test built.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
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

const { VaultService, SecretNameTakenError, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { SlackInstallationStore } = await import("../src/lib/slack/installation-store.js");
const { TeamsInstallationStore } = await import("../src/lib/teams/installation-store.js");
const { PagerDutyServiceConfigStore } =
  await import("../src/lib/pagerduty/service-config-store.js");
const jira = await import("../src/lib/connectors/jira/jira-service.js");
const testmgmt = await import("../src/lib/connectors/testmgmt/connection-service.js");

const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#258 — vault callers re-use names and labels after a delete (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let vault: InstanceType<typeof VaultService>;
    const prevKey = process.env.VAULT_MASTER_KEY;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("258-vault-callers");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      // The Jira service reads through the vault singleton; give it a stable key.
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      await db.user.create({
        data: { id: "u1", username: "u1", displayName: "u1", email: "u1@x.test" },
      });
      await db.workspace.create({ data: { id: "ws-1", name: "W", slug: "ws-1" } });
      await db.project.create({ data: { id: "p1", name: "P", slug: "p1", createdById: "u1" } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
      else process.env.VAULT_MASTER_KEY = prevKey;
      __resetVaultSingleton();
    });

    it("VaultService.create on a soft-deleted name throws SecretNameTakenError, not a raw P2002", async () => {
      const s = await vault.create("taken-name", "v1", "project");
      await vault.delete(s.id);
      await expect(vault.create("taken-name", "v2", "project")).rejects.toBeInstanceOf(
        SecretNameTakenError,
      );
    });

    it("Slack: reinstall after uninstall succeeds and resolves the NEW token", async () => {
      const store = new SlackInstallationStore(db, vault);
      await store.install({ workspaceId: "ws-1", slackTeamId: "T1", botToken: "xoxb-old" });
      expect(await store.uninstall("ws-1")).toBe(true);
      await store.install({ workspaceId: "ws-1", slackTeamId: "T1", botToken: "xoxb-new" });
      expect((await store.resolveBotToken("ws-1"))?.botToken).toBe("xoxb-new");
    });

    it("Teams: reinstall after uninstall succeeds and resolves the NEW password", async () => {
      const store = new TeamsInstallationStore(db, vault);
      await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw-old" });
      expect(await store.uninstall("ws-1")).toBe(true);
      await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw-new" });
      expect((await store.resolveAppPassword("ws-1"))?.appPassword).toBe("pw-new");
    });

    it("PagerDuty: re-register after delete succeeds and resolves the NEW routing key", async () => {
      const store = new PagerDutyServiceConfigStore(db, vault);
      await store.register({ workspaceId: "ws-1", routingKey: "rk-old" });
      expect(await store.delete("ws-1", "default")).toBe(true);
      await store.register({ workspaceId: "ws-1", routingKey: "rk-new" });
      expect(await store.resolveRoutingKey("ws-1")).toBe("rk-new");
    });

    it("Jira: a deleted connection's label can be used again, and the new token is what it reads", async () => {
      const input = {
        edition: "datacenter" as const,
        baseUrl: "https://jira.example.test",
        username: "svc",
        label: "prod",
      };
      const first = await jira.createJiraConnection("p1", { ...input, apiToken: "old" }, "u1");
      await jira.deleteJiraConnection(first.id, "u1");

      const second = await jira.createJiraConnection("p1", { ...input, apiToken: "new" }, "u1");

      expect(second.label).toBe("prod");
      const row = await db.jiraConnection.findUniqueOrThrow({ where: { id: second.id } });
      expect((await vault.read(row.secretId)).plaintext).toBe("new");
      expect((await jira.listJiraConnections("p1")).map((c) => c.id)).toEqual([second.id]);
      // A live duplicate is still refused.
      await expect(
        jira.createJiraConnection("p1", { ...input, apiToken: "x" }, "u1"),
      ).rejects.toMatchObject({ status: 409, code: "JIRA_LABEL_TAKEN" });
    });

    it("test management: a deleted connection's label can be re-used; rotation keeps working", async () => {
      const deps = { prisma: db, vault, assertHost: async () => undefined };
      const input = {
        label: "zs",
        kind: "zephyr" as const,
        baseUrl: "https://zephyr.example.test",
        auth: { kind: "zephyr" as const, bearerToken: "old" },
      };
      const first = await testmgmt.createTestManagementConnection("p1", input, "u1", deps);
      await testmgmt.deleteTestManagementConnection(first.id, "u1", undefined, deps);

      const second = await testmgmt.createTestManagementConnection(
        "p1",
        { ...input, auth: { kind: "zephyr", bearerToken: "new" } },
        "u1",
        deps,
      );
      await testmgmt.updateTestManagementConnection(
        second.id,
        { auth: { kind: "zephyr", bearerToken: "newer" } },
        "u1",
        undefined,
        deps,
      );

      const loaded = await testmgmt.loadResolvedTestManagementConnection(
        second.id,
        undefined,
        deps,
      );
      expect(loaded.label).toBe("zs");
      expect(loaded.auth).toEqual({ kind: "zephyr", bearerToken: "newer" });
    });
  },
);
