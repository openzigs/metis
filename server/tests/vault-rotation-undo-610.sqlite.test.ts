/**
 * #610 — the follow-up to #593 for the two other `rotateOrCreate` callers.
 * Credential discovery and suggested-connector provisioning both rotate a
 * secret in place and then write a row; when that write fails, the previous
 * value is put back, so a run or request that reports failure has not changed
 * the stored credential. When the row did land, the new value stays.
 *
 * Real SQLite built by the migration chain, the real `VaultService`, the real
 * router behind a signed JWT and the real audit service; the only thing faked
 * is the one failure each test forces. Every assertion reads the secret back
 * through the vault, as a real consumer would.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import request from "supertest";
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
  process.env.RATE_LIMIT_MAX = "100000";
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

const { suggestedConnectorsRouter } = await import("../src/routes/suggested-connectors.js");
const { discoverAndUpsertConnections } =
  await import("../src/lib/connectors/repo/connection-discovery.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

const MASTER_KEY = Buffer.alloc(32, 6).toString("base64");
const PROJ = "proj-610";
const ADMIN_ID = "u-admin-610";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#610 — discovery and provisioning restore a secret they rotated in place when the write fails (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ADMIN = "";
    let tmp = "";
    const prevKey = process.env.VAULT_MASTER_KEY;
    let seq = 0;
    const next = () => (seq += 1);

    const vault = () => getVaultService();
    const plaintext = async (id: string) => (await vault().read(id)).plaintext;
    const restoreAudits = async (id: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.rotate", targetType: "secret", targetId: id },
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

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/suggested-connectors", suggestedConnectorsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("610-rotation-undo");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      await db.user.create({
        data: { id: ADMIN_ID, username: ADMIN_ID, displayName: ADMIN_ID, email: "a@x.test" },
      });
      await db.project.create({
        data: {
          id: PROJ,
          name: PROJ,
          slug: PROJ,
          createdById: ADMIN_ID,
          allowCredentialScan: true,
        },
      });
      ADMIN = issueTokens({
        userId: ADMIN_ID,
        username: ADMIN_ID,
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
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
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), "610-discovery-"));
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    // ---- Credential discovery ---------------------------------------------

    /** A suggestion whose password secret discovery itself wrote (system-owned). */
    async function discoveredSuggestion() {
      const n = next();
      const database = `appdb${n}`;
      const secret = await vault().create(`discovered-610-${n}`, "old-pw", "project", {
        createdById: null,
      });
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
          passwordVaultRef: secret.id,
          devCredsDetected: true,
        },
      });
      await fs.writeFile(
        path.join(tmp, "application-dev.properties"),
        [
          `spring.datasource.url=jdbc:postgresql://db-host:5432/${database}`,
          "spring.datasource.username=app",
          "spring.datasource.password=new-pw",
        ].join("\n"),
      );
      return { row, secretId: secret.id };
    }

    it("discovery: the upsert failing after the password was rotated in place restores the old password, audited", async () => {
      const { row, secretId } = await discoveredSuggestion();
      const rotate = vi.spyOn(vault(), "rotateUndoable");
      vi.spyOn(db.suggestedConnector, "upsert").mockRejectedValueOnce(new Error("disk full"));

      const summary = await discoverAndUpsertConnections(PROJ, tmp);

      expect(summary.errors).toBe(1);
      expect(rotate).toHaveBeenCalledTimes(1); // it really did rotate in place first
      expect(await plaintext(secretId)).toBe("old-pw");
      const after = await db.suggestedConnector.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.passwordVaultRef).toBe(secretId);
      const audits = await restoreAudits(secretId);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorId).toBeNull();
      expect(JSON.parse(audits[0]!.metadata ?? "{}")).toMatchObject({
        source: "update_not_applied",
        reason: "update_failed",
        restored: "previous_value",
        resourceType: "suggested_connector",
        resourceId: row.id,
        projectId: PROJ,
      });
    });

    it("discovery: a row that landed keeps the new password even if a later step fails", async () => {
      const { secretId } = await discoveredSuggestion();
      failAuditOf("suggested_connector.credential_discovered");

      const summary = await discoverAndUpsertConnections(PROJ, tmp);

      expect(summary.errors).toBe(1);
      expect(await plaintext(secretId)).toBe("new-pw");
      expect(await restoreAudits(secretId)).toHaveLength(0);
    });

    // ---- Suggested-connector provisioning ---------------------------------

    /** A suggestion holding a password secret the admin supplied (so it rotates in place). */
    async function ownedSuggestion() {
      const n = next();
      const secret = await vault().create(`provisioned-610-${n}`, "old-pw", "project", {
        createdById: ADMIN_ID,
      });
      const row = await db.suggestedConnector.create({
        data: {
          projectId: PROJ,
          driverType: "postgresql",
          host: "db-host",
          port: 5432,
          database: `prov${n}`,
          sourceFile: ".env",
          lineNumber: n,
          confidence: "high",
          passwordVaultRef: secret.id,
        },
      });
      return { row, secretId: secret.id };
    }
    const provision = (id: string) =>
      request(app())
        .post(`/api/projects/${PROJ}/suggested-connectors/${id}/provision`)
        .set("Authorization", `Bearer ${ADMIN}`)
        .send({
          label: `prov-610-${next()}`,
          driver: "postgres",
          host: "db-host",
          port: 5432,
          database: "app",
          username: "app",
          password: "new-pw",
        });

    it("provision: the suggestion update failing after the password was rotated in place restores the old password, audited", async () => {
      const { row, secretId } = await ownedSuggestion();
      const rotate = vi.spyOn(vault(), "rotateUndoable");
      vi.spyOn(db.suggestedConnector, "update").mockRejectedValueOnce(new Error("disk full"));

      const res = await provision(row.id);

      expect(res.status, JSON.stringify(res.body)).toBe(500);
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(await plaintext(secretId)).toBe("old-pw");
      const after = await db.suggestedConnector.findUniqueOrThrow({ where: { id: row.id } });
      expect(after).toMatchObject({ status: "pending", passwordVaultRef: secretId });
      const audits = await restoreAudits(secretId);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorId).toBe(ADMIN_ID);
      expect(JSON.parse(audits[0]!.metadata ?? "{}")).toMatchObject({
        source: "update_not_applied",
        reason: "update_failed",
        restored: "previous_value",
        resourceType: "suggested_connector",
        resourceId: row.id,
        projectId: PROJ,
      });
    });

    it("provision: the connector create failing after the rotation restores the old password", async () => {
      const { row, secretId } = await ownedSuggestion();
      vi.spyOn(db.databaseConnection, "create").mockRejectedValueOnce(new Error("disk full"));

      const res = await provision(row.id);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await plaintext(secretId)).toBe("old-pw");
      expect(await restoreAudits(secretId)).toHaveLength(1);
    });

    it("provision: once the suggestion update landed, a later failure keeps the new password", async () => {
      const { row, secretId } = await ownedSuggestion();
      failAuditOf("suggested_connector.provisioned");

      const res = await provision(row.id);

      expect(res.status).toBe(500);
      expect(await plaintext(secretId)).toBe("new-pw");
      const after = await db.suggestedConnector.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe("accepted");
      expect(await restoreAudits(secretId)).toHaveLength(0);
    });
  },
);
