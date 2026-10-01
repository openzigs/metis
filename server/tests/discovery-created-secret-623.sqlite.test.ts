/**
 * #623 — the follow-up to #610 for the other half of `rotateOrCreateUndoable`.
 * When the suggestion's old secret is missing or deleted, credential discovery
 * CREATES a new system-owned secret rather than rotating one. If the suggestion
 * upsert then fails, nothing references that secret, so it is withdrawn
 * (soft-deleted, audited `vault.delete`) exactly as the #495/#574 paths do. A
 * suggestion that did land keeps its new secret.
 *
 * Real SQLite built by the migration chain, the real `VaultService` and the real
 * audit service; the only thing faked is the one failure each test forces.
 * Liveness is read back from the `Secret` table and through the vault.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const { discoverAndUpsertConnections } =
  await import("../src/lib/connectors/repo/connection-discovery.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const PROJ = "proj-623";
const OWNER_ID = "u-owner-623";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#623 — discovery withdraws a secret it created when the suggestion upsert fails (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let tmp = "";
    const prevKey = process.env.VAULT_MASTER_KEY;
    let seq = 0;
    const next = () => (seq += 1);

    const vault = () => getVaultService();
    const withdrawAudits = async (id: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.delete", targetType: "secret", targetId: id },
      });
    };
    /** Make the audit sink throw for one action, so a failure lands AFTER the row write. */
    const failAuditOf = (action: string) => {
      const svc = getAuditService();
      const real = svc.record.bind(svc);
      vi.spyOn(svc, "record").mockImplementation((entry) => {
        if (entry.action === action) throw new Error("audit sink down");
        real(entry);
      });
    };
    /** Spy on `vault.create`, collecting the id of every secret it creates. */
    const trackCreated = () => {
      const ids: string[] = [];
      const v = vault();
      const real = v.create.bind(v);
      vi.spyOn(v, "create").mockImplementation(async (...args) => {
        const s = await real(...args);
        ids.push(s.id);
        return s;
      });
      return ids;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("623-discovery-created");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      await db.user.create({
        data: { id: OWNER_ID, username: OWNER_ID, displayName: OWNER_ID, email: "o@x.test" },
      });
      await db.project.create({
        data: {
          id: PROJ,
          name: PROJ,
          slug: PROJ,
          createdById: OWNER_ID,
          allowCredentialScan: true,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      await db?.$disconnect();
      sqlite?.cleanup();
      if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
      else process.env.VAULT_MASTER_KEY = prevKey;
      __resetVaultSingleton();
    });

    beforeEach(async () => {
      vi.restoreAllMocks();
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), "623-discovery-"));
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    /** Write a dev properties file naming `database` with password `new-pw`. */
    async function writeDevFile(database: string) {
      await fs.writeFile(
        path.join(tmp, "application-dev.properties"),
        [
          `spring.datasource.url=jdbc:postgresql://db-host:5432/${database}`,
          "spring.datasource.username=app",
          "spring.datasource.password=new-pw",
        ].join("\n"),
      );
    }

    /** An existing suggestion whose password secret has been deleted from the vault. */
    async function suggestionWithDeletedSecret() {
      const n = next();
      const database = `appdb${n}`;
      const old = await vault().create(`discovered-623-${n}`, "old-pw", "project", {
        createdById: null,
      });
      await vault().delete(old.id);
      const row = await db.suggestedConnector.create({
        data: {
          projectId: PROJ,
          driverType: "postgresql",
          host: "db-host",
          port: 5432,
          database,
          sourceFile: "application-dev.properties",
          lineNumber: 1,
          confidence: "high",
          passwordVaultRef: old.id,
          devCredsDetected: true,
        },
      });
      await writeDevFile(database);
      return { row, oldId: old.id };
    }

    it("a new suggestion (no old ref) whose upsert fails leaves no live new secret, audited create_not_applied", async () => {
      await writeDevFile(`fresh${next()}`);
      const created = trackCreated();
      vi.spyOn(db.suggestedConnector, "upsert").mockRejectedValueOnce(new Error("disk full"));

      const summary = await discoverAndUpsertConnections(PROJ, tmp);

      expect(summary.errors).toBe(1);
      expect(created).toHaveLength(1); // it really did create a secret first
      const secret = await db.secret.findUniqueOrThrow({ where: { id: created[0]! } });
      expect(secret.deletedAt).not.toBeNull();
      await expect(vault().read(created[0]!)).rejects.toThrow();
      const audits = await withdrawAudits(created[0]!);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorId).toBeNull();
      expect(JSON.parse(audits[0]!.metadata ?? "{}")).toEqual({
        source: "create_not_applied",
        reason: "create_failed",
        resourceType: "suggested_connector",
        projectId: PROJ,
      });
    });

    it("an existing suggestion with a deleted old ref whose upsert fails withdraws the new secret, audited against the row", async () => {
      const { row, oldId } = await suggestionWithDeletedSecret();
      const created = trackCreated();
      vi.spyOn(db.suggestedConnector, "upsert").mockRejectedValueOnce(new Error("disk full"));

      const summary = await discoverAndUpsertConnections(PROJ, tmp);

      expect(summary.errors).toBe(1);
      expect(created).toHaveLength(1);
      expect(created[0]).not.toBe(oldId);
      const secret = await db.secret.findUniqueOrThrow({ where: { id: created[0]! } });
      expect(secret.deletedAt).not.toBeNull();
      const after = await db.suggestedConnector.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.passwordVaultRef).toBe(oldId);
      const audits = await withdrawAudits(created[0]!);
      expect(audits).toHaveLength(1);
      expect(JSON.parse(audits[0]!.metadata ?? "{}")).toMatchObject({
        source: "update_not_applied",
        reason: "update_failed",
        resourceType: "suggested_connector",
        resourceId: row.id,
        projectId: PROJ,
      });
    });

    it("a landed upsert keeps the new secret live even if a later step fails", async () => {
      const { row } = await suggestionWithDeletedSecret();
      const created = trackCreated();
      failAuditOf("suggested_connector.credential_discovered");

      const summary = await discoverAndUpsertConnections(PROJ, tmp);

      expect(summary.errors).toBe(1);
      expect(created).toHaveLength(1);
      const after = await db.suggestedConnector.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.passwordVaultRef).toBe(created[0]);
      expect((await vault().read(created[0]!)).plaintext).toBe("new-pw");
      expect(await withdrawAudits(created[0]!)).toHaveLength(0);
    });
  },
);
