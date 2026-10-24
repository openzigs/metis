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
import {
  isMsiClientIdAllowed,
  loadTeamsMsiAllowlist,
  normalizeClientId,
  type TeamsMsiAllowlist,
} from "./msi-allowlist.js";

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
 * Why an installation must be reinstalled before it is trusted (#1466). Every
 * reason except `legacy-app-type` also stops credential resolution.
 *   - `unknown-app-type`   — the stored type is not one botbuilder recognises.
 *   - `msi-not-allowed`    — a managed identity the operator has not listed in
 *                            `TEAMS_MSI_CLIENT_IDS` (or no longer lists).
 *   - `msi-in-use`         — the managed identity is active in another workspace.
 *   - `msi-missing-tenant` — a managed identity stored without a tenant id.
 *   - `legacy-app-type`    — stored as `UserAssignedMSID`, which botbuilder never
 *                            recognised: the bot actually ran as MultiTenant with
 *                            the password saved alongside it.
 */
export type TeamsReinstallReason =
  "unknown-app-type" | "msi-not-allowed" | "msi-in-use" | "msi-missing-tenant" | "legacy-app-type";

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
  /** True when the admin must reinstall the bot; {@link reinstallReason} says why. */
  needsReinstall: boolean;
  reinstallReason: TeamsReinstallReason | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The fields of an installation row the store reads. */
interface InstallRowLike {
  id: string;
  workspaceId: string;
  appId: string;
  appPasswordRef: string;
  tenantId: string | null;
  appType: string;
  status: string;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Resolution refusal for each blocking {@link TeamsReinstallReason}. */
const REINSTALL_REFUSAL: Record<
  Exclude<TeamsReinstallReason, "legacy-app-type">,
  { statusCode: number; code: string; message: string }
> = {
  "unknown-app-type": {
    statusCode: 500,
    code: "APP_TYPE_UNKNOWN",
    message: "stored Teams bot app type is not one botbuilder recognises",
  },
  "msi-not-allowed": {
    statusCode: 403,
    code: "MSI_CLIENT_ID_NOT_ALLOWED",
    message:
      "this managed identity is not allowed for Teams bots: the operator must add its client id to TEAMS_MSI_CLIENT_IDS",
  },
  "msi-in-use": {
    statusCode: 409,
    code: "MSI_CLIENT_ID_IN_USE",
    message: "this managed identity is already connected to another workspace",
  },
  "msi-missing-tenant": {
    statusCode: 500,
    code: "TENANT_REQUIRED",
    message: "a UserAssignedMsi Teams bot needs a tenant id; reinstall it with one",
  },
};

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
  private readonly msiAllowlist: () => TeamsMsiAllowlist;

  /**
   * @param msiAllowlist read on every install and resolution, so an id the
   *   operator removes stops working without a data change.
   */
  constructor(
    db: PrismaClient = defaultPrisma,
    vault: VaultService = getVaultService(),
    msiAllowlist: () => TeamsMsiAllowlist = () => loadTeamsMsiAllowlist(),
  ) {
    this.db = db;
    this.vault = vault;
    this.msiAllowlist = msiAllowlist;
  }

  /**
   * Install (or re-install) the Teams app for a workspace. Encrypts the app
   * password into the vault and persists only the `${vault:ref}`. Re-installing
   * the same `(workspace, appId)` rotates the stored secret in place.
   *
   * A workspace has one active app: installing revokes the workspace's other
   * active installations and retires their vaulted passwords, so switching to a
   * different app (for example from a password app to a managed identity, whose
   * client id always differs) leaves nothing active or vaulted behind (#1466).
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
      // Naming a client id proves nothing about owning it, so only identities the
      // operator listed may be used, and only by one workspace at a time.
      this.refuse(await this.msiReason(workspaceId, appId, input.tenantId ?? null));
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

    // 3. Only after the new row is in place: retire what it replaces, so a failed
    //    upsert never leaves an active row pointing at a deleted secret.
    if (appPasswordRef === "") {
      // Re-installing this same app as a managed identity: its old password, if
      // one was vaulted, is no longer used by anything.
      const previous = await this.findSecretByLabel(label);
      if (previous) await this.vault.delete(previous.id);
    }
    const others = await this.db.teamsAppInstallation.findMany({
      where: { workspaceId, status: "active", id: { not: row.id } },
    });
    for (const other of others) await this.revoke(other);

    return this.toSummary(row, await this.reinstallReason(row));
  }

  /** Fetch the active installation for a workspace, or null. */
  async getByWorkspace(workspaceId: string): Promise<InstallationSummary | null> {
    const row = await this.db.teamsAppInstallation.findFirst({
      where: { workspaceId, status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    return row ? this.toSummary(row, await this.reinstallReason(row)) : null;
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

    // Handing botbuilder an unrecognised type would silently select MultiTenant
    // app-password auth — the failure #1466 fixed. A managed identity is checked
    // against the operator's allowlist HERE too, not only at install, so a row
    // written before the allowlist existed, or whose id was since removed from
    // it, stops authenticating.
    this.refuse(await this.reinstallReason(row));
    const appType = normalizeTeamsAppType(row.appType) as TeamsAppType;

    if (appType === "UserAssignedMsi") {
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
    await this.revoke(row);
    return true;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Mark an installation revoked and soft-delete its vaulted password, if any. */
  private async revoke(row: InstallRowLike): Promise<void> {
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
  }

  /** Why a stored installation must be reinstalled, or null when it is sound. */
  private async reinstallReason(row: InstallRowLike): Promise<TeamsReinstallReason | null> {
    const appType = normalizeTeamsAppType(row.appType);
    if (!appType) return "unknown-app-type";
    if (appType === "UserAssignedMsi") {
      const blocking = await this.msiReason(row.workspaceId, row.appId, row.tenantId);
      if (blocking) return blocking;
    }
    return row.appType.trim().toLowerCase() === LEGACY_MSI_APP_TYPE ? "legacy-app-type" : null;
  }

  /** The blocking reason a managed identity may not be used by `workspaceId`, if any. */
  private async msiReason(
    workspaceId: string,
    clientId: string,
    tenantId: string | null,
  ): Promise<Exclude<TeamsReinstallReason, "legacy-app-type" | "unknown-app-type"> | null> {
    if (!isMsiClientIdAllowed(this.msiAllowlist(), clientId)) return "msi-not-allowed";
    const elsewhere = await this.db.teamsAppInstallation.findMany({
      where: { status: "active", workspaceId: { not: workspaceId } },
      select: { appId: true },
    });
    const id = normalizeClientId(clientId);
    if (elsewhere.some((r) => normalizeClientId(r.appId) === id)) return "msi-in-use";
    if (!tenantId) return "msi-missing-tenant";
    return null;
  }

  /** Throw the named refusal for a blocking reason; return for none or `legacy-app-type`. */
  private refuse(reason: TeamsReinstallReason | null): void {
    if (!reason || reason === "legacy-app-type") return;
    const { statusCode, code, message } = REINSTALL_REFUSAL[reason];
    throw new TeamsInstallationError(statusCode, code, message);
  }

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

  private toSummary(
    row: InstallRowLike,
    reinstallReason: TeamsReinstallReason | null,
  ): InstallationSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      appId: row.appId,
      tenantId: row.tenantId,
      // Pre-#1466 rows carry `UserAssignedMSID`; show the spelling botbuilder uses.
      appType: normalizeTeamsAppType(row.appType) ?? row.appType,
      status: row.status,
      label: row.label,
      needsReinstall: reinstallReason !== null,
      reinstallReason,
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
