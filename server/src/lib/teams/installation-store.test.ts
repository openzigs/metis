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
import { createRequire } from "node:module";

import { beforeEach, describe, expect, it } from "vitest";

import { VaultService } from "../vault/vault-service.js";
import { buildCredentialsFactory } from "./bot-adapter.js";
import {
  normalizeTeamsAppType,
  TeamsInstallationStore,
  type InstallInput,
} from "./installation-store.js";
import { loadTeamsMsiAllowlist, type TeamsMsiAllowlist } from "./msi-allowlist.js";

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
      // Like the real table: `Secret.name` is UNIQUE and a soft-deleted row
      // keeps its name (#258).
      if (this.secrets.some((s) => s.name === args.data.name)) {
        throw Object.assign(new Error("Unique constraint failed on the fields: (`name`)"), {
          code: "P2002",
        });
      }
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
    upsert: async (args: {
      where: { name: string };
      create: Partial<SecretRow>;
      update: Partial<SecretRow>;
    }): Promise<SecretRow> => {
      const row = this.secrets.find((s) => s.name === args.where.name);
      if (!row) return this.secret.create({ data: args.create });
      Object.assign(row, args.update, { updatedAt: new Date() });
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
      create: Pick<InstallRow, "workspaceId" | "appId" | "appPasswordRef"> & Partial<InstallRow>;
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
        ...args.create,
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
    findMany: async (args: {
      where: {
        status?: string;
        workspaceId?: string | { not: string };
        id?: { not: string };
      };
    }): Promise<InstallRow[]> => {
      const { status, workspaceId, id } = args.where;
      return this.installs.filter(
        (i) =>
          (status ? i.status === status : true) &&
          (typeof workspaceId === "string"
            ? i.workspaceId === workspaceId
            : workspaceId
              ? i.workspaceId !== workspaceId.not
              : true) &&
          (id ? i.id !== id.not : true),
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

/** The managed identity the operator allowed, and one they did not (#1466). */
const MSI = "11111111-2222-3333-4444-555555555555";
const OTHER_MSI = "99999999-8888-7777-6666-555555555555";

function msiInput(over: Partial<InstallInput> = {}): InstallInput {
  return {
    workspaceId: "ws-1",
    appId: MSI,
    appType: "UserAssignedMsi",
    tenantId: "tenant-1",
    ...over,
  };
}

describe("TeamsInstallationStore (#548)", () => {
  let db: FakeDb;
  let vault: VaultService;
  let store: TeamsInstallationStore;
  let allowlist: TeamsMsiAllowlist;

  beforeEach(() => {
    allowlist = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: MSI });
    db = new FakeDb();
    vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
    // The vault persists via the global prisma import; here we inject our fake by
    // re-pointing the vault's prisma is not possible, so we test the store's
    // secret handling by giving the vault a fake-backed store through the same
    // FakeDb (vault-service uses `prisma.secret.*`).
    store = new TeamsInstallationStore(db as never, vaultOver(vault, db), () => allowlist);
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

  it("reinstall after uninstall revives the secret with the NEW value (#258)", async () => {
    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "old-value" });
    expect(await store.uninstall("ws-1")).toBe(true);

    await store.install({ workspaceId: "ws-1", appId: "app-1", appPassword: "new-value" });

    expect((await store.resolveAppPassword("ws-1"))?.appPassword).toBe("new-value");
    expect(db.secrets).toHaveLength(1);
    expect(db.secrets[0].deletedAt).toBeNull();
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

  // ── #1466 — user-assigned managed identity ──────────────────────────────
  // botbuilder-core selects its managed-identity factory on `UserAssignedMsi`
  // (case-insensitive) and requires a tenant id and NO password for it. METIS
  // additionally requires the operator to have allowed the client id
  // (TEAMS_MSI_CLIENT_IDS), because naming one proves no ownership of it.

  it("installs an allowed UserAssignedMsi bot with a tenant id and no password, vaulting nothing", async () => {
    const summary = await store.install(msiInput());
    expect(summary).toMatchObject({
      appType: "UserAssignedMsi",
      needsReinstall: false,
      reinstallReason: null,
    });
    expect(db.installs[0].appType).toBe("UserAssignedMsi");
    expect(db.installs[0].appPasswordRef).toBe("");
    expect(db.secrets).toHaveLength(0);

    expect(await store.resolveAppPassword("ws-1")).toEqual({
      appId: MSI,
      appPassword: "",
      appType: "UserAssignedMsi",
      tenantId: "tenant-1",
    });
  });

  it("refuses a managed identity the operator has not allowed — e.g. another workspace's or the host's", async () => {
    await expect(store.install(msiInput({ appId: OTHER_MSI }))).rejects.toMatchObject({
      statusCode: 403,
      code: "MSI_CLIENT_ID_NOT_ALLOWED",
      message: expect.stringContaining("TEAMS_MSI_CLIENT_IDS"),
    });
    expect(db.installs).toHaveLength(0);
  });

  it("refuses every managed identity when TEAMS_MSI_CLIENT_IDS is unset", async () => {
    allowlist = loadTeamsMsiAllowlist({});
    await expect(store.install(msiInput())).rejects.toMatchObject({
      code: "MSI_CLIENT_ID_NOT_ALLOWED",
    });
  });

  it("refuses an allowed managed identity already active in another workspace, without naming it", async () => {
    await store.install(msiInput({ workspaceId: "ws-a" }));
    let thrown: { code?: string; statusCode?: number; message?: string } = {};
    try {
      await store.install(msiInput({ workspaceId: "ws-b", appId: MSI.toUpperCase() }));
    } catch (err) {
      thrown = err as typeof thrown;
    }
    expect(thrown).toMatchObject({
      statusCode: 409,
      code: "MSI_CLIENT_ID_IN_USE",
    });
    expect(thrown.message).not.toContain("ws-a");
    expect(db.installs.filter((i) => i.workspaceId === "ws-b")).toHaveLength(0);
    // Once workspace A disconnects, B may use it.
    await store.uninstall("ws-a");
    await expect(store.install(msiInput({ workspaceId: "ws-b" }))).resolves.toMatchObject({
      needsReinstall: false,
    });
  });

  it("stops resolving a managed identity once the operator removes it from the allowlist", async () => {
    await store.install(msiInput());
    allowlist = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: OTHER_MSI });
    await expect(store.resolveAppPassword("ws-1")).rejects.toMatchObject({
      statusCode: 403,
      code: "MSI_CLIENT_ID_NOT_ALLOWED",
    });
    expect(await store.getByWorkspace("ws-1")).toMatchObject({
      needsReinstall: true,
      reinstallReason: "msi-not-allowed",
    });
  });

  it("refuses to resolve a managed identity that is active in two workspaces", async () => {
    // e.g. two rows written before the in-use check existed.
    await store.install(msiInput({ workspaceId: "ws-a" }));
    await store.install({
      workspaceId: "ws-b",
      appId: "app-b",
      appPassword: "pw",
    });
    Object.assign(db.installs[1], {
      appId: MSI,
      appType: "UserAssignedMsi",
      tenantId: "t",
    });
    await expect(store.resolveAppPassword("ws-a")).rejects.toMatchObject({
      code: "MSI_CLIENT_ID_IN_USE",
    });
    expect((await store.getByWorkspace("ws-b"))?.reinstallReason).toBe("msi-in-use");
  });

  it("requires a tenant id for a UserAssignedMsi bot", async () => {
    await expect(store.install(msiInput({ tenantId: null }))).rejects.toMatchObject({
      statusCode: 400,
      code: "TENANT_REQUIRED",
    });
  });

  it("rejects a password for a UserAssignedMsi bot rather than vaulting a secret it never uses", async () => {
    await expect(store.install(msiInput({ appPassword: "pw" }))).rejects.toMatchObject({
      statusCode: 400,
      code: "APP_PASSWORD_NOT_ALLOWED",
    });
    expect(db.secrets).toHaveLength(0);
  });

  it("switching a workspace from a password app to a managed identity revokes the old app and retires its password", async () => {
    // A managed identity's client id always differs from the password app's id.
    await store.install({
      workspaceId: "ws-1",
      appId: "app-1",
      appPassword: "pw",
    });
    await store.install(msiInput());
    const old = db.installs.find((i) => i.appId === "app-1");
    expect(old?.status).toBe("revoked");
    expect(db.secrets[0].deletedAt).not.toBeNull();
    expect(db.installs.filter((i) => i.status === "active").map((i) => i.appId)).toEqual([MSI]);
    expect((await store.resolveAppPassword("ws-1"))?.appType).toBe("UserAssignedMsi");
  });

  it("installing a second password app revokes the first and retires its secret", async () => {
    await store.install({
      workspaceId: "ws-1",
      appId: "app-1",
      appPassword: "pw-1",
    });
    await store.install({
      workspaceId: "ws-1",
      appId: "app-2",
      appPassword: "pw-2",
    });
    expect(db.installs.find((i) => i.appId === "app-1")?.status).toBe("revoked");
    expect(db.secrets.find((s) => s.name.endsWith(":app-1"))?.deletedAt).not.toBeNull();
    expect(db.secrets.find((s) => s.name.endsWith(":app-2"))?.deletedAt).toBeNull();
    // Another workspace's installation is untouched.
    await store.install({
      workspaceId: "ws-2",
      appId: "app-3",
      appPassword: "pw-3",
    });
    expect(db.installs.find((i) => i.appId === "app-2")?.status).toBe("active");
  });

  it("re-installing the same app as a managed identity retires its password only after the row is updated", async () => {
    const id = MSI;
    await store.install({
      workspaceId: "ws-1",
      appId: id,
      appPassword: "pw",
      tenantId: "t",
    });
    const upsert = db.teamsAppInstallation.upsert;
    db.teamsAppInstallation.upsert = async () => {
      throw new Error("db down");
    };
    await expect(store.install(msiInput())).rejects.toThrow("db down");
    // The failed install left the password the still-active row points at.
    expect(db.secrets[0].deletedAt).toBeNull();
    expect((await store.resolveAppPassword("ws-1"))?.appPassword).toBe("pw");

    db.teamsAppInstallation.upsert = upsert;
    await store.install(msiInput());
    expect(db.secrets[0].deletedAt).not.toBeNull();
    expect(db.installs[0].appPasswordRef).toBe("");
  });

  it("uninstalls a UserAssignedMsi bot without touching the vault", async () => {
    await store.install(msiInput());
    expect(await store.uninstall("ws-1")).toBe(true);
    expect(db.installs[0].status).toBe("revoked");
  });

  it("maps a stored legacy `UserAssignedMSID` row to UserAssignedMsi, and flags it for reinstall", async () => {
    // A row written before #1466: the old spelling, and the vaulted password the
    // install flow required at the time — the bot really ran as MultiTenant.
    await store.install({
      workspaceId: "ws-1",
      appId: MSI,
      appPassword: "pw",
      tenantId: "t-1",
    });
    db.installs[0].appType = "UserAssignedMSID";

    expect(await store.getByWorkspace("ws-1")).toMatchObject({
      appType: "UserAssignedMsi",
      needsReinstall: true,
      reinstallReason: "legacy-app-type",
    });
    // An allowed identity still resolves — as a managed identity, never with the
    // legacy vaulted password, which botbuilder refuses for MSI.
    expect(await store.resolveAppPassword("ws-1")).toEqual({
      appId: MSI,
      appPassword: "",
      appType: "UserAssignedMsi",
      tenantId: "t-1",
    });
    // Uninstall still retires the legacy vaulted password.
    expect(await store.uninstall("ws-1")).toBe(true);
    expect(db.secrets[0].deletedAt).not.toBeNull();
  });

  it("a legacy `UserAssignedMSID` row whose id is not allowed is refused, not run as MultiTenant", async () => {
    await store.install({
      workspaceId: "ws-1",
      appId: "app-1",
      appPassword: "pw",
      tenantId: "t",
    });
    db.installs[0].appType = "UserAssignedMSID";
    await expect(store.resolveAppPassword("ws-1")).rejects.toMatchObject({
      code: "MSI_CLIENT_ID_NOT_ALLOWED",
    });
    expect((await store.getByWorkspace("ws-1"))?.reinstallReason).toBe("msi-not-allowed");
  });

  it("a stored legacy `UserAssignedMSID` installation now reaches botbuilder's managed-identity path", async () => {
    await store.install({
      workspaceId: "ws-1",
      appId: MSI,
      appPassword: "pw",
      tenantId: "t-1",
    });
    db.installs[0].appType = "UserAssignedMSID";

    const creds = await store.resolveAppPassword("ws-1");
    const credentials = await buildCredentialsFactory(creds!).createCredentials(
      MSI,
      "https://api.botframework.com",
      "https://login.microsoftonline.com/botframework.com",
      true,
    );
    const connector = createRequire(createRequire(import.meta.url).resolve("botbuilder"))(
      "botframework-connector",
    ) as {
      ManagedIdentityAppCredentials: new (...args: never[]) => unknown;
    };
    expect(credentials).toBeInstanceOf(connector.ManagedIdentityAppCredentials);
  });

  it("refuses to resolve a managed-identity row stored without a tenant id, and flags it", async () => {
    await store.install({ workspaceId: "ws-1", appId: MSI, appPassword: "pw" });
    db.installs[0].appType = "UserAssignedMSID";
    await expect(store.resolveAppPassword("ws-1")).rejects.toMatchObject({
      code: "TENANT_REQUIRED",
    });
    expect((await store.getByWorkspace("ws-1"))?.reinstallReason).toBe("msi-missing-tenant");
  });

  it("refuses to resolve an unrecognised stored app type instead of falling through to MultiTenant", async () => {
    await store.install({
      workspaceId: "ws-1",
      appId: "app-1",
      appPassword: "pw",
    });
    db.installs[0].appType = "SomethingElse";
    await expect(store.resolveAppPassword("ws-1")).rejects.toMatchObject({
      code: "APP_TYPE_UNKNOWN",
    });
    // The secret-free summary still renders, showing what is stored.
    expect(await store.getByWorkspace("ws-1")).toMatchObject({
      appType: "SomethingElse",
      needsReinstall: true,
      reinstallReason: "unknown-app-type",
    });
  });

  it("a sound password installation does not need reinstalling", async () => {
    await store.install({
      workspaceId: "ws-1",
      appId: "app-1",
      appPassword: "pw",
    });
    expect(await store.getByWorkspace("ws-1")).toMatchObject({
      needsReinstall: false,
      reinstallReason: null,
    });
  });
});

describe("normalizeTeamsAppType (#1466)", () => {
  it("returns the canonical spelling, case-insensitively, and maps the legacy spelling", () => {
    expect(normalizeTeamsAppType("MultiTenant")).toBe("MultiTenant");
    expect(normalizeTeamsAppType("singletenant")).toBe("SingleTenant");
    expect(normalizeTeamsAppType(" UserAssignedMsi ")).toBe("UserAssignedMsi");
    expect(normalizeTeamsAppType("UserAssignedMSID")).toBe("UserAssignedMsi");
    expect(normalizeTeamsAppType("userassignedmsid")).toBe("UserAssignedMsi");
  });

  it("returns null for anything else", () => {
    expect(normalizeTeamsAppType("Other")).toBeNull();
    expect(normalizeTeamsAppType("")).toBeNull();
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
    upsert: VaultService["upsert"];
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

  wrapped.upsert = (async (
    label: string,
    plaintext: string,
    scope = "global",
    opts: { description?: string; createdById?: string | null } = {},
  ) => {
    const env = await realEncrypt(plaintext);
    const name = `${scope}:${label}`;
    const cipher = {
      ciphertext: env.ciphertext,
      keyVersion: env.keyVersion,
      algorithm: env.algorithm,
    };
    const row = await db.secret.upsert({
      where: { name },
      create: { name, ...cipher, createdById: opts.createdById ?? null },
      update: { ...cipher, deletedAt: null },
    });
    return { id: row.id, label, scope, keyVersion: env.keyVersion } as never;
  }) as VaultService["upsert"];

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
