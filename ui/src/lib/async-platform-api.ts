/**
 * Epic #156 — typed wrappers for the async agent platform endpoints.
 */
import { apiFetch } from "@/lib/api-client";

export type RunStatus = "queued" | "running" | "paused" | "cancelled" | "failed" | "succeeded";

export interface BackgroundRunDto {
  id: string;
  projectId: string;
  sessionId: string | null;
  kind: string;
  status: RunStatus;
  priority: number;
  runGroupId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  result: string | null;
  score: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerDto {
  id: string;
  projectId: string;
  name: string;
  source: "webhook" | "github" | "slack" | "cron";
  config: Record<string, unknown> | string;
  enabled: boolean;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunGroupDto {
  id: string;
  projectId: string;
  parentRunId: string | null;
  n: number;
  strategy: "best-of-n" | "parallel";
  selectionMethod: "highest-score" | "judge-llm" | "manual";
  winnerRunId: string | null;
  status: "pending" | "running" | "completed" | "failed";
  runs: BackgroundRunDto[];
  createdAt: string;
  updatedAt: string;
}

export const asyncApi = {
  listBackgroundRuns: (params: { projectId?: string; status?: RunStatus; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.projectId) qs.set("projectId", params.projectId);
    if (params.status) qs.set("status", params.status);
    if (params.limit) qs.set("limit", String(params.limit));
    return apiFetch<{ items: BackgroundRunDto[] }>(
      `/runs/background${qs.size ? `?${qs.toString()}` : ""}`,
    );
  },
  getBackgroundRun: (id: string) =>
    apiFetch<
      BackgroundRunDto & {
        messages: Array<{ id: string; ord: number; role: string; content: string; status: string }>;
      }
    >(`/runs/background/${id}`),
  submitBackgroundRun: (input: {
    projectId: string;
    sessionId?: string;
    kind: "analysis" | "chat" | "browse" | "custom";
    payload?: Record<string, unknown>;
    priority?: number;
  }) =>
    apiFetch<{ runId: string }>("/runs/background", {
      method: "POST",
      body: input,
    }),
  cancelBackgroundRun: (id: string) =>
    apiFetch<{ ok: boolean }>(`/runs/background/${id}/cancel`, { method: "POST" }),
  pauseBackgroundRun: (id: string) =>
    apiFetch<{ ok: boolean }>(`/runs/background/${id}/pause`, { method: "POST" }),
  resumeBackgroundRun: (id: string) =>
    apiFetch<{ ok: boolean }>(`/runs/background/${id}/resume`, { method: "POST" }),
  steerRun: (id: string, message: string, role: "user" | "system" | "agent" = "user") =>
    apiFetch<{ messageId: string; ord: number }>(`/runs/${id}/steer`, {
      method: "POST",
      body: { message, role },
    }),
  submitGroup: (input: {
    projectId: string;
    kind: "analysis" | "chat" | "browse" | "custom";
    payload?: Record<string, unknown>;
    n: number;
    selectionMethod?: "highest-score" | "judge-llm" | "manual";
  }) =>
    apiFetch<{ groupId: string; runIds: string[] }>("/runs/group", {
      method: "POST",
      body: input,
    }),
  getGroup: (id: string) => apiFetch<RunGroupDto>(`/runs/group/${id}`),

  listTriggers: (projectId: string) =>
    apiFetch<{ items: TriggerDto[] }>(`/projects/${projectId}/triggers`),
  createTrigger: (
    projectId: string,
    input: {
      name: string;
      source: TriggerDto["source"];
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) =>
    apiFetch<TriggerDto>(`/projects/${projectId}/triggers`, {
      method: "POST",
      body: input,
    }),
  updateTrigger: (
    projectId: string,
    id: string,
    patch: Partial<{
      name: string;
      source: TriggerDto["source"];
      config: Record<string, unknown>;
      enabled: boolean;
    }>,
  ) =>
    apiFetch<TriggerDto>(`/projects/${projectId}/triggers/${id}`, {
      method: "PATCH",
      body: patch,
    }),
  deleteTrigger: (projectId: string, id: string) =>
    apiFetch<{ ok: boolean }>(`/projects/${projectId}/triggers/${id}`, {
      method: "DELETE",
    }),

  compactSession: (sessionId: string) =>
    apiFetch<{ compacted: boolean; before: number; after: number; summarizedTurns: number }>(
      `/ai/sessions/${sessionId}/compact`,
      { method: "POST" },
    ),
};
