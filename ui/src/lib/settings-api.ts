/**
 * Phase 12 — Settings API client.
 *
 * Wraps the redacted env-vars endpoint. Provider preferences are stored
 * client-side in localStorage; see `provider-prefs` below.
 *
 * Epic #249 (Phase 2) — `configApi` now talks to the unified
 * `/api/admin/config` surface (#257). The Phase 1 `/admin/config/secrets/:key`
 * paths are gone; secrets and tunables share the same PUT/DELETE shape.
 */
import { apiFetch } from "@/lib/api-client";

export interface EnvVarRow {
  key: string;
  value: string;
  classification: "public" | "secret";
  set: boolean;
}

export const settingsApi = {
  envVars: () => apiFetch<{ items: EnvVarRow[] }>("/settings/env"),
};

export interface ConfigAuditRow {
  id: string;
  key: string;
  oldValueRedacted: string;
  newValueRedacted: string;
  actorId: string;
  scope: string;
  ts: string;
}

export interface ConfigKeyView {
  key: string;
  tier: "bootstrap" | "secret" | "tunable";
  valueType: "string" | "int" | "bool" | "json" | "csv";
  description: string;
  sensitive: boolean;
  source: "vault" | "db" | "env" | "unset";
  value: string | null;
}

export const configApi = {
  list: () => apiFetch<{ items: ConfigKeyView[] }>("/admin/config"),
  get: (key: string) => apiFetch<ConfigKeyView>(`/admin/config/${encodeURIComponent(key)}`),
  set: (key: string, value: unknown) =>
    apiFetch<ConfigKeyView>(`/admin/config/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value },
    }),
  clear: (key: string) =>
    apiFetch<ConfigKeyView>(`/admin/config/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  // Phase 1 alias kept so existing call sites continue to compile until the
  // SecretRow refactor (#259) lands. Both methods now call the unified route.
  setSecret: (key: string, value: string) =>
    apiFetch<ConfigKeyView>(`/admin/config/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value },
    }),
  clearSecret: (key: string) =>
    apiFetch<ConfigKeyView>(`/admin/config/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  audit: (params: { limit?: number; cursor?: string } = {}) =>
    apiFetch<{ items: ConfigAuditRow[]; nextCursor: string | null }>("/admin/config/audit", {
      params: {
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      },
    }),
};

// ---------------------------------------------------------------------------
// Client-side provider preferences (per-user, per-browser).
//
// Phase 12 AC #87 calls for "Provider config changes take effect after
// explicit save" — the *credentials* themselves live in the encrypted vault
// (Phase 1) and are managed via existing flows. What changes here is the
// user's preferred default model + provider for new chat sessions, persisted
// to localStorage so the choice survives reloads but never leaks across
// browsers or users.
// ---------------------------------------------------------------------------

export interface ProviderPrefs {
  defaultProvider: string;
  defaultModel: string;
  reasoningEffort: "minimal" | "medium" | "high";
}

const STORAGE_KEY = "metis.settings.providerPrefs";

const DEFAULT_PREFS: ProviderPrefs = {
  defaultProvider: "anthropic",
  defaultModel: "claude-sonnet-4.5",
  reasoningEffort: "medium",
};

export function loadProviderPrefs(): ProviderPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_PREFS };
    const obj = parsed as Partial<ProviderPrefs>;
    return {
      defaultProvider:
        typeof obj.defaultProvider === "string" && obj.defaultProvider.trim().length > 0
          ? obj.defaultProvider
          : DEFAULT_PREFS.defaultProvider,
      defaultModel:
        typeof obj.defaultModel === "string" && obj.defaultModel.trim().length > 0
          ? obj.defaultModel
          : DEFAULT_PREFS.defaultModel,
      reasoningEffort:
        obj.reasoningEffort === "minimal" ||
        obj.reasoningEffort === "medium" ||
        obj.reasoningEffort === "high"
          ? obj.reasoningEffort
          : DEFAULT_PREFS.reasoningEffort,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveProviderPrefs(prefs: ProviderPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* swallow — Safari private mode etc. */
  }
}

export function resetProviderPrefs(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow */
  }
}

export const _DEFAULT_PROVIDER_PREFS: ProviderPrefs = DEFAULT_PREFS;
