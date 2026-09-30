/**
 * #593 — an update that rotates a connection's own secret in place and then
 * fails part-way puts the previous value back: the request reports failure, so
 * the credential must not have changed. Covers the Jira and test-management
 * update paths and the vault primitives they use (`rotateUndoable`,
 * `undoRotation`, `undoRotations`).
 *
 * Real SQLite built by the migration chain and the real `VaultService`; the
 * only thing faked is the one failure each test forces. Every assertion reads
 * the secret back through the vault, as a real consumer would.
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

const { getVaultService, __resetVaultSingleton, SecretNotFoundError } =
  await import("../src/lib/vault/vault-service.js");
const jira = await import("../src/lib/connectors/jira/jira-service.js");
const testmgmt = await import("../src/lib/connectors/testmgmt/connection-service.js");
const { undoRotations } = await import("../src/lib/vault/secret-retirement.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

const MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
const OWNER = "owner-593";
const OTHER = "other-593";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#593 — a failed update restores the secrets it rotated in place (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const prevKey = process.env.VAULT_MASTER_KEY;
    let seq = 0;
    const uniq = (p: string) => `${p}-${++seq}`;
    const refIdOf = (ref: string) => /^\$\{vault:([^}]+)\}$/.exec(ref)![1]!;
    const vault = () => getVaultService();
    const plaintext = async (id: string) => (await vault().read(id)).plaintext;
    const ciphertext = async (id: string) =>
      (await db.secret.findUniqueOrThrow({ where: { id } })).ciphertext;
    const rotationAudits = async (ids: string[]) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.rotate", targetType: "secret", targetId: { in: ids } },
      });
    };

    /** Make the `n`th in-place rotation from now on fail (1-based); the others are real. */
    function failRotationOn(n: number) {
      const v = vault();
      const real = v.rotateUndoable.bind(v);
      let calls = 0;
      return vi.spyOn(v, "rotateUndoable").mockImplementation(async (...args) => {
        calls += 1;
        if (calls === n) throw new Error("vault unavailable");
        return real(...args);
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("593-rotation-undo");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      for (const id of [OWNER, OTHER]) {
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

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    // ---- Jira ---------------------------------------------------------------

    async function ownerJira() {
      const made = await jira.createJiraConnection(
        "p1",
        {
          label: uniq("j"),
          edition: "datacenter",
          baseUrl: "https://jira.example.test",
          username: "svc",
          apiToken: "owner-token",
          tlsCaCert: "owner-ca",
        },
        OWNER,
      );
      return db.jiraConnection.findUniqueOrThrow({ where: { id: made.id } });
    }

    it("Jira update: the row write failing after the token was rotated in place restores the old token, audited", async () => {
      const before = await ownerJira();
      const cipherBefore = await ciphertext(before.secretId);
      vi.spyOn(db.jiraConnection, "update").mockRejectedValueOnce(new Error("disk full"));

      await expect(
        jira.updateJiraConnection(before.id, { apiToken: "new-token" }, OWNER),
      ).rejects.toThrow("disk full");

      expect(await plaintext(before.secretId)).toBe("owner-token");
      expect(await ciphertext(before.secretId)).toBe(cipherBefore);
      const after = await db.jiraConnection.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.secretId).toBe(before.secretId);
      const audits = await rotationAudits([before.secretId]);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorId).toBe(OWNER);
      expect(JSON.parse(audits[0]!.metadata ?? "{}")).toMatchObject({
        source: "update_not_applied",
        reason: "update_failed",
        restored: "previous_value",
        resourceType: "jira_connection",
        resourceId: before.id,
        projectId: "p1",
      });
    });

    it("Jira update: the CA cert rotation failing restores the token rotated before it", async () => {
      const before = await ownerJira();
      failRotationOn(2);

      await expect(
        jira.updateJiraConnection(before.id, { apiToken: "new-token", tlsCaCert: "new-ca" }, OWNER),
      ).rejects.toThrow("vault unavailable");

      expect(await plaintext(before.secretId)).toBe("owner-token");
      expect(await plaintext(before.tlsCaSecretId!)).toBe("owner-ca");
    });

    it("Jira update: a concurrent update restores every secret rotated, and says why", async () => {
      const before = await ownerJira();
      // Another writer changes the row while this update does its vault work.
      const v = vault();
      const real = v.rotateUndoable.bind(v);
      let moved = false;
      vi.spyOn(v, "rotateUndoable").mockImplementation(async (...args) => {
        if (!moved) {
          moved = true;
          await db.jiraConnection.update({
            where: { id: before.id },
            data: { username: "someone-else", updatedAt: new Date(Date.now() + 60_000) },
          });
        }
        return real(...args);
      });

      await expect(
        jira.updateJiraConnection(
          before.id,
          { apiToken: "new-token", tlsCaCert: "new-ca" },
          OWNER,
          undefined,
          before.updatedAt,
        ),
      ).rejects.toMatchObject({ code: "CONCURRENT_UPDATE" });

      expect(await plaintext(before.secretId)).toBe("owner-token");
      expect(await plaintext(before.tlsCaSecretId!)).toBe("owner-ca");
      const audits = await rotationAudits([before.secretId, before.tlsCaSecretId!]);
      expect(audits).toHaveLength(2);
      for (const a of audits) {
        expect(JSON.parse(a.metadata ?? "{}")).toMatchObject({ reason: "concurrent_update" });
      }
    });

    it("Jira update: a successful update keeps the rotated values", async () => {
      const before = await ownerJira();

      await jira.updateJiraConnection(
        before.id,
        { apiToken: "new-token", tlsCaCert: "new-ca" },
        OWNER,
      );

      expect(await plaintext(before.secretId)).toBe("new-token");
      expect(await plaintext(before.tlsCaSecretId!)).toBe("new-ca");
      expect(await rotationAudits([before.secretId, before.tlsCaSecretId!])).toEqual([]);
    });

    // ---- Test management ---------------------------------------------------

    const tmDeps = () => ({
      prisma: db,
      vault: vault(),
      assertHost: async () => undefined,
    });

    async function ownerXray() {
      const made = await testmgmt.createTestManagementConnection(
        "p1",
        {
          label: uniq("x"),
          kind: "xray",
          baseUrl: "https://xray.example.test",
          auth: { kind: "xray", clientId: "owner-id", clientSecret: "owner-secret" },
          tlsConfig: { rejectUnauthorized: true, caCert: "owner-ca" },
        },
        OWNER,
        tmDeps(),
      );
      const row = await db.testManagementConnection.findUniqueOrThrow({ where: { id: made.id } });
      const auth = JSON.parse(row.authConfigJson) as Record<string, string>;
      const tls = JSON.parse(row.tlsConfigJson!) as { caCertRef: string };
      return {
        row,
        clientId: refIdOf(auth.clientIdRef!),
        clientSecret: refIdOf(auth.clientSecretRef!),
        ca: refIdOf(tls.caCertRef),
      };
    }

    it("test management update: the row write failing restores both xray credentials and the CA cert", async () => {
      const { row, clientId, clientSecret, ca } = await ownerXray();
      vi.spyOn(db.testManagementConnection, "update").mockRejectedValueOnce(new Error("disk full"));

      await expect(
        testmgmt.updateTestManagementConnection(
          row.id,
          {
            auth: { kind: "xray", clientId: "new-id", clientSecret: "new-secret" },
            tlsConfig: { rejectUnauthorized: true, caCert: "new-ca" },
          },
          OWNER,
          undefined,
          tmDeps(),
        ),
      ).rejects.toThrow("disk full");

      expect(await plaintext(clientId)).toBe("owner-id");
      expect(await plaintext(clientSecret)).toBe("owner-secret");
      expect(await plaintext(ca)).toBe("owner-ca");
      const after = await db.testManagementConnection.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.authConfigJson).toBe(row.authConfigJson);
      const audits = await rotationAudits([clientId, clientSecret, ca]);
      expect(audits.map((a) => a.targetId).sort()).toEqual([clientId, clientSecret, ca].sort());
      for (const a of audits) {
        expect(JSON.parse(a.metadata ?? "{}")).toMatchObject({
          resourceType: "test_management_connection",
          resourceId: row.id,
        });
      }
    });

    it("test management update: the client_secret rotation failing restores the client_id", async () => {
      const { row, clientId, clientSecret } = await ownerXray();
      failRotationOn(2);

      await expect(
        testmgmt.updateTestManagementConnection(
          row.id,
          { auth: { kind: "xray", clientId: "new-id", clientSecret: "new-secret" } },
          OWNER,
          undefined,
          tmDeps(),
        ),
      ).rejects.toThrow("vault unavailable");

      expect(await plaintext(clientId)).toBe("owner-id");
      expect(await plaintext(clientSecret)).toBe("owner-secret");
    });

    it("test management update: a successful update keeps the rotated values", async () => {
      const { row, clientId, clientSecret } = await ownerXray();

      await testmgmt.updateTestManagementConnection(
        row.id,
        { auth: { kind: "xray", clientId: "new-id", clientSecret: "new-secret" } },
        OWNER,
        undefined,
        tmDeps(),
      );

      expect(await plaintext(clientId)).toBe("new-id");
      expect(await plaintext(clientSecret)).toBe("new-secret");
    });

    // ---- Vault primitives --------------------------------------------------

    const ownerSecret = async (value = "v0") =>
      vault().create(uniq("s"), value, "project", { createdById: OWNER });

    it("rotateUndoable refuses a missing, soft-deleted or foreign-owned secret and writes nothing", async () => {
      const s = await ownerSecret();
      await expect(
        vault().rotateUndoable(s.id, "v1", { onlyIfCreatedBy: OTHER }),
      ).rejects.toBeInstanceOf(SecretNotFoundError);
      expect(await plaintext(s.id)).toBe("v0");
      await expect(vault().rotateUndoable("nope", "v1")).rejects.toBeInstanceOf(
        SecretNotFoundError,
      );
      await vault().delete(s.id);
      await expect(vault().rotateUndoable(s.id, "v1")).rejects.toBeInstanceOf(SecretNotFoundError);
    });

    it("rotateUndoable then undoRotation puts the previous envelope back", async () => {
      const s = await ownerSecret();
      const before = await db.secret.findUniqueOrThrow({ where: { id: s.id } });
      const undo = await vault().rotateUndoable(s.id, "v1", { onlyIfCreatedBy: OWNER });
      expect(await plaintext(s.id)).toBe("v1");
      expect(undo.previous.ciphertext).toBe(before.ciphertext);

      expect(await vault().undoRotation(undo)).toBe(true);
      expect(await plaintext(s.id)).toBe("v0");
      expect(await ciphertext(s.id)).toBe(before.ciphertext);
    });

    it("undoRotation never overwrites a value written after the rotation", async () => {
      const s = await ownerSecret();
      const undo = await vault().rotateUndoable(s.id, "v1");
      await vault().rotate(s.id, "v2");

      expect(await vault().undoRotation(undo)).toBe(false);
      expect(await plaintext(s.id)).toBe("v2");
    });

    it("rotateUndoable retries when a write interleaves between its read and its swap", async () => {
      const s = await ownerSecret();
      const realUpdateMany = db.secret.updateMany.bind(db.secret);
      let interleaved = false;
      vi.spyOn(db.secret, "updateMany").mockImplementation((async (args: never) => {
        if (!interleaved) {
          interleaved = true;
          await vault().rotate(s.id, "concurrent");
        }
        return realUpdateMany(args);
      }) as never);

      const undo = await vault().rotateUndoable(s.id, "v1");

      expect(await plaintext(s.id)).toBe("v1");
      // The undo names the value it actually replaced — the concurrent one.
      expect(await vault().undoRotation(undo)).toBe(true);
      expect(await plaintext(s.id)).toBe("concurrent");
    });

    it("rotateUndoable gives up rather than overwrite a value it never read", async () => {
      const s = await ownerSecret();
      vi.spyOn(db.secret, "updateMany").mockResolvedValue({ count: 0 } as never);

      await expect(vault().rotateUndoable(s.id, "v1")).rejects.toThrow(/kept changing/);
      expect(db.secret.updateMany).toHaveBeenCalledTimes(3);
      vi.restoreAllMocks();
      expect(await plaintext(s.id)).toBe("v0");
    });

    it("undoRotations undoes in reverse order, and never throws on a failing or stale undo", async () => {
      const s = await ownerSecret();
      const first = await vault().rotateUndoable(s.id, "v1");
      const second = await vault().rotateUndoable(s.id, "v2");
      const t = await ownerSecret("t0");
      const stale = await vault().rotateUndoable(t.id, "t1");
      await vault().rotate(t.id, "t2");
      const broken = { ...first, id: "broken" };
      const realUndo = vault().undoRotation.bind(vault());
      vi.spyOn(vault(), "undoRotation").mockImplementation(async (u) => {
        if (u.id === "broken") throw new Error("db down");
        return realUndo(u);
      });

      await expect(
        undoRotations(vault(), [broken, stale, first, second], {
          actorId: OWNER,
          resource: { type: "jira_connection", id: "c1" },
          cause: new Error("x"),
        }),
      ).resolves.toBeUndefined();

      expect(await plaintext(s.id)).toBe("v0");
      expect(await plaintext(t.id)).toBe("t2");
      const audits = await rotationAudits([s.id, t.id, "broken"]);
      expect(audits.map((a) => a.targetId)).toEqual([s.id, s.id]);
      expect(JSON.parse(audits[0]!.metadata ?? "{}")).not.toHaveProperty("projectId");
    });
  },
);
