/**
 * Typed wrappers for the v1.1.0 enterprise integrations REST surface
 * (Epic #163: Confluence/Jira ingest, ACP tokens, GitHub Projects v2).
 */
import { apiFetch } from "@/lib/api-client";

type Id = string;

// ── Atlassian ──────────────────────────────────────────────────────────────
export interface AtlassianStatus {
  configured: boolean;
  serverId: string | null;
}

export interface AtlassianIngestSummary {
  ingested: number;
  skipped: number;
  failed: number;
  documentIds: string[];
}

export const atlassianApi = {
  status: (projectId: Id) =>
    apiFetch<AtlassianStatus>(`/projects/${projectId}/connectors/atlassian/status`),
  ingestConfluence: (projectId: Id, body: { spaceKey: string; query?: string }) =>
    apiFetch<AtlassianIngestSummary>(`/projects/${projectId}/connectors/confluence/ingest`, {
      method: "POST",
      body,
    }),
  ingestJira: (projectId: Id, body: { jql: string }) =>
    apiFetch<AtlassianIngestSummary>(`/projects/${projectId}/connectors/jira/ingest`, {
      method: "POST",
      body,
    }),
};

// ── ACP tokens ────────────────────────────────────────────────────────────
export interface ApiTokenView {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}
export interface CreatedApiToken extends ApiTokenView {
  /** Plaintext token. Returned ONCE on creation. */
  token: string;
}

export const acpApi = {
  listTokens: () => apiFetch<ApiTokenView[]>(`/acp/tokens`),
  createToken: (body: { name: string; scopes?: string[]; expiresAt?: string | null }) =>
    apiFetch<CreatedApiToken>(`/acp/tokens`, { method: "POST", body }),
  revokeToken: (id: Id) => apiFetch<ApiTokenView>(`/acp/tokens/${id}`, { method: "DELETE" }),
};

// ── GitHub Projects v2 settings ────────────────────────────────────────────
export interface ProjectsV2Board {
  id: string;
  number: number;
  title: string;
  url: string;
}

export interface ProjectV2FieldMapping {
  fieldId: string;
  type: "text" | "number" | "date" | "single_select";
  value: string | number;
}

export interface ProjectsV2Settings {
  githubProjectId: string | null;
  fieldMappings: Record<string, ProjectV2FieldMapping>;
}

export const projectsV2Api = {
  getSettings: (projectId: Id) =>
    apiFetch<ProjectsV2Settings>(`/projects/${projectId}/github/projects-v2-settings`),
  updateSettings: (
    projectId: Id,
    body: {
      githubProjectId: string | null;
      fieldMappings: Record<string, ProjectV2FieldMapping> | null;
    },
  ) =>
    apiFetch<ProjectsV2Settings>(`/projects/${projectId}/github/projects-v2-settings`, {
      method: "PUT",
      body,
    }),
  listBoards: (
    projectId: Id,
    body: {
      secretRef: string;
      targetOwner: string;
      targetRepo?: string;
      targetBaseUrl?: string | null;
    },
  ) =>
    apiFetch<ProjectsV2Board[]>(`/projects/${projectId}/github/projects-v2-boards`, {
      method: "POST",
      body,
    }),
};
