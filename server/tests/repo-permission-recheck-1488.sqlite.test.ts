/**
 * #1488 (review of #1494) — the one-shot boot re-check of connectors upgraded
 * with no recorded permission. Real migrated SQLite for the candidate query,
 * a fake GitHub for the Test it runs; no live GitHub call.
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/connectors/network-allowlist.js", async (original) => ({
  ...(await original<typeof import("../src/lib/connectors/network-allowlist.js")>()),
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async (hostname: string) => ({
    address: "192.0.2.1",
    family: 4,
    hostname,
  })),
}));

const { recheckUnrecordedRepoPermissions, startRepoPermissionRecheck } =
  await import("../src/lib/connectors/repo/permission-recheck.js");
const { __setOctokitFactory } = await import("../src/lib/connectors/repo/repo-service.js");
const { VaultService, __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { newWebhookSecretNonce, webhookSecretCheck, webhookSecretRootKey } =
  await import("../src/lib/connectors/repo/webhook-secret.js");

const MASTER_KEY = Buffer.alloc(32, 15).toString("base64");
const TOKEN = "ghp_recheck_admin_1488";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1488 — boot re-check of connectors with no recorded permission",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let secretId: string;
    const noSleep = vi.fn(async (_ms: number) => undefined);

    const seed = (
      id: string,
      data: Partial<{
        status: string;
        provider: string;
        secretId: string | null;
        repoPermission: string | null;
        projectId: string;
        deletedAt: Date | null;
        webhookSecretNonce: string | null;
        webhookSecretCheck: string | null;
      }> = {},
    ) =>
      db.repoConnection.create({
        data: {
          id,
          projectId: "p-live",
          label: id,
          ownerOrOrg: "acme-recheck",
          repoName: id,
          status: "connected",
          provider: "github",
          secretId,
          repoPermission: null,
          ...data,
        },
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1488-permission-recheck");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      await db.user.create({
        data: { id: "u", username: "u", displayName: "u", email: "u@example.test" },
      });
      await db.project.create({ data: { id: "p-live", name: "l", slug: "l", createdById: "u" } });
      await db.project.create({
        data: { id: "p-gone", name: "g", slug: "g", createdById: "u", deletedAt: new Date() },
      });
      const vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      secretId = (await vault.create("recheck-pat-1488", TOKEN, "global", { createdById: "u" })).id;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      __setOctokitFactory(null);
      __resetVaultSingleton();
      delete process.env.VAULT_MASTER_KEY;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.repoConnection.deleteMany({});
      noSleep.mockClear();
    });

    it("re-tests exactly the connectors that would otherwise lose shared-secret reviews", async () => {
      const root = webhookSecretRootKey()!;
      const nonce = newWebhookSecretNonce();
      await seed("c-candidate");
      await seed("c-stale-own-secret", {
        // An own secret that no longer verifies does not exclude the connector.
        webhookSecretNonce: "stale-nonce",
        webhookSecretCheck: "not-the-check",
      });
      await seed("c-active-own-secret", { webhookSecretNonce: nonce });
      await db.repoConnection.update({
        where: { id: "c-active-own-secret" },
        data: { webhookSecretCheck: webhookSecretCheck(root, "c-active-own-secret", nonce) },
      });
      await seed("c-tokenless", { secretId: null });
      await seed("c-recorded", { repoPermission: "admin" });
      await seed("c-errored", { status: "error" });
      await seed("c-pending", { status: "pending" });
      await seed("c-gitlab", { provider: "gitlab" });
      await seed("c-deleted", { deletedAt: new Date() });
      await seed("c-deleted-project", { projectId: "p-gone" });

      const test = vi.fn(async (_p: string, _id: string, _actor: string) => ({}) as never);
      const out = await recheckUnrecordedRepoPermissions({
        test,
        sleep: noSleep,
        env: { REPO_PERMISSION_RECHECK_INTERVAL_MS: "1500" },
      });
      expect(test.mock.calls.map((c) => c[1]).sort()).toEqual([
        "c-candidate",
        "c-stale-own-secret",
      ]);
      expect(test.mock.calls.every((c) => c[0] === "p-live" && c[2] === "system")).toBe(true);
      expect(out).toEqual({
        skipped: false,
        candidates: 2,
        recorded: 2,
        failed: 0,
        noLongerCandidate: 0,
      });
      // Serial and spaced: one wait between two checks, of the configured length.
      expect(noSleep.mock.calls).toEqual([[1500]]);
    });

    it("records the permission through the real Test, with the connector's own token", async () => {
      await seed("c-real");
      const seen: Array<string | undefined> = [];
      __setOctokitFactory(
        (args) =>
          ({
            rest: {
              repos: {
                get: async () => {
                  seen.push(args.token);
                  return {
                    data: {
                      id: 1,
                      name: "c-real",
                      full_name: "acme-recheck/c-real",
                      default_branch: "main",
                      private: false,
                      archived: false,
                      size: 1,
                      language: null,
                      permissions: { admin: true, push: true, pull: true },
                    },
                  };
                },
              },
              git: { getRef: async () => ({ data: {} }) },
            },
          }) as never,
      );
      const out = await recheckUnrecordedRepoPermissions({ sleep: noSleep, env: {} });
      expect(out.recorded).toBe(1);
      expect(seen).toEqual([TOKEN]);
      const row = await db.repoConnection.findUnique({ where: { id: "c-real" } });
      expect(row).toMatchObject({ status: "connected", repoPermission: "admin" });
    });

    it("counts a failed check and carries on with the next", async () => {
      await seed("c-a");
      await seed("c-b");
      const test = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { code: "REPO_FORBIDDEN" }))
        .mockResolvedValueOnce({});
      const out = await recheckUnrecordedRepoPermissions({ test, sleep: noSleep, env: {} });
      expect(test).toHaveBeenCalledTimes(2);
      expect(out).toMatchObject({ candidates: 2, recorded: 1, failed: 1 });
    });

    it("#1499 — skips, without a GitHub call or a wait, a candidate another replica recorded meanwhile", async () => {
      await seed("c-first");
      await seed("c-second");
      await seed("c-third");
      // While this replica checks the first, another records the second.
      const test = vi.fn(async (_p: string, id: string) => {
        if (id === "c-first") {
          await db.repoConnection.update({
            where: { id: "c-second" },
            data: { repoPermission: "admin" },
          });
        }
        return {} as never;
      });
      const out = await recheckUnrecordedRepoPermissions({
        test,
        sleep: noSleep,
        env: { REPO_PERMISSION_RECHECK_INTERVAL_MS: "700" },
        order: (xs) => [...xs], // id order, so "first" is checked first
      });
      // On main every candidate in the list read at start was re-tested.
      expect(test.mock.calls.map((c) => c[1])).toEqual(["c-first", "c-third"]);
      expect(out).toEqual({
        skipped: false,
        candidates: 3,
        recorded: 2,
        failed: 0,
        noLongerCandidate: 1,
      });
      // One wait: between the two GitHub calls, none for the skipped candidate.
      expect(noSleep.mock.calls).toEqual([[700]]);
    });

    it("#1499 — each replica checks in its own random order, so replicas booted together drift apart", async () => {
      await seed("c-1");
      await seed("c-2");
      await seed("c-3");
      const test = vi.fn(async (_p: string, _id: string) => ({}) as never);
      // Fisher-Yates over [c-1, c-2, c-3] with every draw 0 gives [c-2, c-3, c-1].
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        await recheckUnrecordedRepoPermissions({ test, sleep: noSleep, env: {} });
      } finally {
        random.mockRestore();
      }
      // On the first cut every replica walked the same `id asc` list.
      expect(test.mock.calls.map((c) => c[1])).toEqual(["c-2", "c-3", "c-1"]);
    });

    it("#1499 — the re-check is unattended, so a DNS failure at boot leaves a connector as it was", async () => {
      await seed("c-dns");
      const { resolveAndAssertConnectorHost } =
        await import("../src/lib/connectors/network-allowlist.js");
      const { ConnectorError } = await import("../src/lib/connectors/types.js");
      vi.mocked(resolveAndAssertConnectorHost).mockRejectedValueOnce(
        new ConnectorError(502, "DNS_LOOKUP_FAILED", "repo host DNS lookup failed"),
      );
      const out = await recheckUnrecordedRepoPermissions({ sleep: noSleep, env: {} });
      expect(out).toMatchObject({ candidates: 1, recorded: 0, failed: 1 });
      // On main the boot check marked it `error`.
      const row = await db.repoConnection.findUnique({ where: { id: "c-dns" } });
      expect(row).toMatchObject({ status: "connected", errorMessage: null, repoPermission: null });
    });

    it.each(["off", "0", "false", "OFF"])("REPO_PERMISSION_RECHECK=%s turns it off", async (v) => {
      await seed("c-x");
      const test = vi.fn();
      const out = await recheckUnrecordedRepoPermissions({
        test,
        sleep: noSleep,
        env: { REPO_PERMISSION_RECHECK: v },
      });
      expect(out.skipped).toBe(true);
      expect(test).not.toHaveBeenCalled();
    });

    it("never throws into boot, even when the candidate query fails", async () => {
      const saved = state.db;
      state.db = {
        repoConnection: {
          findMany: async () => {
            throw new Error("database is down");
          },
        },
      };
      try {
        expect(() => startRepoPermissionRecheck({ sleep: noSleep, env: {} })).not.toThrow();
        await new Promise((r) => setTimeout(r, 20));
      } finally {
        state.db = saved;
      }
    });
  },
);
