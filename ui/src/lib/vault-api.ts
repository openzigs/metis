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
  rotate: (id: string, value: string) =>
    apiFetch<VaultEntry>(`/vault/${id}/rotate`, { method: "POST", body: { value } }),
  reveal: (id: string) =>
    apiFetch<{ summary: VaultEntry; plaintext: string }>(`/vault/${id}/reveal`),
  remove: (id: string) => apiFetch<void>(`/vault/${id}`, { method: "DELETE" }),
  audit: (id: string, limit = 50) =>
    apiFetch<{ items: VaultAuditEntry[] }>(`/vault/${id}/audit?limit=${limit}`),
};
