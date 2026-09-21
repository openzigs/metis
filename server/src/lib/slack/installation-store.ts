/**
 * Issue #579 (epic #63) — per-(workspace, Slack team) Slack app installation
 * store.
 *
 * Models the Slack OAuth install step that grants METIS a per-workspace bot
 * token (`xoxb-...`). The bot token is the sensitive material; it is NEVER
 * persisted on the installation row — this mirrors the #548 Teams
 * `installation-store.ts` exactly.
 *
 * SECRET HANDLING (OWASP A02 — cryptographic storage):
 *   1. On install, the plaintext bot token is written to the hardened secret
 *      vault (`server/src/lib/vault/vault-service.ts`, AES-256-GCM with a
 *      versioned envelope) under a deterministic label.
 *   2. Only the `${vault:label}` REFERENCE is stored in
 *      `SlackAppInstallation.botTokenRef`.
 *   3. When a WebClient is needed the reference is resolved back to plaintext via
 *      the vault — plaintext never touches the installation table, logs, or API
 *      responses. The token is also redacted from every returned summary.
 *
 * Tenant scoping: every read/write is keyed by `workspaceId`, so one workspace's
 * Slack credentials are never visible to another. The `(workspaceId, slackTeamId)`
 * unique key lets a workspace connect a Slack team and re-install (rotate) it.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { getVaultService, type VaultService } from "../vault/vault-service.js";

export interface SlackInstallInput {
  workspaceId: string;
  /** Slack team (workspace) id from the OAuth `team.id`. */
  slackTeamId: string;
  /** PLAINTEXT Slack bot token (`xoxb-...`) — encrypted+vaulted, never stored raw. */
  botToken: string;
  slackTeamName?: string | null;
  botUserId?: string | null;
  label?: string | null;
  createdById?: string | null;
}

/**
 * Public, secret-free view of an installation. The bot token is NEVER included —
 * callers that need it must resolve via {@link SlackInstallationStore.resolveBotToken}.
 */
export interface SlackInstallationSummary {
  id: string;
  workspaceId: string;
  slackTeamId: string;
  slackTeamName: string | null;
  botUserId: string | null;
  status: string;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The credentials needed to build a Slack WebClient for a workspace. */
export interface ResolvedSlackCredentials {
  slackTeamId: string;
  botToken: string;
  botUserId: string | null;
}

export class SlackInstallationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SlackInstallationError";
  }
}

/** Deterministic vault label for a workspace's Slack bot token. */
function vaultLabel(workspaceId: string, slackTeamId: string): string {
  return `slack-bot-token:${workspaceId}:${slackTeamId}`;
}

export class SlackInstallationStore {
  private readonly db: PrismaClient;
  private readonly vault: VaultService;

  constructor(db: PrismaClient = defaultPrisma, vault: VaultService = getVaultService()) {
    this.db = db;
    this.vault = vault;
  }

  /**
   * Install (or re-install) the Slack app for a workspace. Encrypts the bot token
   * into the vault and persists only the `${vault:ref}`. Re-installing the same
   * `(workspace, slackTeam)` rotates the stored secret in place.
   */
  async install(input: SlackInstallInput): Promise<SlackInstallationSummary> {
    const { workspaceId, slackTeamId } = input;
    if (!workspaceId || workspaceId.trim().length === 0) {
      throw new SlackInstallationError(400, "WORKSPACE_REQUIRED", "workspaceId is required");
    }
    if (!slackTeamId || slackTeamId.trim().length === 0) {
      throw new SlackInstallationError(400, "TEAM_REQUIRED", "slackTeamId is required");
    }
    if (!input.botToken || input.botToken.trim().length === 0) {
      throw new SlackInstallationError(400, "BOT_TOKEN_REQUIRED", "botToken is required");
    }

    // 1. Encrypt + persist the plaintext token to the vault, keeping only a
    //    `${vault:label}` reference. The label is deterministic so a re-install
    //    rotates the same secret rather than leaking orphans.
    const label = vaultLabel(workspaceId, slackTeamId);
    const existingSecret = await this.findSecretByLabel(label);
    if (existingSecret) {
      await this.vault.rotate(existingSecret.id, input.botToken);
    } else {
      await this.vault.create(label, input.botToken, "project", {
        description: `Slack bot token (workspace ${workspaceId})`,
        createdById: input.createdById ?? null,
      });
    }
    const botTokenRef = `\${vault:${label}}`;

    // 2. Upsert the installation row (secret-free). One active install per
    //    (workspace, Slack team).
    const row = await this.db.slackAppInstallation.upsert({
      where: { workspaceId_slackTeamId: { workspaceId, slackTeamId } },
      create: {
        workspaceId,
        slackTeamId,
        slackTeamName: input.slackTeamName ?? null,
        botUserId: input.botUserId ?? null,
        botTokenRef,
        status: "active",
        label: input.label ?? null,
        createdById: input.createdById ?? null,
      },
      update: {
        slackTeamName: input.slackTeamName ?? null,
        botUserId: input.botUserId ?? null,
        botTokenRef,
        status: "active",
        label: input.label ?? null,
      },
    });
    return this.toSummary(row);
  }

  /** Fetch the active installation for a workspace, or null. */
  async getByWorkspace(workspaceId: string): Promise<SlackInstallationSummary | null> {
    const row = await this.db.slackAppInstallation.findFirst({
      where: { workspaceId, status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    return row ? this.toSummary(row) : null;
  }

  /** Fetch the active installation for a Slack team id, or null. */
  async getBySlackTeam(slackTeamId: string): Promise<SlackInstallationSummary | null> {
    const row = await this.db.slackAppInstallation.findFirst({
      where: { slackTeamId, status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    return row ? this.toSummary(row) : null;
  }

  /**
   * Resolve the decrypted bot-token credentials for a workspace's active
   * installation. Returns null when no active installation exists. The plaintext
   * token is only ever returned here — never logged, never in a summary.
   */
  async resolveBotToken(workspaceId: string): Promise<ResolvedSlackCredentials | null> {
    const row = await this.db.slackAppInstallation.findFirst({
      where: { workspaceId, status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    if (!row) return null;

    const label = this.vaultRefLabel(row.botTokenRef);
    const secret = await this.findSecretByLabel(label);
    if (!secret) {
      throw new SlackInstallationError(
        500,
        "VAULT_REF_UNRESOLVED",
        "Slack bot token reference does not resolve to a stored secret",
      );
    }
    const { plaintext } = await this.vault.read(secret.id);
    return {
      slackTeamId: row.slackTeamId,
      botToken: plaintext,
      botUserId: row.botUserId,
    };
  }

  /**
   * Revoke (uninstall) the workspace's active installation. Marks the row
   * `revoked` and soft-deletes the vaulted secret. Returns true if something was
   * revoked. Idempotent.
   */
  async uninstall(workspaceId: string): Promise<boolean> {
    const row = await this.db.slackAppInstallation.findFirst({
      where: { workspaceId, status: "active" },
    });
    if (!row) return false;

    const label = this.vaultRefLabel(row.botTokenRef);
    const secret = await this.findSecretByLabel(label);
    if (secret) {
      await this.vault.delete(secret.id);
    }
    await this.db.slackAppInstallation.update({
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
      throw new SlackInstallationError(
        500,
        "VAULT_REF_INVALID",
        "stored botTokenRef is not a ${vault:label} reference",
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
    slackTeamId: string;
    slackTeamName: string | null;
    botUserId: string | null;
    status: string;
    label: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): SlackInstallationSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      slackTeamId: row.slackTeamId,
      slackTeamName: row.slackTeamName,
      botUserId: row.botUserId,
      status: row.status,
      label: row.label,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

let singleton: SlackInstallationStore | null = null;
export function getSlackInstallationStore(): SlackInstallationStore {
  if (!singleton) singleton = new SlackInstallationStore();
  return singleton;
}

/** Test helper — reset the singleton so a test can inject its own deps. */
export function __resetSlackInstallationStore(): void {
  singleton = null;
}
