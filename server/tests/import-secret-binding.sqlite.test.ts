/**
 * #763 — an import source may use an EXISTING vault secret by `${vault:label}`.
 *
 * Real SQLite built by the migration chain and the real `VaultService`: the
 * binding check (#344), the id binding (#480), the `secretBound` column and the
 * retirement reference check are all read back from the database.
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

const { VaultService, __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { authorizeImportSecretRef } = await import("../src/lib/importers/import-secret-binding.js");
const { ImportService } = await import("../src/lib/importers/import-service.js");
const { isSecretReferenced } = await import("../src/lib/vault/secret-retirement.js");

const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
const OWNER = { userId: "owner-763", role: "coordinator" as const };
const OTHER = { userId: "other-763", role: "coordinator" as const };
const ADMIN = { userId: "admin-763", role: "admin" as const };
const TARGET = { type: "import_source", id: "new" };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#763 — import sources bind an existing vault secret (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let vault: InstanceType<typeof VaultService>;
    let ownerSecretId: string;
    const prevKey = process.env.VAULT_MASTER_KEY;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("763-import-secret");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      for (const u of [OWNER, OTHER, ADMIN]) {
        await db.user.create({
          data: {
            id: u.userId,
            username: u.userId,
            displayName: u.userId,
            email: `${u.userId}@x.test`,
          },
        });
      }
      await db.project.create({
        data: { id: "p763", name: "P", slug: "p763", createdById: OWNER.userId },
      });
      const secret = await vault.create("github-flux-v2-sandbox", "ghp_owner_secret", "global", {
        createdById: OWNER.userId,
      });
      ownerSecretId = secret.id;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
      else process.env.VAULT_MASTER_KEY = prevKey;
      __resetVaultSingleton();
    });

    it("binds the creator's own secret by label to its id", async () => {
      const bound = await authorizeImportSecretRef(
        OWNER,
        "p763",
        "${vault:github-flux-v2-sandbox}",
        TARGET,
      );
      expect(bound.secretId).toBe(ownerSecretId);
    });

    it("refuses another user's secret to a caller without vault.reveal (#344)", async () => {
      await expect(
        authorizeImportSecretRef(OTHER, "p763", "${vault:github-flux-v2-sandbox}", TARGET),
      ).rejects.toMatchObject({ statusCode: 403, code: "SECRET_BINDING_FORBIDDEN" });
    });

    it("lets an admin (vault.reveal) bind any secret", async () => {
      const bound = await authorizeImportSecretRef(
        ADMIN,
        "p763",
        "${vault:github-flux-v2-sandbox}",
        TARGET,
      );
      expect(bound.secretId).toBe(ownerSecretId);
    });

    it("refuses a reference that names no secret, and a malformed one", async () => {
      // A non-admin gets the same 403 for "no such secret" as for "not yours",
      // so the check is no existence oracle; an admin is told it is unresolved.
      await expect(
        authorizeImportSecretRef(OWNER, "p763", "${vault:no-such-secret}", TARGET),
      ).rejects.toMatchObject({ statusCode: 403, code: "SECRET_BINDING_FORBIDDEN" });
      await expect(
        authorizeImportSecretRef(ADMIN, "p763", "${vault:no-such-secret}", TARGET),
      ).rejects.toMatchObject({ statusCode: 400, code: "VAULT_REF_UNRESOLVED" });
      await expect(
        authorizeImportSecretRef(OWNER, "p763", "github-flux-v2-sandbox", TARGET),
      ).rejects.toMatchObject({ statusCode: 400, code: "VAULT_REF_INVALID" });
    });

    it("binds nothing when no reference is given", async () => {
      expect(await authorizeImportSecretRef(OWNER, "p763", undefined, TARGET)).toEqual({
        secretId: null,
        until: null,
      });
    });

    it("persists the bound id with secretBound, reads the token by id, and keeps the secret on delete", async () => {
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        expect(auth).toBe("Bearer ghp_owner_secret");
        const body = String(url).includes("/graphql")
          ? { data: { search: { issueCount: 0 } } }
          : [];
        return new Response(JSON.stringify(body), { status: 200 });
      });
      const svc = new ImportService({
        prisma: db,
        vault,
        enqueueTask: async () => ({ id: "task-763" }),
        createScheduledJob: async () => ({ id: "job-763" }),
        deleteScheduledJob: async () => undefined,
        resolveJira: async () => {
          throw new Error("unused");
        },
        importerDeps: { fetchFn, assertHostAllowed: () => undefined },
      });
      const { secretId } = await authorizeImportSecretRef(
        OWNER,
        "p763",
        "${vault:github-flux-v2-sandbox}",
        TARGET,
      );
      const { source } = await svc.createSource(
        "p763",
        {
          source: "github",
          label: "miniflux",
          filter: { owner: "miniflux", repo: "v2", state: "open" },
          syncEnabled: false,
          syncIntervalMinutes: 15,
        },
        OWNER.userId,
        { secretId },
      );
      const row = await db.importSource.findUniqueOrThrow({ where: { id: source.id } });
      expect(row.secretId).toBe(ownerSecretId);
      expect(row.secretBound).toBe(true);
      expect(source.usesVaultSecret).toBe(true);
      // No second copy of the token was vaulted.
      expect(await db.secret.count({ where: { deletedAt: null } })).toBe(1);

      await svc.runSource(source.id, { trigger: "manual" });
      expect(fetchFn).toHaveBeenCalled();

      // A bound import source keeps the secret from being retired (#481).
      const name = (await db.secret.findUniqueOrThrow({ where: { id: ownerSecretId } })).name;
      expect(await isSecretReferenced(ownerSecretId, name)).toBe(true);

      await svc.deleteSource("p763", source.id, OWNER.userId);
      const after = await db.secret.findUniqueOrThrow({ where: { id: ownerSecretId } });
      expect(after.deletedAt).toBeNull();
    });
  },
);
