/**
 * Epic #547 (Phase 0, #548) — per-workspace Teams app installation store.
 *
 * Models the OAuth/connect step that registers an Azure Bot for a METIS
 * workspace. The bot's Microsoft App Password (client secret) is the sensitive
 * material; it is NEVER persisted on the installation row.
 *
 * SECRET HANDLING (OWASP A02 — cryptographic storage):
 *   1. On install, the plaintext app password is written to the hardened secret
 *      vault (`server/src/lib/vault/vault-service.ts`, AES-256-GCM with a
 *      versioned envelope) under a deterministic label.
 *   2. Only the `${vault:label}` REFERENCE is stored in
 *      `TeamsAppInstallation.appPasswordRef`.
 *   3. At adapter-construction time the reference is resolved back to plaintext
 *      via the vault — plaintext never touches the installation table, logs, or
 *      API responses. The password is also redacted from every returned summary.
 *
 * Tenant scoping: every read/write is keyed by `workspaceId`, so one workspace's
 * Teams credentials are never visible to another.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { getVaultService, type VaultService } from "../vault/vault-service.js";

/**
 * Bot identity types accepted from Azure, spelled exactly as botbuilder-core's
 * `ConfigurationServiceClientCredentialFactory` compares `MicrosoftAppType`.
 * A value it does not recognise falls through to MultiTenant app-password auth,
 * which is how `UserAssignedMSID` silently lost managed identity (#1466).
 */
export const TEAMS_APP_TYPES = ["MultiTenant", "SingleTenant", "UserAssignedMsi"] as const;
export type TeamsAppType = (typeof TEAMS_APP_TYPES)[number];

/** The spelling METIS stored before #1466. Rows still carrying it are mapped on read. */
const LEGACY_MSI_APP_TYPE = "userassignedmsid";

/**
 * The canonical {@link TeamsAppType} for a stored or submitted value, compared
 * case-insensitively as botbuilder does, with the pre-#1466 `UserAssignedMSID`
 * mapped to `UserAssignedMsi`. Null for anything else.
 */
export function normalizeTeamsAppType(raw: string): TeamsAppType | null {
  const lower = raw.trim().toLowerCase();
  if (lower === LEGACY_MSI_APP_TYPE) return "UserAssignedMsi";
  return TEAMS_APP_TYPES.find((t) => t.toLowerCase() === lower) ?? null;
}

export interface InstallInput {
  workspaceId: string;
  /** Azure AD application (client) id of the bot — the `MicrosoftAppId`. */
  appId: string;
  /**
   * PLAINTEXT Microsoft App Password — encrypted+vaulted, never stored raw.
   * Required for MultiTenant and SingleTenant; must be omitted for
   * UserAssignedMsi, which authenticates as the managed identity instead.
   */
  appPassword?: string | null;
  /** Required for SingleTenant and UserAssignedMsi bots; null/omitted for MultiTenant. */
  tenantId?: string | null;
  appType?: TeamsAppType;
  label?: string | null;
  createdById?: string | null;
}

/**
 * Public, secret-free view of an installation. The app password is NEVER
 * included — callers that need it must resolve via {@link resolveAppPassword}.
 */
export interface InstallationSummary {
  id: string;
  workspaceId: string;
  appId: string;
  tenantId: string | null;
  appType: string;
  status: string;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The credentials needed to build a CloudAdapter for a workspace. */
export interface ResolvedCredentials {
  appId: string;
  /** Empty for UserAssignedMsi, which takes no password. */
  appPassword: string;
  appType: string;
  tenantId: string | null;
}

export class TeamsInstallationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TeamsInstallationError";
  }
}

/** Deterministic vault label for a workspace's bot password. */
function vaultLabel(workspaceId: string, appId: string): string {
  return `teams-bot-password:${workspaceId}:${appId}`;
}

export class TeamsInstallationStore {
  private readonly db: PrismaClient;
  private readonly vault: VaultService;

  constructor(db: PrismaClient = defaultPrisma, vault: VaultService = getVaultService()) {
    this.db = db;
    this.vault = vault;
  }

  /**
   * Install (or re-install) the Teams app for a workspace. Encrypts the app
   * password into the vault and persists only the `${vault:ref}`. Re-installing
   * the same `(workspace, appId)` rotates the stored secret in place.
   */
  async install(input: InstallInput): Promise<InstallationSummary> {
    const { workspaceId, appId } = input;
    if (!workspaceId || workspaceId.trim().length === 0) {
      throw new TeamsInstallationError(400, "WORKSPACE_REQUIRED", "workspaceId is required");
    }
    if (!appId || appId.trim().length === 0) {
      throw new TeamsInstallationError(400, "APP_ID_REQUIRED", "appId is required");
    }
    const appType: TeamsAppType = input.appType ?? "MultiTenant";
    if ((appType === "SingleTenant" || appType === "UserAssignedMsi") && !input.tenantId) {
      throw new TeamsInstallationError(
        400,
        "TENANT_REQUIRED",
        `tenantId is required for a ${appType} bot`,
      );
    }
    const appPassword = input.appPassword?.trim() ? input.appPassword : null;
    const label = vaultLabel(workspaceId, appId);
    let appPasswordRef: string;

    if (appType === "UserAssignedMsi") {
      // A managed identity has no client secret, and botbuilder refuses an MSI
      // configuration that carries one — so there is nothing to vault.
      if (appPassword) {
        throw new TeamsInstallationError(
          400,
          "APP_PASSWORD_NOT_ALLOWED",
          "appPassword must not be set for a UserAssignedMsi bot",
        );
      }
      // Switching this app from a password to managed identity retires the
      // password vaulted for it earlier, rather than leaving it orphaned.
      const previous = await this.findSecretByLabel(label);
      if (previous) await this.vault.delete(previous.id);
      appPasswordRef = "";
    } else {
      if (!appPassword) {
        throw new TeamsInstallationError(400, "APP_PASSWORD_REQUIRED", "appPassword is required");
      }
      // 1. Encrypt + persist the plaintext password to the vault, then keep only a
      //    `${vault:label}` reference. The label is deterministic so a re-install
      //    rotates the same secret rather than leaking orphans.
      // #258 — one upsert on the name, which this (workspace, app) pair alone owns.
      // The earlier find-live-then-create missed the SOFT-DELETED secret an uninstall
      // leaves behind, so a reinstall re-created a taken name and 500'd; the
      // upsert revives that row with the new value instead.
      await this.vault.upsert(label, appPassword, "project", {
        description: `Microsoft Teams bot password (workspace ${workspaceId})`,
        createdById: input.createdById ?? null,
      });
      appPasswordRef = `\${vault:${label}}`;
    }

    // 2. Upsert the installation row (secret-free). One active app per workspace.
    const row = await this.db.teamsAppInstallation.upsert({
      where: { workspaceId_appId: { workspaceId, appId } },
      create: {
        workspaceId,
        appId,
        appPasswordRef,
        tenantId: input.tenantId ?? null,
        appType,
        status: "active",
        label: input.label ?? null,
        createdById: input.createdById ?? null,
      },
      update: {
        appPasswordRef,
        tenantId: input.tenantId ?? null,
        appType,
        status: "active",
        label: input.label ?? null,
      },
    });
    return this.toSummary(row);
  }

  /** Fetch the active installation for a workspace, or null. */
  async getByWorkspace(workspaceId: string): Promise<InstallationSummary | null> {
    const row = await this.db.teamsAppInstallation.findFirst({
      where: { workspaceId, status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    return row ? this.toSummary(row) : null;
  }

  /**
   * Resolve the decrypted credentials for a workspace's active installation.
   * Returns null when no active installation exists. The plaintext password is
   * only ever returned here — never logged, never in a summary.
   */
  async resolveAppPassword(workspaceId: string): Promise<ResolvedCredentials | null> {
    const row = await this.db.teamsAppInstallation.findFirst({
      where: { workspaceId, status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    if (!row) return null;

    const appType = normalizeTeamsAppType(row.appType);
    if (!appType) {
      // Handing botbuilder an unrecognised type would silently select MultiTenant
      // app-password auth — the failure #1466 fixed. Refuse instead.
      throw new TeamsInstallationError(
        500,
        "APP_TYPE_UNKNOWN",
        "stored Teams bot app type is not one botbuilder recognises",
      );
    }

    if (appType === "UserAssignedMsi") {
      if (!row.tenantId) {
        throw new TeamsInstallationError(
          500,
          "TENANT_REQUIRED",
          "a UserAssignedMsi Teams bot needs a tenant id; reinstall it with one",
        );
      }
      // No password: botbuilder authenticates as the managed identity and refuses
      // an MSI configuration that carries one. A row stored before #1466 may still
      // reference a vaulted password; it is deliberately not read.
      return { appId: row.appId, appPassword: "", appType, tenantId: row.tenantId };
    }

    const label = this.vaultRefLabel(row.appPasswordRef);
    const secret = await this.findSecretByLabel(label);
    if (!secret) {
      throw new TeamsInstallationError(
        500,
        "VAULT_REF_UNRESOLVED",
        "Teams bot password reference does not resolve to a stored secret",
      );
    }
    const { plaintext } = await this.vault.read(secret.id);
    return {
      appId: row.appId,
      appPassword: plaintext,
      appType,
      tenantId: row.tenantId,
    };
  }

  /**
   * Revoke (uninstall) the workspace's active installation. Marks the row
   * `revoked` and soft-deletes the vaulted secret. Returns true if something was
   * revoked. Idempotent.
   */
  async uninstall(workspaceId: string): Promise<boolean> {
    const row = await this.db.teamsAppInstallation.findFirst({
      where: { workspaceId, status: "active" },
    });
    if (!row) return false;

    // A managed-identity installation stores no password reference.
    if (row.appPasswordRef !== "") {
      const label = this.vaultRefLabel(row.appPasswordRef);
      const secret = await this.findSecretByLabel(label);
      if (secret) {
        await this.vault.delete(secret.id);
      }
    }
    await this.db.teamsAppInstallation.update({
      where: { id: row.id },
      data: { status: "revoked" },
    });
    return true;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Extract the bare label from a `${vault:label}` reference. */
  private vaultRefLabel(ref: string): string {
    const m = /^\$\{vault:(.+)\}$/.exec(ref);
    if (!m) {
      throw new TeamsInstallationError(
        500,
        "VAULT_REF_INVALID",
        "stored appPasswordRef is not a ${vault:label} reference",
      );
    }
    return m[1];
  }

  /**
   * Look up a vault secret by its (project-scoped) label. The vault stores names
   * as `${scope}:${label}`; project-scoped secrets are `project:<label>`.
   */
  private async findSecretByLabel(label: string): Promise<{ id: string } | null> {
    const row = await this.db.secret.findFirst({
      where: { name: `project:${label}`, deletedAt: null },
      select: { id: true },
    });
    return row;
  }

  private toSummary(row: {
    id: string;
    workspaceId: string;
    appId: string;
    tenantId: string | null;
    appType: string;
    status: string;
    label: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): InstallationSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      appId: row.appId,
      tenantId: row.tenantId,
      // Pre-#1466 rows carry `UserAssignedMSID`; show the spelling botbuilder uses.
      appType: normalizeTeamsAppType(row.appType) ?? row.appType,
      status: row.status,
      label: row.label,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

let singleton: TeamsInstallationStore | null = null;
export function getTeamsInstallationStore(): TeamsInstallationStore {
  if (!singleton) singleton = new TeamsInstallationStore();
  return singleton;
}

/** Test helper — reset the singleton so a test can inject its own deps. */
export function __resetTeamsInstallationStore(): void {
  singleton = null;
}
