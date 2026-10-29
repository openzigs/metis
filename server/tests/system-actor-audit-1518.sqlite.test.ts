/**
 * #1518 — a system-initiated connector Test keeps its audit row.
 *
 * The boot permission re-check (#1488/#1499) and the scheduled refresh call
 * `testRepoConnector(projectId, id, "system")`. `AuditLog.actorId` is a foreign
 * key to `User` and no user has the id `system`, so every such row failed its
 * insert ("Foreign key constraint violated") and was lost. Real migrated SQLite
 * with the REAL audit service (not mocked), so the foreign key is enforced; a
 * fake GitHub for the Test itself.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/connectors/network-allowlist.js", async (original) => ({
  ...(await original<typeof import("../src/lib/connectors/network-allowlist.js")>()),
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async (hostname: string) => ({
    address: "192.0.2.1",
    family: 4,
    hostname,
  })),
}));

const { recheckUnrecordedRepoPermissions } =
  await import("../src/lib/connectors/repo/permission-recheck.js");
const { __setOctokitFactory, testRepoConnector } =
  await import("../src/lib/connectors/repo/repo-service.js");
const { VaultService, __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { audit, getAuditService, __resetAuditSingleton, SYSTEM_ACTOR_ID } =
  await import("../src/lib/audit/audit-service.js");

const MASTER_KEY = Buffer.alloc(32, 18).toString("base64");
const TOKEN = "ghp_system_actor_1518";

/** Wait for the queued (microtask) audit writes to land. */
async function flushAudit(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (getAuditService().inFlight === 0) return;
  }
  throw new Error("audit writes did not settle");
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1518 — system-initiated actions write their audit row",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let secretId: string;

    const seed = (id: string) =>
      db.repoConnection.create({
        data: {
          id,
          projectId: "p-1518",
          label: id,
          ownerOrOrg: "acme-1518",
          repoName: id,
          status: "connected",
          provider: "github",
          secretId,
          repoPermission: null,
        },
      });

    const testRows = (connectorId: string) =>
      db.auditLog.findMany({
        where: { action: "connector.repo.test", targetId: connectorId },
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1518-system-actor-audit");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      __resetAuditSingleton();
      await db.user.create({
        data: { id: "u-1518", username: "u1518", displayName: "u", email: "u1518@example.test" },
      });
      await db.project.create({
        data: { id: "p-1518", name: "p", slug: "p-1518", createdById: "u-1518" },
      });
      const vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      secretId = (await vault.create("pat-1518", TOKEN, "global", { createdById: "u-1518" })).id;
      __setOctokitFactory(
        (args) =>
          ({
            rest: {
              repos: {
                get: async () => ({
                  data: {
                    id: 1,
                    name: "r",
                    full_name: "acme-1518/r",
                    default_branch: "main",
                    private: false,
                    archived: false,
                    size: 1,
                    language: null,
                    permissions: { admin: args.token === TOKEN, push: true, pull: true },
                  },
                }),
              },
              git: { getRef: async () => ({ data: {} }) },
            },
          }) as never,
      );
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      __setOctokitFactory(null);
      __resetVaultSingleton();
      __resetAuditSingleton();
      delete process.env.VAULT_MASTER_KEY;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.repoConnection.deleteMany({});
      await db.auditLog.deleteMany({});
    });

    it("the boot permission re-check's Test writes an audit row marked as system", async () => {
      await seed("c-boot");
      const out = await recheckUnrecordedRepoPermissions({
        sleep: async () => undefined,
        env: {},
      });
      expect(out).toMatchObject({ candidates: 1, recorded: 1, failed: 0 });
      await flushAudit();

      // On main the insert failed the AuditLog→User foreign key: zero rows.
      const rows = await testRows("c-boot");
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBeNull();
      const meta = JSON.parse(rows[0].metadata ?? "{}") as Record<string, unknown>;
      expect(meta).toMatchObject({
        actorType: "system",
        projectId: "p-1518",
        repo: "acme-1518/c-boot",
      });
    });

    it("a Test called with the system actor directly (the scheduled refresh's path) keeps its row", async () => {
      await seed("c-sched");
      await testRepoConnector("p-1518", "c-sched", SYSTEM_ACTOR_ID);
      await flushAudit();
      const rows = await testRows("c-sched");
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBeNull();
      expect(JSON.parse(rows[0].metadata ?? "{}")).toMatchObject({ actorType: "system" });
    });

    it("a user-initiated Test still names the user and carries no system marker", async () => {
      await seed("c-user");
      await testRepoConnector("p-1518", "c-user", "u-1518");
      await flushAudit();
      const rows = await testRows("c-user");
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe("u-1518");
      expect(JSON.parse(rows[0].metadata ?? "{}")).not.toHaveProperty("actorType");
    });

    it.each([
      ["a bare string", SYSTEM_ACTOR_ID],
      ["an actor object", { id: SYSTEM_ACTOR_ID }],
    ])("audit() given the system actor as %s persists the row", async (_label, actor) => {
      // The non-connector paths (publish reconcile, replaced-secret sweep,
      // library auto-discover) pass `{ id: "system" }` straight to audit().
      audit({
        actor,
        action: "vault.delete",
        target: { type: "secret", id: "s-1518" },
        metadata: { source: "replaced_secret_sweep" },
      });
      await flushAudit();
      const rows = await db.auditLog.findMany({ where: { targetId: "s-1518" } });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBeNull();
      expect(JSON.parse(rows[0].metadata ?? "{}")).toEqual({
        source: "replaced_secret_sweep",
        actorType: "system",
      });
    });
  },
);
