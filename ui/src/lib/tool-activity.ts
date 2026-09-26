/**
 * Epic #128 / #143 — the chat page's live view of tool calls in a turn.
 *
 * Events arrive twice (the SSE stream AND the session's socket room) and in any
 * order, so {@link applyToolEvent} is an idempotent upsert keyed by call id in
 * which a call's phase only moves forward: a late or duplicated `started` never
 * turns a finished call back into a running one.
 */
import type { AiToolEvent } from "@metis/shared";

export interface ToolActivity {
  callId: string;
  name: string;
  risk: AiToolEvent["risk"];
  source: AiToolEvent["source"];
  phase: AiToolEvent["phase"];
  argsPreview?: string;
  argsHiddenChars?: boolean;
  approvalId?: string;
  expiresAt?: string;
  resultPreview?: string;
  isError?: boolean;
  code?: AiToolEvent["code"];
}

const RANK: Record<AiToolEvent["phase"], number> = {
  started: 0,
  awaiting_approval: 1,
  result: 2,
  error: 2,
};

export function applyToolEvent(list: readonly ToolActivity[], ev: AiToolEvent): ToolActivity[] {
  const i = list.findIndex((a) => a.callId === ev.callId);
  const prev = i >= 0 ? list[i] : undefined;
  if (prev && RANK[ev.phase] < RANK[prev.phase]) return [...list];
  const next: ToolActivity = {
    ...(prev ?? {}),
    callId: ev.callId,
    name: ev.name,
    risk: ev.risk ?? prev?.risk ?? null,
    source: ev.source ?? prev?.source ?? null,
    phase: ev.phase,
    ...(ev.argsPreview !== undefined ? { argsPreview: ev.argsPreview } : {}),
    ...(ev.argsHiddenChars ? { argsHiddenChars: true } : {}),
    ...(ev.approvalId ? { approvalId: ev.approvalId } : {}),
    ...(ev.expiresAt ? { expiresAt: ev.expiresAt } : {}),
    ...(ev.resultPreview !== undefined ? { resultPreview: ev.resultPreview } : {}),
    ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
    ...(ev.code ? { code: ev.code } : {}),
  };
  if (i < 0) return [...list, next];
  const out = [...list];
  out[i] = next;
  return out;
}

/**
 * #143 — the UI's OWN text for each error code. The server already sends fixed
 * messages; the page still never renders a message string it received, so no
 * exception text can reach the screen whatever a server build sends.
 */
export const TOOL_ERROR_TEXT: Readonly<Record<NonNullable<AiToolEvent["code"]>, string>> = {
  TOOL_DENIED: "Denied — the tool did not run.",
  TOOL_APPROVAL_EXPIRED: "No answer in time — the tool did not run.",
  TOOL_NOT_ALLOWED: "Not allowed for this agent — the tool did not run.",
  TOOL_UNKNOWN: "The model asked for a tool that does not exist.",
  TOOL_INVALID_ARGS: "The model sent arguments the tool does not accept.",
  TOOL_FAILED: "The tool failed while running.",
  TOOL_CALL_LIMIT: "Too many tool calls in one reply.",
};

export function toolErrorText(code: AiToolEvent["code"] | undefined): string {
  return (code && TOOL_ERROR_TEXT[code]) || "The tool call failed.";
}

/** A human label for a recorded approval decision. */
export function decisionLabel(decision: string | undefined, executed: boolean): string {
  if (!executed) {
    if (decision === "expired") return "not answered in time";
    if (decision === "deny") return "denied";
    return "not run";
  }
  if (decision === "approve") return "approved by you";
  if (decision === "auto-approve") return "allowed by policy";
  return "ran";
}
