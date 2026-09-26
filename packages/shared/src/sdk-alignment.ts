/**
 * Epic #165 — agent session shared types (custom agents, hooks, session plan,
 * resume). Originally modelled on the GitHub Copilot SDK's primitives; they
 * are implemented natively in the METIS server and work for every provider.
 * (The Copilot provider itself was removed in #149.)
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
  /** Epic #129 (#145) — library skill keys the agent carries (loaded on demand). */
  skillKeys?: string[];
  /** Epic #129 (#145) — approval-policy override; can only tighten the session's. */
  approvalPolicy?: CustomAgentApprovalPolicy | null;
}

/** Per-risk approval override (`auto` < `prompt-once` < `always-prompt` < `deny`). */
export interface CustomAgentApprovalPolicy {
  low?: "auto" | "prompt-once" | "always-prompt" | "deny";
  medium?: "auto" | "prompt-once" | "always-prompt" | "deny";
  high?: "auto" | "prompt-once" | "always-prompt" | "deny";
}

export interface CustomAgentDto extends CustomAgentDefinition {
  id: string;
  projectId: string | null;
  isBuiltIn: boolean;
  /** Epic #129 (#145) — bumped on every change (always sent by the server). */
  version?: string;
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
