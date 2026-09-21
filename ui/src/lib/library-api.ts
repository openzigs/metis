/**
 * Phase 10 — typed wrappers around `/api/skills`, `/api/agents`, `/api/library`.
 *
 * Mirrors the server route surface so the admin pages, the project allow-list
 * editor, and the chat-time agent picker share one client.
 */
import { apiFetch } from "@/lib/api-client";

export interface SkillSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  version: string;
  tools: string[];
  resources: string[];
  tags: string[];
  enabled: boolean;
  archived: boolean;
  source: string;
  contentSha256: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetail extends SkillSummary {
  instructions: string;
  manifest: Record<string, unknown>;
}

export interface SkillVersionSummary {
  id: string;
  version: string;
  contentSha256: string;
  createdById: string | null;
  createdAt: string;
}

export interface AgentSummary {
  id: string;
  key: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  model: string;
  tools: string[];
  tags: string[];
  handoffs: string[];
  enabled: boolean;
  archived: boolean;
  source: string;
  contentSha256: string | null;
  defaultSkillKeys: string[];
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDetail extends AgentSummary {
  systemPrompt: string;
  manifest: Record<string, unknown>;
}

export interface AgentVersionSummary {
  id: string;
  version: string;
  contentSha256: string;
  createdById: string | null;
  createdAt: string;
}

export type LibrarySearchHit =
  | {
      kind: "skill";
      id: string;
      key: string;
      name: string;
      description: string;
      tags: string[];
      updatedAt: string;
    }
  | {
      kind: "agent";
      id: string;
      key: string;
      name: string;
      description: string;
      tags: string[];
      updatedAt: string;
    };

export interface ProjectAllowlistEntry {
  enabled: boolean;
  addedById: string | null;
}
export interface ProjectSkillAllowlistEntry extends ProjectAllowlistEntry {
  skillId: string;
  skillKey: string;
}
export interface ProjectAgentAllowlistEntry extends ProjectAllowlistEntry {
  agentId: string;
  agentKey: string;
}

/** Effective skill available to a project's chat sessions (resolved gate, #468). */
export interface ProjectAvailableSkill {
  skillId: string;
  skillKey: string;
  name: string;
  description: string;
}

export const skillsApi = {
  list: (params?: { q?: string; tag?: string; includeArchived?: "1" }) =>
    apiFetch<{ items: SkillSummary[] }>("/skills", { params }),
  get: (id: string) => apiFetch<SkillDetail>(`/skills/${id}`),
  create: (source: string, key?: string, origin?: string) =>
    apiFetch<SkillDetail>("/skills", {
      method: "POST",
      body: { source, ...(key ? { key } : {}), ...(origin ? { origin } : {}) },
    }),
  update: (id: string, source: string, key?: string, origin?: string) =>
    apiFetch<SkillDetail>(`/skills/${id}`, {
      method: "PATCH",
      body: { source, ...(key ? { key } : {}), ...(origin ? { origin } : {}) },
    }),
  remove: (id: string) => apiFetch<void>(`/skills/${id}`, { method: "DELETE" }),
  archive: (id: string) => apiFetch<SkillDetail>(`/skills/${id}/archive`, { method: "POST" }),
  enable: (id: string) => apiFetch<SkillDetail>(`/skills/${id}/enable`, { method: "POST" }),
  disable: (id: string) => apiFetch<SkillDetail>(`/skills/${id}/disable`, { method: "POST" }),
  versions: (id: string) => apiFetch<{ items: SkillVersionSummary[] }>(`/skills/${id}/versions`),
};

export const agentsApi = {
  list: (params?: { q?: string; tag?: string; includeArchived?: "1" }) =>
    apiFetch<{ items: AgentSummary[] }>("/agents", { params }),
  get: (id: string) => apiFetch<AgentDetail>(`/agents/${id}`),
  create: (source: string, defaultSkillKeys: string[] = [], key?: string) =>
    apiFetch<AgentDetail>("/agents", {
      method: "POST",
      body: { source, defaultSkillKeys, ...(key ? { key } : {}) },
    }),
  update: (id: string, source: string, defaultSkillKeys?: string[], key?: string) =>
    apiFetch<AgentDetail>(`/agents/${id}`, {
      method: "PATCH",
      body: {
        source,
        ...(defaultSkillKeys ? { defaultSkillKeys } : {}),
        ...(key ? { key } : {}),
      },
    }),
  remove: (id: string) => apiFetch<void>(`/agents/${id}`, { method: "DELETE" }),
  archive: (id: string) => apiFetch<AgentDetail>(`/agents/${id}/archive`, { method: "POST" }),
  enable: (id: string) => apiFetch<AgentDetail>(`/agents/${id}/enable`, { method: "POST" }),
  disable: (id: string) => apiFetch<AgentDetail>(`/agents/${id}/disable`, { method: "POST" }),
  versions: (id: string) => apiFetch<{ items: AgentVersionSummary[] }>(`/agents/${id}/versions`),
};

export const libraryApi = {
  search: (params?: { q?: string; tag?: string; kind?: "skill" | "agent" }) =>
    apiFetch<{ items: LibrarySearchHit[] }>("/library", { params }),
  projectSkills: (projectId: string) =>
    apiFetch<{ items: ProjectSkillAllowlistEntry[] }>(`/projects/${projectId}/library/skills`),
  projectAvailableSkills: (projectId: string) =>
    apiFetch<{ items: ProjectAvailableSkill[] }>(`/projects/${projectId}/library/skills/available`),
  projectAgents: (projectId: string) =>
    apiFetch<{ items: ProjectAgentAllowlistEntry[] }>(`/projects/${projectId}/library/agents`),
  setProjectSkill: (projectId: string, skillId: string, enabled: boolean) =>
    apiFetch<void>(`/projects/${projectId}/library/skills/${skillId}`, {
      method: "PUT",
      body: { enabled },
    }),
  setProjectAgent: (projectId: string, agentId: string, enabled: boolean) =>
    apiFetch<void>(`/projects/${projectId}/library/agents/${agentId}`, {
      method: "PUT",
      body: { enabled },
    }),
  removeProjectSkill: (projectId: string, skillId: string) =>
    apiFetch<void>(`/projects/${projectId}/library/skills/${skillId}`, { method: "DELETE" }),
  removeProjectAgent: (projectId: string, agentId: string) =>
    apiFetch<void>(`/projects/${projectId}/library/agents/${agentId}`, { method: "DELETE" }),
};
