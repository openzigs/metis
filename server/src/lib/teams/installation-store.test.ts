/**
 * Epic #547 (Phase 0, #548) — Teams installation store tests.
 *
 * Proves the OWASP A02 secret-handling contract:
 *   - the plaintext app password is NEVER stored on the installation row (only a
 *     `${vault:label}` reference);
 *   - the secret round-trips through the REAL VaultService (AES-256-GCM) so the
 *     password decrypts back identically at adapter-construction time;
 *   - re-install rotates the SAME secret (no orphans), uninstall soft-deletes it;
 *   - everything is workspace-scoped.
 *
 * Uses the real `VaultService` (with an injected master key) over a fake Prisma
 * `secret` + `teamsAppInstallation` model, so no real DB or master-key env is
 * required.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { VaultService } from "../vault/vault-service.js";
import { TeamsInstallationStore } from "./installation-store.js";

interface SecretRow {
  id: string;
  name: string;
  description: string;
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
  keyVersion: number;
  algorithm: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface InstallRow {
  id: string;
  workspaceId: string;
  appId: string;
  appPasswordRef: string;
  tenantId: string | null;
  appType: string;
  status: string;
  label: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fake Prisma covering only the `secret` + `teamsAppInstallation` surfaces. */
class FakeDb {
  secrets: SecretRow[] = [];
  installs: InstallRow[] = [];
  private sseq = 0;
  private iseq = 0;

  secret = {
    create: async (args: { data: Partial<SecretRow> }): Promise<SecretRow> => {
      const row: SecretRow = {
        id: `sec_${++this.sseq}`,
        description: "",
        iv: "",
        tag: "",
        salt: "",
        keyVersion: 1,
        algorithm: "aes-256-gcm",
        createdById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        name: "",
        ciphertext: "",
        ...args.data,
      } as SecretRow;
      this.secrets.push(row);
      return row;
    },
    findFirst: async (args: {
      where: { id?: string; name?: string; deletedAt?: null };
    }): Promise<SecretRow | null> => {
      return (
        this.secrets.find(
          (s) =>
            (args.where.id ? s.id === args.where.id : true) &&
            (args.where.name ? s.name === args.where.name : true) &&
            (args.where.deletedAt === null ? s.deletedAt === null : true),
        ) ?? null
      );
    },
    update: async (args: {
      where: { id: string };
      data: Partial<SecretRow>;
    }): Promise<SecretRow> => {
      const row = this.secrets.find((s) => s.id === args.where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    },
  };

  teamsAppInstallation = {
    upsert: async (args: {
      where: { workspaceId_appId: { workspaceId: string; appId: string } };
      create: Partial<InstallRow>;
      update: Partial<InstallRow>;
    }): Promise<InstallRow> => {
      const { workspaceId, appId } = args.where.workspaceId_appId;
      const existing = this.installs.find(
        (i) => i.workspaceId === workspaceId && i.appId === appId,
      );
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date() });
        return existing;
      }
      const row: InstallRow = {
        id: `inst_${++this.iseq}`,
        tenantId: null,
        appType: "MultiTenant",
        status: "active",
        label: null,
        createdById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(args.create as InstallRow),
      };
      this.installs.push(row);
      return row;
    },
    findFirst: async (args: {
      where: { workspaceId: string; status?: string };
      orderBy?: unknown;
    }): Promise<InstallRow | null> => {
      return (
        this.installs.find(
          (i) =>
            i.workspaceId === args.where.workspaceId &&
            (args.where.status ? i.status === args.where.status : true),
        ) ?? null
      );
    },
    update: async (args: {
      where: { id: string };
      data: Partial<InstallRow>;
    }): Promise<InstallRow> => {
      const row = this.installs.find((i) => i.id === args.where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    },
  };
}

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

describe("TeamsInstallationStore (#548)", () => {
  let db: FakeDb;
  let vault: VaultService;
  let store: TeamsInstallationStore;

  beforeEach(() => {
    db = new FakeDb();
    vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
    // The vault persists via the global prisma import; here we inject our fake by
    // re-pointing the vault's prisma is not possible, so we test the store's
    // secret handling by giving the vault a fake-backed store through the same
    // FakeDb (vault-service uses `prisma.secret.*`).
    store = new TeamsInstallationStore(db as never, vaultOver(vault, db));
  });

  it("install encrypts the password into the vault and stores only a ${vault:ref}", async () => {
    const summary = await store.install({
      workspaceId: "ws-1",
      appId: "app-1",
      appPassword: "s3cret-bot-pw",
      appType: "MultiTenant",
    });

    // The installation row holds a vault ref, never the plaintext.
    const row = db.installs[0];
    expect(row.appPasswordRef).toBe("${vault:teams-bot-password:ws-1:app-1}");
    expect(JSON.stringify(row)).not.toContain("s3cret-bot-pw");
    // The summary returned to the API never leaks the password.
    expect(JSON.stringify(summary)).not.toContain("s3cret-bot-pw");
    // The secret IS persisted (encrypted) in the vault table.
    expect(db.secrets).toHaveLength(1);
    expect(db.secrets[0].ciphertext).not.toContain("s3cret-bot-pw");
    expect(db.secrets[0].name).toBe("project:teams-bot-password:ws-1:app-1");
  });

  it("resolveAppPassword decrypts the stored secret back to plaintext", async () => {
    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw-abc" });
    const creds = await store.resolveAppPassword("ws-1");
    expect(creds).not.toBeNull();
    expect(creds?.appId).toBe("app-1");
    expect(creds?.appPassword).toBe("pw-abc");
    expect(creds?.appType).toBe("MultiTenant");
  });

  it("re-install rotates the SAME vaulted secret (no orphan secrets)", async () => {
    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw-old" });
    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw-new" });
    expect(db.secrets).toHaveLength(1); // rotated in place, not a new secret
    expect(db.installs).toHaveLength(1); // upserted in place
    const creds = await store.resolveAppPassword("ws-1");
    expect(creds?.appPassword).toBe("pw-new");
  });

  it("uninstall marks the row revoked and soft-deletes the secret", async () => {
    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw" });
    expect(await store.uninstall("ws-1")).toBe(true);
    expect(db.installs[0].status).toBe("revoked");
    expect(db.secrets[0].deletedAt).not.toBeNull();
    // No active installation remains.
    expect(await store.getByWorkspace("ws-1")).toBeNull();
    expect(await store.resolveAppPassword("ws-1")).toBeNull();
  });

  it("uninstall is idempotent (returns false when nothing installed)", async () => {
    expect(await store.uninstall("ws-empty")).toBe(false);
  });

  it("requires a tenantId for a SingleTenant bot", async () => {
    await expect(
      store.install({
        workspaceId: "ws-1",
        appId: "app-1",
        appPassword: "pw",
        appType: "SingleTenant",
      }),
    ).rejects.toMatchObject({ code: "TENANT_REQUIRED" });
  });

  it("rejects missing required fields", async () => {
    await expect(
      store.install({ workspaceId: "", appId: "a", appPassword: "p" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_REQUIRED" });
    await expect(
      store.install({ workspaceId: "w", appId: "", appPassword: "p" }),
    ).rejects.toMatchObject({ code: "APP_ID_REQUIRED" });
    await expect(
      store.install({ workspaceId: "w", appId: "a", appPassword: "" }),
    ).rejects.toMatchObject({ code: "APP_PASSWORD_REQUIRED" });
  });

  it("is workspace-scoped — resolving for another workspace yields null", async () => {
    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw" });
    expect(await store.resolveAppPassword("ws-2")).toBeNull();
    expect(await store.getByWorkspace("ws-2")).toBeNull();
  });

  it("install accepts a SingleTenant bot with a tenantId and resolves it", async () => {
    await store.install({
      workspaceId: "ws-1",
      appId: "app-1",
      appPassword: "pw",
      appType: "SingleTenant",
      tenantId: "tenant-1",
      label: "Prod bot",
    });
    const creds = await store.resolveAppPassword("ws-1");
    expect(creds?.appType).toBe("SingleTenant");
    expect(creds?.tenantId).toBe("tenant-1");
    expect((await store.getByWorkspace("ws-1"))?.label).toBe("Prod bot");
  });

  it("uninstall still revokes the row when the vaulted secret is already gone", async () => {
    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw" });
    // Simulate the secret having been purged out-of-band.
    db.secrets[0].deletedAt = new Date();
    expect(await store.uninstall("ws-1")).toBe(true);
    expect(db.installs[0].status).toBe("revoked");
  });

  it("resolveAppPassword throws VAULT_REF_UNRESOLVED when the secret is missing", async () => {
    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw" });
    // Hard-delete the secret so the ref no longer resolves.
    db.secrets = [];
    await expect(store.resolveAppPassword("ws-1")).rejects.toMatchObject({
      code: "VAULT_REF_UNRESOLVED",
    });
  });

  it("resolveAppPassword throws VAULT_REF_INVALID on a malformed stored ref", async () => {
    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "pw" });
    db.installs[0].appPasswordRef = "not-a-vault-ref";
    await expect(store.resolveAppPassword("ws-1")).rejects.toMatchObject({
      code: "VAULT_REF_INVALID",
    });
  });
});

/**
 * Point the real VaultService at the FakeDb. The vault persists via the module's
 * `prisma` import; rather than mock the module, we wrap the vault so its
 * persistence methods route to the fake — the crypto path (encrypt/decrypt) stays
 * 100% real, which is what the secret-handling contract requires.
 */
function vaultOver(vault: VaultService, db: FakeDb): VaultService {
  const wrapped = vault as unknown as {
    create: VaultService["create"];
    read: VaultService["read"];
    rotate: VaultService["rotate"];
    delete: VaultService["delete"];
    encrypt: (p: string) => Promise<{ ciphertext: string; algorithm: string; keyVersion: number }>;
    decrypt: (e: { ciphertext: string }) => Promise<string>;
  };
  const realEncrypt = wrapped.encrypt.bind(vault);
  const realDecrypt = wrapped.decrypt.bind(vault);

  wrapped.create = (async (
    label: string,
    plaintext: string,
    scope = "global",
    opts: { description?: string; createdById?: string | null } = {},
  ) => {
    const env = await realEncrypt(plaintext);
    const row = await db.secret.create({
      data: {
        name: `${scope}:${label}`,
        description: opts.description ?? "",
        ciphertext: env.ciphertext,
        keyVersion: env.keyVersion,
        algorithm: env.algorithm,
        createdById: opts.createdById ?? null,
      },
    });
    return { id: row.id, label, scope, keyVersion: env.keyVersion } as never;
  }) as VaultService["create"];

  wrapped.read = (async (id: string) => {
    const row = await db.secret.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new Error("not found");
    const plaintext = await realDecrypt({ ciphertext: row.ciphertext });
    return { summary: { id } as never, plaintext };
  }) as VaultService["read"];

  wrapped.rotate = (async (id: string, newPlaintext: string) => {
    const env = await realEncrypt(newPlaintext);
    await db.secret.update({
      where: { id },
      data: { ciphertext: env.ciphertext, keyVersion: env.keyVersion, algorithm: env.algorithm },
    });
    return { id } as never;
  }) as VaultService["rotate"];

  wrapped.delete = (async (id: string) => {
    await db.secret.update({ where: { id }, data: { deletedAt: new Date() } });
  }) as VaultService["delete"];

  return vault;
}
