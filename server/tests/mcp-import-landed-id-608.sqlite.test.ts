/**
 * #608 — an mcp.json import entry whose row landed before a later step failed
 * is reported as created (with a warning) and names the landed row's id, so a
 * user who would otherwise re-import into `LABEL_TAKEN` can see the server
 * exists. `onLanded` carries that id from both create paths.
 *
 * Real SQLite built by the migration chain, the real `VaultService` and the
 * real `MCPRegistryService`; the only thing faked is the failure each test
 * forces. The reported id is checked against a fresh read of the database.
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

const state = vi.hoisted(() => {
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

const { __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { executeImport, importStatus } = await import("../src/lib/mcp/mcp-importer.js");
const { MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");

const MASTER_KEY = Buffer.alloc(32, 8).toString("base64");
const ADMIN = "admin-608";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#608 — MCP import names the id of a row that landed before a later failure (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let registry: InstanceType<typeof MCPRegistryService>;
    const prevKey = process.env.VAULT_MASTER_KEY;
    let seq = 0;
    const uniq = (p: string) => `${p}-${++seq}`;
    const failViewOnce = (message: string) =>
      vi
        .spyOn(registry as unknown as { toView: (row: unknown) => unknown }, "toView")
        .mockImplementationOnce(() => {
          const err = new Error(message) as Error & { code: string };
          err.code = "VIEW_FAILED";
          throw err;
        });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("608-import-landed-id");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      registry = new MCPRegistryService(
        new MCPLifecycleManager({
          resolveEnv: async (e) => e,
          transportFactory: () => {
            throw new Error("no MCP transport in this test");
          },
        }),
      );
      await db.user.create({
        data: { id: ADMIN, username: ADMIN, displayName: ADMIN, email: `${ADMIN}@x.test` },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
      else process.env.VAULT_MASTER_KEY = prevKey;
      __resetVaultSingleton();
    });

    beforeEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it("reports a landed-then-failed entry as created with a warning naming the landed row's id", async () => {
      failViewOnce("view failed");
      const label = uniq("imp");

      const result = await executeImport(
        { mcpServers: { [label]: { command: "node", env: { API_KEY: "plaintext-608" } } } },
        registry,
        { id: ADMIN, role: "admin" },
      );

      const row = await db.mCPServer.findFirstOrThrow({ where: { label, deletedAt: null } });
      expect(result.errors).toEqual([]);
      expect(result.created).toEqual([
        { id: row.id, label, warning: { message: "view failed", code: "VIEW_FAILED" } },
      ]);
      // A partial success is not a clean 200.
      expect(importStatus(result)).toBe(207);
    });

    it("a clean entry beside a landed-then-failed one carries no warning", async () => {
      failViewOnce("view failed");
      const bad = uniq("imp");
      const good = uniq("imp");

      const result = await executeImport(
        { mcpServers: { [bad]: { command: "node" }, [good]: { command: "node" } } },
        registry,
        { id: ADMIN, role: "admin" },
      );

      const badRow = await db.mCPServer.findFirstOrThrow({ where: { label: bad } });
      const goodRow = await db.mCPServer.findFirstOrThrow({ where: { label: good } });
      expect(result.created).toEqual([
        { id: badRow.id, label: bad, warning: { message: "view failed", code: "VIEW_FAILED" } },
        { id: goodRow.id, label: good },
      ]);
      expect(result.errors).toEqual([]);
    });

    it("an entry refused before its row lands stays an error with no id", async () => {
      const label = uniq("imp");
      await executeImport({ mcpServers: { [label]: { command: "node" } } }, registry, {
        id: ADMIN,
        role: "admin",
      });

      const result = await executeImport(
        { mcpServers: { [label]: { command: "node" } } },
        registry,
        {
          id: ADMIN,
          role: "admin",
        },
      );

      expect(result.created).toEqual([]);
      expect(result.errors).toEqual([expect.objectContaining({ label, code: "LABEL_TAKEN" })]);
      expect(importStatus(result)).toBe(207);
    });

    it("onLanded receives the written row's id on the global create path", async () => {
      const onLanded = vi.fn();
      const label = uniq("svc");
      const view = await registry.create(
        { scope: "global", label, transport: "stdio", runtime: "native", command: "node" },
        { id: ADMIN, role: "admin" },
        { onLanded },
      );

      const row = await db.mCPServer.findFirstOrThrow({ where: { label } });
      expect(onLanded).toHaveBeenCalledTimes(1);
      expect(onLanded).toHaveBeenCalledWith(row.id);
      expect(view.id).toBe(row.id);
    });

    it("onLanded receives the written row's id on the user-scope create path", async () => {
      vi.stubEnv("MCP_ALLOW_USER_SCOPE", "true");
      const onLanded = vi.fn();
      const label = uniq("usr");
      await registry.create(
        { scope: "user", label, transport: "stdio", runtime: "native", command: "node" },
        { id: ADMIN, role: "admin" },
        { onLanded },
      );

      const row = await db.mCPServer.findFirstOrThrow({ where: { label, userId: ADMIN } });
      expect(onLanded).toHaveBeenCalledTimes(1);
      expect(onLanded).toHaveBeenCalledWith(row.id);
    });
  },
);
