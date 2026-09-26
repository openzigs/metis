/**
 * Epic #128 — the one tool runtime shared by chat and analysis.
 *
 * A {@link RuntimeTool} is any tool a model may be offered in a session: a METIS
 * tool from the {@link ToolRegistry}, an MCP tool the registry bridges, or a
 * curated code-search tool. Every call goes through the approval gate (#142)
 * before it executes, and every lifecycle step is reported as a
 * {@link ToolEvent} whose error text comes from a FIXED vocabulary (#143) — raw
 * exception text never reaches a client.
 */
import type { AiToolEvent, AiToolEventPhase } from "@metis/shared";
import type { RiskLevel } from "../types.js";

/** #147 — `agent`: a sub-agent call (the tool runs another agent). */
export type ToolSource = "metis" | "mcp" | "code" | "agent";

/** What one execution produced. `text` is the FULL result (the transcript keeps it). */
export interface RuntimeToolResult {
  text: string;
  isError?: boolean;
  /** Code tools: how many results came back (`0` = a well-formed empty result). */
  resultCount?: number;
  truncated?: boolean;
  /** #147 — the sub-agent run this call started, when the tool ran an agent. */
  subAgentRunId?: string;
}

/** The identity a tool executes under — always server-derived, never model-supplied. */
export interface RuntimeToolContext {
  sessionId: string;
  userId: string;
  projectId: string | null;
  /**
   * #147 — the model's id for THIS call, set by the executor when it runs the
   * tool, so a sub-agent run can be linked to the call that started it.
   */
  callId?: string;
}

export interface RuntimeTool {
  /** Canonical name — what the registry, the audit log and agent allowlists use. */
  name: string;
  /**
   * The name offered to the model. Both wire formats restrict tool names to
   * `^[a-zA-Z0-9_-]{1,64}$`, which `mcp:<server>:<tool>` is not, so a canonical
   * name is mapped to a unique safe one and mapped back on the way in.
   */
  wireName: string;
  description: string;
  /** JSON Schema for the arguments, sent verbatim as the tool's parameters. */
  parameters: Record<string, unknown>;
  risk: RiskLevel;
  source: ToolSource;
  /**
   * The tool must be approved by a person on every call, whatever the session
   * policy says (an MCP server whose governance sets `requireApproval`).
   */
  forcePrompt?: boolean;
  /**
   * Re-read, per call, whether a person must approve it (an MCP server's
   * `requireApproval` may be switched on mid-turn). Consulted when
   * `forcePrompt` is not already set; a failed read forces the prompt.
   */
  forcePromptNow?: () => Promise<boolean>;
  /** Validate raw model arguments BEFORE anyone is asked to approve them. */
  validate(args: unknown): { ok: true; args: unknown } | { ok: false };
  execute(args: unknown, ctx: RuntimeToolContext): Promise<RuntimeToolResult>;
}

/**
 * #143 — the fixed error vocabulary. A client only ever sees these messages;
 * the model sees a more specific (still server-authored) sentence.
 */
export const TOOL_ERROR_MESSAGES = {
  TOOL_DENIED: "The tool call was denied.",
  TOOL_APPROVAL_EXPIRED: "The approval request expired before anyone answered it.",
  TOOL_NOT_ALLOWED: "This tool is not allowed in this session.",
  TOOL_UNKNOWN: "The model asked for a tool that does not exist.",
  TOOL_INVALID_ARGS: "The model sent arguments the tool does not accept.",
  TOOL_FAILED: "The tool failed while running.",
  TOOL_CALL_LIMIT: "The model asked for more tool calls than one reply may make.",
} as const;

export type ToolErrorCode = keyof typeof TOOL_ERROR_MESSAGES;

export type ToolEventPhase = AiToolEventPhase;

/**
 * #143 — one step of one tool call, streamed to the chat UI (SSE `tool_event`)
 * and to the session's socket room (`ai:tool:event`). Previews are bounded and
 * never carry an exception message. The shape is the shared contract.
 */
export type ToolEvent = AiToolEvent & { code?: ToolErrorCode };

/** Bound for argument / result previews carried in events. */
export const TOOL_EVENT_PREVIEW_CHARS = 500;

export function preview(text: string, max = TOOL_EVENT_PREVIEW_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
