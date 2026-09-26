/**
 * Epic #165 — typed wrappers for the Copilot SDK alignment endpoints.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  CustomAgentApprovalPolicy,
  CustomAgentDto,
  HookSubscriptionDto,
  ResumableSessionDto,
  SdkHookEvent,
  SdkReasoningEffort,
  SessionPlanDto,
} from "@metis/shared";

// ---------- Custom agents ----------------------------------------------------

export interface CreateCustomAgentInput {
  projectId: string;
  name: string;
  description?: string;
  systemPrompt: string;
  tools?: string[];
  model?: string | null;
  reasoningEffort?: SdkReasoningEffort | null;
  /** Epic #129 (#145) — library skill keys the agent carries. */
  skillKeys?: string[];
  /** Epic #129 (#145) — approval override; the server only lets it tighten. */
  approvalPolicy?: CustomAgentApprovalPolicy | null;
}

/** A tool an agent's allowlist may name (`GET /ai/tools`). */
export interface ToolDescriptorDto {
  name: string;
  description: string;
  risk: "low" | "medium" | "high";
}

/** Token accounting returned by the playground invocation (Epic #260 / #83). */
export interface CustomAgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Result of a playground invocation (Epic #260 / #83). */
export interface InvokeCustomAgentResult {
  content: string;
  usage: CustomAgentUsage;
  model: string;
  provider: string;
}

/** Per-project enablement row (Epic #260 / #79/#80). */
export interface CustomAgentEnablement {
  id: string;
  customAgentId: string;
  projectId: string;
  enabled: boolean;
  enabledById: string | null;
  createdAt: string;
  updatedAt: string;
}

export const sdkApi = {
  // Agents
  listAgents: (projectId?: string, includeBuiltIns = true) =>
    apiFetch<CustomAgentDto[]>(
      `/custom-agents?${new URLSearchParams({
        ...(projectId ? { projectId } : {}),
        includeBuiltIns: includeBuiltIns ? "1" : "0",
      }).toString()}`,
    ),
  getAgent: (id: string) => apiFetch<CustomAgentDto>(`/custom-agents/${id}`),
  /** Epic #129 — the tools an agent's allowlist may name (the real registry). */
  listTools: () => apiFetch<{ tools: ToolDescriptorDto[] }>("/ai/tools"),
  createAgent: (input: CreateCustomAgentInput) =>
    apiFetch<CustomAgentDto>("/custom-agents", { method: "POST", body: input }),
  updateAgent: (id: string, patch: Partial<CreateCustomAgentInput>) =>
    apiFetch<CustomAgentDto>(`/custom-agents/${id}`, { method: "PATCH", body: patch }),
  deleteAgent: (id: string) => apiFetch<void>(`/custom-agents/${id}`, { method: "DELETE" }),

  // Playground invocation (Epic #260 / #83). Wrapped server-side; input is
  // size-capped at 20k chars by the backend.
  invokeAgent: (id: string, input: { projectId: string; input: string }) =>
    apiFetch<InvokeCustomAgentResult>(`/custom-agents/${id}/invoke`, {
      method: "POST",
      body: input,
    }),

  // Per-project enablement (Epic #260 / #79/#80).
  listEnabledAgents: (projectId: string) =>
    apiFetch<CustomAgentDto[]>(`/custom-agents/projects/${projectId}/enabled`),
  setAgentEnablement: (id: string, input: { projectId: string; enabled: boolean }) =>
    apiFetch<CustomAgentEnablement>(`/custom-agents/${id}/enablement`, {
      method: "PUT",
      body: input,
    }),

  // Hooks
  listHooks: (projectId: string) => apiFetch<HookSubscriptionDto[]>(`/projects/${projectId}/hooks`),
  createHook: (
    projectId: string,
    input: {
      event: SdkHookEvent;
      handlerKind?: "webhook" | "builtin";
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) =>
    apiFetch<HookSubscriptionDto>(`/projects/${projectId}/hooks`, {
      method: "POST",
      body: input,
    }),
  updateHook: (
    projectId: string,
    id: string,
    patch: Partial<{ enabled: boolean; config: Record<string, unknown> }>,
  ) =>
    apiFetch<HookSubscriptionDto>(`/projects/${projectId}/hooks/${id}`, {
      method: "PATCH",
      body: patch,
    }),
  deleteHook: (projectId: string, id: string) =>
    apiFetch<void>(`/projects/${projectId}/hooks/${id}`, { method: "DELETE" }),

  // Skill directories
  getSkillDirs: (projectId: string) =>
    apiFetch<{ directories: string[] }>(`/projects/${projectId}/skill-directories`),
  addSkillDir: (projectId: string, path: string) =>
    apiFetch<{ directories: string[] }>(`/projects/${projectId}/skill-directories`, {
      method: "POST",
      body: { path },
    }),
  removeSkillDir: (projectId: string, path: string) =>
    apiFetch<{ directories: string[] }>(`/projects/${projectId}/skill-directories`, {
      method: "DELETE",
      body: { path },
    }),
  getDisabledSkills: (projectId: string) =>
    apiFetch<{ disabled: string[] }>(`/projects/${projectId}/disabled-skills`),
  disableSkill: (projectId: string, slug: string) =>
    apiFetch<{ disabled: string[] }>(`/projects/${projectId}/disabled-skills`, {
      method: "POST",
      body: { slug },
    }),
  enableSkill: (projectId: string, slug: string) =>
    apiFetch<{ disabled: string[] }>(`/projects/${projectId}/disabled-skills`, {
      method: "DELETE",
      body: { slug },
    }),

  // Sessions / plan / model
  listResumable: () => apiFetch<ResumableSessionDto[]>("/ai/sessions?status=resumable"),
  resumeSession: (id: string) => apiFetch<unknown>(`/ai/sessions/${id}/resume`, { method: "POST" }),
  switchModel: (id: string, body: { model: string; reasoningEffort?: SdkReasoningEffort }) =>
    apiFetch<{ currentModel: string; previousModel: string | null }>(`/ai/sessions/${id}/model`, {
      method: "PATCH",
      body,
    }),
  getPlan: (id: string) => apiFetch<SessionPlanDto | null>(`/ai/sessions/${id}/plan`),
  recordPlan: (id: string, planText: string) =>
    apiFetch<SessionPlanDto>(`/ai/sessions/${id}/plan`, {
      method: "POST",
      body: { planText },
    }),
  decidePlan: (id: string, decision: "approved" | "rejected") =>
    apiFetch<SessionPlanDto>(`/ai/sessions/${id}/approve-plan`, {
      method: "POST",
      body: { decision },
    }),
};
