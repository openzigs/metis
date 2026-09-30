/**
 * Epic #196 / #222 — Vault API client.
 *
 * Wraps the `/api/vault` admin routes added in this epic. All payloads
 * are JSON; no plaintext is returned by `list`/`create`/`rotate`. The
 * dedicated `reveal` endpoint returns plaintext exactly once.
 */
import { apiFetch } from "./api-client";

export interface VaultEntry {
  id: string;
  label: string;
  scope: "global" | "project";
  description: string;
  algorithm: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface VaultAuditEntry {
  id: string;
  action: string;
  actorId: string | null;
  createdAt: string;
  metadata: unknown;
}

/**
 * #482 — the `details` of a 409 `VAULT_ROTATE_FOREIGN_OWNER`: who owns the
 * secret and where it is bound. Mirrors `server/src/lib/vault/rotate-foreign-owner.ts`.
 */
export const VAULT_ROTATE_FOREIGN_OWNER = "VAULT_ROTATE_FOREIGN_OWNER";

export interface VaultForeignOwner {
  secretId: string;
  owner: { id: string; username: string | null; displayName: string | null };
  bindings: Array<{
    type: string;
    id: string;
    label: string;
    projectId: string | null;
    destination: string | null;
  }>;
}

export interface CreateVaultEntryInput {
  label: string;
  value: string;
  scope?: "global" | "project";
  description?: string;
}

export const vaultApi = {
  list: (scope?: "global" | "project") =>
    apiFetch<{ items: VaultEntry[] }>(`/vault${scope ? `?scope=${scope}` : ""}`),
  create: (body: CreateVaultEntryInput) => apiFetch<VaultEntry>(`/vault`, { method: "POST", body }),
  /** #482 — `confirmForeignOwner` is required to rotate a secret another user owns. */
  rotate: (id: string, value: string, opts: { confirmForeignOwner?: boolean } = {}) =>
    apiFetch<VaultEntry>(`/vault/${id}/rotate`, {
      method: "POST",
      body: opts.confirmForeignOwner ? { value, confirmForeignOwner: true } : { value },
    }),
  reveal: (id: string) =>
    apiFetch<{ summary: VaultEntry; plaintext: string }>(`/vault/${id}/reveal`),
  remove: (id: string) => apiFetch<void>(`/vault/${id}`, { method: "DELETE" }),
  audit: (id: string, limit = 50) =>
    apiFetch<{ items: VaultAuditEntry[] }>(`/vault/${id}/audit?limit=${limit}`),
};
