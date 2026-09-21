/**
 * Epic #165 — Copilot SDK alignment shared types.
 *
 * These shapes mirror the Copilot SDK's `customAgents`, `HooksConfig`,
 * `SessionPlan`, and resume primitives. They are implemented natively in the
 * METIS server today (`@github/copilot` was dropped in #179) and form the
 * target interface that the future Copilot sidecar (#180) will plug into
 * without changing METIS code.
 */

export const SDK_HOOK_EVENTS = [
  "preToolUse",
  "postToolUse",
  "sessionStart",
  "sessionEnd",
  "userPromptSubmit",
  "notification",
] as const;
export type SdkHookEvent = (typeof SDK_HOOK_EVENTS)[number];

export const SDK_HOOK_HANDLER_KINDS = ["webhook", "builtin", "script"] as const;
export type SdkHookHandlerKind = (typeof SDK_HOOK_HANDLER_KINDS)[number];

export const SDK_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type SdkReasoningEffort = (typeof SDK_REASONING_EFFORTS)[number];

export const SDK_PLAN_STATUSES = ["pending", "approved", "rejected"] as const;
export type SdkPlanStatus = (typeof SDK_PLAN_STATUSES)[number];

/** Definition for a custom session-scoped agent. */
export interface CustomAgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string | null;
  reasoningEffort?: SdkReasoningEffort | null;
}

export interface CustomAgentDto extends CustomAgentDefinition {
  id: string;
  projectId: string | null;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HookSubscriptionDto {
  id: string;
  projectId: string;
  event: SdkHookEvent;
  handlerKind: SdkHookHandlerKind;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionPlanDto {
  id: string;
  sessionId: string;
  planText: string;
  status: SdkPlanStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResumableSessionDto {
  id: string;
  projectId: string | null;
  title: string;
  model: string;
  currentModel: string | null;
  currentReasoningEffort: SdkReasoningEffort | null;
  planModeActive: boolean;
  status: string;
  snapshotUpdatedAt: string | null;
  updatedAt: string;
}

export interface SessionSnapshot {
  /** Schema version for forward-compat. */
  v: 1;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
    name?: string;
  }>;
  currentModel: string | null;
  currentReasoningEffort: SdkReasoningEffort | null;
  loadedSkillIds: string[];
  customAgentIds: string[];
}

export const DEFAULT_SESSION_SNAPSHOT_INTERVAL = 5;
