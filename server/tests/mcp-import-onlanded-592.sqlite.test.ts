/**
 * #592 — the mcp.json importer keeps the secrets a landed row points to, and
 * withdraws (audited as `vault.delete`) only the secrets of an entry whose row
 * never landed. #574 fixed the same shape for `POST /api/mcp`.
 *
 * Real SQLite built by the migration chain, the real `VaultService` and the
 * real `MCPRegistryService`; the only thing faked is the one failure each test
 * forces. Secret state is read back from the database.
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
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/audit/audit-service.js")>();
  return { ...real, audit: vi.fn(real.audit) };
});

const { audit } = await import("../src/lib/audit/audit-service.js");
const { __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { executeImport } = await import("../src/lib/mcp/mcp-importer.js");
const { MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const ADMIN = "admin-592";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#592 — MCP import keeps a landed row's secrets and audits the withdrawal of the rest (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let registry: InstanceType<typeof MCPRegistryService>;
    const prevKey = process.env.VAULT_MASTER_KEY;
    let seq = 0;
    const uniq = (p: string) => `${p}-${++seq}`;

    const blob = (label: string) => ({
      mcpServers: { [label]: { command: "node", env: { API_KEY: "plaintext-key-592" } } },
    });

    /** The secrets ADMIN created during `fn`, split into live and withdrawn. */
    async function madeDuring<T>(fn: () => Promise<T>) {
      const ids = async () =>
        db.secret.findMany({
          where: { createdById: ADMIN },
          select: { id: true, name: true, deletedAt: true },
        });
      const before = new Set((await ids()).map((s) => s.id));
      const value = await fn();
      const made = (await ids()).filter((s) => !before.has(s.id));
      return {
        value,
        live: made.filter((s) => s.deletedAt === null),
        withdrawn: made.filter((s) => s.deletedAt !== null).map((s) => s.id),
      };
    }

    const vaultDeleteAudits = () =>
      vi
        .mocked(audit)
        .mock.calls.map(([e]) => e)
        .filter((e) => e.action === "vault.delete");

    beforeAll(async () => {
      sqlite = createMigratedSqlite("592-import-onlanded");
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
      await db.project.create({
        data: { id: "p592", name: "P", slug: "p592", createdById: ADMIN },
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
      vi.mocked(audit).mockClear();
    });

    it("a failure after the row landed keeps the secret the row names, and withdraws nothing", async () => {
      const spy = registry as unknown as { toView: (row: unknown) => unknown };
      vi.spyOn(spy, "toView").mockImplementationOnce(() => {
        throw new Error("view failed");
      });
      const label = uniq("imp");

      const r = await madeDuring(() =>
        executeImport(blob(label), registry, { id: ADMIN, role: "admin" }),
      );

      const rows = await db.mCPServer.findMany({ where: { label } });
      expect(rows).toHaveLength(1);
      // #608 — the landed row is reported as created, with the failure as a warning.
      expect(r.value.created).toEqual([
        { id: rows[0]!.id, label, warning: { message: "view failed" } },
      ]);
      expect(r.value.errors).toEqual([]);
      expect(r.withdrawn).toEqual([]);
      expect(r.live).toHaveLength(1);
      // The surviving secret is the one the landed row names.
      const kept = r.live[0]!;
      const keptLabel = kept.name.slice(kept.name.indexOf(":") + 1);
      expect(rows[0]!.envJson).toContain(`\${vault:${keptLabel}}`);
      expect(vaultDeleteAudits()).toEqual([]);
    });

    it("a failure before the row lands withdraws the secret and audits it as vault.delete", async () => {
      const label = uniq("imp");
      // First import takes the label; the second is refused with LABEL_TAKEN.
      const first = await executeImport(
        blob(label),
        registry,
        { id: ADMIN, role: "admin" },
        {
          scope: "project",
          projectId: "p592",
        },
      );
      expect(first.errors).toEqual([]);
      vi.mocked(audit).mockClear();

      const r = await madeDuring(() =>
        executeImport(
          blob(label),
          registry,
          { id: ADMIN, role: "admin" },
          {
            scope: "project",
            projectId: "p592",
          },
        ),
      );

      expect(r.value.errors).toEqual([expect.objectContaining({ label, code: "LABEL_TAKEN" })]);
      expect(await db.mCPServer.count({ where: { label } })).toBe(1);
      expect(r.live).toEqual([]);
      expect(r.withdrawn).toHaveLength(1);
      expect(vaultDeleteAudits()).toEqual([
        {
          actor: { id: ADMIN },
          action: "vault.delete",
          target: { type: "secret", id: r.withdrawn[0] },
          metadata: {
            source: "create_not_applied",
            reason: "create_failed",
            resourceType: "mcp_server",
            projectId: "p592",
          },
        },
      ]);
    });

    it("a failed entry's withdrawal is audited, and the ok entry's secret survives as the one its row names", async () => {
      const ok = uniq("imp");
      const bad = uniq("imp");
      await executeImport(blob(bad), registry, { id: ADMIN, role: "admin" });
      vi.mocked(audit).mockClear();

      const r = await madeDuring(() =>
        executeImport(
          { mcpServers: { ...blob(ok).mcpServers, ...blob(bad).mcpServers } },
          registry,
          { id: ADMIN, role: "admin" },
        ),
      );

      expect(r.value.created.map((c) => c.label)).toEqual([ok]);
      expect(r.value.errors.map((e) => e.label)).toEqual([bad]);
      expect(r.live).toHaveLength(1);
      expect(r.withdrawn).toHaveLength(1);
      expect(vaultDeleteAudits().map((e) => e.target.id)).toEqual(r.withdrawn);
      // The surviving secret is the one the ok row's env names.
      const okRow = await db.mCPServer.findFirstOrThrow({ where: { label: ok } });
      const kept = r.live[0]!;
      const keptLabel = kept.name.slice(kept.name.indexOf(":") + 1);
      expect(JSON.parse(okRow.envJson!)).toEqual({ API_KEY: `\${vault:${keptLabel}}` });
    });

    it("a failure after the row landed keeps an auto-vaulted header secret, the one the row's headers name", async () => {
      const spy = registry as unknown as { toView: (row: unknown) => unknown };
      vi.spyOn(spy, "toView").mockImplementationOnce(() => {
        throw new Error("view failed");
      });
      const label = uniq("imp-hdr");

      const r = await madeDuring(() =>
        executeImport(
          {
            mcpServers: {
              [label]: {
                url: "https://mcp.example.test/sse",
                headers: { Authorization: "Bearer plaintext-header-592" },
              },
            },
          },
          registry,
          { id: ADMIN, role: "admin" },
        ),
      );

      const rows = await db.mCPServer.findMany({ where: { label } });
      expect(rows).toHaveLength(1);
      // #608 — the landed row is reported as created, with the failure as a warning.
      expect(r.value.created).toEqual([
        { id: rows[0]!.id, label, warning: { message: "view failed" } },
      ]);
      expect(r.value.errors).toEqual([]);
      expect(r.withdrawn).toEqual([]);
      expect(r.live).toHaveLength(1);
      // The surviving secret is the one the landed row's headers name.
      const kept = r.live[0]!;
      const keptLabel = kept.name.slice(kept.name.indexOf(":") + 1);
      expect(JSON.parse(rows[0]!.headers!)).toEqual({ Authorization: `\${vault:${keptLabel}}` });
      expect(vaultDeleteAudits()).toEqual([]);
    });
  },
);
