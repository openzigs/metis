/**
 * Typed wrappers around the Jira connector REST endpoints — Epic #556.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  JiraConnectionDetail,
  JiraTestResult,
  JiraProject,
  JiraSearchResult,
  JiraIssueDetail,
  CreateJiraConnectionInput,
  UpdateJiraConnectionInput,
} from "@metis/shared";

type Id = string;

const base = (id?: Id) => `/jira/connections${id ? `/${id}` : ""}`;

export const jiraApi = {
  list: (projectId: Id) =>
    apiFetch<JiraConnectionDetail[]>(`${base()}?projectId=${encodeURIComponent(projectId)}`),

  get: (id: Id) => apiFetch<JiraConnectionDetail>(base(id)),

  create: (projectId: Id, body: CreateJiraConnectionInput) =>
    apiFetch<JiraConnectionDetail>(base(), {
      method: "POST",
      body: { ...body, projectId },
    }),

  update: (id: Id, body: UpdateJiraConnectionInput) =>
    apiFetch<JiraConnectionDetail>(base(id), { method: "PATCH", body }),

  remove: (id: Id) => apiFetch<void>(base(id), { method: "DELETE" }),

  test: (id: Id) => apiFetch<JiraTestResult>(`${base(id)}/test`, { method: "POST" }),

  // ── Issue browsing ─────────────────────────────────────────────────
  listProjects: (id: Id) => apiFetch<JiraProject[]>(`${base(id)}/projects`),

  search: (
    id: Id,
    body: { jql: string; startAt?: number; maxResults?: number; fields?: string[] },
  ) => apiFetch<JiraSearchResult>(`${base(id)}/search`, { method: "POST", body }),

  getIssue: (connectionId: Id, issueKey: string) =>
    apiFetch<JiraIssueDetail>(`${base(connectionId)}/issues/${encodeURIComponent(issueKey)}`),
};
