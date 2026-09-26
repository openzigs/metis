/**
 * Epic #129 — one agent definition, progressive skills and sub-agents.
 *
 * METIS stores agents in two places — the admin-managed LIBRARY (`agents`,
 * authored as `*.agent.md` frontmatter) and project CUSTOM agents
 * (`custom_agents`, authored in the wizard or imported as JSON). Both resolve
 * to ONE {@link AgentDefinitionDto}, which is the only shape the chat and
 * analysis runtimes read (#145).
 */
import type { SdkReasoningEffort } from "./sdk-alignment.js";

export const AGENT_KINDS = ["library", "custom"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * A stable reference to one agent of either kind: `library:<agentId>` or
 * `custom:<customAgentId>`.
 */
export type AgentRef = `${AgentKind}:${string}`;

export const APPROVAL_ACTIONS = ["auto", "prompt-once", "always-prompt", "deny"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/**
 * An agent's approval-policy override, per risk level. It can only TIGHTEN the
 * session's policy (`auto` < `prompt-once` < `always-prompt` < `deny`): an
 * agent never loosens what the session's owner chose.
 */
export interface ApprovalPolicyOverride {
  low?: ApprovalAction;
  medium?: ApprovalAction;
  high?: ApprovalAction;
}

/** The one agent definition both kinds resolve to (#145). */
export interface AgentDefinitionDto {
  ref: AgentRef;
  kind: AgentKind;
  id: string;
  /** Library: the unique key. Custom: a slug of the name (display only). */
  key: string;
  name: string;
  description: string;
  /** The persona — the agent's system prompt. */
  persona: string;
  /** Skill keys the agent carries (loaded on demand, #146). */
  skillKeys: string[];
  /**
   * Tool refs the agent may call (exact names, `mcp:<server>:*`, `agent:*`,
   * `agent:<kind>:<id>`). `null` = no allowlist declared.
   */
  toolAllowlist: string[] | null;
  /** Preferred model; used only when the model catalog knows it (#135). */
  model: string | null;
  reasoningEffort: SdkReasoningEffort | null;
  approvalPolicy: ApprovalPolicyOverride | null;
  version: string;
  /** Custom agents: the owning project (`null` = built-in / workspace-wide). */
  projectId: string | null;
}

/** #146 — the tool the model calls to read a skill's full instructions. */
export const LOAD_SKILL_TOOL_NAME = "load_skill";

/** #147 — sub-agent tools are named `agent:<kind>:<id>`. */
export const SUBAGENT_TOOL_PREFIX = "agent:";

export const SUBAGENT_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "budget_exhausted",
  "aborted",
] as const;
export type SubAgentRunStatus = (typeof SUBAGENT_RUN_STATUSES)[number];

/** One tool call a sub-agent made, as its stored transcript records it. */
export interface SubAgentToolCallDto {
  callId: string;
  tool: string;
  args: unknown;
  result: string;
  isError?: boolean;
  decision?: string;
  errorCode?: string;
  executed: boolean;
  subAgentRunId?: string;
}

/** #147 — `GET /api/ai/sessions/:id/subagent-runs/:runId`. */
export interface SubAgentRunDto {
  id: string;
  sessionId: string;
  /** The run that called this one; `null` when the session's main agent did. */
  parentRunId: string | null;
  /** The tool call in the caller's turn this run answers. */
  parentCallId: string;
  agentRef: string;
  agentName: string;
  depth: number;
  task: string;
  status: SubAgentRunStatus;
  result: string;
  model: string | null;
  /** Every model turn's text, in order. */
  turns: string[];
  toolCalls: SubAgentToolCallDto[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  createdAt: string;
  completedAt: string | null;
}
