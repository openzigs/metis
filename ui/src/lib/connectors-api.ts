/**
 * Typed wrappers around the Phase 8 connector REST endpoints.
 *
 * `apiFetch` lives in `@/lib/api-client`; we use the shared types from
 * `@metis/shared` where possible so the UI stays in lockstep with the server.
 */
import { apiFetch, ApiError } from "@/lib/api-client";
import { API_BASE } from "@/lib/config";
import type {
  RepoConnector,
  DatabaseConnector,
  CreateRepoConnectorInput,
  UpdateRepoConnectorInput,
  CreateDatabaseConnectorInput,
  UpdateDatabaseConnectorInput,
  DbSchemaSnapshot,
  DbQueryResult,
} from "@metis/shared";

export interface ConnectorTestResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
}
export interface RepoMetadataSnapshot {
  repo: { full_name: string; default_branch: string; language?: string | null };
  readme: string | null;
  topFiles: { path: string; type: string }[];
  latestCommit: { sha: string } | null;
}
export interface ConnectorIngestSummary {
  documentId: string;
  chunks: number;
  units: number;
}
export interface DeepIngestSummary {
  codeGraph: {
    filesScanned: number;
    filesParsed: number;
    symbolsUpserted: number;
    edgesUpserted: number;
  };
  sourceKnowledge: { documentsCreated: number; chunkCount: number };
  cloneSizeBytes: number;
}
export interface RefreshIngestSummary {
  pulled: boolean;
  filesChanged: number;
  codeGraph: {
    filesScanned: number;
    filesParsed: number;
    filesSkipped: number;
    symbolsUpserted: number;
    edgesUpserted: number;
    durationMs: number;
  };
  sourceKnowledge: { documentsCreated: number; documentsUpdated: number; chunkCount: number };
  cloneSizeBytes: number;
}

type Id = string;

const repoBase = (projectId: Id, id?: Id) =>
  `/projects/${projectId}/connectors/repos${id ? `/${id}` : ""}`;
const dbBase = (projectId: Id, id?: Id) =>
  `/projects/${projectId}/connectors/dbs${id ? `/${id}` : ""}`;

export const repoConnectorsApi = {
  list: (projectId: Id) => apiFetch<RepoConnector[]>(repoBase(projectId)),
  get: (projectId: Id, id: Id) => apiFetch<RepoConnector>(repoBase(projectId, id)),
  create: (projectId: Id, body: CreateRepoConnectorInput) =>
    apiFetch<RepoConnector>(repoBase(projectId), { method: "POST", body }),
  // Issue #288 — local server-path connector (admin-only on the server).
  createLocal: (projectId: Id, body: { label: string; localPath: string }) =>
    apiFetch<RepoConnector>(`${repoBase(projectId)}/local`, { method: "POST", body }),
  // Issue #288 — folder upload (.zip). Multipart, so bypass apiFetch's JSON path.
  createUpload: async (projectId: Id, label: string, file: File): Promise<RepoConnector> => {
    const fd = new FormData();
    fd.append("label", label);
    fd.append("file", file);
    const res = await fetch(`${API_BASE}${repoBase(projectId)}/upload`, {
      method: "POST",
      credentials: "same-origin",
      body: fd,
    });
    const text = await res.text();
    let payload:
      | { success?: boolean; data?: unknown; error?: { code?: string; message?: string } }
      | undefined;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON */
    }
    if (!res.ok || (payload && payload.success === false)) {
      throw new ApiError(
        res.status,
        payload?.error?.message ?? res.statusText ?? "Upload failed",
        payload?.error?.code,
      );
    }
    return payload?.data as RepoConnector;
  },
  update: (projectId: Id, id: Id, body: Omit<UpdateRepoConnectorInput, "id">) =>
    apiFetch<RepoConnector>(repoBase(projectId, id), { method: "PATCH", body }),
  remove: (projectId: Id, id: Id) => apiFetch<void>(repoBase(projectId, id), { method: "DELETE" }),
  test: (projectId: Id, id: Id) =>
    apiFetch<ConnectorTestResult>(`${repoBase(projectId, id)}/test`, { method: "POST" }),
  metadata: (projectId: Id, id: Id) =>
    apiFetch<RepoMetadataSnapshot>(`${repoBase(projectId, id)}/metadata`, {
      method: "POST",
    }),
  ingest: (projectId: Id, id: Id) =>
    apiFetch<ConnectorIngestSummary>(`${repoBase(projectId, id)}/ingest`, {
      method: "POST",
    }),
  deepIngest: (projectId: Id, id: Id) =>
    apiFetch<DeepIngestSummary>(`${repoBase(projectId, id)}/deep-ingest`, {
      method: "POST",
    }),
  refreshIngest: (projectId: Id, id: Id) =>
    apiFetch<RefreshIngestSummary>(`${repoBase(projectId, id)}/refresh-ingest`, {
      method: "POST",
    }),
  rescanCredentials: (projectId: Id, id: Id) =>
    apiFetch<{
      filesScanned: number;
      connectionsFound: number;
      suggestionsUpserted: number;
      errors: number;
    }>(`${repoBase(projectId, id)}/rescan-credentials`, { method: "POST" }),
  setPrimary: (projectId: Id, id: Id) =>
    apiFetch<RepoConnector>(`${repoBase(projectId, id)}/set-primary`, { method: "PATCH" }),
  getPrimary: (projectId: Id) =>
    apiFetch<RepoConnector | null>(`/projects/${projectId}/connectors/repos/primary`),
};

/**
 * Epic #820 (#821/#828) — a sibling project (same workspace) that also connects
 * to a shared {@link DatabaseResource}. Surfaced by the identity view so an
 * operator can see the cross-project blast radius of a physical database before
 * linking or unlinking.
 */
export interface SharingProject {
  projectId: string;
  name: string;
}

/**
 * The identity resolution for ONE of a project's database connections.
 * `databaseResourceId` is null when the connection is unlinked;
 * `insufficientIdentity` is true when it lacks the minimum host + databaseName to
 * ever be auto-linked (a null-host connection is NEVER given a guessed link).
 * `sharingProjects` lists the OTHER workspace projects linked to the same
 * resource (empty when unlinked or when the project has no workspace).
 */
export interface ProjectDatabaseIdentity {
  connectionId: string;
  databaseResourceId: string | null;
  insufficientIdentity: boolean;
  sharingProjects: SharingProject[];
}

/** Result of an explicit link / unlink / re-resolve mutation (Epic #820 #821). */
export interface ConnectionLinkResult {
  connectionId: string;
  databaseResourceId: string | null;
  /** Whether the mutation changed the stored link (false ⇒ idempotent no-op). */
  changed: boolean;
}

export const dbConnectorsApi = {
  list: (projectId: Id) => apiFetch<DatabaseConnector[]>(dbBase(projectId)),
  get: (projectId: Id, id: Id) => apiFetch<DatabaseConnector>(dbBase(projectId, id)),
  create: (projectId: Id, body: CreateDatabaseConnectorInput) =>
    apiFetch<DatabaseConnector>(dbBase(projectId), { method: "POST", body }),
  update: (projectId: Id, id: Id, body: Omit<UpdateDatabaseConnectorInput, "id">) =>
    apiFetch<DatabaseConnector>(dbBase(projectId, id), { method: "PATCH", body }),
  remove: (projectId: Id, id: Id) => apiFetch<void>(dbBase(projectId, id), { method: "DELETE" }),
  test: (projectId: Id, id: Id) =>
    apiFetch<ConnectorTestResult>(`${dbBase(projectId, id)}/test`, { method: "POST" }),
  inspect: (projectId: Id, id: Id, schema?: string) =>
    apiFetch<DbSchemaSnapshot>(`${dbBase(projectId, id)}/inspect`, {
      method: "POST",
      body: schema ? { schema } : {},
    }),
  query: (projectId: Id, id: Id, sql: string) =>
    apiFetch<DbQueryResult>(`${dbBase(projectId, id)}/query`, {
      method: "POST",
      body: { sql },
    }),
  ingest: (projectId: Id, id: Id, schema?: string) =>
    apiFetch<ConnectorIngestSummary>(`${dbBase(projectId, id)}/ingest`, {
      method: "POST",
      body: schema ? { schema } : {},
    }),
  // Epic #820 (#821/#828) — physical-DB identity management. `identities`
  // resolves every connection's linked DatabaseResource (or null), whether it is
  // linkable, and the sibling projects sharing each resource. `link` asserts a
  // connection points at an EXISTING resource (the escape hatch for the same
  // physical DB behind two hostnames the conservative auto-key cannot detect);
  // `unlink` reverses it; `reresolve` find-or-creates a resource by the
  // conservative identity key for an UNLINKED connection only.
  identities: (projectId: Id) =>
    apiFetch<ProjectDatabaseIdentity[]>(`${dbBase(projectId)}/identities`),
  link: (projectId: Id, id: Id, databaseResourceId: string) =>
    apiFetch<ConnectionLinkResult>(`${dbBase(projectId, id)}/link`, {
      method: "POST",
      body: { databaseResourceId },
    }),
  unlink: (projectId: Id, id: Id) =>
    apiFetch<ConnectionLinkResult>(`${dbBase(projectId, id)}/unlink`, { method: "POST" }),
  reresolve: (projectId: Id, id: Id) =>
    apiFetch<ConnectionLinkResult>(`${dbBase(projectId, id)}/reresolve`, { method: "POST" }),
};

// ---- Suggested Connectors (Epic #467) ----------------------------------------

export interface SuggestedConnector {
  id: string;
  projectId: string;
  driverType: string;
  host: string | null;
  port: number | null;
  database: string | null;
  sourceFile: string;
  lineNumber: number;
  confidence: string;
  status: string;
  username?: string | null;
  devCredsDetected?: boolean;
  credentialSourceFile?: string | null;
  hasStoredPassword?: boolean;
  acceptedConnectorId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SuggestedConnectorDetail extends SuggestedConnector {
  password: string | null;
}

export interface SuggestedConnectorTestInput {
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  password?: string | null;
}

export interface SuggestedConnectorTestResult {
  ok: boolean;
  latencyMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SuggestedConnectorProvisionInput {
  label: string;
  driver: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  password: string;
  options?: Record<string, unknown>;
}

export interface SuggestedConnectorProvisionResult {
  ok: true;
  connectorId: string;
  suggestionId: string;
}

export interface SuggestedConnectorsResponse {
  suggestions: SuggestedConnector[];
  count: number;
}

const suggestedBase = (projectId: Id) => `/projects/${projectId}/suggested-connectors`;

export const suggestedConnectorsApi = {
  list: (projectId: Id, status?: string) =>
    apiFetch<SuggestedConnectorsResponse>(
      `${suggestedBase(projectId)}${status ? `?status=${status}` : ""}`,
    ),
  get: (projectId: Id, id: Id) =>
    apiFetch<SuggestedConnectorDetail>(`${suggestedBase(projectId)}/${id}`),
  updateStatus: (projectId: Id, id: Id, status: string) =>
    apiFetch<SuggestedConnector>(`${suggestedBase(projectId)}/${id}`, {
      method: "PATCH",
      body: { status },
    }),
  remove: (projectId: Id, id: Id) =>
    apiFetch<void>(`${suggestedBase(projectId)}/${id}`, { method: "DELETE" }),
  test: (projectId: Id, id: Id, body: SuggestedConnectorTestInput) =>
    apiFetch<SuggestedConnectorTestResult>(`${suggestedBase(projectId)}/${id}/test`, {
      method: "POST",
      body,
    }),
  provision: (projectId: Id, id: Id, body: SuggestedConnectorProvisionInput) =>
    apiFetch<SuggestedConnectorProvisionResult>(`${suggestedBase(projectId)}/${id}/provision`, {
      method: "POST",
      body,
    }),
};
