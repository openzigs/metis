/**
 * #1499 — follow-ups to #1488's recorded repository permission.
 *
 *   - A vault rotation rewrites a secret's value under the same id. Every
 *     connector bound to that secret forgets its recorded permission, in every
 *     project, and nothing else does; a Test in flight when the rotation lands
 *     records nothing.
 *   - A metadata sync whose binding-guarded write matched nothing (the
 *     connector was repointed while it read) ingests nothing.
 *
 * Driven through the real `apiRouter()` (vault rotate, connector Test and
 * metadata ingest) against a REAL SQLite database built by the migration
 * chain, with real vault secrets. The fake GitHub answers `repos.get` with the
 * permissions of the token it was handed. Nothing reaches GitHub.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
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
  return { db: null as unknown };
});
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
// The metadata ingest is what a raced sync must never reach.
const ingestSpy = vi.hoisted(() => vi.fn(async () => ({ failures: 0, documents: 0 })));
vi.mock("../src/lib/connectors/connector-ingest.js", async (original) => ({
  ...(await original<typeof import("../src/lib/connectors/connector-ingest.js")>()),
  ingestRepoMetadata: ingestSpy,
}));

const { apiRouter } = await import("../src/routes/index.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { VaultService, __resetVaultSingleton, getVaultService } =
  await import("../src/lib/vault/vault-service.js");
const { __setOctokitFactory } = await import("../src/lib/connectors/repo/repo-service.js");

const MASTER_KEY = Buffer.alloc(32, 21).toString("base64");
const WS = "ws-1499";
const P1 = "project-a-1499";
const P2 = "project-b-1499";
const ADMIN_TOKEN = "ghp_admin_token_1499";
const READ_TOKEN = "ghp_read_token_1499";
const OTHER_TOKEN = "ghp_other_admin_token_1499";

const PERMISSIONS: Record<string, Record<string, boolean>> = {
  [ADMIN_TOKEN]: { admin: true, push: true, pull: true },
  [OTHER_TOKEN]: { admin: true, push: true, pull: true },
  [READ_TOKEN]: { admin: false, push: false, pull: true },
};

/** Runs inside the next `repos.get`, before it answers. */
let duringGet: null | (() => Promise<void>) = null;

function fakeGithub(args: { token?: string }) {
  return {
    rest: {
      repos: {
        get: async () => {
          if (duringGet) {
            const hook = duringGet;
            duringGet = null;
            await hook();
          }
          const permissions = args.token ? PERMISSIONS[args.token] : undefined;
          return {
            data: {
              id: 1499,
              name: "app",
              full_name: "acme-1499/app",
              default_branch: "main",
              private: false,
              archived: false,
              size: 10,
              language: "TypeScript",
              ...(permissions ? { permissions } : {}),
            },
          };
        },
        listLanguages: async () => ({ data: { TypeScript: 1 } }),
        listCommits: async () => ({ data: [{ sha: "b".repeat(40) }] }),
        getContent: async () => ({ data: [] }),
        getReadme: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
      },
      git: { getRef: async () => ({ data: {} }) },
    },
  } as never;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1499 — vault rotation and raced syncs never leave a stale recorded permission",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let api: express.Express;
    let rotatedSecretId: string;
    let otherSecretId: string;

    const bearer = (userId: string, role: RoleKey) => {
      const payload: AuthPayload = {
        userId,
        username: userId,
        role,
        permissions: getPermissionsForRole(role),
        workspaces: [WS],
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };
    const asAdmin = () => bearer("u-admin", "admin");

    const connect = (id: string, projectId: string, secretId: string, repoPermission: string) =>
      db.repoConnection.create({
        data: {
          id,
          projectId,
          label: id,
          ownerOrOrg: "acme-1499",
          repoName: "app",
          status: "connected",
          secretId,
          repoPermission,
        },
      });
    const permissionOf = async (id: string) =>
      (await db.repoConnection.findUniqueOrThrow({ where: { id } })).repoPermission;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1499-permission-followups");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      await db.user.create({
        data: { id: "u-admin", username: "u-admin", displayName: "a", email: "a@example.test" },
      });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: "u-admin", role: "member" },
      });
      for (const id of [P1, P2]) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-admin", workspaceId: WS },
        });
      }
      const vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      rotatedSecretId = (
        await vault.create("rotated-pat-1499", ADMIN_TOKEN, "global", { createdById: "u-admin" })
      ).id;
      otherSecretId = (
        await vault.create("other-pat-1499", OTHER_TOKEN, "global", { createdById: "u-admin" })
      ).id;
      __setOctokitFactory(fakeGithub);

      api = express();
      api.use(express.json());
      api.use("/api", apiRouter());
      api.use(notFoundHandler);
      api.use(errorHandler);
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
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      duringGet = null;
      ingestSpy.mockClear();
      // Every test starts from the admin token in the rotated secret.
      await getVaultService().rotate(rotatedSecretId, ADMIN_TOKEN);
    });

    it("a vault rotation forgets the permission of every connector bound to the secret, and only those", async () => {
      await connect("c-bound-a", P1, rotatedSecretId, "admin");
      await connect("c-bound-b", P2, rotatedSecretId, "push");
      await connect("c-other", P1, otherSecretId, "admin");

      const res = await request(api)
        .post(`/api/vault/${rotatedSecretId}/rotate`)
        .set("Authorization", asAdmin())
        .send({ value: READ_TOKEN });
      expect(res.status, res.text).toBe(200);

      // On main the rotated token (read-only) kept the old token's `admin`.
      expect(await permissionOf("c-bound-a")).toBeNull();
      expect(await permissionOf("c-bound-b")).toBeNull();
      expect(await permissionOf("c-other")).toBe("admin");
      // Nothing else about the bound connectors changed.
      const row = await db.repoConnection.findUniqueOrThrow({ where: { id: "c-bound-a" } });
      expect(row).toMatchObject({ status: "connected", secretId: rotatedSecretId });

      // The next Test earns the permission again, with the new value.
      const test = await request(api)
        .post(`/api/projects/${P1}/connectors/repos/c-bound-a/test`)
        .set("Authorization", asAdmin());
      expect(test.body.data, test.text).toMatchObject({ ok: true, repoPermission: "read" });
      expect(await permissionOf("c-bound-a")).toBe("read");
    });

    it.each([
      ["an undoable rotation (connector discovery's in-place write)", "rotateUndoable"],
      ["the undo of a rotation", "undoRotation"],
      ["a create-or-rotate by label", "upsert"],
    ] as const)("%s forgets it too", async (_name, write) => {
      const vault = getVaultService();
      // The undo case needs a rotation to undo; take it before planting the record.
      const undo =
        write === "undoRotation" ? await vault.rotateUndoable(rotatedSecretId, READ_TOKEN) : null;
      await connect("c-bound", P1, rotatedSecretId, "admin");
      await connect("c-other", P2, otherSecretId, "push");
      if (write === "rotateUndoable") await vault.rotateUndoable(rotatedSecretId, READ_TOKEN);
      if (write === "undoRotation") expect(await vault.undoRotation(undo!)).toBe(true);
      if (write === "upsert") await vault.upsert("rotated-pat-1499", READ_TOKEN, "global");
      expect(await permissionOf("c-bound")).toBeNull();
      expect(await permissionOf("c-other")).toBe("push");
    });

    it("a Test in flight when the secret is rotated records nothing", async () => {
      await connect("c-inflight", P1, rotatedSecretId, "read");
      await db.repoConnection.update({
        where: { id: "c-inflight" },
        data: { repoPermission: null },
      });
      // The Test read the admin token; the value is replaced before it writes.
      duringGet = async () => {
        await getVaultService().rotate(rotatedSecretId, READ_TOKEN);
      };
      const res = await request(api)
        .post(`/api/projects/${P1}/connectors/repos/c-inflight/test`)
        .set("Authorization", asAdmin());
      expect(duringGet).toBeNull(); // the rotation ran inside the Test
      expect(res.body.data).toMatchObject({ ok: false, code: "REPO_CONNECTOR_CHANGED" });
      // Without the envelope in the binding guard, the old token's `admin` landed.
      expect(await permissionOf("c-inflight")).toBeNull();
    });

    it("a metadata sync that loses the binding race ingests nothing", async () => {
      await connect("c-sync", P1, rotatedSecretId, "admin");
      await db.repoConnection.update({
        where: { id: "c-sync" },
        data: { ownerOrOrg: "attacker-1499", repoName: "own", repoPermission: null },
      });
      // While the sync reads the attacker's repository, the connector is repointed.
      duringGet = async () => {
        await db.repoConnection.update({
          where: { id: "c-sync" },
          data: { ownerOrOrg: "acme-1499", repoName: "app" },
        });
      };
      const res = await request(api)
        .post(`/api/projects/${P1}/connectors/repos/c-sync/ingest`)
        .set("Authorization", asAdmin());
      expect(duringGet).toBeNull(); // the repoint ran inside the sync
      expect(res.status, res.text).toBe(409);
      expect(res.body.error?.code ?? res.body.code).toBe("REPO_CONNECTOR_CHANGED");
      // On main the old repository's README and manifests were ingested.
      expect(ingestSpy).not.toHaveBeenCalled();
      expect(await permissionOf("c-sync")).toBeNull();
    });

    it("a sync that keeps its binding still ingests", async () => {
      await connect("c-sync-ok", P1, rotatedSecretId, "admin");
      const res = await request(api)
        .post(`/api/projects/${P1}/connectors/repos/c-sync-ok/ingest`)
        .set("Authorization", asAdmin());
      expect(res.status, res.text).toBe(200);
      expect(ingestSpy).toHaveBeenCalledTimes(1);
    });
  },
);
