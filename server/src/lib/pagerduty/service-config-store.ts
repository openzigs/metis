/**
 * Issue #580 (epic #63) — per-workspace PagerDuty service-config store.
 *
 * Persists, per `(workspaceId, serviceKey)`, the PagerDuty routing key used to
 * fire sev-1 incidents. The routing key is the sensitive material and is NEVER
 * stored on the config row.
 *
 * SECRET HANDLING (OWASP A02 — cryptographic storage), mirroring the #548
 * {@link TeamsInstallationStore} pattern:
 *   1. On register, the plaintext routing key is written to the hardened secret
 *      vault (`server/src/lib/vault/vault-service.ts`, AES-256-GCM) under a
 *      deterministic label.
 *   2. Only the `${vault:label}` REFERENCE is stored in
 *      `PagerDutyServiceConfig.routingKeyRef`.
 *   3. At trigger time the reference is resolved back to plaintext via the vault —
 *      plaintext never touches the config table, logs, or API responses.
 *
 * Tenant scoping: every read/write is keyed by `workspaceId`, so one workspace's
 * routing key is never visible to — nor fired by — another workspace.
 *
 * This store does NOT authorize — the route layer enforces workspace-admin access
 * before invoking it (mirroring the #67 notification-target surface).
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { getVaultService, type VaultService } from "../vault/vault-service.js";

/** Default logical service when a caller does not split event classes. */
export const DEFAULT_SERVICE_KEY = "default";

export interface RegisterInput {
  workspaceId: string;
  /** Free-form logical service name. Defaults to "default". */
  serviceKey?: string;
  /** PLAINTEXT PagerDuty routing key — encrypted+vaulted, never stored raw. */
  routingKey: string;
  label?: string | null;
  createdById?: string | null;
}

/** Secret-free view of a config. The routing key is NEVER included. */
export interface ServiceConfigSummary {
  id: string;
  workspaceId: string;
  serviceKey: string;
  label: string | null;
  status: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class PagerDutyServiceConfigError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PagerDutyServiceConfigError";
  }
}

/** Deterministic vault label for a workspace+service routing key. */
function vaultLabel(workspaceId: string, serviceKey: string): string {
  return `pagerduty-routing-key:${workspaceId}:${serviceKey}`;
}

export class PagerDutyServiceConfigStore {
  private readonly db: PrismaClient;
  private readonly vault: VaultService;

  constructor(db: PrismaClient = defaultPrisma, vault: VaultService = getVaultService()) {
    this.db = db;
    this.vault = vault;
  }

  /**
   * Register (or re-point) the routing key for a `(workspace, service)`. Encrypts
   * the plaintext into the vault and persists only the `${vault:ref}`. Re-register
   * rotates the same secret in place (no orphans, idempotent on the key pair).
   */
  async register(input: RegisterInput): Promise<ServiceConfigSummary> {
    const workspaceId = input.workspaceId?.trim();
    const serviceKey = (input.serviceKey ?? DEFAULT_SERVICE_KEY).trim();
    if (!workspaceId) {
      throw new PagerDutyServiceConfigError(400, "WORKSPACE_REQUIRED", "workspaceId is required");
    }
    if (!serviceKey) {
      throw new PagerDutyServiceConfigError(400, "SERVICE_KEY_REQUIRED", "serviceKey is required");
    }
    if (!input.routingKey || input.routingKey.trim().length === 0) {
      throw new PagerDutyServiceConfigError(400, "ROUTING_KEY_REQUIRED", "routingKey is required");
    }

    // 1. Encrypt + persist the plaintext routing key; keep only a ${vault:label}.
    const label = vaultLabel(workspaceId, serviceKey);
    const existingSecret = await this.findSecretByLabel(label);
    if (existingSecret) {
      await this.vault.rotate(existingSecret.id, input.routingKey);
    } else {
      await this.vault.create(label, input.routingKey, "project", {
        description: `PagerDuty routing key (workspace ${workspaceId}, service ${serviceKey})`,
        createdById: input.createdById ?? null,
      });
    }
    const routingKeyRef = `\${vault:${label}}`;

    // 2. Upsert the secret-free config row.
    const row = await this.db.pagerDutyServiceConfig.upsert({
      where: { workspaceId_serviceKey: { workspaceId, serviceKey } },
      create: {
        workspaceId,
        serviceKey,
        routingKeyRef,
        label: input.label ?? null,
        status: "active",
        createdById: input.createdById ?? null,
      },
      update: {
        routingKeyRef,
        label: input.label ?? null,
        status: "active",
      },
    });
    return this.toSummary(row);
  }

  /** List every config in a workspace (secret-free, most-recent first). */
  async listByWorkspace(workspaceId: string): Promise<ServiceConfigSummary[]> {
    const rows = await this.db.pagerDutyServiceConfig.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toSummary(r));
  }

  /**
   * Resolve the decrypted routing key for `(workspaceId, serviceKey)`, or null
   * when no ACTIVE config exists. Plaintext is only ever returned here — never
   * logged, never in a summary. An `inactive` config returns null (delivery off).
   */
  async resolveRoutingKey(
    workspaceId: string,
    serviceKey: string = DEFAULT_SERVICE_KEY,
  ): Promise<string | null> {
    const row = await this.db.pagerDutyServiceConfig.findUnique({
      where: { workspaceId_serviceKey: { workspaceId, serviceKey } },
    });
    if (!row || row.status !== "active") return null;

    const label = this.vaultRefLabel(row.routingKeyRef);
    const secret = await this.findSecretByLabel(label);
    if (!secret) return null;
    const { plaintext } = await this.vault.read(secret.id);
    return plaintext;
  }

  /**
   * Delete the config for `(workspaceId, serviceKey)` and soft-delete its vaulted
   * routing key. Scoped by workspace so a caller can never remove another
   * workspace's config. Returns true if a row was removed (idempotent).
   */
  async delete(workspaceId: string, serviceKey: string): Promise<boolean> {
    const row = await this.db.pagerDutyServiceConfig.findUnique({
      where: { workspaceId_serviceKey: { workspaceId, serviceKey } },
    });
    if (!row) return false;

    const label = this.vaultRefLabel(row.routingKeyRef);
    const secret = await this.findSecretByLabel(label);
    if (secret) {
      await this.vault.delete(secret.id);
    }
    const res = await this.db.pagerDutyServiceConfig.deleteMany({
      where: { workspaceId, serviceKey },
    });
    return res.count > 0;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private vaultRefLabel(ref: string): string {
    const m = /^\$\{vault:(.+)\}$/.exec(ref);
    if (!m) {
      throw new PagerDutyServiceConfigError(
        500,
        "VAULT_REF_INVALID",
        "stored routingKeyRef is not a ${vault:label} reference",
      );
    }
    return m[1];
  }

  private async findSecretByLabel(label: string): Promise<{ id: string } | null> {
    return this.db.secret.findFirst({
      where: { name: `project:${label}`, deletedAt: null },
      select: { id: true },
    });
  }

  private toSummary(row: {
    id: string;
    workspaceId: string;
    serviceKey: string;
    label: string | null;
    status: string;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ServiceConfigSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      serviceKey: row.serviceKey,
      label: row.label,
      status: row.status,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

let singleton: PagerDutyServiceConfigStore | null = null;
export function getPagerDutyServiceConfigStore(): PagerDutyServiceConfigStore {
  if (!singleton) singleton = new PagerDutyServiceConfigStore();
  return singleton;
}

/** Test helper — reset the singleton so a test can inject its own deps. */
export function __resetPagerDutyServiceConfigStore(): void {
  singleton = null;
}
