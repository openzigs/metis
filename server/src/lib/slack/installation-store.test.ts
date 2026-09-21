/**
 * Issue #579 (epic #63) — Slack installation store tests.
 *
 * Proves the OWASP A02 secret-handling contract (mirrors the #548 Teams store):
 *   - the plaintext bot token is NEVER stored on the installation row (only a
 *     `${vault:label}` reference);
 *   - the token round-trips through the REAL VaultService (AES-256-GCM) so it
 *     decrypts back identically when a WebClient is needed;
 *   - re-install rotates the SAME secret (no orphans), uninstall soft-deletes it;
 *   - everything is workspace-scoped.
 *
 * Uses the real `VaultService` (injected master key) over a fake Prisma
 * `secret` + `slackAppInstallation` model, so no real DB or master-key env is
 * required.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { VaultService } from "../vault/vault-service.js";
import {
  SlackInstallationStore,
  getSlackInstallationStore,
  __resetSlackInstallationStore,
} from "./installation-store.js";

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
  slackTeamId: string;
  slackTeamName: string | null;
  botUserId: string | null;
  botTokenRef: string;
  status: string;
  label: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fake Prisma covering only the `secret` + `slackAppInstallation` surfaces. */
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

  slackAppInstallation = {
    upsert: async (args: {
      where: { workspaceId_slackTeamId: { workspaceId: string; slackTeamId: string } };
      create: Partial<InstallRow>;
      update: Partial<InstallRow>;
    }): Promise<InstallRow> => {
      const { workspaceId, slackTeamId } = args.where.workspaceId_slackTeamId;
      const existing = this.installs.find(
        (i) => i.workspaceId === workspaceId && i.slackTeamId === slackTeamId,
      );
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date() });
        return existing;
      }
      const row: InstallRow = {
        id: `inst_${++this.iseq}`,
        slackTeamName: null,
        botUserId: null,
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
      where: { workspaceId?: string; slackTeamId?: string; status?: string };
      orderBy?: unknown;
    }): Promise<InstallRow | null> => {
      return (
        this.installs.find(
          (i) =>
            (args.where.workspaceId ? i.workspaceId === args.where.workspaceId : true) &&
            (args.where.slackTeamId ? i.slackTeamId === args.where.slackTeamId : true) &&
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

describe("SlackInstallationStore (#579)", () => {
  let db: FakeDb;
  let vault: VaultService;
  let store: SlackInstallationStore;

  beforeEach(() => {
    db = new FakeDb();
    vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
    store = new SlackInstallationStore(db as never, vaultOver(vault, db));
  });

  it("install encrypts the token into the vault and stores only a ${vault:ref}", async () => {
    const summary = await store.install({
      workspaceId: "ws-1",
      slackTeamId: "T123",
      botToken: "xoxb-super-secret",
      slackTeamName: "Acme",
      botUserId: "U999",
    });

    const row = db.installs[0];
    expect(row.botTokenRef).toBe("${vault:slack-bot-token:ws-1:T123}");
    expect(JSON.stringify(row)).not.toContain("xoxb-super-secret");
    expect(JSON.stringify(summary)).not.toContain("xoxb-super-secret");
    expect(db.secrets).toHaveLength(1);
    expect(db.secrets[0].ciphertext).not.toContain("xoxb-super-secret");
    expect(db.secrets[0].name).toBe("project:slack-bot-token:ws-1:T123");
    expect(summary.slackTeamName).toBe("Acme");
    expect(summary.botUserId).toBe("U999");
  });

  it("resolveBotToken decrypts the stored token back to plaintext", async () => {
    await store.install({ workspaceId: "ws-1", slackTeamId: "T123", botToken: "xoxb-abc" });
    const creds = await store.resolveBotToken("ws-1");
    expect(creds).not.toBeNull();
    expect(creds?.slackTeamId).toBe("T123");
    expect(creds?.botToken).toBe("xoxb-abc");
  });

  it("re-install rotates the SAME vaulted secret (no orphan secrets)", async () => {
    await store.install({ workspaceId: "ws-1", slackTeamId: "T123", botToken: "xoxb-old" });
    await store.install({ workspaceId: "ws-1", slackTeamId: "T123", botToken: "xoxb-new" });
    expect(db.secrets).toHaveLength(1);
    expect(db.installs).toHaveLength(1);
    const creds = await store.resolveBotToken("ws-1");
    expect(creds?.botToken).toBe("xoxb-new");
  });

  it("uninstall marks the row revoked and soft-deletes the secret", async () => {
    await store.install({ workspaceId: "ws-1", slackTeamId: "T123", botToken: "xoxb" });
    expect(await store.uninstall("ws-1")).toBe(true);
    expect(db.installs[0].status).toBe("revoked");
    expect(db.secrets[0].deletedAt).not.toBeNull();
    expect(await store.getByWorkspace("ws-1")).toBeNull();
    expect(await store.resolveBotToken("ws-1")).toBeNull();
  });

  it("uninstall is idempotent (returns false when nothing installed)", async () => {
    expect(await store.uninstall("ws-empty")).toBe(false);
  });

  it("rejects missing required fields", async () => {
    await expect(
      store.install({ workspaceId: "", slackTeamId: "T", botToken: "x" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_REQUIRED" });
    await expect(
      store.install({ workspaceId: "w", slackTeamId: "", botToken: "x" }),
    ).rejects.toMatchObject({ code: "TEAM_REQUIRED" });
    await expect(
      store.install({ workspaceId: "w", slackTeamId: "T", botToken: "" }),
    ).rejects.toMatchObject({ code: "BOT_TOKEN_REQUIRED" });
  });

  it("is workspace-scoped — resolving for another workspace yields null", async () => {
    await store.install({ workspaceId: "ws-1", slackTeamId: "T123", botToken: "xoxb" });
    expect(await store.resolveBotToken("ws-2")).toBeNull();
    expect(await store.getByWorkspace("ws-2")).toBeNull();
  });

  it("getBySlackTeam returns the active install for a team id", async () => {
    await store.install({ workspaceId: "ws-1", slackTeamId: "T123", botToken: "xoxb" });
    expect((await store.getBySlackTeam("T123"))?.workspaceId).toBe("ws-1");
    expect(await store.getBySlackTeam("T-other")).toBeNull();
  });

  it("uninstall still revokes the row when the vaulted secret is already gone", async () => {
    await store.install({ workspaceId: "ws-1", slackTeamId: "T123", botToken: "xoxb" });
    db.secrets[0].deletedAt = new Date();
    expect(await store.uninstall("ws-1")).toBe(true);
    expect(db.installs[0].status).toBe("revoked");
  });

  it("resolveBotToken throws VAULT_REF_UNRESOLVED when the secret is missing", async () => {
    await store.install({ workspaceId: "ws-1", slackTeamId: "T123", botToken: "xoxb" });
    db.secrets = [];
    await expect(store.resolveBotToken("ws-1")).rejects.toMatchObject({
      code: "VAULT_REF_UNRESOLVED",
    });
  });

  it("resolveBotToken throws VAULT_REF_INVALID on a malformed stored ref", async () => {
    await store.install({ workspaceId: "ws-1", slackTeamId: "T123", botToken: "xoxb" });
    db.installs[0].botTokenRef = "not-a-vault-ref";
    await expect(store.resolveBotToken("ws-1")).rejects.toMatchObject({
      code: "VAULT_REF_INVALID",
    });
  });

  it("exposes a process-wide singleton via getSlackInstallationStore", () => {
    __resetSlackInstallationStore();
    const a = getSlackInstallationStore();
    expect(getSlackInstallationStore()).toBe(a);
    __resetSlackInstallationStore();
    expect(getSlackInstallationStore()).not.toBe(a);
  });
});

/** Point the real VaultService at the FakeDb (crypto stays 100% real). */
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
