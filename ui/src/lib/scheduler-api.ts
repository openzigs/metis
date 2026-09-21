/**
 * Phase 11 — typed wrappers around `/api/scheduler` and `/api/tasks`.
 */
import { apiFetch } from "@/lib/api-client";

export interface ScheduledJobRow {
  id: string;
  key: string;
  name: string;
  cron: string;
  taskType: string;
  payload: string;
  projectId: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  maxAttempts: number;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface TaskRow {
  id: string;
  scheduledJobId: string | null;
  projectId: string | null;
  type: string;
  trigger: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  priority: number;
  payload: string;
  result: string | null;
  errorMessage: string | null;
  progress: number | null;
  attempts: number;
  maxAttempts: number;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskHandlerInfo {
  type: string;
  description: string;
}

export interface CreateScheduledJobInput {
  key: string;
  name: string;
  cron: string;
  taskType: string;
  payload?: Record<string, unknown>;
  projectId?: string | null;
  enabled?: boolean;
  maxAttempts?: number;
}

export interface UpdateScheduledJobInput {
  name?: string;
  cron?: string;
  taskType?: string;
  payload?: Record<string, unknown>;
  projectId?: string | null;
  enabled?: boolean;
  maxAttempts?: number;
}

export const schedulerApi = {
  list: (params?: { projectId?: string }) => apiFetch<ScheduledJobRow[]>("/scheduler", { params }),
  get: (id: string) => apiFetch<ScheduledJobRow>(`/scheduler/${id}`),
  create: (input: CreateScheduledJobInput) =>
    apiFetch<ScheduledJobRow>("/scheduler", { method: "POST", body: input }),
  update: (id: string, input: UpdateScheduledJobInput) =>
    apiFetch<ScheduledJobRow>(`/scheduler/${id}`, { method: "PATCH", body: input }),
  remove: (id: string) => apiFetch<void>(`/scheduler/${id}`, { method: "DELETE" }),
  runNow: (id: string) =>
    apiFetch<{ taskId: string; status: string }>(`/scheduler/${id}/run`, { method: "POST" }),
  pause: (id: string) => apiFetch<ScheduledJobRow>(`/scheduler/${id}/pause`, { method: "POST" }),
  resume: (id: string) => apiFetch<ScheduledJobRow>(`/scheduler/${id}/resume`, { method: "POST" }),
  history: (id: string) => apiFetch<TaskRow[]>(`/scheduler/${id}/history`),
  handlers: () => apiFetch<TaskHandlerInfo[]>("/scheduler/handlers"),
};

export interface TaskListResponse {
  items: TaskRow[];
  total: number;
}

export const tasksApi = {
  list: (params?: {
    status?: string;
    jobType?: string;
    projectId?: string;
    take?: number;
    skip?: number;
  }) => apiFetch<TaskListResponse>("/tasks", { params }),
  get: (id: string) => apiFetch<TaskRow>(`/tasks/${id}`),
  cancel: (id: string) => apiFetch<{ ok: boolean }>(`/tasks/${id}/cancel`, { method: "POST" }),
  retry: (id: string) =>
    apiFetch<{ taskId: string; status: string }>(`/tasks/${id}/retry`, { method: "POST" }),
};
